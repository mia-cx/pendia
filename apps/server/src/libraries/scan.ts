import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { AuthError } from "../auth/errors.ts";
import type { Database } from "../db/client.ts";
import {
  episodes,
  files,
  items,
  libraries,
  seasons,
  streams,
  versions,
} from "../db/schema/index.ts";
import { insertItem } from "../db/tree.ts";
import { groupMoviePaths, moviesMedium } from "../mediums/movies.ts";
import { groupShowPaths, showsScan } from "../mediums/shows.ts";
import { videoVersionLabel } from "../mediums/video-common/labels.ts";
import { type ProbeResult, probeVideo } from "../mediums/video-common/probe.ts";
import { type ProbedLibraryFile, probeLibraryFile } from "./probe-cache.ts";
import { persistScanTimelines } from "./timelines.ts";
import { readLibraryFile, walkLibrary } from "./walker.ts";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Replace one File's Stream inventory from a probe, reusing (fileId, index) ids. */
async function upsertFileStreams(
  tx: Transaction,
  versionId: string,
  fileId: string,
  probe: ProbeResult,
) {
  const indexes: number[] = [];
  for (const stream of probe.streams) {
    indexes.push(stream.index);
    const fields = {
      versionId,
      kind: stream.kind,
      codec: stream.codec,
      profile: stream.profile,
      level: stream.level,
      language: stream.language,
      title: stream.title,
      bitrate: stream.bitrate === null ? null : BigInt(stream.bitrate),
      disposition: stream.disposition,
      width: stream.width,
      height: stream.height,
      frameRateNumerator: stream.frameRateNumerator,
      frameRateDenominator: stream.frameRateDenominator,
      hdr: stream.hdr,
      dvProfile: stream.dvProfile,
      channels: stream.channels,
      channelLayout: stream.channelLayout,
      sampleRate: stream.sampleRate,
    };
    await tx
      .insert(streams)
      .values({ fileId, index: stream.index, ...fields })
      .onConflictDoUpdate({
        target: [streams.fileId, streams.index],
        targetWhere: sql`${streams.fileId} is not null`,
        set: fields,
      });
  }
  if (indexes.length === 0) {
    await tx.delete(streams).where(eq(streams.fileId, fileId));
  } else {
    await tx
      .delete(streams)
      .where(
        and(eq(streams.fileId, fileId), notInArray(streams.index, indexes)),
      );
  }
}

