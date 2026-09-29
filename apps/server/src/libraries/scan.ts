import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { AuthError } from "../auth/errors.ts";
import type { Database } from "../db/client.ts";
import {
  artwork,
  episodes,
  files,
  itemAncestors,
  items,
  libraries,
  progress,
  type ScanChange,
  seasons,
  sessionRegistry,
  streams,
  versions,
} from "../db/schema/index.ts";
import {
  type DeletedArtworkFile,
  deleteItemSubtree,
  insertItem,
} from "../db/tree.ts";
import type { ScanRules } from "../mediums/medium.ts";
import { groupMoviePaths, moviesMedium } from "../mediums/movies.ts";
import { groupShowPaths, showsScan } from "../mediums/shows.ts";
import { videoVersionLabel } from "../mediums/video-common/labels.ts";
import { type ProbeResult, probeVideo } from "../mediums/video-common/probe.ts";
import { removeColocatedArtworkFiles } from "../metadata/artwork-store.ts";
import {
  applyScanChanges,
  findItemByProviderIds,
  setItemProviderIds,
  updateItemCanonicalFolder,
} from "./changes.ts";
import { type ProbedLibraryFile, probeLibraryFile } from "./probe-cache.ts";
import { persistScanTimelines } from "./timelines.ts";
import {
  MissingLibraryPathError,
  readLibraryFile,
  walkLibrary,
} from "./walker.ts";

/** Optional collaborators and queued changes for one directory scan. */
export type ScanDirectoryOptions = {
  probe?: typeof probeVideo;
  changes?: readonly ScanChange[];
  reconcileMissing?: boolean;
};

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

/** Re-walks the requested scope inside the write lock and rejects on any drift. */
async function revalidateScope(
  rootPath: string,
  rules: ScanRules,
  path: string,
  recursive: boolean,
  expected: readonly string[],
): Promise<void> {
  const current = new Set<string>();
  try {
    for await (const file of walkLibrary(rootPath, rules, {
      path,
      recursive,
    })) {
      current.add(file.path);
    }
  } catch (error) {
    if (
      !(error instanceof MissingLibraryPathError) ||
      error.scope !== "requested"
    ) {
      throw error;
    }
  }
  if (current.size !== expected.length) {
    throw new Error("Library directory changed before scan write.");
  }
  for (const walked of expected) {
    if (!current.has(walked)) {
      throw new Error("Library directory changed before scan write.");
    }
  }
}

/** Returns whether the requested scope still holds recognized media. */
async function scopeHasMedia(
  rootPath: string,
  rules: ScanRules,
  path: string,
  recursive: boolean,
): Promise<boolean> {
  try {
    for await (const file of walkLibrary(rootPath, rules, {
      path,
      recursive,
    })) {
      if (file.path !== "") return true;
    }
    return false;
  } catch (error) {
    if (
      error instanceof MissingLibraryPathError &&
      error.scope === "requested"
    ) {
      return false;
    }
    throw error;
  }
}

/** Combines ordered member keyframes into one Version index offset by duration. */
function combineKeyframes(
  members: readonly ProbedLibraryFile[],
): number[] | null {
  const combined: number[] = [];
  let offset = 0;
  for (const member of members) {
    const duration = member.probe.durationSeconds;
    const keyframes = member.probe.keyframesSeconds;
    if (duration === null || keyframes === null) return null;
    for (const keyframe of keyframes) {
      const shifted = keyframe + offset;
      const last = combined[combined.length - 1];
      if (last === undefined || shifted > last) combined.push(shifted);
    }
    offset += duration;
  }
  return combined;
}

