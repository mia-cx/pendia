import { posix } from "node:path";
import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { AuthError } from "../auth/errors.ts";
import type { Database } from "../db/client.ts";
import {
  episodes,
  files,
  itemAncestors,
  items,
  libraries,
  libraryRoots,
  type ScanChange,
  seasons,
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
import {
  groupShowPaths,
  mergeEpisodeRanges,
  type ShowPathGroup,
  showsScan,
} from "../mediums/shows.ts";
import { videoVersionLabel } from "../mediums/video-common/labels.ts";
import { type ProbeResult, probeVideo } from "../mediums/video-common/probe.ts";
import { removeArtworkFiles } from "../metadata/artwork-store.ts";
import {
  applyScanChanges,
  findItemByProviderIds,
  setItemProviderIds,
  updateItemCanonicalFolder,
} from "./changes.ts";
import { type ProbedLibraryFile, probeLibraryFile } from "./probe-cache.ts";
import {
  type LibraryRoot,
  type RootedPath,
  rootedKey,
} from "./roots.ts";
import { persistScanTimelines } from "./timelines.ts";
import {
  type LibraryFile,
  MissingLibraryPathError,
  readLibraryFile,
  walkLibrary,
} from "./walker.ts";

/** A walked file in one root. */
export type RootedFile = LibraryFile & { rootId: string };

/** A probed file in one root. */
export type ProbedRootedFile = ProbedLibraryFile & { rootId: string };

/** Where a scan reads its files: the local disk, or a watcher's report. */
export type ScanSource = {
  /** The Library's roots revision when this source read its roots; a write under a newer revision is refused. */
  rootsRevision: number;
  /** Lists accepted media files under a root-relative scope in every root; a missing scope lists none. */
  walk(path: string, recursive: boolean): Promise<RootedFile[]>;
  /** Returns one walked file with its probe result. */
  probe(file: RootedPath): Promise<ProbedRootedFile>;
  /** Fails when a probed file changed before the write. Runs under the write lock. */
  verify(file: ProbedRootedFile): Promise<void>;
  /** Fails when an empty scope gained files in any root before the write. Runs under the write lock. */
  confirmEmpty(path: string, recursive: boolean): Promise<void>;
  /** Fails when a file the walk missed exists again before the write. Runs under the write lock. */
  confirmMissing(files: readonly RootedPath[]): Promise<void>;
  /** Whether a stored File outside the scope still exists. */
  exists(file: RootedPath): Promise<boolean>;
};

/** Optional collaborators and queued changes for one directory scan. */
export type ScanDirectoryOptions = {
  probe?: typeof probeVideo;
  source?: ScanSource;
  changes?: readonly ScanChange[];
  reconcileMissing?: boolean;
};

/** The scan rules and walk depth for one library-relative scope of a medium. */
export function scanScope(
  medium: (typeof libraries.$inferSelect)["medium"],
  path: string,
) {
  return {
    rules: medium === "movies" ? moviesMedium.scan : showsScan,
    recursive: path === "." || medium === "shows",
  };
}

/** Whether a walk of this library-relative scope would reach the path. */
export const inScope = (scope: string, recursive: boolean, path: string) =>
  recursive
    ? scope === "." || path.startsWith(`${scope}/`)
    : posix.dirname(path) === scope;

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Splits each grouped Version of a Show into one Version per root holding
 * its paths: a Version's Files all sit in one root. Roots keep walk order.
 */
function splitVersionsByRoot(
  group: ShowPathGroup | undefined,
  walked: readonly RootedFile[],
) {
  if (group === undefined) return undefined;
  const rootIds = [...new Set(walked.map((file) => file.rootId))];
  const held = new Set(walked.map(rootedKey));
  return {
    ...group,
    seasons: group.seasons.map((season) => ({
      ...season,
      episodes: season.episodes.map((episode) => ({
        ...episode,
        versions: episode.versions.flatMap((version) =>
          rootIds.flatMap((rootId) => {
            const paths = version.paths.filter((path) =>
              held.has(rootedKey({ rootId, path })),
            );
            return paths.length === 0 ? [] : [{ rootId, paths }];
          }),
        ),
      })),
    })),
  };
}

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

/** Re-walks the requested scope inside the write lock before an empty result deletes rows. */
async function confirmScopeEmpty(
  rootPath: string,
  rules: ScanRules,
  path: string,
  recursive: boolean,
): Promise<void> {
  try {
    for await (const file of walkLibrary(rootPath, rules, {
      path,
      recursive,
    })) {
      if (file.path !== "") {
        throw new Error("Library directory changed before scan write.");
      }
    }
  } catch (error) {
    if (
      error instanceof MissingLibraryPathError &&
      error.scope === "requested"
    ) {
      return;
    }
    throw error;
  }
}

/** Reads a Library's roots on the local disk through the walker and the persistent probe cache. */
export function localScanSource(
  db: Database,
  roots: readonly LibraryRoot[],
  rootsRevision: number,
  medium: (typeof libraries.$inferSelect)["medium"],
  probe: typeof probeVideo = probeVideo,
): ScanSource {
  const { rules } = scanScope(medium, ".");
  const rootOf = (rootId: string) => {
    const root = roots.find((candidate) => candidate.id === rootId);
    if (root === undefined) throw new Error(`Unknown library root ${rootId}.`);
    return root;
  };
  const exists = async (file: RootedPath) => {
    try {
      await readLibraryFile(rootOf(file.rootId).path, file.path);
      return true;
    } catch (error) {
      if (error instanceof MissingLibraryPathError) return false;
      throw error;
    }
  };
  return {
    rootsRevision,
    async walk(path, recursive) {
      const walked: RootedFile[] = [];
      for (const root of roots) {
        try {
          for await (const file of walkLibrary(root.path, rules, {
            path,
            recursive,
          }))
            walked.push({ ...file, rootId: root.id });
        } catch (error) {
          if (
            !(error instanceof MissingLibraryPathError) ||
            error.scope !== "requested"
          )
            throw error;
        }
      }
      return walked;
    },
    probe: async (file) => ({
      ...(await probeLibraryFile(db, rootOf(file.rootId), file.path, probe)),
      rootId: file.rootId,
    }),
    async verify(file) {
      const current = await readLibraryFile(
        rootOf(file.rootId).path,
        file.path,
      );
      if (
        current.bytes !== file.bytes ||
        current.modifiedNs !== file.modifiedNs
      )
        throw new Error("File changed before scan write.");
    },
    async confirmEmpty(path, recursive) {
      for (const root of roots)
        await confirmScopeEmpty(root.path, rules, path, recursive);
    },
    async confirmMissing(missing) {
      for (const file of missing)
        if (await exists(file))
          throw new Error("Library directory changed before scan write.");
    },
    exists,
  };
}

/**
 * Reads a Library's own roots on the local disk. The roots and their
 * revision come from one statement, so a scan never pairs old roots with
 * the revision a root edit already bumped.
 */
export async function libraryScanSource(
  db: Database,
  library: Pick<typeof libraries.$inferSelect, "id" | "medium">,
  probe: typeof probeVideo = probeVideo,
) {
  const rows = await db
    .select({
      id: libraryRoots.id,
      path: libraryRoots.path,
      rootsRevision: libraries.rootsRevision,
    })
    .from(libraries)
    .innerJoin(libraryRoots, eq(libraryRoots.libraryId, libraries.id))
    .where(eq(libraries.id, library.id))
    .orderBy(asc(libraryRoots.position), asc(libraryRoots.id));
  return localScanSource(
    db,
    rows.map(({ id, path }) => ({ id, path })),
    rows[0]?.rootsRevision ?? 0,
    library.medium,
    probe,
  );
}

/**
 * Finds the Show whose live Files all sit at these paths: a queued folder
 * move re-paths Files before the scan finds their Show. A Show with a
 * File still on disk elsewhere only lost some of them, so it stays put.
 * Rows of Files already gone from disk do not count.
 */
async function findShowOwningFiles(
  tx: Transaction,
  libraryId: string,
  paths: readonly string[],
  source: ScanSource,
) {
  if (paths.length === 0) return undefined;
  const [owner] = await tx
    .select({ item: items })
    .from(files)
    .innerJoin(itemAncestors, eq(itemAncestors.descendantId, files.itemId))
    .innerJoin(
      items,
      and(eq(items.id, itemAncestors.ancestorId), eq(items.kind, "show")),
    )
    .where(and(eq(files.libraryId, libraryId), inArray(files.path, [...paths])))
    .limit(1);
  if (owner === undefined) return undefined;
  const elsewhere = await tx
    .select({ rootId: files.rootId, path: files.path })
    .from(files)
    .innerJoin(itemAncestors, eq(itemAncestors.descendantId, files.itemId))
    .where(
      and(
        eq(itemAncestors.ancestorId, owner.item.id),
        notInArray(files.path, [...paths]),
      ),
    );
  for (const file of elsewhere) if (await source.exists(file)) return undefined;
  return owner.item;
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
    if (version === undefined)
      await deleteItemSubtree(tx, item.id, deletedArtwork);
  }
}

