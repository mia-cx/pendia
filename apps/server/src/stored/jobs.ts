import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import {
  files,
  items,
  type JobPayload,
  jobs,
  libraries,
  segmentTimelines,
  streams,
  versions,
} from "../db/schema/index.ts";
import { createJobQueue } from "../jobs/queue.ts";
import type { createJobRegistry } from "../jobs/registry.ts";
import { locateFile } from "../libraries/roots.ts";
import { MissingLibraryPathError } from "../libraries/walker.ts";
import { probeVideo } from "../mediums/video-common/probe.ts";
import {
  copiesAudio,
  runStore,
  type StoreRun,
  storedAudioBitrate,
} from "./encode.ts";
import {
  idleWindowAt,
  readStoredVersionPolicy,
  readStoreSettings,
  rungFits,
} from "./policy.ts";
import { sweepStoredFolders } from "./sweep.ts";

type StorePayload = Extract<
  JobPayload,
  { type: "store"; sourceFileId: string }
>;

/** The concurrency key that runs one store job at a time across the cluster. */
export const storeConcurrencyKey = "store";

/** Store jobs yield to every other job on the queue. */
export const storePriority = -10;

/** The library-relative folder a rung of a source File lives in. */
export function storedFolderOf(sourcePath: string, rung: string) {
  return `${sourcePath}.pendia/${rung}`;
}

/** Enqueues one store job for a rung of a source File, optionally for later. */
export async function enqueueStore(
  db: Database,
  payload: Omit<StorePayload, "type">,
  runAfter?: Date,
) {
  return createJobQueue(db).enqueue(
    { type: "store", ...payload },
    {
      priority: storePriority,
      concurrencyKey: storeConcurrencyKey,
      ...(runAfter === undefined ? {} : { runAfter }),
    },
  );
}

/** Queues a sweep of a library folder's stored output on a worker, unless one is already queued. */
export async function enqueueStoreSweep(
  db: Database,
  libraryId: string,
  folder: string,
) {
  const [queued] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.type, "store"),
        eq(jobs.state, "queued"),
        sql`${jobs.payload}->>'libraryId' = ${libraryId}`,
        sql`${jobs.payload}->>'folder' = ${folder}`,
      ),
    )
    .limit(1);
  if (queued !== undefined) return;
  // The encode key keeps a sweep from ever running beside an encode, whose
  // new Version its ownership snapshot would miss. Cleanup can wait.
  await createJobQueue(db).enqueue(
    { type: "store", libraryId, folder },
    { priority: storePriority, concurrencyKey: storeConcurrencyKey },
  );
}

/** Loads what a store job needs; null when the job went stale: source gone, unaligned, rung dropped, unfit or done. */
async function loadStoreTarget(db: Database, payload: StorePayload) {
  const [row] = await db
    .select({ file: files, version: versions, library: libraries })
    .from(files)
    .innerJoin(versions, eq(versions.id, files.versionId))
    .innerJoin(items, eq(items.id, files.itemId))
    .innerJoin(libraries, eq(libraries.id, items.libraryId))
    .where(eq(files.id, payload.sourceFileId))
    .limit(1);
  if (row === undefined) return null;
  const { file, version, library } = row;
  if (version.segmentTimelineId === null || !version.timelineAligned)
    return null;
  const rung = readStoredVersionPolicy(library.configuration)?.rungs.find(
    (candidate) => candidate.name === payload.rung,
  );
  if (rung === undefined) return null;
  const [done] = await db
    .select({ id: versions.id })
    .from(versions)
    .where(
      and(
        eq(versions.sourceFileId, file.id),
        eq(versions.rung, rung.name),
        eq(versions.complete, true),
      ),
    )
    .limit(1);
  if (done !== undefined) return null;
  const sourceStreams = await db
    .select()
    .from(streams)
    .where(eq(streams.fileId, file.id))
    .orderBy(asc(streams.index));
  const video = sourceStreams.find(
    (stream) =>
      stream.kind === "video" && stream.disposition.attached_pic !== true,
  );
  const audio = sourceStreams.find((stream) => stream.kind === "audio");
  if (video?.height == null || video.hdr === null) return null;
  if (
    !rungFits(rung, {
      codec: video.codec,
      height: video.height,
      hdr: video.hdr,
    })
  )
    return null;
  const [timeline] = await db
    .select()
    .from(segmentTimelines)
    .where(eq(segmentTimelines.id, version.segmentTimelineId))
    .limit(1);
  if (timeline === undefined) return null;
  let located: Awaited<ReturnType<typeof locateFile>>;
  try {
    located = await locateFile(db, file);
  } catch (error) {
    // A source missing on disk waits for the scan that removes its File.
    if (error instanceof MissingLibraryPathError) return null;
    throw error;
  }
  // The rung folder sits beside its source, in the source File's root.
  const storedFolder = storedFolderOf(located.path, rung.name);
  return {
    file,
    version,
    video,
    audio,
    timeline,
    storedFolder,
    run: {
      inputPath: located.absolute,
      boundariesSeconds: timeline.boundariesSeconds,
      timelineId: timeline.id,
      rung,
      source: {
        codec: video.codec,
        hdr: video.hdr,
        audioCodec: audio?.codec ?? null,
      },
      folder: storedFolderOf(located.absolute, rung.name),
    } satisfies StoreRun,
  };
}

type StoreTarget = NonNullable<Awaited<ReturnType<typeof loadStoreTarget>>>;