/** Deletes leaf Items still holding no Versions after queued file deletes. */
async function deleteEmptiedItems(
  tx: Transaction,
  itemIds: readonly string[],
  deletedArtwork: DeletedArtworkFile[],
) {
  for (const itemId of new Set(itemIds)) {
    const [item] = await tx.select().from(items).where(eq(items.id, itemId));
    if (!item || item.kind === "show" || item.kind === "season") continue;
    const [version] = await tx
      .select({ id: versions.id })
      .from(versions)
      .where(eq(versions.itemId, itemId))
      .limit(1);
    if (version !== undefined) continue;
    const { parentId } = item;
    await deleteItemSubtree(tx, item.id, deletedArtwork);
    // Prune only emptied containers; a populated Season or Show stays.
    let ancestorId = parentId;
    while (ancestorId !== null) {
      const [ancestor] = await tx
        .select({ parentId: items.parentId })
        .from(items)
        .where(eq(items.id, ancestorId));
      if (!ancestor) break;
      const [child] = await tx
        .select({ id: items.id })
        .from(items)
        .where(eq(items.parentId, ancestorId))
        .limit(1);
      if (child !== undefined) break;
      await deleteItemSubtree(tx, ancestorId, deletedArtwork);
      ancestorId = ancestor.parentId;
    }
  }
}

/** Scan one canonical directory of a movies library into Items, Versions, Files and Streams. */
export async function scanDirectory(
  db: Database,
  libraryId: string,
  path: string,
  options: ScanDirectoryOptions = {},
): Promise<{ itemId: string | null; versionIds: string[]; probed: number }> {
  const probe = options.probe ?? probeVideo;
  const changes = options.changes ?? [];
  const [library] = await db
    .select()
    .from(libraries)
    .where(eq(libraries.id, libraryId));
  if (!library) throw new AuthError("NOT_FOUND");
  if (library.medium !== "movies") throw new AuthError("INVALID_INPUT");

  const walked: string[] = [];
  try {
    for await (const file of walkLibrary(library.rootPath, moviesMedium.scan, {
      path,
      recursive: false,
    })) {
      walked.push(file.path);
    }
  } catch (error) {
    if (
      !(error instanceof MissingLibraryPathError) ||
      error.scope !== "requested"
    ) {
      throw error;
    }
  }
  const [group] = groupMoviePaths(walked);

  const members: ProbedLibraryFile[] = [];
  let probed = 0;
  if (group) {
    for (const memberPath of group.paths) {
      const member = await probeLibraryFile(db, library, memberPath, probe);
      if (
        !member.probe.streams.some(
          (stream) =>
            stream.kind === "video" && !stream.disposition.attached_pic,
        )
      ) {
        throw new Error(`Recognized media has no video stream: ${memberPath}`);
      }
      if (!member.cached) probed += 1;
      members.push(member);
    }
  }

  const mergedProviderIds: Record<string, string> = group
    ? { ...group.providerIds }
    : {};
  for (const change of changes) {
    Object.assign(mergedProviderIds, change.providerIds);
  }

  const deletedArtwork: DeletedArtworkFile[] = [];
  const written = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(libraries)
      .where(eq(libraries.id, libraryId))
      .for("update");
    if (!locked) throw new AuthError("NOT_FOUND");

    const emptiedItemIds = await applyScanChanges(
      tx,
      libraryId,
      changes,
      deletedArtwork,
    );

    for (const member of members) {
      const current = await readLibraryFile(library.rootPath, member.path);
      if (
        current.bytes !== member.bytes ||
        current.modifiedNs !== member.modifiedNs
      ) {
        throw new Error("File changed before scan write.");
      }
    }

    if (options.reconcileMissing === true) {
      await revalidateScope(
        library.rootPath,
        moviesMedium.scan,
        path,
        false,
        walked,
      );
    }

    if (!group) {
      await deleteEmptiedItems(tx, emptiedItemIds, deletedArtwork);
      if (options.reconcileMissing === true) {
        const [item] = await tx
          .select()
          .from(items)
          .where(
            and(
              eq(items.libraryId, libraryId),
              eq(items.canonicalFolder, path),
            ),
          );
        if (item) await deleteItemSubtree(tx, item.id, deletedArtwork);
      }
      return { itemId: null, versionIds: [] as string[] };
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
    const found = await findItemByProviderIds(tx, libraryId, mergedProviderIds);
    if (existingItem && found && existingItem.id !== found.id)
      throw new AuthError("CONFLICT");
    let itemId: string;
    if (existingItem) {
      if (existingItem.kind !== "movie") throw new AuthError("CONFLICT");
      itemId = existingItem.id;
    } else if (found) {
      if (found.kind !== "movie") throw new AuthError("CONFLICT");
      if (
        await scopeHasMedia(
          library.rootPath,
          moviesMedium.scan,
          found.canonicalFolder,
          false,
        )
      )
        throw new AuthError("CONFLICT");
      await updateItemCanonicalFolder(tx, found, group.canonicalFolder);
      itemId = found.id;
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
    if (options.reconcileMissing === true) {
      const itemFiles = await tx
        .select()
        .from(files)
        .where(eq(files.itemId, itemId));
      const present = new Set(group.paths);
      for (const file of itemFiles) {
        if (present.has(file.path)) continue;
        const [version] = await tx
          .select({ origin: versions.origin })
          .from(versions)
          .where(eq(versions.id, file.versionId));
        if (version?.origin === "imported") {
          await tx.delete(versions).where(eq(versions.id, file.versionId));
        }
      }
    }

    await deleteEmptiedItems(tx, emptiedItemIds, deletedArtwork);
    await setItemProviderIds(tx, itemId, mergedProviderIds);
    await persistScanTimelines(tx, itemId);
    return { itemId, versionIds };
  });
  await removeColocatedArtworkFiles(deletedArtwork);
  return { ...written, probed };
}

