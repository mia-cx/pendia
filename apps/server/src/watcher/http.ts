import { extname, posix } from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Schema } from "effect";
import { AuthError } from "../auth/errors.ts";
import { requirePermission } from "../auth/permissions.ts";
import { authenticate } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { jobs, libraries, probeCache } from "../db/schema/index.ts";
import { createJobQueue } from "../jobs/queue.ts";
import { runScanJob } from "../libraries/jobs.ts";
import { cacheProbe } from "../libraries/probe-cache.ts";
import type { ScanSource } from "../libraries/scan.ts";
import type {
  createChangeDebouncer,
  WatchedChange,
} from "../libraries/webhooks.ts";
import { parseProbeOutput } from "../mediums/video-common/probe.ts";

const bearerPattern = /^Bearer (\S+)$/i;
const jobPattern = /^\/api\/watcher\/jobs\/([^/]+)$/;

/** A normalized library-relative path below the root. */
const RelativePath = Schema.String.pipe(
  Schema.filter(
    (path) =>
      !path.includes("\0") &&
      !posix.isAbsolute(path) &&
      posix.normalize(path) === path &&
      path !== "." &&
      path !== ".." &&
      !path.startsWith("../"),
  ),
);

const EventBatch = Schema.Struct({
  libraryId: Schema.UUID,
  changes: Schema.Array(
    Schema.Union(
      Schema.Struct({
        kind: Schema.Literal("add", "delete"),
        path: RelativePath,
      }),
      Schema.Struct({
        kind: Schema.Literal("move"),
        path: RelativePath,
        previousPath: RelativePath,
      }),
    ),
  ),
}) satisfies Schema.Schema<{
  libraryId: string;
  changes: readonly WatchedChange[];
}>;

const WatchedLibraries = Schema.Struct({
  libraryIds: Schema.NonEmptyArray(Schema.UUID),
});

/** The file sizes and mtimes travel as decimal strings: JSON has no 64-bit integers. */
const ReportedFile = Schema.Struct({
  path: RelativePath,
  bytes: Schema.BigInt,
  modifiedNs: Schema.BigInt,
});

const ScanReport = Schema.Union(
  Schema.Struct({
    attempts: Schema.Int,
    files: Schema.Array(ReportedFile),
    probes: Schema.Array(
      Schema.Struct({
        path: RelativePath,
        ffprobe: Schema.Unknown,
        keyframesSeconds: Schema.NullOr(Schema.Array(Schema.Number)),
      }),
    ),
  }),
  Schema.Struct({ attempts: Schema.Int, error: Schema.String }),
);

/** What the api answers a watcher's claim: one scan job to run, or none. */
export type WatcherClaim = {
  job: {
    id: string;
    attempts: number;
    libraryId: string;
    path: string;
    medium: (typeof libraries.$inferSelect)["medium"];
    /** Files whose cached probe is current at this size and mtime. */
    cached: (typeof ReportedFile.Encoded)[];
  } | null;
};

/** The body a watcher posts when its claimed scan finished or failed. */
export type WatcherReport = typeof ScanReport.Encoded;

const respond = (body: unknown, status: number) =>
  Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });

/** Accepts only an API key with manage-libraries, sent as a Bearer header. */
async function requireWatcherKey(db: Database, request: Request) {
  const token = request.headers.get("authorization")?.match(bearerPattern)?.[1];
  if (token === undefined) throw new AuthError("UNAUTHENTICATED");
  const auth = await authenticate(db, token);
  if (auth.credential.kind !== "api-key")
    throw new AuthError("UNAUTHENTICATED");
  await requirePermission(db, auth.user.id, "manage-libraries");
}

async function readBody<A, I>(request: Request, schema: Schema.Schema<A, I>) {
  try {
    return Schema.decodeUnknownSync(schema)(await request.json());
  } catch {
    throw new AuthError("INVALID_INPUT");
  }
}

/** Records the watcher's heartbeat on its Libraries, which keeps their scans away from workers. */
async function beat(db: Database, libraryIds: readonly string[]) {
  const watched = await db
    .update(libraries)
    .set({ watcherSeenAt: sql`statement_timestamp()` })
    .where(inArray(libraries.id, [...libraryIds]))
    .returning({ id: libraries.id, medium: libraries.medium });
  if (watched.length !== new Set(libraryIds).size)
    throw new AuthError("NOT_FOUND");
  return watched;
}

/** Records the watcher's heartbeat and claims one scan of its Libraries. */
async function claim(
  db: Database,
  libraryIds: readonly string[],
): Promise<WatcherClaim> {
  const watched = await beat(db, libraryIds);
  const job = await createJobQueue(db).claim(["scan"], { libraryIds });
  if (job === undefined) return { job: null };
  if (job.payload.type !== "scan") throw new Error("Claimed a non-scan job.");
  const { libraryId, path } = job.payload;
  const medium = watched.find((library) => library.id === libraryId)?.medium;
  if (medium === undefined) throw new Error("Claimed an unwatched scan.");
  // A Library scan only lists files, so it needs no probes.
  const cached =
    path === "."
      ? []
      : await db
          .select({
            path: probeCache.path,
            bytes: probeCache.bytes,
            modifiedNs: probeCache.modifiedNs,
          })
          .from(probeCache)
          .where(
            and(
              eq(probeCache.libraryId, libraryId),
              sql`starts_with(${probeCache.path}, ${`${path}/`})`,
              sql`${probeCache.result} ? 'keyframesSeconds'`,
            ),
          );
  return {
    job: {
      id: job.id,
      attempts: job.attempts,
      libraryId,
      path,
      medium,
      cached: cached.map((file) => Schema.encodeSync(ReportedFile)(file)),
    },
  };
}

