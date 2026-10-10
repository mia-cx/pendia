import { rm } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { Schema } from "effect";
import { listVersionViews } from "../api/views.ts";
import { AuthError } from "../auth/errors.ts";
import { requirePermission } from "../auth/permissions.ts";
import type { Database } from "../db/client.ts";
import { items } from "../db/schema/index.ts";
import { firstInRoots } from "../libraries/roots.ts";
import { locateVersionFile } from "../playback/direct.ts";
import { toSubtitleStream } from "../playback/planning.ts";
import { PluginFailed } from "../plugins/runtime.ts";
import { readSubtitle, type SubtitleWindow } from "../transcoder/subtitles.ts";
import {
  type SubtitleProviderOptions,
  subtitleProviders,
} from "./providers.ts";
import {
  readLanguage,
  type StoredSubtitle,
  subtitleFolders,
  subtitleFormats,
  writeSubtitle,
} from "./store.ts";

/** Stored subtitle text is bounded like downloaded provider files. */
export const maxSubtitleBytes = 8 * 1024 * 1024;

async function visibleItem(db: Database, userId: string, itemId: string) {
  const [item] = await db.select().from(items).where(eq(items.id, itemId));
  if (item === undefined) throw new AuthError("NOT_FOUND");
  await requirePermission(db, userId, "view", item.libraryId);
  return item;
}

async function manageableItem(db: Database, userId: string, itemId: string) {
  const item = await visibleItem(db, userId, itemId);
  await requirePermission(db, userId, "manage-subtitles");
  return item;
}

/** Stores a full or flagged text track using the same asset roots as provider jobs. */
export async function uploadSubtitle(
  db: Database,
  userId: string,
  itemId: string,
  track: StoredSubtitle,
  bytes: Uint8Array,
) {
  await manageableItem(db, userId, itemId);
  const language = readLanguage(track.language);
  if (
    language === null ||
    !subtitleFormats.includes(track.format) ||
    bytes.length === 0 ||
    bytes.length > maxSubtitleBytes
  )
    throw new AuthError("INVALID_INPUT");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AuthError("INVALID_INPUT");
  }
  await writeSubtitle(db, itemId, { ...track, language }, text);
}

/** Deletes stored track copies across roots. Embedded tracks remain inside the original media file. */
export async function deleteSubtitle(
  db: Database,
  userId: string,
  itemId: string,
  index: number,
) {
  await manageableItem(db, userId, itemId);
  const [version] = await listVersionViews(db, userId, itemId);
  const track = version?.externalSubtitles.find(
    (track) => track.index === index,
  );
  if (track === undefined) return;
  for (const folder of await subtitleFolders(db, itemId))
    await rm(folder.file(track), { force: true });
}

/** Resolves an authorized embedded or stored subtitle to a file and its subtitle ordinal. */
export async function subtitleSource(
  db: Database,
  userId: string,
  itemId: string,
  versionId: string,
  index: number,
) {
  await visibleItem(db, userId, itemId);
  const versions = await listVersionViews(db, userId, itemId);
  const version =
    versionId === itemId
      ? versions[0]
      : versions.find((version) => version.id === versionId);
  if (version === undefined) throw new AuthError("NOT_FOUND");
  const external = version.externalSubtitles.find(
    (track) => track.index === index,
  );
  if (external !== undefined) {
    const found = await firstInRoots(
      await subtitleFolders(db, itemId),
      async (folder) => {
        const path = folder.file(external);
        return (await Bun.file(path).exists()) ? path : null;
      },
    );
    if (found === null) throw new AuthError("NOT_FOUND");
    return {
      path: found,
      ordinal: 0,
      durationSeconds: version.durationSeconds,
    };
  }
  const tracks = version.streams.filter((stream) => stream.kind === "subtitle");
  const ordinal = tracks.findIndex((stream) => stream.index === index);
  const stream = tracks[ordinal];
  if (stream === undefined || toSubtitleStream(stream).kind !== "text")
    throw new AuthError("NOT_FOUND");
  const { path } = await locateVersionFile(db, userId, itemId, version.id);
  if (path === undefined) throw new AuthError("NOT_FOUND");
  return { path, ordinal, durationSeconds: version.durationSeconds };
}

