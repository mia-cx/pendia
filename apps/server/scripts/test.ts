/**
 * `bun test` runner: runs the suite's test files through N parallel `bun test`
 * child processes. `bun test --parallel` crashes this suite (workers SIGSEGV
 * under spawn/postgres load), so sharding files across real processes does the
 * same job reliably. File args pass straight through to a single `bun test`.
 */
import { availableParallelism } from "node:os";

const args = process.argv.slice(2);

if (args.length > 0) {
  const child = Bun.spawn(["bun", "test", ...args], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  process.exit(await child.exited);
}

// Each worker also runs multithreaded ffmpeg processes; leave CPU headroom.
const defaultWorkers = Math.min(
  8,
  Math.max(1, Math.floor(availableParallelism() / 2)),
);
const workers =
  Number(process.env.THALIA_TEST_WORKERS ?? defaultWorkers) || defaultWorkers;

const glob = new Bun.Glob("src/**/*.test.ts");
const files: string[] = [];
for await (const file of glob.scan({ cwd: `${import.meta.dir}/..` })) {
  files.push(file);
}
files.sort();

// Round-robin keeps ffmpeg/CDP-heavy files spread across workers.
const shards: string[][] = Array.from({ length: workers }, () => []);
for (const [index, file] of files.entries())
  shards[index % workers]?.push(file);

/** Runs one shard and prints its output; a shard killed by a signal is a crash. */
async function runShard(shard: string[]) {
  const proc = Bun.spawn(["bun", "test", ...shard], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  // Drain both pipes immediately so a full pipe cannot stall the shard.
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  process.stdout.write(out);
  process.stderr.write(err);
  // Bun keeps going after a failed test, so a crash can follow a real failure.
  const failed = /^\(fail\) /m.test(out) || /^\(fail\) /m.test(err);
  return { code, signal: proc.signalCode, failed };
}

// Bun itself sometimes segfaults under this suite's load. A crash says nothing
// about the tests, so a crashed shard runs once more, unless a test in it had
// already failed.
const codes = await Promise.all(
  shards
    .filter((shard) => shard.length > 0)
    .map(async (shard) => {
      const first = await runShard(shard);
      if (first.signal === null) return first.code;
      if (first.failed) {
        console.error(
          `\nA test shard crashed (${first.signal}) after a test failed: ${shard.join(" ")}\n`,
        );
        return 1;
      }
      console.error(
        `\nA test shard crashed (${first.signal}); running it again: ${shard.join(" ")}\n`,
      );
      const second = await runShard(shard);
      if (second.signal !== null)
        console.error(`\nThe test shard crashed again (${second.signal}).\n`);
      return second.signal === null ? second.code : 1;
    }),
);
process.exit(codes.some((code) => code !== 0) ? 1 : 0);
