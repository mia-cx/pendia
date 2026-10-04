import { extname, posix } from "node:path";
import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Schema } from "effect";
import { AuthError } from "../auth/errors.ts";
import { requirePermission } from "../auth/permissions.ts";
import { authenticate } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import {
  files,
  itemAncestors,
  items,
  jobs,
  libraries,
  libraryRoots,
  probeCache,
} from "../db/schema/index.ts";
import { createJobQueue } from "../jobs/queue.ts";
import { runScanJob } from "../libraries/jobs.ts";
import { cacheProbe } from "../libraries/probe-cache.ts";
import { type RootedPath, rootedKey, rootsOf } from "../libraries/roots.ts";
import { inScope, type ScanSource } from "../libraries/scan.ts";
import type {
  createChangeDebouncer,
  WatchedChange,
} from "../libraries/webhooks.ts";
import { parseProbeOutput } from "../mediums/video-common/probe.ts";

const bearerPattern = /^Bearer (\S+)$/i;
const jobPattern = /^\/api\/watcher\/jobs\/([^/]+)$/;

/** A normalized root-relative path below the root. */
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
  rootId: Schema.UUID,
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
  rootId: string;
  changes: readonly WatchedChange[];
}>;

const WatchedRoots = Schema.Struct({
  rootIds: Schema.NonEmptyArray(Schema.UUID),
});

/** The claim a report or heartbeat speaks for. */
const HeldClaim = Schema.Struct({ claimToken: Schema.UUID });

/** A heartbeat during a scan also renews the lease on the claimed job. */
const Heartbeat = Schema.Struct({
  ...WatchedRoots.fields,
  job: Schema.optional(Schema.Struct({ id: Schema.UUID, ...HeldClaim.fields })),
});

/** A path in one root. */
const ReportedPath = Schema.Struct({ rootId: Schema.UUID, path: RelativePath });

/** The file sizes and mtimes travel as decimal strings: JSON has no 64-bit integers. */
const ReportedFile = Schema.Struct({
  ...ReportedPath.fields,
  bytes: Schema.BigInt,
  modifiedNs: Schema.BigInt,
});

const ScanReport = Schema.Union(
  Schema.Struct({
    ...HeldClaim.fields,
    /** The Library's roots revision at claim time; a root edit since fails the scan. */
    rootsRevision: Schema.Int,
    files: Schema.Array(ReportedFile),
    probes: Schema.Array(
      Schema.Struct({
        ...ReportedPath.fields,
        ffprobe: Schema.Unknown,
        keyframesSeconds: Schema.NullOr(Schema.Array(Schema.Number)),
      }),
    ),
    /** The claim's `check` files that are gone. */
    missing: Schema.optionalWith(Schema.Array(ReportedPath), {
      default: () => [],
    }),
  }),
  Schema.Struct({ ...HeldClaim.fields, error: Schema.String }),
);