const inScope = (scope: string, recursive: boolean, path: string) =>
  recursive
    ? scope === "." || path.startsWith(`${scope}/`)
    : posix.dirname(path) === scope;

/** Reads a scan's files from a watcher's report and its probes into the probe cache. */
function reportedScanSource(
  db: Database,
  libraryId: string,
  report: Extract<typeof ScanReport.Type, { files: unknown }>,
): ScanSource {
  const files = new Map(
    report.files.map((file) => [
      file.path,
      { ...file, modifiedAt: new Date(Number(file.modifiedNs / 1_000_000n)) },
    ]),
  );
  const probes = new Map(report.probes.map((probe) => [probe.path, probe]));
  return {
    async walk(path, recursive) {
      const walked = [...files.values()];
      if (walked.some((file) => !inScope(path, recursive, file.path)))
        throw new Error("Watcher reported a file outside the scan scope.");
      return walked;
    },
    async probe(path) {
      const file = files.get(path);
      if (file === undefined)
        throw new Error(`Watcher did not report ${path}.`);
      const reported = probes.get(path);
      if (reported !== undefined) {
        const probe = {
          ...parseProbeOutput(reported.ffprobe, extname(path).toLowerCase()),
          keyframesSeconds:
            reported.keyframesSeconds === null
              ? null
              : [...reported.keyframesSeconds],
        };
        await cacheProbe(db, libraryId, file, probe);
        return { ...file, probe, cached: false };
      }
      const [cached] = await db
        .select({ result: probeCache.result })
        .from(probeCache)
        .where(
          and(
            eq(probeCache.libraryId, libraryId),
            eq(probeCache.path, path),
            eq(probeCache.bytes, file.bytes),
            eq(probeCache.modifiedNs, file.modifiedNs),
          ),
        );
      if (cached?.result.keyframesSeconds === undefined)
        throw new Error(`Watcher reported no probe for ${path}.`);
      return { ...file, probe: cached.result, cached: true };
    },
    // The watcher re-reads each file after its probe, and its walk is the whole scope.
    verify: async () => {},
    confirmEmpty: async () => {},
  };
}

/** Writes a watcher's report for its running scan job, then completes or fails the job. */
async function finishJob(db: Database, request: Request, jobId: string) {
  const [job] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.state, "running")));
  if (job?.payload.type !== "scan") throw new AuthError("NOT_FOUND");
  const queue = createJobQueue(db);
  let report: typeof ScanReport.Type;
  try {
    report = await readBody(request, ScanReport);
  } catch (error) {
    await queue.fail(job, new Error("Invalid watcher report."));
    throw error;
  }
  if (report.attempts !== job.attempts) throw new AuthError("CONFLICT");
  if ("error" in report) {
    const failed = await queue.fail(job, new Error(report.error));
    return { state: failed?.state };
  }
  try {
    await runScanJob(
      db,
      job.payload,
      job,
      reportedScanSource(db, job.payload.libraryId, report),
    );
  } catch (error) {
    const failed = await queue.fail(job, error);
    return { state: failed?.state };
  }
  const completed = await queue.complete(job);
  return { state: completed?.state };
}

/** Creates the HTTP handler for `/api/watcher/*`, the watcher role's api. */
export function createWatcherHandler(
  db: Database,
  debouncer: Pick<ReturnType<typeof createChangeDebouncer>, "submitWatched">,
) {
  return async (request: Request): Promise<Response | undefined> => {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith("/api/watcher/")) return undefined;
    try {
      if (request.method !== "POST") throw new AuthError("METHOD_NOT_ALLOWED");
      await requireWatcherKey(db, request);
      if (pathname === "/api/watcher/events") {
        const batch = await readBody(request, EventBatch);
        const accepted = await debouncer.submitWatched(
          batch.libraryId,
          batch.changes,
        );
        return respond({ accepted }, 202);
      }
      if (pathname === "/api/watcher/claim") {
        const { libraryIds } = await readBody(request, WatchedLibraries);
        return respond(await claim(db, libraryIds), 200);
      }
      if (pathname === "/api/watcher/heartbeat") {
        const { libraryIds } = await readBody(request, WatchedLibraries);
        await beat(db, libraryIds);
        return new Response(null, {
          status: 204,
          headers: { "Cache-Control": "no-store" },
        });
      }
      const jobId = pathname.match(jobPattern)?.[1];
      if (jobId !== undefined && Schema.is(Schema.UUID)(jobId))
        return respond(await finishJob(db, request, jobId), 200);
      throw new AuthError("NOT_FOUND");
    } catch (error) {
      if (error instanceof AuthError)
        return respond(
          { error: { code: error.code, message: error.message } },
          error.status,
        );
      throw error;
    }
  };
}
