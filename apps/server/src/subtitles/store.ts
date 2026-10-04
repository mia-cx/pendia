import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { AuthError } from "../auth/errors.ts";
import type { Database } from "../db/client.ts";
import { items } from "../db/schema/index.ts";
import { assetRoots } from "../libraries/roots.ts";

/** The formats a stored subtitle track may have. */
export const subtitleFormats = ["srt", "ass", "vtt"] as const;

/** One stored subtitle track of an Item. */
export type StoredSubtitle = {
  language: string;
  format: (typeof subtitleFormats)[number];
};

// ISO 639 with an optional region, as providers write them: en, pob, pt-br, zh-cn.
const languagePattern = /^[a-z]{2,3}(-[a-z0-9]{2,4})?$/;

/** Lowercases a provider's language code; resolves null for one that cannot name a file. */
export function readLanguage(language: string): string | null {
  const lower = language.trim().toLowerCase();
  return languagePattern.test(lower) ? lower : null;
}

/** Reads a track file name, `<language>.<format>`, or null when it is not one. */
export function readTrackName(name: string): StoredSubtitle | null {
  const dot = name.lastIndexOf(".");
  const language = readLanguage(name.slice(0, dot));
  const format = subtitleFormats.find((known) => known === name.slice(dot + 1));
  if (dot < 1 || language === null || format === undefined) return null;
  return { language, format };
}

/** The file name of a track: `<language>.<format>`. */
export function trackName(track: StoredSubtitle): string {
  return `${track.language}.${track.format}`;
}

/**
 * The subtitle folders an Item's tracks may sit in, home root first:
 * `.pendia/subtitles` in its canonical folder under each asset root.
 * Episodes share a Season folder, so each file starts with the Item id.
 */
export async function subtitleFolders(db: Database, itemId: string) {
  const [row] = await db
    .select({
      libraryId: items.libraryId,
      canonicalFolder: items.canonicalFolder,
    })
    .from(items)
    .where(eq(items.id, itemId));
  if (row === undefined) throw new AuthError("NOT_FOUND");
  return (await assetRoots(db, itemId)).map((root) => {
    const folder = join(root.path, row.canonicalFolder);
    return {
      libraryId: row.libraryId,
      itemFolder: folder,
      path: join(folder, ".pendia", "subtitles"),
      file: (track: StoredSubtitle) =>
        join(folder, ".pendia", "subtitles", `${itemId}.${trackName(track)}`),
    };
  });
}

/** Where an Item's tracks are written: the first of its asset roots' subtitle folders. */
export async function subtitleFolder(db: Database, itemId: string) {
  const [home] = await subtitleFolders(db, itemId);
  if (home === undefined) throw new AuthError("NOT_FOUND");
  return home;
}

/** Lists an Item's stored tracks by language across its asset roots; a missing folder means none. */
export async function listSubtitles(
  db: Database,
  itemId: string,
): Promise<StoredSubtitle[]> {
  const tracks = new Map<string, StoredSubtitle>();
  const prefix = `${itemId}.`;
  for (const folder of await subtitleFolders(db, itemId)) {
    let names: string[];
    try {
      names = await readdir(folder.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      const track = readTrackName(name.slice(prefix.length));
      if (track !== null) tracks.set(trackName(track), track);
    }
  }
  return [...tracks.values()].sort((a, b) =>
    a.language.localeCompare(b.language),
  );
}

/** Writes one track atomically. The Item folder must exist; only `.pendia/subtitles` is created. */
export async function writeSubtitle(
  db: Database,
  itemId: string,
  track: StoredSubtitle,
  text: string,
): Promise<void> {
  const folder = await subtitleFolder(db, itemId);
  if (!(await stat(folder.itemFolder)).isDirectory())
    throw new Error(`${folder.itemFolder} is not a folder.`);
  await mkdir(folder.path, { recursive: true });
  const target = folder.file(track);
  const staging = `${target}.${Bun.randomUUIDv7()}.tmp`;
  try {
    await Bun.write(staging, text);
    await rename(staging, target);
  } finally {
    await rm(staging, { force: true });
  }
}