/** Scan one canonical directory of a movies library into Items, Versions, Files and Streams. */
export async function scanDirectory(
  db: Database,
  libraryId: string,
  path: string,
  probe: typeof probeVideo = probeVideo,
): Promise<{ itemId: string | null; versionIds: string[]; probed: number }> {
  const [library] = await db
    .select()
    .from(libraries)
    .where(eq(libraries.id, libraryId));
  if (!library) throw new AuthError("NOT_FOUND");
  if (library.medium !== "movies") throw new AuthError("INVALID_INPUT");

  const walked: string[] = [];
  for await (const file of walkLibrary(library.rootPath, moviesMedium.scan, {
    path,
    recursive: false,
  })) {
    walked.push(file.path);
  }
  const [group] = groupMoviePaths(walked);
  if (!group) return { itemId: null, versionIds: [], probed: 0 };

  const members: ProbedLibraryFile[] = [];
  let probed = 0;
  for (const memberPath of group.paths) {
    const member = await probeLibraryFile(db, library, memberPath, probe);
    if (
      !member.probe.streams.some(
        (stream) => stream.kind === "video" && !stream.disposition.attached_pic,
      )
    ) {
      throw new Error(`Recognized media has no video stream: ${memberPath}`);
    }
    if (!member.cached) probed += 1;
    members.push(member);
  }

  const written = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(libraries)
      .where(eq(libraries.id, libraryId))
      .for("update");
    if (!locked) throw new AuthError("NOT_FOUND");

    for (const member of members) {
      const current = await readLibraryFile(library.rootPath, member.path);
      if (
        current.bytes !== member.bytes ||
        current.modifiedNs !== member.modifiedNs
      ) {
        throw new Error("File changed before scan write.");
      }
    }

    const [existingItem] = await tx
      .select()
      .from(items)
      .where(
        and(
          eq(items.libraryId, libraryId),
          eq(items.canonicalFolder, group.canonicalFolder),
        ),
      );
    let itemId: string;
    if (existingItem) {
      if (existingItem.kind !== "movie") throw new AuthError("CONFLICT");
      itemId = existingItem.id;
    } else {
      const created = await insertItem(tx, {
        libraryId,
        kind: "movie",
        title: group.title,
        year: group.year,
        canonicalFolder: group.canonicalFolder,
        extension: {},
      });
      itemId = created.id;
    }

    const versionIds: string[] = [];
    for (const member of members) {
      const label = videoVersionLabel(member.path, member.probe);
      const [existingFile] = await tx
        .select()
        .from(files)
        .where(
          and(eq(files.libraryId, libraryId), eq(files.path, member.path)),
        );

      let versionId: string;
      let fileId: string;
      if (existingFile) {
        if (existingFile.itemId !== itemId) throw new AuthError("CONFLICT");
        versionId = existingFile.versionId;
        fileId = existingFile.id;
        await tx
          .update(versions)
          .set({
            label,
            bytes: member.bytes,
            durationSeconds: member.probe.durationSeconds,
            keyframesSeconds: member.probe.keyframesSeconds,
            lazyIndexPending: member.probe.keyframesSeconds === null,
          })
          .where(eq(versions.id, versionId));
        await tx
          .update(files)
          .set({
            bytes: member.bytes,
            modifiedAt: member.modifiedAt,
            container: member.probe.container,
            durationSeconds: member.probe.durationSeconds,
            chapters: member.probe.chapters,
          })
          .where(eq(files.id, fileId));
      } else {
        const [version] = await tx
          .insert(versions)
          .values({
            itemId,
            itemKind: "movie",
            libraryId,
            label,
            format: "video",
            bytes: member.bytes,
            durationSeconds: member.probe.durationSeconds,
            keyframesSeconds: member.probe.keyframesSeconds,
            lazyIndexPending: member.probe.keyframesSeconds === null,
          })
          .returning();
        if (!version) {
          throw new Error("Version insertion returned no row.");
        }
        const [file] = await tx
          .insert(files)
          .values({
            versionId: version.id,
            itemId,
            libraryId,
            path: member.path,
            order: 0,
            bytes: member.bytes,
            modifiedAt: member.modifiedAt,
            container: member.probe.container,
            durationSeconds: member.probe.durationSeconds,
            chapters: member.probe.chapters,
          })
          .returning();
        if (!file) {
          throw new Error("File insertion returned no row.");
        }
        versionId = version.id;
        fileId = file.id;
      }
      versionIds.push(versionId);
      await upsertFileStreams(tx, versionId, fileId, member.probe);
    }
    await persistScanTimelines(tx, itemId);
    return { itemId, versionIds };
  });
  return { ...written, probed };
}

