---
date: 2026-09-07
tested: bun 1.3.11+af24e281e, bun 1.4.2+744846f84
question: What does Bun 1.3+ give a media server, and where are its limits?
---

# Bun capabilities audit

## Summary

Run Pendia on Bun 1.4.x, not 1.3.x. Three limits that would have shaped the design are fixed in 1.4.
On 1.3.11 a streamed response body ignores a stalled client: a 1 GB file through `Bun.file().stream()` puts 1164 MB in RSS. On 1.4.2 the same test holds at 20 MB.
On 1.3.11 `Bun.serve` ignores `Range`, so every seek needs hand-rolled byte serving. On 1.4.2 `new Response(Bun.file(p))` answers `206` with a correct `Content-Range` on its own, over `sendfile(2)`.
On 1.3.11 `worker.terminate()` never stops a worker in `while(true)`. On 1.4.2 it fires `close` in 1 ms.
`Bun.spawn` streams ffmpeg output fine, but unread stdout has no backpressure: a child that writes 400 MB puts 400 MB in RSS on both versions. Set `maxBuffer`, or drain the stream, or point stdout at a `Bun.file`.
`proc.kill()` kills the direct child only. Spawn ffmpeg with `detached: true` and send `process.kill(-pid)` to take the tree.
Postgres is fine, with one trap: `Bun.sql` compiles one named prepared statement per null pattern, so 6 nullable columns produce 64 server-side statements and 20 columns would produce a million. Use `prepare: false` on wide nullable writes.
A Worker is not a sandbox. It reads the filesystem, spawns processes and calls `process.dlopen`, `resourceLimits` is ignored, and a runaway worker OOM-kills the whole process. Bun has no in-process sandbox at all. Plugin isolation has to be a subprocess.
`bun build --compile` gives a 77.6 MB binary that starts in 12.2 ms. A Docker image with it is 149 MB, and adding ffmpeg takes that to 884 MB, so ffmpeg is the image, not Bun.
sharp works and matches Node speed (13.7 ms vs 13.9 ms per thumbnail). `Bun.Image` needs no addon but is 1.85x slower on that same job.

## How this was verified

Every number below comes from a script in `/tmp/bun-audit` on this machine, not from a doc. Machine: Linux 6.12.95 x86_64, 24 cores, 7.8 GB RAM, `ulimit -n` 524288. Postgres 17.11 in Docker on port 55432. Scripts are reproduced inline with their output.

Two Bun versions are covered because the installed one is six months old:

| version | released | role here |
| --- | --- | --- |
| 1.3.11+af24e281e | 2026-03-18 | the build installed at `~/.bun/bin/bun` |
| 1.4.2+744846f84 | 2026-09-05 | current release, downloaded to `/tmp/bun142` for this audit |

Where the two differ, both numbers appear. Doc links point at `bun.sh/docs`, which describes 1.4.x; several pages describe APIs that 1.3.11 does not have.

## 1. Bun.spawn

### Streaming stdout and stderr