/** What the api answers a watcher's claim: one scan job to run, or none. */
export type WatcherClaim = {
  job: {
    id: string;
    /** Sent back with the heartbeats and the report: only this claim may settle the job. */
    claimToken: string;
    libraryId: string;
    /** The Library's root ids, first root first: the scan walks its path in each. */
    rootIds: string[];
    /** The roots revision the root ids were read at; sent back with the report. */
    rootsRevision: number;
    path: string;
    medium: (typeof libraries.$inferSelect)["medium"];
    /** Files whose cached probe is current at this size and mtime. */
    cached: (typeof ReportedFile.Encoded)[];
    /** Stored Files outside the scope whose existence the scan may need: the rest of a moved Show. */
    check: RootedPath[];
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

/**
 * Records the watcher's heartbeat on the Libraries it watches whole, which
 * keeps their scans away from workers. A scan walks every root, so a
 * Library with a root this watcher lacks stays with the workers.
 */
async function beat(db: Database, rootIds: readonly string[]) {
  const watchedRoots = new Set(rootIds);
  const roots = await db
    .select({
      libraryId: libraryRoots.libraryId,
      rootId: libraryRoots.id,
      rootsRevision: libraries.rootsRevision,
    })
    .from(libraryRoots)
    .innerJoin(libraries, eq(libraries.id, libraryRoots.libraryId))
    .where(
      inArray(
        libraryRoots.libraryId,
        db
          .select({ id: libraryRoots.libraryId })
          .from(libraryRoots)
          .where(inArray(libraryRoots.id, [...watchedRoots])),
      ),
    )
    .orderBy(asc(libraryRoots.position), asc(libraryRoots.id));
  const known = roots.filter((root) => watchedRoots.has(root.rootId));
  if (known.length !== watchedRoots.size) throw new AuthError("NOT_FOUND");
  const rootIdsOf = Map.groupBy(roots, (root) => root.libraryId);
  const revisionOf = new Map(
    roots.map((root) => [root.libraryId, root.rootsRevision]),
  );
  const whole = [...rootIdsOf]
    .filter(([, held]) => held.every((root) => watchedRoots.has(root.rootId)))
    .map(([libraryId]) => libraryId);
  const watched =
    whole.length === 0
      ? []
      : await db
          .update(libraries)
          .set({ watcherSeenAt: sql`statement_timestamp()` })
          .where(inArray(libraries.id, whole))
          .returning({ id: libraries.id, medium: libraries.medium });
  return watched.map((library) => ({
    ...library,
    rootIds: (rootIdsOf.get(library.id) ?? []).map((root) => root.rootId),
    rootsRevision: revisionOf.get(library.id) ?? 0,
  }));
}

/** Records the watcher's heartbeat and claims one scan of the Libraries it watches whole. */
async function claim(
  db: Database,
  rootIds: readonly string[],
): Promise<WatcherClaim> {
  const watched = await beat(db, rootIds);
  const job = await createJobQueue(db).claim(["scan"], {
    libraryIds: watched.map((library) => library.id),
  });
  if (job === undefined) return { job: null };
  if (job.payload.type !== "scan") throw new Error("Claimed a non-scan job.");
  const { libraryId, path } = job.payload;
  const library = watched.find((candidate) => candidate.id === libraryId);
  if (library === undefined) throw new Error("Claimed an unwatched scan.");
  // A Library scan only lists files, so it needs no probes.
  const cached =
    path === "."
      ? []
      : await db
          .select({
            rootId: probeCache.rootId,
            path: probeCache.path,
            bytes: probeCache.bytes,
            modifiedNs: probeCache.modifiedNs,
          })
          .from(probeCache)
          .where(
            and(
              inArray(probeCache.rootId, library.rootIds),
              sql`starts_with(${probeCache.path}, ${`${path}/`})`,
              sql`${probeCache.result} ? 'keyframesSeconds'`,
            ),
          );
  const moves = (job.payload.changes ?? []).flatMap((change) =>
    change.kind === "move" ? [change] : [],
  );
  // The scan re-paths moved Files first, so a destination that vanished must be checked too.
  const check =
    library.medium === "shows" && moves.length > 0
      ? [
          ...(await filesSharingShow(
            db,
            libraryId,
            moves.map((move) => move.previousPath),
          )),
          ...moves.map(({ rootId, path }) => ({ rootId, path })),
        ]
      : [];
  return {
    job: {
      id: job.id,
      claimToken: job.claimToken,
      libraryId,
      rootIds: library.rootIds,
      rootsRevision: library.rootsRevision,
      path,
      medium: library.medium,
      cached: cached.map((file) => Schema.encodeSync(ReportedFile)(file)),
      check,
    },
  };
}

/** Lists the other Files of the Shows that own Files at these paths. */
async function filesSharingShow(
  db: Database,
  libraryId: string,
  paths: readonly string[],
) {
  const movedFiles = alias(files, "moved_files");
  const movedAncestors = alias(itemAncestors, "moved_ancestors");
  return db
    .selectDistinct({ rootId: files.rootId, path: files.path })
    .from(movedFiles)
    .innerJoin(
      movedAncestors,
      eq(movedAncestors.descendantId, movedFiles.itemId),
    )
    .innerJoin(
      items,
      and(eq(items.id, movedAncestors.ancestorId), eq(items.kind, "show")),
    )
    .innerJoin(itemAncestors, eq(itemAncestors.ancestorId, items.id))
    .innerJoin(files, eq(files.itemId, itemAncestors.descendantId))
    .where(
      and(
        eq(movedFiles.libraryId, libraryId),
        inArray(movedFiles.path, [...paths]),
        notInArray(files.path, [...paths]),
      ),
    );
}

/** Reads a scan's files from a watcher's report and its probes into the probe cache. */
function reportedScanSource(
  db: Database,
  rootIds: readonly string[],
  report: Extract<typeof ScanReport.Type, { files: unknown }>,
): ScanSource {
  if (report.files.some((file) => !rootIds.includes(file.rootId)))
    throw new Error("Watcher reported a file outside the Library's roots.");
  const reportedFiles = new Map(
    report.files.map((file) => [
      rootedKey(file),
      { ...file, modifiedAt: new Date(Number(file.modifiedNs / 1_000_000n)) },
    ]),
  );
  const probes = new Map(
    report.probes.map((probe) => [rootedKey(probe), probe]),
  );
  const missing = new Set(report.missing.map(rootedKey));
  return {
    rootsRevision: report.rootsRevision,
    async walk(path, recursive) {
      const walked = [...reportedFiles.values()];
      if (walked.some((file) => !inScope(path, recursive, file.path)))
        throw new Error("Watcher reported a file outside the scan scope.");
      return walked;
    },
    async probe(at) {
      const file = reportedFiles.get(rootedKey(at));
      if (file === undefined)
        throw new Error(`Watcher did not report ${at.path}.`);
      const reported = probes.get(rootedKey(at));
      if (reported !== undefined) {
        const probe = {
          ...parseProbeOutput(reported.ffprobe, extname(at.path).toLowerCase()),
          keyframesSeconds:
            reported.keyframesSeconds === null
              ? null
              : [...reported.keyframesSeconds],
        };
        await cacheProbe(db, file.rootId, file, probe);
        return { ...file, probe, cached: false };
      }
      const [cached] = await db
        .select({ result: probeCache.result })
        .from(probeCache)
        .where(
          and(
            eq(probeCache.rootId, file.rootId),
            eq(probeCache.path, file.path),
            eq(probeCache.bytes, file.bytes),
            eq(probeCache.modifiedNs, file.modifiedNs),
          ),
        );
      if (cached?.result.keyframesSeconds === undefined)
        throw new Error(`Watcher reported no probe for ${at.path}.`);
      return { ...file, probe: cached.result, cached: true };
    },
    // The watcher re-reads each file after its probe, and its walk is the whole scope.
    verify: async () => {},
    confirmEmpty: async () => {},
    confirmMissing: async () => {},
    // An unchecked file counts as present, which keeps a Show where it is.
    exists: async (file) => !missing.has(rootedKey(file)),
  };
}

/** Writes a watcher's report for its running scan job, then completes or fails the job. */
async function finishJob(db: Database, request: Request, jobId: string) {
  const [job] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.state, "running")));
  if (job?.payload.type !== "scan") throw new AuthError("NOT_FOUND");
  const body: unknown = await request.json().catch(() => undefined);
  // Only the claim that holds the job may settle it, even with a malformed report.
  if (!Schema.is(HeldClaim)(body)) throw new AuthError("INVALID_INPUT");
  const queue = createJobQueue(db);
  // Another claim may have taken the job while the body arrived. A renewal
  // proves this claim still holds it, and holding keeps it while the report is written.
  const held = { ...job, claimToken: body.claimToken };
  if (!(await queue.renew(held))) throw new AuthError("CONFLICT");
  let report: typeof ScanReport.Type;
  try {
    report = Schema.decodeUnknownSync(ScanReport)(body);
  } catch {
    await queue.fail(held, new Error("Invalid watcher report."));
    throw new AuthError("INVALID_INPUT");
  }
  if ("error" in report) {
    const failed = await queue.fail(held, new Error(report.error));
    return { state: failed?.state };
  }
  const { payload } = job;
  const roots = await rootsOf(db, payload.libraryId);
  const source = reportedScanSource(
    db,
    roots.map((root) => root.id),
    report,
  );
  try {
    await queue.hold(held, () => runScanJob(db, payload, job, source));
  } catch (error) {
    const failed = await queue.fail(held, error);
    return { state: failed?.state };
  }
  const completed = await queue.complete(held);
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
          batch.rootId,
          batch.changes,
        );
        return respond({ accepted }, 202);
      }
      if (pathname === "/api/watcher/claim") {
        const { rootIds } = await readBody(request, WatchedRoots);
        return respond(await claim(db, rootIds), 200);
      }
      if (pathname === "/api/watcher/heartbeat") {
        const { rootIds, job } = await readBody(request, Heartbeat);
        await beat(db, rootIds);
        if (job !== undefined && !(await createJobQueue(db).renew(job)))
          throw new AuthError("CONFLICT");
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