/** Scan one canonical Show folder into Show, Season and Episode Items with episode Versions. */
export async function scanShowDirectory(
  db: Database,
  libraryId: string,
  path: string,
  probe: typeof probeVideo = probeVideo,
): Promise<{ itemId: string | null; versionIds: string[]; probed: number }> {
  const [library] = await db
    .select()
    .from(libraries)
    .where(eq(libraries.id, libraryId));
  if (!library) throw new AuthError("NOT_FOUND");
  if (library.medium !== "shows") throw new AuthError("INVALID_INPUT");

  const walked: string[] = [];
  for await (const file of walkLibrary(library.rootPath, showsScan, {
    path,
  })) {
    walked.push(file.path);
  }
  const group = groupShowPaths(walked).find(
    (candidate) => candidate.canonicalFolder === path,
  );
  if (!group) return { itemId: null, versionIds: [], probed: 0 };

  const memberByPath = new Map<string, ProbedLibraryFile>();
  let probed = 0;
  for (const season of group.seasons) {
    for (const episode of season.episodes) {
      for (const version of episode.versions) {
        for (const memberPath of version.paths) {
          if (memberByPath.has(memberPath)) continue;
          const member = await probeLibraryFile(db, library, memberPath, probe);
          if (
            !member.probe.streams.some(
              (stream) =>
                stream.kind === "video" && !stream.disposition.attached_pic,
            )
          ) {
            throw new Error(
              `Recognized media has no video stream: ${memberPath}`,
            );
          }
          if (!member.cached) probed += 1;
          memberByPath.set(memberPath, member);
        }
      }
    }
  }

  const written = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(libraries)
      .where(eq(libraries.id, libraryId))
      .for("update");
    if (!locked) throw new AuthError("NOT_FOUND");

    for (const member of memberByPath.values()) {
      const current = await readLibraryFile(library.rootPath, member.path);
      if (
        current.bytes !== member.bytes ||
        current.modifiedNs !== member.modifiedNs
      ) {
        throw new Error("File changed before scan write.");
      }
    }

    const [existingShow] = await tx
      .select()
      .from(items)
      .where(
        and(
          eq(items.libraryId, libraryId),
          eq(items.canonicalFolder, group.canonicalFolder),
        ),
      );
    let showId: string;
    if (existingShow) {
      if (existingShow.kind !== "show") throw new AuthError("CONFLICT");
      showId = existingShow.id;
    } else {
      const created = await insertItem(tx, {
        libraryId,
        kind: "show",
        title: group.title,
        year: group.year,
        canonicalFolder: group.canonicalFolder,
        extension: {},
      });
      showId = created.id;
    }

    const versionIds: string[] = [];
    for (const seasonGroup of group.seasons) {
      const [existingSeason] = await tx
        .select({ item: items, season: seasons })
        .from(seasons)
        .innerJoin(items, eq(items.id, seasons.itemId))
        .where(
          and(
            eq(seasons.showId, showId),
            eq(seasons.seasonNumber, seasonGroup.seasonNumber),
          ),
        );
      let seasonId: string;
      if (existingSeason) {
        if (
          existingSeason.item.libraryId !== libraryId ||
          existingSeason.item.parentId !== showId ||
          existingSeason.item.kind !== "season"
        ) {
          throw new AuthError("CONFLICT");
        }
        seasonId = existingSeason.item.id;
      } else {
        const created = await insertItem(tx, {
          libraryId,
          kind: "season",
          parentId: showId,
          title: seasonGroup.title,
          canonicalFolder: seasonGroup.canonicalFolder,
          extension: { seasonNumber: seasonGroup.seasonNumber },
        });
        seasonId = created.id;
      }

      const persistedEpisodes = await tx
        .select({
          itemId: episodes.itemId,
          episodeNumber: episodes.episodeNumber,
          episodeEndNumber: episodes.episodeEndNumber,
        })
        .from(episodes)
        .where(eq(episodes.seasonId, seasonId));

      const discoveredStarts = seasonGroup.episodes.map(
        (episode) => episode.episodeNumber,
      );
      for (const persisted of persistedEpisodes) {
        const persistedEnd =
          persisted.episodeEndNumber ?? persisted.episodeNumber;
        const blockingStart = discoveredStarts.find(
          (start) => start > persisted.episodeNumber && start <= persistedEnd,
        );
        if (blockingStart === undefined) continue;
        const normalizedEnd = blockingStart - 1;
        await tx
          .update(episodes)
          .set({
            episodeEndNumber:
              normalizedEnd === persisted.episodeNumber ? null : normalizedEnd,
          })
          .where(eq(episodes.itemId, persisted.itemId));
        persisted.episodeEndNumber =
          normalizedEnd === persisted.episodeNumber ? null : normalizedEnd;
      }

      for (const episodeGroup of seasonGroup.episodes) {
        const [existingEpisode] = await tx
          .select({ item: items, episode: episodes })
          .from(episodes)
          .innerJoin(items, eq(items.id, episodes.itemId))
          .where(
            and(
              eq(episodes.seasonId, seasonId),
              eq(episodes.episodeNumber, episodeGroup.episodeNumber),
            ),
          );
        let episodeId: string;
        if (existingEpisode) {
          if (
            existingEpisode.item.libraryId !== libraryId ||
            existingEpisode.item.parentId !== seasonId ||
            existingEpisode.item.kind !== "episode"
          ) {
            throw new AuthError("CONFLICT");
          }
          episodeId = existingEpisode.item.id;
          const existingEnd =
            existingEpisode.episode.episodeEndNumber ??
            existingEpisode.episode.episodeNumber;
          const discoveredEnd =
            episodeGroup.episodeEndNumber ?? episodeGroup.episodeNumber;
          const overlapsDiscoveredEpisode = seasonGroup.episodes.some(
            (candidate) =>
              candidate.episodeNumber > discoveredEnd &&
              candidate.episodeNumber <= existingEnd,
          );
          const blocksWidening = persistedEpisodes.some(
            (candidate) =>
              candidate.itemId !== episodeId &&
              candidate.episodeNumber > existingEnd &&
              candidate.episodeNumber <= discoveredEnd,
          );
          if (
            (discoveredEnd > existingEnd && !blocksWidening) ||
            (discoveredEnd < existingEnd && overlapsDiscoveredEpisode)
          ) {
            await tx
              .update(episodes)
              .set({ episodeEndNumber: episodeGroup.episodeEndNumber })
              .where(eq(episodes.itemId, episodeId));
          }
        } else {
          const created = await insertItem(tx, {
            libraryId,
            kind: "episode",
            parentId: seasonId,
            title: episodeGroup.title,
            canonicalFolder: seasonGroup.canonicalFolder,
            extension: {
              episodeNumber: episodeGroup.episodeNumber,
              episodeEndNumber: episodeGroup.episodeEndNumber,
            },
          });
          episodeId = created.id;
        }

        for (const versionGroup of episodeGroup.versions) {
          const members = versionGroup.paths.map((memberPath) => {
            const member = memberByPath.get(memberPath);
            if (!member) throw new Error(`Unprobed member: ${memberPath}`);
            return member;
          });
          const bytes = members.reduce(
            (total, member) => total + member.bytes,
            0n,
          );
          const durationSeconds = members.every(
            (member) => member.probe.durationSeconds !== null,
          )
            ? members.reduce(
                (total, member) => total + (member.probe.durationSeconds ?? 0),
                0,
              )
            : null;
          const first = members[0];
          if (!first) throw new Error("Show Version has no Files.");
          const label = videoVersionLabel(first.path, first.probe);

          const existingFiles = await tx
            .select()
            .from(files)
            .where(
              and(
                eq(files.libraryId, libraryId),
                inArray(files.path, versionGroup.paths),
              ),
            );
          const existingFile = existingFiles[0];
          let versionId: string;
          if (existingFile) {
            for (const file of existingFiles) {
              if (
                file.itemId !== episodeId ||
                file.versionId !== existingFile.versionId
              ) {
                throw new AuthError("CONFLICT");
              }
            }
            const [version] = await tx
              .select()
              .from(versions)
              .where(eq(versions.id, existingFile.versionId));
            if (
              !version ||
              version.itemId !== episodeId ||
              version.itemKind !== "episode" ||
              version.libraryId !== libraryId
            ) {
              throw new AuthError("CONFLICT");
            }
            await tx
              .update(versions)
              .set({ label, bytes, durationSeconds })
              .where(eq(versions.id, version.id));
            versionId = version.id;
          } else {
            const [version] = await tx
              .insert(versions)
              .values({
                itemId: episodeId,
                itemKind: "episode",
                libraryId,
                label,
                format: "video",
                bytes,
                durationSeconds,
              })
              .returning();
            if (!version) {
              throw new Error("Version insertion returned no row.");
            }
            versionId = version.id;
          }
          versionIds.push(versionId);

          const versionFiles = await tx
            .select({ id: files.id, path: files.path, order: files.order })
            .from(files)
            .where(eq(files.versionId, versionId));
          const maxOrder = versionFiles.reduce(
            (maximum, file) => Math.max(maximum, file.order),
            -1,
          );
          if (maxOrder >= 0) {
            const offset = maxOrder + members.length + 1;
            await tx
              .update(files)
              .set({ order: sql`${files.order} + ${offset}` })
              .where(eq(files.versionId, versionId));
          }

          for (const [order, member] of members.entries()) {
            const file = existingFiles.find(
              (candidate) => candidate.path === member.path,
            );
            let fileId: string;
            if (file) {
              fileId = file.id;
              await tx
                .update(files)
                .set({
                  order,
                  bytes: member.bytes,
                  modifiedAt: member.modifiedAt,
                  container: member.probe.container,
                  durationSeconds: member.probe.durationSeconds,
                  chapters: member.probe.chapters,
                })
                .where(eq(files.id, fileId));
            } else {
              const [created] = await tx
                .insert(files)
                .values({
                  versionId,
                  itemId: episodeId,
                  libraryId,
                  path: member.path,
                  order,
                  bytes: member.bytes,
                  modifiedAt: member.modifiedAt,
                  container: member.probe.container,
                  durationSeconds: member.probe.durationSeconds,
                  chapters: member.probe.chapters,
                })
                .returning();
              if (!created) {
                throw new Error("File insertion returned no row.");
              }
              fileId = created.id;
            }
            await upsertFileStreams(tx, versionId, fileId, member.probe);
          }

          const memberPaths = new Set(versionGroup.paths);
          const staleFiles = versionFiles
            .filter((file) => !memberPaths.has(file.path))
            .sort(
              (a, b) =>
                a.order - b.order ||
                a.path.localeCompare(b.path) ||
                a.id.localeCompare(b.id),
            );
          for (const [index, file] of staleFiles.entries()) {
            await tx
              .update(files)
              .set({ order: members.length + index })
              .where(eq(files.id, file.id));
          }
        }
      }
    }
    return { itemId: showId, versionIds };
  });
  return { ...written, probed };
}