/** Converts an authorized text track, clipping or rebasing the requested time window. */
export async function readItemSubtitle(
  db: Database,
  userId: string,
  itemId: string,
  versionId: string,
  index: number,
  format: StoredSubtitle["format"],
  window: SubtitleWindow,
  signal?: AbortSignal,
) {
  const source = await subtitleSource(db, userId, itemId, versionId, index);
  return readSubtitle(source.path, source.ordinal, format, window, signal);
}

type SubtitleReference = {
  itemId: string;
  provider: string;
  providerId: string;
  language: string;
  forced: boolean;
};

/** Encodes a provider match as an opaque resource id, not an authorization credential. */
export function subtitleReference(reference: SubtitleReference) {
  return Buffer.from(JSON.stringify(reference)).toString("base64url");
}

function readReference(id: string): SubtitleReference {
  if (id.length > 8192 || !/^[\w-]+$/.test(id))
    throw new AuthError("INVALID_INPUT");
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(id, "base64url").toString());
  } catch {
    throw new AuthError("INVALID_INPUT");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new AuthError("INVALID_INPUT");
  const fields = value as Record<string, unknown>;
  if (
    !Schema.is(Schema.UUID)(fields.itemId) ||
    typeof fields.provider !== "string" ||
    !fields.provider ||
    typeof fields.providerId !== "string" ||
    !fields.providerId ||
    typeof fields.language !== "string" ||
    readLanguage(fields.language) === null ||
    typeof fields.forced !== "boolean"
  )
    throw new AuthError("INVALID_INPUT");
  return {
    itemId: fields.itemId,
    provider: fields.provider,
    providerId: fields.providerId,
    language: fields.language,
    forced: fields.forced,
  };
}

/** Searches configured providers for one authorized movie/episode and language. */
export async function searchSubtitleCandidates(
  db: Database,
  userId: string,
  itemId: string,
  requestedLanguage: string,
  options: SubtitleProviderOptions = {},
) {
  const item = await manageableItem(db, userId, itemId);
  const rawLanguage = readLanguage(requestedLanguage);
  if (rawLanguage === null) throw new AuthError("INVALID_INPUT");
  let language: string;
  try {
    // Clients use ISO 639-2 (eng/nld); providers commonly use en/nl.
    language = new Intl.Locale(rawLanguage).toString().toLowerCase();
  } catch {
    throw new AuthError("INVALID_INPUT");
  }
  if (item.kind !== "movie" && item.kind !== "episode") return [];
  const results = [];
  for (const provider of await subtitleProviders(db, options)) {
    try {
      for (const match of await provider.search({
        itemId,
        languages: [language],
      })) {
        if (readLanguage(match.language) !== language) continue;
        results.push({
          ...match,
          provider: provider.id,
          id: subtitleReference({
            itemId,
            provider: provider.id,
            providerId: match.providerId,
            language,
            forced: match.forced,
          }),
        });
      }
    } catch (error) {
      // PluginFailed is already recorded and disables that plugin; other providers still answer.
      if (!(error instanceof PluginFailed)) throw error;
    }
  }
  return results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/** Downloads a provider match after checking the referenced Item's management permissions. */
export async function downloadSubtitleCandidate(
  db: Database,
  userId: string,
  id: string,
  options: SubtitleProviderOptions = {},
  expectedItemId?: string,
) {
  const reference = readReference(id);
  if (expectedItemId !== undefined && reference.itemId !== expectedItemId)
    throw new AuthError("INVALID_INPUT");
  await manageableItem(db, userId, reference.itemId);
  const provider = (await subtitleProviders(db, options)).find(
    (provider) => provider.id === reference.provider,
  );
  if (provider === undefined) throw new AuthError("NOT_FOUND");
  const downloaded = await provider.download({
    providerId: reference.providerId,
  });
  if (
    !subtitleFormats.includes(downloaded.format) ||
    Buffer.byteLength(downloaded.text) > maxSubtitleBytes
  )
    throw new AuthError("INVALID_INPUT");
  return {
    ...downloaded,
    itemId: reference.itemId,
    language: reference.language,
    forced: reference.forced,
  };
}

/** Installs a downloaded provider track through the same validated upload boundary. */
export async function installSubtitleCandidate(
  db: Database,
  userId: string,
  itemId: string,
  id: string,
  options: SubtitleProviderOptions = {},
) {
  const downloaded = await downloadSubtitleCandidate(
    db,
    userId,
    id,
    options,
    itemId,
  );
  await uploadSubtitle(
    db,
    userId,
    itemId,
    downloaded,
    Buffer.from(downloaded.text),
  );
}