/** Scan one canonical Show folder into Show, Season and Episode Items with episode Versions. */
export async function scanShowDirectory(
  db: Database,
  libraryId: string,
  path: string,
  options: ScanDirectoryOptions = {},
): Promise<{ itemId: string | null; versionIds: string[]; probed: number }> {
  const probe = options.probe ?? probeVideo;
  const changes = options.changes ?? [];
  const [library] = await db
    .select()
    .from(libraries)
    .where(eq(libraries.id, libraryId));
  if (!library) throw new AuthError("NOT_FOUND");
  if (library.medium !== "shows") throw new AuthError("INVALID_INPUT");

  const walked: string[] = [];
  try {
    for await (const file of walkLibrary(library.rootPath, showsScan, {
      path,
    })) {
      walked.push(file.path);
    }
  } catch (error) {
    if (
      !(error instanceof MissingLibraryPathError) ||
      error.scope !== "requested"
    )
      throw error;
  }
  const group = groupShowPaths(walked).find(
    (candidate) => candidate.canonicalFolder === path,
  );

  const memberByPath = new Map<string, ProbedLibraryFile>();
  let probed = 0;
  for (const season of group?.seasons ?? []) {
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

  const mergedProviderIds: Record<string, string> = {};
  for (const change of changes) {
    Object.assign(mergedProviderIds, change.providerIds);
  }

  const deletedArtwork: DeletedArtworkFile[] = [];
  const written = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(libraries)
      .where(eq(libraries.id, libraryId))
      .for("update");
    if (!locked) throw new AuthError("NOT_FOUND");

    const emptiedItemIds = await applyScanChanges(
      tx,
      libraryId,
      changes,
      deletedArtwork,
    );

    for (const member of memberByPath.values()) {
      const current = await readLibraryFile(library.rootPath, member.path);
      if (
        current.bytes !== member.bytes ||
        current.modifiedNs !== member.modifiedNs
      ) {
        throw new Error("File changed before scan write.");
      }
    }

    if (options.reconcileMissing === true) {
      await revalidateScope(library.rootPath, showsScan, path, true, walked);
    }

    if (!group) {
      await deleteEmptiedItems(tx, emptiedItemIds, deletedArtwork);
      if (options.reconcileMissing === true) {
        const [show] = await tx
          .select()
          .from(items)
          .where(
            and(
              eq(items.libraryId, libraryId),
              eq(items.canonicalFolder, path),
              eq(items.kind, "show"),
            ),
          );
        if (show) await deleteItemSubtree(tx, show.id, deletedArtwork);
      }
      return { itemId: null, versionIds: [] as string[] };
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
    const found = await findItemByProviderIds(tx, libraryId, mergedProviderIds);
    if (existingShow && found && existingShow.id !== found.id)
      throw new AuthError("CONFLICT");
    let showId: string;
    if (existingShow) {
      if (existingShow.kind !== "show") throw new AuthError("CONFLICT");
      showId = existingShow.id;
    } else if (found) {
      if (found.kind !== "show") throw new AuthError("CONFLICT");
      if (
        await scopeHasMedia(
          library.rootPath,
          showsScan,
          found.canonicalFolder,
          true,
        )
      )
        throw new AuthError("CONFLICT");
      await updateItemCanonicalFolder(tx, found, group.canonicalFolder);
      showId = found.id;
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
    const processedEpisodeIds = new Set<string>();
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
        await updateItemCanonicalFolder(
          tx,
          existingSeason.item,
          seasonGroup.canonicalFolder,
        );
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
          await updateItemCanonicalFolder(
            tx,
            existingEpisode.item,
            seasonGroup.canonicalFolder,
          );
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
          const blocksWidening =
            persistedEpisodes.some(
              (candidate) =>
                candidate.itemId !== episodeId &&
                candidate.episodeNumber > existingEnd &&
                candidate.episodeNumber <= discoveredEnd,
            ) ||
            seasonGroup.episodes.some(
              (candidate) =>
                candidate.episodeNumber !== episodeGroup.episodeNumber &&
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
          processedEpisodeIds.add(episodeId);
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
          const combinedKeyframes = combineKeyframes(members);
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
                file.itemId !== existingFile.itemId ||
                file.versionId !== existingFile.versionId
              ) {
                throw new AuthError("CONFLICT");
              }
            }
            if (existingFile.itemId !== episodeId) {
              const allVersionFiles = await tx
                .select({ id: files.id })
                .from(files)
                .where(eq(files.versionId, existingFile.versionId));
              const allVersionFileIds = allVersionFiles.map((file) => file.id);
              const destinationFileIds = new Set(
                existingFiles.map((file) => file.id),
              );
              if (
                allVersionFileIds.length !== destinationFileIds.size ||
                allVersionFileIds.some(
                  (fileId) => !destinationFileIds.has(fileId),
                )
              ) {
                throw new AuthError("CONFLICT");
              }
              // Stored Versions derived from the moved Files retire with the
              // source Item; keep their colocated artwork for byte cleanup.
              const dependentStoredVersions =
                allVersionFileIds.length === 0
                  ? []
                  : await tx
                      .select({ id: versions.id })
                      .from(versions)
                      .where(
                        and(
                          eq(versions.origin, "stored"),
                          inArray(versions.sourceFileId, allVersionFileIds),
                        ),
                      );
              if (dependentStoredVersions.length > 0) {
                const storedIds = dependentStoredVersions.map(
                  (version) => version.id,
                );
                const orphanedArtwork = await tx
                  .select({
                    rootPath: libraries.rootPath,
                    storageKey: artwork.storageKey,
                  })
                  .from(artwork)
                  .innerJoin(versions, eq(artwork.versionId, versions.id))
                  .innerJoin(libraries, eq(versions.libraryId, libraries.id))
                  .where(
                    and(
                      eq(artwork.backend, "colocated"),
                      inArray(artwork.versionId, storedIds),
                    ),
                  );
                deletedArtwork.push(...orphanedArtwork);
                await tx
                  .delete(versions)
                  .where(inArray(versions.id, storedIds));
              }
              // Same-user Progress: the freshest persisted playback state wins.
              const sourceProgress = await tx
                .select()
                .from(progress)
                .where(eq(progress.versionId, existingFile.versionId));
              for (const sourceRow of sourceProgress) {
                const [destinationRow] = await tx
                  .select()
                  .from(progress)
                  .where(
                    and(
                      eq(progress.userId, sourceRow.userId),
                      eq(progress.itemId, episodeId),
                    ),
                  )
                  .limit(1);
                if (destinationRow === undefined) continue;
                const sourceIsFresher =
                  sourceRow.updatedAt.getTime() >
                    destinationRow.updatedAt.getTime() ||
                  (sourceRow.updatedAt.getTime() ===
                    destinationRow.updatedAt.getTime() &&
                    sourceRow.id > destinationRow.id);
                await tx
                  .delete(progress)
                  .where(
                    eq(
                      progress.id,
                      sourceIsFresher ? destinationRow.id : sourceRow.id,
                    ),
                  );
              }
              const sourceEpisodeId = existingFile.itemId;
              // files.(version_id, item_id), progress.(version_id, item_id,
              // format) and session_registry.(version_id, item_id) reference
              // versions.(id, item_id) non-deferrably, so all four tables must
              // move in one statement. The source Episode's segment timeline
              // cannot follow, so the Version re-establishes one under the
              // destination Episode in persistScanTimelines.
              await tx.execute(sql`
                with moved_files as (
                  update ${files} set item_id = ${episodeId}
                  where version_id = ${existingFile.versionId}
                ), moved_progress as (
                  update ${progress} set item_id = ${episodeId}
                  where version_id = ${existingFile.versionId}
                ), moved_sessions as (
                  update ${sessionRegistry} set item_id = ${episodeId}
                  where version_id = ${existingFile.versionId}
                )
                update ${versions}
                set item_id = ${episodeId},
                  segment_timeline_id = null,
                  timeline_aligned = false
                where id = ${existingFile.versionId}
              `);
              emptiedItemIds.push(sourceEpisodeId);
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
              .set({
                label,
                bytes,
                durationSeconds,
                keyframesSeconds: combinedKeyframes,
                lazyIndexPending: combinedKeyframes === null,
              })
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
                keyframesSeconds: combinedKeyframes,
                lazyIndexPending: combinedKeyframes === null,
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

    await deleteEmptiedItems(tx, emptiedItemIds, deletedArtwork);

    if (options.reconcileMissing === true) {
      const showFiles = await tx
        .select({
          id: files.id,
          versionId: files.versionId,
          path: files.path,
        })
        .from(files)
        .innerJoin(
          itemAncestors,
          and(
            eq(itemAncestors.descendantId, files.itemId),
            eq(itemAncestors.ancestorId, showId),
          ),
        );
      const stale = showFiles.filter((file) => !memberByPath.has(file.path));
      const staleFileIds = stale.map((file) => file.id);
      if (staleFileIds.length > 0) {
        await tx.delete(files).where(inArray(files.id, staleFileIds));
      }
      const affectedVersionIds = [
        ...new Set(stale.map((file) => file.versionId)),
      ];
      for (const versionId of affectedVersionIds) {
        const [version] = await tx
          .select({ origin: versions.origin })
          .from(versions)
          .where(eq(versions.id, versionId));
        if (version?.origin !== "imported") continue;
        const [remaining] = await tx
          .select({ id: files.id })
          .from(files)
          .where(eq(files.versionId, versionId))
          .limit(1);
        if (remaining === undefined) {
          await tx.delete(versions).where(eq(versions.id, versionId));
        }
      }
      const descendants = await tx
        .select({ id: items.id, kind: items.kind })
        .from(items)
        .innerJoin(
          itemAncestors,
          and(
            eq(itemAncestors.descendantId, items.id),
            eq(itemAncestors.ancestorId, showId),
          ),
        );
      for (const item of descendants) {
        if (item.kind !== "episode") continue;
        const [version] = await tx
          .select({ id: versions.id })
          .from(versions)
          .where(eq(versions.itemId, item.id))
          .limit(1);
        if (version === undefined)
          await deleteItemSubtree(tx, item.id, deletedArtwork);
      }
      for (const item of descendants) {
        if (item.kind !== "season") continue;
        const [child] = await tx
          .select({ id: items.id })
          .from(items)
          .where(eq(items.parentId, item.id))
          .limit(1);
        if (child === undefined)
          await deleteItemSubtree(tx, item.id, deletedArtwork);
      }
    }

    await setItemProviderIds(tx, showId, mergedProviderIds);
    for (const episodeId of processedEpisodeIds) {
      await persistScanTimelines(tx, episodeId);
    }
    return { itemId: showId, versionIds };
  });
  await removeColocatedArtworkFiles(deletedArtwork);
  return { ...written, probed };
}
