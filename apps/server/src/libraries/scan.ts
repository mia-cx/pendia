import { and, eq, notInArray, sql } from "drizzle-orm";
import { AuthError } from "../auth/errors.ts";
import type { Database } from "../db/client.ts";
import {
  files,
  items,
  libraries,
  type ScanChange,
  streams,
  versions,
} from "../db/schema/index.ts";
import { deleteItemSubtree, insertItem } from "../db/tree.ts";
import { groupMoviePaths, moviesMedium } from "../mediums/movies.ts";
import { videoVersionLabel } from "../mediums/video-common/labels.ts";
import { probeVideo } from "../mediums/video-common/probe.ts";
import {
  applyScanChanges,
  findItemByProviderIds,
  setItemProviderIds,
} from "./changes.ts";
import { type ProbedLibraryFile, probeLibraryFile } from "./probe-cache.ts";
import {
  MissingLibraryPathError,
  readLibraryFile,
  walkLibrary,
} from "./walker.ts";

/** Optional collaborators and queued changes for one directory scan. */
export type ScanDirectoryOptions = {
  probe?: typeof probeVideo;
  changes?: readonly ScanChange[];
};

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
    if (!(error instanceof MissingLibraryPathError)) throw error;
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

  const mergedProviderIds: Record<string, string> = {};
  for (const change of changes) {
    Object.assign(mergedProviderIds, change.providerIds);
  }

  const written = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(libraries)
      .where(eq(libraries.id, libraryId))
      .for("update");
    if (!locked) throw new AuthError("NOT_FOUND");

    await applyScanChanges(tx, libraryId, changes);

    for (const member of members) {
      const current = await readLibraryFile(library.rootPath, member.path);
      if (
        current.bytes !== member.bytes ||
        current.modifiedNs !== member.modifiedNs
      ) {
        throw new Error("File changed before scan write.");
      }
    }

    if (!group) {
      const [item] = await tx
        .select()
        .from(items)
        .where(
          and(eq(items.libraryId, libraryId), eq(items.canonicalFolder, path)),
        );
      if (item) await deleteItemSubtree(tx, item.id);
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
      await tx
        .update(items)
        .set({
          canonicalFolder: group.canonicalFolder,
          updatedAt: new Date(),
        })
        .where(eq(items.id, found.id));
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

      const indexes: number[] = [];
      for (const stream of member.probe.streams) {
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

    await setItemProviderIds(tx, itemId, mergedProviderIds);

    return { itemId, versionIds };
  });
  return { ...written, probed };
}