`stdout` defaults to `"pipe"` and gives a `ReadableStream`. `stderr` defaults to `"inherit"`. Both accept `"pipe"`, `"inherit"`, `"ignore"`, a `BunFile` or a raw fd ([Bun docs, spawn](https://bun.sh/docs/api/spawn)).

Chunks arrive as the child writes them, not at exit:

```ts
const proc = Bun.spawn(["sh", "-c", "for i in 1 2 3; do echo chunk-$i; sleep 0.2; done"], { stdout: "pipe" });
const reader = proc.stdout.getReader();
while (true) { const { done, value } = await reader.read(); if (done) break; /* log */ }
```

```
A t=5ms   chunk="chunk-1\n"
A t=211ms chunk="chunk-2\n"
A t=405ms chunk="chunk-3\n"
A exitCode: 0
```

ffmpeg progress streams the same way. A 30 s 1080p HLS transcode delivered 52 `-progress` lines on stdout while running:

```
HLS transcode 30s 1080p h264->h264 veryfast: total=1855ms, first .ts appeared at 733ms, 4 segments
  ffmpeg -progress streamed 52 lines to stdout while running, last out_time_ms=29933333, exit=0
HLS remux (-c copy): total=96ms, first .ts at 62ms
```

### Backpressure: there is none on unread output

Bun drains the child's pipe into memory whether or not anything reads the stream. A child writing 400 MB to an unread `stdout: "pipe"`:

```ts
const rss0 = process.memoryUsage.rss();
const proc = Bun.spawn(["sh", "-c", "dd if=/dev/zero bs=1M count=400 2>/dev/null"], { stdout: "pipe" });
await proc.exited;   // parent never reads proc.stdout
```

```
1.3.11: child wrote 400MB, parent never read. exited after 880ms. rss 32MB -> 454MB
1.4.2:  child wrote 400MB, parent never read. exited after 380ms. rss 15MB -> 437MB
```

Two ways out, both measured:

- `stdout: Bun.file(path)` never touches the JS heap: `rss 454MB -> 455MB, file=419430400` in 224 ms.
- `maxBuffer` works on async `Bun.spawn` in 1.3.11, not only on `spawnSync` as the docs suggest. With `maxBuffer: 1024*1024, killSignal: "SIGKILL"`: `exitCode=null signal=SIGKILL killed=true in 6ms, rss=47MB`.

`maxBuffer` enforcement on the streaming read path is still being tightened upstream ([#31517](https://github.com/oven-sh/bun/pull/31517), open). Treat it as a safety net, not the design.

### Killing process trees

`proc.kill()` signals the direct child only. With a real ffmpeg under an `sh -c` wrapper:

```ts
const p = Bun.spawn(["sh", "-c", `ffmpeg ... -preset veryslow -f null - ; true`], { detached });
detached ? process.kill(-p.pid, "SIGKILL") : p.kill("SIGKILL");
```

```
detached=false kill=proc.kill()       -> ffmpeg grandchildren: 1 before, 1 after
detached=true  kill=process.kill(-pid) -> ffmpeg grandchildren: 1 before, 0 after
```

`detached: true` calls `setsid()` so the child leads its own process group, and `process.kill(-pid)` then reaches the whole group. That is the pattern for a transcode session. `Subprocess` exposes no group API of its own: its prototype is `connected, disconnect, exitCode, exited, kill, killed, pid, readable, ref, resourceUsage, send, signalCode, stderr, stdin, stdio, stdout, terminal, unref, writable`.

`timeout` plus `killSignal` covers the simple case and needs no group ([Bun docs, spawn](https://bun.sh/docs/api/spawn)).

### Concurrent children

Bun sets no ceiling. Each child with three pipes costs 3 socketpairs plus one pidfd in the parent; with `stdout` piped only, 2 fds. Measured on Linux:

```
1.3.11: 4000 concurrent children -> correct stdout 4000, wrong/empty 0, in 1232ms, fds 8012, rss 47MB
1.4.2:  8000 concurrent children -> correct stdout 8000, wrong/empty 0, in 2120ms, fds 16006, rss 30MB
```

The real limit is `ulimit -n` and `kernel.pid_max`. On macOS there is a reported cliff at roughly 5,200 concurrent children where stdout is silently lost with no error ([#40476](https://github.com/oven-sh/bun/issues/40476), open, filed against 1.3.11). Not reproduced on Linux.

### One fd per child stays open until you drain or cancel

fds by kind, 100 children with `stdin`, `stdout` and `stderr` piped:

```
running-100     {"socket:[N]":301, "anon_inode:[pidfd]":100, ...}
after-exit      {"socket:[N]":101, ...}          <- one socket per child survives the child
after-cancel+gc {"socket:[N]":1, ...}            <- back to baseline
```

`Bun.gc(true)` alone does not reclaim them. `await proc.stdout.cancel()` does. A transcoder that spawns ffmpeg and ignores its output leaks one fd per session until GC of the stream object. Sequential spawns that drain properly stay flat: 2000 spawn-and-drain cycles held at 612 fds and 55 MB.

## 2. Bun.file and Bun.serve

### Range responses

Bun 1.3.11 does not handle `Range` anywhere. Bun 1.4.2 handles it everywhere a `Bun.file` is the body. Same script, both versions:

```ts
Bun.serve({
  routes: { "/static": Bun.file(path), "/static-resp": new Response(Bun.file(path)) },
  fetch: () => new Response(Bun.file(path)),
});
```

```
1.3.11  /static   Range=bytes=100-199 -> 200 bytes=20971520  CR=null AR=null
1.3.11  /dynamic  Range=bytes=100-199 -> 200 bytes=20971520  CR=null AR=null

1.4.2   /static   Range=bytes=100-199 -> 206 bytes=100  CR=bytes 100-199/20971520 AR=bytes
1.4.2   /dynamic  Range=bytes=19000000- -> 206 bytes=1971520  CR=bytes 19000000-20971519/20971520 AR=bytes
```

Announced in the 1.4 release: "`Bun.serve` honors `Range` headers for file responses", enabling "video seeking and resumable downloads" ([Bun 1.4 blog](https://bun.com/blog/bun-v1.4)).

On both versions a sliced file body sets `206` by itself, but with an unknown total:

```
GET /slice (server-side .slice) -> status=206 len=1024 content-range=bytes 0-1023/*
```

`bytes a-b/*` is legal under RFC 9110 but many players want the total, so set `Content-Range` yourself when you slice. `Bun.file(p).slice(a, b)` returns a `Blob`, not a `BunFile`.

`If-Range` is not evaluated on either version, so a resumed download after the file changed on disk can silently mix two versions ([#33548](https://github.com/oven-sh/bun/pull/33548), open PR).

### sendfile

Verified under strace on 1.3.11, serving a 20 MB file:

```
sendfile(12, 13, [0]        => [6091464],  20971520) = 6091464
sendfile(12, 13, [6091464]  => [12965912], 14880056) = 6874448
...
sendfile(12, 13, [19839632] => [20971520], 1131888)  = 1131888
sendfile(12, 13, [1000]     => [5000000],  4999000)  = 4999000   <- the .slice(1000, 5_000_000) route
```

`new Response(Bun.file(p))` and `new Response(Bun.file(p).slice(a, b))` both go through `sendfile(2)` with the right offset, and resume at the offset the kernel accepted, which is real backpressure. `Bun.file(p).stream()` does not: it reads through `pread64` in 256 KiB chunks and copies through JS.

`sendfile` can be refused by the kernel, a seccomp policy or the source filesystem. Today `Bun.serve` closes the connection with an empty body when that happens; the read-write fallback is an open PR ([#41474](https://github.com/oven-sh/bun/pull/41474)). Worth a check against the NFS mount in the perf prototype: the failure mode is `200 OK` with `Content-Length` followed by a connection reset, with no `error()` callback.

### Streaming response bodies and backpressure

This is the biggest single difference between the two versions. A client connects, sends the request and never reads:

```python
s = socket.create_connection(("127.0.0.1", PORT))
s.sendall(b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
time.sleep(6)
```

Producer writes 64 KiB chunks in a loop, either through `type: "direct"` with `await controller.write(chunk)` or through a queueing `ReadableStream`:

```
1.3.11 direct: produced=1049MB rss=1108MB
1.3.11 queued: produced=1074MB rss=1147MB
1.4.2  direct: produced=3MB    rss=21MB
1.4.2  queued: produced=3MB    rss=21MB
```

Same story with a 1 GB file as the body:

```
1.3.11  new Response(Bun.file(p))          rss=38MB     <- sendfile, backpressure works
1.3.11  new Response(Bun.file(p).stream()) rss=1164MB   <- whole file buffered
1.4.2   new Response(Bun.file(p))          rss=20MB
1.4.2   new Response(Bun.file(p).stream()) rss=20MB
```

On 1.3.11 `await controller.write()` never returns a pending promise, so a producer that follows the documented backpressure protocol still runs away. That matches the open report ([#18315](https://github.com/oven-sh/bun/issues/18315)) and the fix in flight ([#41757](https://github.com/oven-sh/bun/pull/41757), which records 1144 MB RSS against release 1.4.3, close to the 1164 MB measured here on 1.3.11). 1.4 announced the fix: streams pause "when the connection can't accept more data, so a slow or stalled client holds at most one buffer's worth of server memory" ([Bun 1.4 blog](https://bun.com/blog/bun-v1.4)).

For the plugin host this matters: a plugin that returns a `ReadableStream` from an HTTP route can hold gigabytes on 1.3.x. On 1.4.x it cannot.

### WebSockets

Backpressure on WebSockets works on both versions. `ws.send()` returns `-1` under backpressure and `drain()` fires when the socket clears:

```
server: sent 3 x 1MB, backpressure signalled 1 time(s), bufferedAmount=487454
server: drain() fired 1 time(s)
```

Options and defaults ([Bun docs, WebSockets](https://bun.sh/docs/api/websockets)): `maxPayloadLength` 16 MB, `idleTimeout` 120 s, `backpressureLimit` 16 MB, `closeOnBackpressureLimit` false, `sendPings` true, `publishToSelf` false. Topic pub/sub is built in through `ws.subscribe(topic)` and `server.publish(topic, msg)`, which covers playback progress fan-out without a broker.

### Request limits and timeouts

From the type definitions shipped with `bun-types` 1.4.1:

- `maxRequestBodySize` default `1024 * 1024 * 128`, so 128 MB.
- `idleTimeout` default 10 s. Long streams need `server.timeout(req, 0)` per request.
- `reusePort` default false, sets `SO_REUSEPORT`, which is how several role processes share one port on Linux.
- "For performance, Bun pre-allocates most of the data for 2048 concurrent requests. That means starting a new server allocates about 500 KB of memory."
- Powered by a fork of uWebSockets.

No configurable ceiling on concurrent connections exists. A 62 s soak on 1.3.11 with 63,000 requests, of which 3,000 were 1 MB range reads, showed no growth:

```
ready port=39890 baseline rss=42MB fds=13
t=5s  reqs=61364 rss=53MB fds=19 pendingReqs=0
t=60s reqs=63000 rss=51MB fds=13 pendingReqs=0
FINAL reqs=63000 rss=51MB fds=13
```

Throughput over loopback with keep-alive: 13,925 req/s for small JSON, 5,142 req/s for 1 MB range reads, so about 5.4 GB/s of file bytes.

### HTTP/2

1.3.11 accepts `http2: true` and then does not speak HTTP/2. 1.4.2 does.

```
1.3.11  Bun.serve({http2:true}) + curl --http2-prior-knowledge:
        curl: (16) Remote peer returned unexpected data while we expected SETTINGS frame.
        http_version=0 code=000     (plain HTTP/1.1 on the same port: http_version=1.1 code=200)
1.4.2   Bun.serve({http2:true}) + curl --http2-prior-knowledge: http_version=2 code=200
```

`node:http2` shows the same split. The identical `createSecureServer` script:

```
bun 1.3.11: curl: (16) nghttp2 recv error -902     node client: ERR_HTTP2_ERROR errno -505
            (ALPN negotiated h2 correctly, the framing is wrong)
node 24.19: http_version=2 code=200
bun 1.4.2:  http_version=2 code=200
```

Bun's compatibility page claims `node:http2` is "Fully Implemented", with "94% of Node.js's test suite passes" ([Bun docs, Node.js APIs](https://bun.sh/docs/runtime/nodejs-apis)). That describes 1.4.x. It is false on 1.3.11. HTTP/3 exists as an experimental `http3: true` option in the 1.4 types; not tested here (**unverified**).

## 3. Postgres

### Bun.sql

Works against Postgres 17.11. Pooling, transactions and savepoints all behave:

```
1 connected. server: PostgreSQL 17.11
3 backends: before=5, after 40 concurrent queries with max:5 -> 5     <- the pool cap holds
tx + failed savepoint -> [{"name":"a"},{"name":"b"}]                  <- savepoint rolled back, tx committed
bulk insert 10000 rows via sql(rows,"name"): 32ms
2000 sequential point queries: 247ms (8099 q/s)
select 10000 rows: 3ms
```

Pool options: `max` default 10, plus `idleTimeout`, `maxLifetime`, `connectionTimeout` ([Bun docs, SQL](https://bun.sh/docs/api/sql)).

### Prepared statements: one per null pattern

Bun creates a named server-side prepared statement per query shape, and the null pattern of the bound parameters is part of that shape. 300 inserts into a table with 6 nullable columns:

```
bun 1.3.11: named prepared statements on the server: 64   (2^6 = 64 null patterns)
bun 1.4.2:  named prepared statements on the server: 64
with prepare:false: 0
```

For a Pendia `items` table with 20 nullable metadata columns this is up to 2^20 statements on one connection. That is the reported crash: a table with 6 nullable columns "silently accumulates gigabytes of memory until it crashes" after 20,000 rows ([#28980](https://github.com/oven-sh/bun/issues/28980), open, updated 2026-09-02). Use `prepare: false` on any wide nullable write path.

### LISTEN and NOTIFY

Not present on 1.3.11 at all, despite being documented:

```
1.3.11 SQL instance keys: array,begin,beginDistributed,close,commitDistributed,connect,distributed,
                          end,file,flush,options,reserve,rollbackDistributed,transaction,unsafe
       sql.listen is not a function
       sql.unsafe("LISTEN pendia_scan") is accepted, but nothing delivers the notification
```

1.4.2 has it, including notifications raised on a different connection:

```
methods: listen=function notify=function ...
LISTEN/NOTIFY payload: {"libraryId":7}
cross-connection notify: from-another-connection
```

That is the cross-role signal (scanner to api) with no broker, on 1.4.x only.

### COPY

Not implemented, and it hangs rather than rejecting on both versions:

```
COPY FROM STDIN -> HUNG (no resolve, no reject after 4s)
```

The docs list COPY under "We haven't implemented these yet" ([Bun docs, SQL](https://bun.sh/docs/api/sql)); the feature PR is open ([#23350](https://github.com/oven-sh/bun/pull/23350)). A bulk scanner cannot use `COPY`. Multi-row `INSERT` through `sql(rows, ...)` is the fallback and did 10,000 rows in 32 ms.

There is also no cursor: `sql\`...\`.cursor(n)` does not exist on 1.3.11, so every result set materialises in full.

### Drizzle bun-sql

`drizzle-orm@0.45.2` on `drizzle-orm/bun-sql` against Bun 1.3.11 and Postgres 17. Select, filters, prepared statements with placeholders and transaction rollback all work:

```
select:    [{"id":1,"name":"alpha",...},{"id":2,"name":"beta",...}]
where:     [{"id":2,"name":"beta",...}]
prepared:  [{"id":1,"name":"alpha",...}]
transaction rollback threw: rollback me
after rollback: [alpha, beta]          <- in-tx insert gone
drizzle 1000 point queries: 195ms (5123 q/s)
```

Against 8,099 q/s for raw `Bun.sql`, Drizzle costs about 37% on a point query. Drizzle's page for the driver gives connection setup and nothing about caveats, prepared statements, migrations or gaps against node-postgres ([Drizzle docs, bun-sql](https://orm.drizzle.team/docs/connect-bun-sql)). Migrations through `drizzle-kit` on this driver are **unverified**.

Open `Bun.SQL` correctness bugs worth knowing before the schema lands: `uuid[]` returned as a raw array literal ([#41039](https://github.com/oven-sh/bun/issues/41039)), `sql.array()` binding `json[]` for a `text[]` column ([#41242](https://github.com/oven-sh/bun/issues/41242)), and `Date` parameters serialised with `.toString()` under `prepare: false` ([#29010](https://github.com/oven-sh/bun/issues/29010)). All open.

## 4. Workers and sandboxing

### Bun offers no in-process sandbox

Stated plainly, because ADR 0005 depends on it: Bun has no permission model, no capability restriction, and no way to limit what in-process code reaches. A Worker is a thread, not a boundary.

Probed from inside a Worker:

```
{"canReadFs":true,"canSpawn":true,"canNet":true,"canFFI":true,"canDlopen":true,
 "hasSAB":true,"pid":4186674,"isMainThread":false}
main pid: 4186674     <- same process
```

The only restriction flag in the whole CLI is `--no-addons`, which is process-wide and only blocks `process.dlopen`. `Bun.Security` in the type definitions is an install-time scanner for `bun install`, not a runtime sandbox. Sandboxing permissions is an open feature request from 2024 ([#6617](https://github.com/oven-sh/bun/issues/6617), open, updated 2026-08-15), with a `--permission` flag PR in flight ([#35403](https://github.com/oven-sh/bun/pull/35403), open).

`node:vm` is fully implemented including `timeout` and `codeGeneration` ([Bun docs, Node.js APIs](https://bun.sh/docs/runtime/nodejs-apis)), but a `vm` context shares the process and its globals reach the same I/O. It is not a security boundary in Node either.

### Separate heap: yes

Each Worker gets its own JSC heap. The main thread's heap barely moved while a worker allocated 300,000 objects:

```
main-thread JSC heap: objectCount 2831 -> 5154
process rss = 141MB          <- the worker's objects are in the process, not in the main heap
```

So a plugin in a Worker cannot corrupt or bloat the host's heap. It does share the process address space, the RSS budget and the OOM killer.

### Shared memory: yes

`SharedArrayBuffer` crosses the boundary and `Atomics` work:

```
SharedArrayBuffer: main sees 4242 (worker wrote 4242) -> shared memory works
```

`postMessage` uses structured clone with fast paths for strings and simple objects ([Bun docs, Workers](https://bun.sh/docs/api/workers)).

### Terminating a worker

```
1.3.11: terminate() on while(true) worker: no close event after 15s. Main thread stays responsive
        and process.exit(0) still works, but the thread is never reclaimed.
1.4.2:  terminate() on while(true) worker: close fired (1ms)
```

`terminate()` returns `undefined`, not a promise, on both. Two loop shapes still resist it upstream: pure-Wasm loops ([#36356](https://github.com/oven-sh/bun/pull/36356), open) and a worker blocked in `Bun.sleepSync` ([#35103](https://github.com/oven-sh/bun/pull/35103), open).

### No memory cap

`resourceLimits` is accepted and ignored. In a 512 MB container, a worker allocating in a loop:

```
bun 1.3.11: ExitCode=137 OOMKilled=true      (no output, whole process killed)
bun 1.4.2:  ExitCode=137 OOMKilled=true
node 24:    RESULT: worker error event: Worker terminated due to reaching memory limit: JS heap out of memory
```

Bun's own compatibility page says so: "`Worker` ignores the `resourceLimits` and `trackUnmanagedFds` options" ([Bun docs, Node.js APIs](https://bun.sh/docs/runtime/nodejs-apis)). `smol: true` sets `JSC::HeapSize` to `Small`, which is a hint, not a cap.

What this means for the plugin host: on 1.4.x a Worker gives a heap boundary and a working kill switch for a plugin that loops. It gives no memory cap and no capability restriction. A plugin that allocates without bound takes the process down. Real isolation is a subprocess with its own rlimits, which the host interface should stay shaped for.

## 5. Single-file executables and Docker

### Size and startup

`bun build --compile` embeds the whole runtime, so the binary is the Bun binary plus your bundle.

| build | 1.3.11 | 1.4.2 |
| --- | --- | --- |
| the `bun` binary itself | 94.70 MB | 75.82 MB |
| `--compile` of a 100-module app | 94.75 MB | 77.60 MB |
| `--compile --minify --bytecode` | 95.31 MB | 77.72 MB |

`--bytecode` makes the file slightly larger because it embeds the cache. 1.4 shrank the binary by 18%, matching the release note of "up to 17% smaller on some platforms" ([Bun 1.4 blog](https://bun.com/blog/bun-v1.4)).

Startup, median of 40 runs after 5 warmups, on the 100-module app that imports drizzle and starts a server:

| command | 1.3.11 | 1.4.2 |
| --- | --- | --- |
| `bun run app.ts` | 31.8 ms | 19.0 ms |
| compiled binary | 19.4 ms | 12.2 ms |
| compiled `--minify --bytecode` | 18.8 ms | 11.3 ms |

For reference on the same machine: a trivial script is 15.9 ms under `bun run` and 18.7 ms under `node -e`; `/bin/true` is 0.4 ms. So the runtime floor is about 11 ms and compiling saves 7 to 12 ms of module resolution.

Cross-compilation targets cover linux, macOS and Windows on x64 and arm64, with musl variants for linux ([Bun docs, executables](https://bun.sh/docs/bundler/executables)). The musl binary is 90.41 MB against 95.31 MB for glibc.

### Docker images

Built and run on this machine. All except the first print output and exit 0.

| image | size |
| --- | --- |
| `alpine:3.22` + musl binary, no libs | 145 MB, **does not run**: `Error loading shared library libstdc++.so.6` |
| `alpine:3.22` + `apk add libstdc++ libgcc` + musl binary | 149 MB |
| `gcr.io/distroless/base-debian12` + glibc binary | 173 MB |
| `oven/bun:1.3.11-alpine` + source + node_modules | 237 MB |
| `oven/bun:1.3.11-distroless` + source + node_modules | 247 MB |
| `debian:trixie-slim` + glibc binary | 257 MB |
| `debian:trixie-slim` + `ffmpeg` + glibc binary | **884 MB** |

Base images for reference: `alpine:3.22` 12.8 MB, `gcr.io/distroless/base-debian12` 33.1 MB, `debian:trixie-slim` 119 MB, `oven/bun:1.3.11` 321 MB, `-slim` 255 MB, `-alpine` 153 MB, `-distroless` 163 MB.

The headline is the last row. ffmpeg 7.1.5 from Debian pulls 449 MB of shared libraries and takes the image from 257 MB to 884 MB. Whatever Pendia does about the Bun layer moves the image by tens of megabytes; ffmpeg moves it by 627 MB. If image size matters, that is where to spend the effort, and a musl static ffmpeg build on the alpine image is the thing to try.

## 6. Native addons

### bun:ffi

Works, and the call overhead is small. A C function compiled at runtime through `cc()`:

```ts
const { symbols } = cc({ source: "add.c", symbols: { add: { args: ["int","int"], returns: "int" } } });
```

```
bun:ffi cc() int add(int,int): 5.76 ns/call | equivalent JS closure: 1.60 ns/call
```

So about 4 ns of crossing cost per call after JIT warmup. `dlopen` against `libc.so.6` also works, and `JSCallback` allocates a callable pointer. Exports: `CFunction, CString, FFIType, JSCallback, cc, dlopen, linkSymbols, native, ptr, read, suffix, toArrayBuffer, toBuffer, viewSource`.

Bun's own warning is blunt: "`bun:ffi` is **experimental**, with known bugs and limitations. Do not rely on it in production. The most stable way to interact with native code from Bun is to write a Node-API module." It also does not manage memory, and "an invalid pointer will crash your program" ([Bun docs, FFI](https://bun.sh/docs/api/ffi)).

For ADR 0001's escape hatch, the crossing cost is not the problem. 4 ns per call means even a per-file call during a scan disappears next to the syscall. The stability warning is the problem, and it points at N-API instead.

### N-API

"Bun implements this interface from scratch, so most existing Node-API extensions work with Bun out of the box" ([Bun docs, Node-API](https://bun.sh/docs/api/node-api)). The page names no N-API version and states no stability guarantee.

Prebuilt `.node` files load through `require()`. Verified with sharp's `@img/sharp-linux-x64` addon.

Open crash reports in the tracker: `napi Finalizer::run` SIGSEGV on 1.4.1 and 1.4.2, described as a regression ([#41655](https://github.com/oven-sh/bun/issues/41655), open, updated 2026-09-06); a napi panic crash ([#17285](https://github.com/oven-sh/bun/issues/17285), open); a crash benchmarking `@napi-rs/canvas` ([#18718](https://github.com/oven-sh/bun/issues/18718), open).

### sharp and libvips

`sharp@0.35.4` with `libvips 8.18.6` installs and runs on Bun with no build step. JPEG, PNG, WebP, HEIF, GIF and TIFF all encode. `sharp.format.avif` reports empty on this build, but `.avif({ quality: 50 }).toBuffer()` produces a valid 1,056-byte file, so AVIF works through the HEIF codec and only the capability report is wrong.

Head-to-head, 200 iterations of a 3840x2160 PNG resized to 400 px wide and encoded as JPEG q80:

| runtime and library | per image | RSS |
| --- | --- | --- |
| sharp on Bun 1.4.2 | 13.7 ms | 60 MB -> 97 MB |
| sharp on Node 24.19.0 | 13.9 ms | 84 MB -> 120 MB |
| `Bun.Image` on Bun 1.4.2 | 25.3 ms | 135 MB -> 138 MB |

sharp is the same speed on Bun as on Node. Memory is not: on a longer loop with libvips' cache on, sharp holds far more under Bun.

```
300 sequential resizes, cache on: node 24: rss 150MB -> 219MB
                                  bun 1.3.11: rss 371MB -> 794MB
with sharp.cache(false) on bun:   rss 72MB -> 136MB
```

Call `sharp.cache(false)` in the artwork worker. `sharp.concurrency()` reports 1 on both runtimes on this machine, so that is a libvips detection quirk, not a Bun difference. 32 concurrent resizes spike RSS to 371 MB on Bun against 150 MB on Node, so batch the artwork queue rather than firing a library's worth at once.

Open sharp-on-Bun reports: heap corruption in a long-running server using sharp and mongodb ([#27929](https://github.com/oven-sh/bun/issues/27929), open since 2026-03-08) and a general sharp crash report ([#20372](https://github.com/oven-sh/bun/issues/20372), open). Neither reproduced here in 300 sequential and 32 concurrent resizes on 1.3.11 or 1.4.2.

### Bun.Image

New in 1.4, absent from 1.3.11. Methods on the prototype: `avif, blob, buffer, bytes, dataurl, flip, flop, heic, height, jpeg, metadata, modulate, placeholder, png, resize, rotate, toBase64, toBuffer, webp, width, write`.

It removes a native dependency from the install, which matters for a single-file binary. It is 1.85x slower than sharp on the job measured above, and it holds memory flat across a 200-image loop where sharp grows. Bun's own benchmark claims 1.38x *faster* than sharp on a 1080p PNG to 400x400 JPEG, which is a different and smaller input; on a 4K source sharp wins here. Known gaps against sharp are tracked ([#32122](https://github.com/oven-sh/bun/issues/32122), open): `clone()`, `stats()` and dominant colour, content-aware crop, encode options, richer metadata, timeout.

## 7. Long-running server issues in the tracker

Nothing leaked in the measurements taken here. A 62 s soak with 63,000 requests held RSS at 51 MB and fds at 13. 2,000 spawn-and-drain cycles held flat. 5,000 `Bun.file().text()` reads held flat. Timers do not drift:

```
bun 1.3.11 idle:    period=1ms over 10s -> median gap 1.06ms p99 1.08ms max 1.6ms, drift 9ms
node 24    idle:    period=1ms over 10s -> median gap 1.07ms p99 1.09ms max 3.6ms, drift 3ms
bun 1.3.11 1s tick: median gap 1000.58ms, drift 6ms over 10s
```

What is open upstream and relevant to a process that runs for months:

| issue | state | what it is |
| --- | --- | --- |
| [#34476](https://github.com/oven-sh/bun/issues/34476) | open, 2026-08-13 | Segfault at 0xD0 in JSC GC parallel marking, long-running HTTP server, Linux arm64, 1.3.14 |
| [#26984](https://github.com/oven-sh/bun/issues/26984) | open, 2026-02-27 | Segfault after a long-running session |
| [#32219](https://github.com/oven-sh/bun/issues/32219) | open, 2026-06-12 | Segfault in `pas_lock_unlock` (libpas) during `Uint8Array.subarray`, long session |
| [#26862](https://github.com/oven-sh/bun/issues/26862) | open | Segfault in a long-running standalone executable on Windows under memory pressure |
| [#27929](https://github.com/oven-sh/bun/issues/27929) | open, 2026-03-08 | Heap corruption in a long-running server using sharp |
| [#9261](https://github.com/oven-sh/bun/issues/9261) | open, 2026-08-04 | `Bun.serve` request header memory leak |
| [#21560](https://github.com/oven-sh/bun/issues/21560) | open, 2026-07-12 | RSS of a Bun-spawned child grows slowly even when idle |
| [#39800](https://github.com/oven-sh/bun/issues/39800) | open, 2026-08-24 | `bun build --compile` with sourcemaps leaks native memory on every thrown error |
| [#41459](https://github.com/oven-sh/bun/issues/41459) | open, 2026-09-06 | Every `new WebAssembly.Memory` leaks about 4 KB of RSS that GC never returns, 1.4.0 through 1.4.3-canary; 1.3.14 is flat |
| [#11083](https://github.com/oven-sh/bun/issues/11083) | open, 2026-08-18 | `bun --hot` always leaks memory (development only) |

Two of these have direct operational consequences. #39800 argues for shipping the binary without `--sourcemap` if the error path is ever hot, or accepting native growth proportional to thrown errors. #41459 is a 1.4-only regression, so a Pendia that compiles Wasm at runtime should watch it.

The segfault reports are all "happens eventually, no minimal repro". None reproduced here. Plan for supervision and restart, which the role-per-process design already allows.

## 8. Where Node or Deno avoids a limit found above

Measured on this machine, not quoted:

- **Runaway worker memory.** Node caps a worker's heap. `new Worker(..., { resourceLimits: { maxOldGenerationSizeMb: 32 } })` fires an `error` event with "Worker terminated due to reaching memory limit: JS heap out of memory" and the process survives. Bun 1.3.11 and 1.4.2 both ignore the option and get OOM-killed (`ExitCode=137 OOMKilled=true`).
- **Terminating a spinning worker on 1.3.x.** Node's `worker.terminate()` resolved with exit code 1 after **1 ms** on a `while(true)` worker. Bun 1.3.11 never fired `close`. Bun 1.4.2 matches Node at 1 ms.
- **HTTP/2 on 1.3.x.** The same `node:http2` `createSecureServer` script serves `http_version=2 code=200` on Node 24.19.0 and fails on Bun 1.3.11 with `nghttp2 recv error -902` and `ERR_HTTP2_ERROR errno -505`. Bun 1.4.2 matches Node.
- **sharp memory.** 300 sequential resizes with libvips' cache on grew RSS by 69 MB on Node 24 and by 423 MB on Bun 1.3.11. `sharp.cache(false)` closes the gap.

From documentation, not measured here (**unverified locally**, deno is not installed on this machine):

- **A real sandbox.** Deno is "sandboxed by default: code cannot touch the file system, network, environment, or run subprocesses unless you allow it", with `--allow-read`, `--allow-write`, `--allow-net`, `--allow-run`, `--allow-ffi`, `--allow-env` and matching `--deny-*` flags ([Deno security docs](https://docs.deno.com/runtime/fundamentals/security/)). Deno also supports giving a Web Worker a reduced permission set. Bun has no equivalent, which is the single largest gap for a plugin host that ever wants untrusted plugins.

Everything else Bun does at least as well: startup is faster than Node (12.2 ms compiled against 18.7 ms), `sendfile` for file bodies is built in, WebSocket pub/sub is built in, timers match, and a single-file executable needs no bundler config.

## 9. What this leaves open

For the perf prototype ([#6](https://github.com/mia-cx/pendia/issues/6)):

- Directory walking on this machine costs nothing. On tmpfs, `readdir(root, { recursive: true })` covered 51,050 entries in 5 ms (9.5M entries/s) and a walk plus `statSync` on 20,069 video files took 55 ms. NFS round-trips will be the entire measurement, so the prototype should vary NFS parameters, not Bun code.
- HLS on this machine: remux to the first `.ts` in 62 ms, transcode 1080p h264 `veryfast` to the first `.ts` in 733 ms.
- One thing to check on the real mount: `sendfile(2)` against NFS. If the kernel refuses it, Bun 1.4.2 sends `200 OK` with `Content-Length` and then resets the connection, with no `error()` callback ([#41474](https://github.com/oven-sh/bun/pull/41474), open). A five-line test on the real library answers it.

For the plugin host interface ([#10](https://github.com/mia-cx/pendia/issues/10)):

- A Worker is a heap boundary with a working kill switch on 1.4.x and no memory cap on any version. If the interface is to stay sandbox-ready, the seam has to be shaped for a subprocess, because that is the only place Bun can enforce a limit.
- `Bun.cron` exists in 1.3.11 and covers the scheduled-task capability Prunarr needs, in-process, with a cancellable handle. Under `--hot` all jobs stop before the module graph re-evaluates.
- `sql.listen`/`sql.notify` gives cross-role events with no broker, on 1.4.x only.
- If a plugin can return a `ReadableStream` from an HTTP route, pin the host to Bun 1.4.x. On 1.3.x that is an unbounded memory hole.
