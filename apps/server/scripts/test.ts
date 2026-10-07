/**
 * `bun test` runner: runs the suite's test files through N parallel `bun test`
 * child processes. `bun test --parallel` crashes this suite (workers SIGSEGV
 * under spawn/postgres load), so sharding files across real processes does the
 * same job reliably. File args pass straight through to a single `bun test`.
 */
const args = process.argv.slice(2);

if (args.length > 0) {
  const child = Bun.spawn(["bun", "test", ...args], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  process.exit(await child.exited);
}

const workers = Number(process.env.THALIA_TEST_WORKERS ?? 8) || 8;

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

const procs = shards
  .filter((shard) => shard.length > 0)
  .map((shard) =>
    Bun.spawn(["bun", "test", ...shard], {
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    }),
  );

let failed = false;
for (const proc of procs) {
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  process.stdout.write(out);
  process.stderr.write(err);
  if (code !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