/** Creates the incomplete Stored Version row for a target, or finds the one a stopped run left. */
async function upsertStoredVersion(db: Database, target: StoreTarget) {
  const { file, version, timeline, run } = target;
  await db
    .insert(versions)
    .values({
      itemId: version.itemId,
      itemKind: version.itemKind,
      libraryId: version.libraryId,
      label: run.rung.name,
      format: "video",
      bytes: 0n,
      durationSeconds: timeline.boundariesSeconds.at(-1) ?? null,
      lazyIndexPending: false,
      segmentTimelineId: timeline.id,
      timelineAligned: true,
      origin: "stored",
      sourceFileId: file.id,
      storedFolder: target.storedFolder,
      rung: run.rung.name,
      complete: false,
    })
    .onConflictDoNothing();
  const [row] = await db
    .select({ id: versions.id })
    .from(versions)
    .where(
      and(eq(versions.sourceFileId, file.id), eq(versions.rung, run.rung.name)),
    )
    .limit(1);
  if (row === undefined)
    throw new Error("Stored Version upsert returned no row.");
  return row.id;
}

/** Probes a finished rung, writes its fileless Streams and marks the Version complete. */
async function completeStoredVersion(
  db: Database,
  versionId: string,
  target: StoreTarget,
) {
  const { run, video, audio, file } = target;
  const scratch = await mkdtemp(join(tmpdir(), "pendia-store-probe-"));
  let probed: Awaited<ReturnType<typeof probeVideo>>;
  try {
    // An init segment alone carries no profile or level, so probe it with segment 0.
    const sample = join(scratch, "sample.mp4");
    await Bun.write(
      sample,
      Buffer.concat([
        await readFile(join(run.folder, "init.mp4")),
        await readFile(join(run.folder, "0.m4s")),
      ]),
    );
    probed = await probeVideo(sample);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  // Bitrates are what the rung was made with: the target for an encode, the
  // source's for a copy, so playback caps judge them like any Version.
  const rung = run.rung;
  const videoFacts =
    "height" in rung
      ? { bitrate: BigInt(rung.bitrate), hdr: "sdr", dvProfile: null }
      : {
          bitrate:
            video.bitrate ??
            (file.durationSeconds
              ? BigInt(
                  Math.round((Number(file.bytes) * 8) / file.durationSeconds),
                )
              : null),
          hdr: video.hdr,
          dvProfile: video.dvProfile,
        };
  const audioFacts = {
    bitrate: copiesAudio(rung, run.source)
      ? (audio?.bitrate ?? null)
      : BigInt(storedAudioBitrate),
    language: audio?.language ?? null,
    title: audio?.title ?? null,
  };
  const rows = probed.streams
    .filter((stream) => stream.kind === "video" || stream.kind === "audio")
    .map((stream) => ({
      ...stream,
      ...(stream.kind === "video" ? videoFacts : audioFacts),
      versionId,
      fileId: null,
    }));
  const names = await readdir(run.folder);
  let bytes = 0;
  for (const name of names) bytes += (await stat(join(run.folder, name))).size;
  await db.transaction(async (tx) => {
    await tx.delete(streams).where(eq(streams.versionId, versionId));
    if (rows.length > 0) await tx.insert(streams).values(rows);
    await tx
      .update(versions)
      .set({ complete: true, bytes: BigInt(bytes) })
      .where(eq(versions.id, versionId));
  });
}

/** Options for the store handler; the clock and throttle are injectable for tests. */
export type StoreJobOptions = {
  signal?: AbortSignal; // aborted on shutdown: ffmpeg stops and the job re-enqueues
  now?: () => Date;
  readRate?: StoreRun["readRate"];
};

/** Registers the `store` handler: inside the idle window it stores one rung, outside it waits for the next window. */
export function registerStoreJobs(
  db: Database,
  registry: ReturnType<typeof createJobRegistry>,
  { signal, now = () => new Date(), readRate }: StoreJobOptions = {},
) {
  registry.register("store", async (payload) => {
    if ("folder" in payload) {
      await sweepStoredFolders(db, payload.libraryId, payload.folder);
      return;
    }
    const target = await loadStoreTarget(db, payload);
    if (target === null) return;
    const { idleWindow } = await readStoreSettings(db);
    // The window may have changed while an encode ran; book against the current one.
    const reschedule = async () => {
      const next = idleWindowAt(
        (await readStoreSettings(db)).idleWindow,
        now(),
      );
      await enqueueStore(
        db,
        { sourceFileId: payload.sourceFileId, rung: payload.rung },
        next.inside ? undefined : next.startsAt,
      );
    };
    const place = idleWindowAt(idleWindow, now());
    if (!place.inside || signal?.aborted) return reschedule();
    const versionId = await upsertStoredVersion(db, target);
    const controller = new AbortController();
    const stop = () => controller.abort();
    const windowEnd =
      place.endsAt === null
        ? null
        : setTimeout(stop, place.endsAt.getTime() - now().getTime());
    signal?.addEventListener("abort", stop, { once: true });
    // A shutdown during the upsert above fired before the listener existed.
    if (signal?.aborted) stop();
    let outcome: Awaited<ReturnType<typeof runStore>>;
    try {
      outcome = await runStore(
        { ...target.run, ...(readRate === undefined ? {} : { readRate }) },
        controller.signal,
      );
    } finally {
      if (windowEnd !== null) clearTimeout(windowEnd);
      signal?.removeEventListener("abort", stop);
    }
    if (outcome === "stopped") return reschedule();
    await completeStoredVersion(db, versionId, target);
  });
}