/** Deletes leaf Items left without Versions, then the Seasons and Shows above them left without children. */
export async function pruneEmptiedItems(
  tx: Transaction,
  itemIds: readonly string[],
  deletedArtwork: DeletedArtworkFile[],
) {
  if (itemIds.length === 0) return;
  const ancestors = await tx
    .selectDistinct({
      id: itemAncestors.ancestorId,
      depth: itemAncestors.depth,
    })
    .from(itemAncestors)
    .where(
      and(
        inArray(itemAncestors.descendantId, [...itemIds]),
        sql`${itemAncestors.depth} > 0`,
      ),
    );
  await deleteEmptiedItems(tx, itemIds, deletedArtwork);
  // Nearest first, so a Season goes before the Show it empties.
  for (const ancestor of ancestors.sort((a, b) => a.depth - b.depth)) {
    const [child] = await tx
      .select({ id: items.id })
      .from(items)
      .where(eq(items.parentId, ancestor.id))
      .limit(1);
    const [exists] = await tx
      .select({ id: items.id })
      .from(items)
      .where(eq(items.id, ancestor.id));
    if (child === undefined && exists !== undefined)
      await deleteItemSubtree(tx, ancestor.id, deletedArtwork);
  }
}

/** Scan one canonical directory of a movies library into Items, Versions, Files and Streams. */
export async function scanDirectory(
  db: Database,
  libraryId: string,
  path: string,
  options: ScanDirectoryOptions = {},
): Promise<{ itemId: string | null; versionIds: string[]; probed: number }> {
  const changes = options.changes ?? [];
  const [library] = await db
    .select()
    .from(libraries)
    .where(eq(libraries.id, libraryId));
  if (!library) throw new AuthError("NOT_FOUND");
  if (library.medium !== "movies") throw new AuthError("INVALID_INPUT");
  const source =
    options.source ?? (await libraryScanSource(db, library, options.probe));

  // Grouping reads root-relative paths, so the same folder in two roots is
  // one Item; each root's file at a member path is its own Version.
  const walked = await source.walk(path, false);
  const [group] = groupMoviePaths(walked.map((file) => file.path));

  const members: ProbedRootedFile[] = [];
  let probed = 0;
  for (const memberPath of group?.paths ?? []) {
    for (const file of walked.filter((file) => file.path === memberPath)) {
      const member = await source.probe(file);
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

  // Only webhook ids may find an Item elsewhere in the Library. Folder tags
  // are stored but never relocate: two folders can carry the same tag.
  const changeProviderIds: Record<string, string> = {};
  for (const change of changes) {
    Object.assign(changeProviderIds, change.providerIds);
  }

  // Artwork of deleted Items is removed only after the delete commits.
  const deletedArtwork: DeletedArtworkFile[] = [];
  const written = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(libraries)
      .where(eq(libraries.id, libraryId))
      .for("update");
    if (!locked) throw new AuthError("NOT_FOUND");
    // A root edit between the walk and this lock made the snapshot stale.
    if (locked.rootsRevision !== source.rootsRevision)
      throw new Error("Library roots changed before scan write.");

    const emptiedItemIds = await applyScanChanges(
      tx,
      libraryId,
      changes,
      deletedArtwork,
    );

    for (const member of members) await source.verify(member);

    if (!group) {
      await deleteEmptiedItems(tx, emptiedItemIds, deletedArtwork);
      if (options.reconcileMissing === true) {
        await source.confirmEmpty(path, false);
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
    const found = await findItemByProviderIds(tx, libraryId, changeProviderIds);
    if (existingItem && found && existingItem.id !== found.id)
      throw new AuthError("CONFLICT");
    let itemId: string;
    if (existingItem) {
      if (existingItem.kind !== "movie") throw new AuthError("CONFLICT");
      itemId = existingItem.id;
    } else if (found) {
      if (found.kind !== "movie") throw new AuthError("CONFLICT");
      // Colocated artwork keys carry the folder, so they move with it.
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
          and(eq(files.rootId, member.rootId), eq(files.path, member.path)),
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
            rootId: member.rootId,
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
        .select({
          versionId: files.versionId,
          rootId: files.rootId,
          path: files.path,
        })
        .from(files)
        .innerJoin(
          versions,
          and(
            eq(versions.id, files.versionId),
            eq(versions.origin, "imported"),
          ),
        )
        .where(eq(files.itemId, itemId));
      // A File is missing only when its own root lacks it.
      const present = new Set(members.map(rootedKey));
      const missing = itemFiles.filter((file) => !present.has(rootedKey(file)));
      // Only a path inside the scope can have come back since the walk.
      await source.confirmMissing(
        missing.filter((file) => inScope(path, false, file.path)),
      );
      if (missing.length > 0)
        await tx.delete(versions).where(
          inArray(
            versions.id,
            missing.map((file) => file.versionId),
          ),
        );
    }

    await deleteEmptiedItems(tx, emptiedItemIds, deletedArtwork);
    // A changed provider id invalidates the match, so metadata re-fetches.
    // Webhook ids assert; folder tags only fill ids nothing asserted yet.
    const assertedChanged = await setItemProviderIds(
      tx,
      itemId,
      changeProviderIds,
    );
    const filledChanged = await setItemProviderIds(
      tx,
      itemId,
      group.providerIds,
      { fillOnly: true },
    );
    if (assertedChanged || filledChanged) {
      await tx
        .update(items)
        .set({ metadataState: "pending", updatedAt: new Date() })
        .where(eq(items.id, itemId));
    }
    await persistScanTimelines(tx, itemId);
    return { itemId, versionIds };
  });
  await removeArtworkFiles(deletedArtwork);
  return { ...written, probed };
}

/** Scan one canonical Show folder into Show, Season and Episode Items with episode Versions. */
export async function scanShowDirectory(
  db: Database,
  libraryId: string,
  path: string,
  options: ScanDirectoryOptions = {},
): Promise<{ itemId: string | null; versionIds: string[]; probed: number }> {
  const changes = options.changes ?? [];
  const [library] = await db
    .select()
    .from(libraries)
    .where(eq(libraries.id, libraryId));
  if (!library) throw new AuthError("NOT_FOUND");
  if (library.medium !== "shows") throw new AuthError("INVALID_INPUT");
  const source =
    options.source ?? (await libraryScanSource(db, library, options.probe));

  const walked = await source.walk(path, true);
  const group = splitVersionsByRoot(
    groupShowPaths(walked.map((file) => file.path)).find(
      (candidate) => candidate.canonicalFolder === path,
    ),
    walked,
  );

  const memberByKey = new Map<string, ProbedRootedFile>();
  let probed = 0;
  for (const season of group?.seasons ?? []) {
    for (const episode of season.episodes) {
      for (const version of episode.versions) {
        for (const memberPath of version.paths) {
          const file = { rootId: version.rootId, path: memberPath };
          if (memberByKey.has(rootedKey(file))) continue;
          const member = await source.probe(file);
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
          memberByKey.set(rootedKey(file), member);
        }
      }
    }
  }

  const mergedProviderIds: Record<string, string> = {};
  for (const change of changes) {
    Object.assign(mergedProviderIds, change.providerIds);
  }

  // Artwork of deleted Items is removed only after the delete commits.
  const deletedArtwork: DeletedArtworkFile[] = [];
  const written = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(libraries)
      .where(eq(libraries.id, libraryId))
      .for("update");
    if (!locked) throw new AuthError("NOT_FOUND");
    // A root edit between the walk and this lock made the snapshot stale.
    if (locked.rootsRevision !== source.rootsRevision)
      throw new Error("Library roots changed before scan write.");

    const emptiedItemIds = await applyScanChanges(
      tx,
      libraryId,
      changes,
      deletedArtwork,
    );

    for (const member of memberByKey.values()) await source.verify(member);

    if (!group) {
      await deleteEmptiedItems(tx, emptiedItemIds, deletedArtwork);
      if (options.reconcileMissing === true) {
        await source.confirmEmpty(path, true);
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
    const found =
      (await findItemByProviderIds(tx, libraryId, mergedProviderIds)) ??
      (existingShow
        ? undefined
        : await findShowOwningFiles(
            tx,
            libraryId,
            [...memberByKey.values()].map((member) => member.path),
            source,
          ));
    if (existingShow && found && existingShow.id !== found.id)
      throw new AuthError("CONFLICT");
    let showId: string;
    if (existingShow) {
      if (existingShow.kind !== "show") throw new AuthError("CONFLICT");
      showId = existingShow.id;
    } else if (found) {
      if (found.kind !== "show") throw new AuthError("CONFLICT");
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
        if (
          existingSeason.item.canonicalFolder !== seasonGroup.canonicalFolder
        ) {
          await tx
            .update(items)
            .set({
              canonicalFolder: seasonGroup.canonicalFolder,
              updatedAt: new Date(),
            })
            .where(eq(items.id, seasonId));
        }
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

      const owners = await tx
        .select({ path: files.path, episodeNumber: episodes.episodeNumber })
        .from(files)
        .innerJoin(episodes, eq(episodes.itemId, files.itemId))
        .where(
          and(
            eq(episodes.seasonId, seasonId),
            inArray(
              files.path,
              seasonGroup.episodes.flatMap((episode) =>
                episode.versions.flatMap((version) => version.paths),
              ),
            ),
          ),
        );
      const seasonEpisodes = mergeEpisodeRanges(
        seasonGroup.episodes,
        persistedEpisodes.map((persisted) => persisted.episodeNumber),
        new Map(owners.map((owner) => [owner.path, owner.episodeNumber])),
      );

      const discoveredStarts = seasonEpisodes.map(
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
      }

      for (const episodeGroup of seasonEpisodes) {
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
          if (
            existingEpisode.item.canonicalFolder !== seasonGroup.canonicalFolder
          ) {
            await tx
              .update(items)
              .set({
                canonicalFolder: seasonGroup.canonicalFolder,
                updatedAt: new Date(),
              })
              .where(eq(items.id, episodeId));
          }
          // Merged ranges stop before every later start, so widening is safe.
          const existingEnd =
            existingEpisode.episode.episodeEndNumber ??
            existingEpisode.episode.episodeNumber;
          const discoveredEnd =
            episodeGroup.episodeEndNumber ?? episodeGroup.episodeNumber;
          if (discoveredEnd > existingEnd) {
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
          const { rootId } = versionGroup;
          const members = versionGroup.paths.map((memberPath) => {
            const member = memberByKey.get(
              rootedKey({ rootId, path: memberPath }),
            );
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
          // Each split File has its own index, so only a lone File indexes the Version.
          const indexFor = (fileCount: number) => {
            const keyframesSeconds =
              fileCount === 1 ? first.probe.keyframesSeconds : null;
            return {
              keyframesSeconds,
              lazyIndexPending: keyframesSeconds === null,
            };
          };

          const existingFiles = await tx
            .select()
            .from(files)
            .where(
              and(
                eq(files.rootId, rootId),
                inArray(files.path, versionGroup.paths),
              ),
            );
          const existingFile = existingFiles[0];
          let versionId: string;
          let versionFiles: (RootedPath & { id: string; order: number })[] = [];
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
            versionId = version.id;
            versionFiles = await tx
              .select({
                id: files.id,
                rootId: files.rootId,
                path: files.path,
                order: files.order,
              })
              .from(files)
              .where(eq(files.versionId, versionId));
            // Reconciliation deletes only Files the walk missed; the rest stay.
            const retained = versionFiles.filter(
              (file) =>
                !versionGroup.paths.includes(file.path) &&
                (options.reconcileMissing !== true ||
                  memberByKey.has(rootedKey(file))),
            ).length;
            await tx
              .update(versions)
              .set({
                label,
                bytes,
                durationSeconds,
                ...indexFor(members.length + retained),
              })
              .where(eq(versions.id, versionId));
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
                ...indexFor(members.length),
              })
              .returning();
            if (!version) {
              throw new Error("Version insertion returned no row.");
            }
            versionId = version.id;
          }
          versionIds.push(versionId);

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
                  rootId,
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
          rootId: files.rootId,
          path: files.path,
        })
        .from(files)
        .innerJoin(
          versions,
          and(
            eq(versions.id, files.versionId),
            eq(versions.origin, "imported"),
          ),
        )
        .innerJoin(
          itemAncestors,
          and(
            eq(itemAncestors.descendantId, files.itemId),
            eq(itemAncestors.ancestorId, showId),
          ),
        );
      // A File is stale only when its own root lacks it.
      const stale = showFiles.filter(
        (file) => !memberByKey.has(rootedKey(file)),
      );
      // Only a path inside the scope can have come back since the walk.
      await source.confirmMissing(
        stale.filter((file) => inScope(path, true, file.path)),
      );
      const staleFileIds = stale.map((file) => file.id);
      if (staleFileIds.length > 0) {
        await tx.delete(files).where(inArray(files.id, staleFileIds));
      }
      const affectedVersionIds = [
        ...new Set(stale.map((file) => file.versionId)),
      ];
      for (const versionId of affectedVersionIds) {
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

    // A changed provider id invalidates the match, so metadata re-fetches.
    // Webhook ids assert; folder tags only fill ids nothing asserted yet.
    const assertedChanged = await setItemProviderIds(
      tx,
      showId,
      mergedProviderIds,
    );
    const filledChanged = await setItemProviderIds(
      tx,
      showId,
      group.providerIds,
      { fillOnly: true },
    );
    if (assertedChanged || filledChanged) {
      await tx
        .update(items)
        .set({ metadataState: "pending", updatedAt: new Date() })
        .where(eq(items.id, showId));
    }
    return { itemId: showId, versionIds };
  });
  await removeArtworkFiles(deletedArtwork);
  return { ...written, probed };
}
