import { posix } from "node:path";

const { basename, extname } = posix;

const extensions = new Set([
  ".mkv",
  ".mp4",
  ".m4v",
  ".avi",
  ".mov",
  ".webm",
  ".mpg",
  ".mpeg",
  ".ts",
  ".m2ts",
  ".mts",
  ".wmv",
]);

const extraNames = new Set([
  "extras",
  "trailers",
  "samples",
  "featurettes",
  "behind the scenes",
  "deleted scenes",
  "interviews",
  "scenes",
  "shorts",
]);

const normalizedName = (name: string) =>
  name.toLowerCase().replace(/[-_]+/g, " ");

/** Whether a library-relative path names a video file by extension. */
export function isVideoPath(path: string): boolean {
  return extensions.has(extname(path).toLowerCase());
}

/** Whether a path sits in an extras or Pendia store directory or is an extra file. */
export function isVideoExtra(path: string): boolean {
  const parts = path.split("/");
  if (parts.some((part) => part.toLowerCase().endsWith(".pendia"))) {
    return true;
  }
  if (parts.slice(0, -1).some((part) => extraNames.has(normalizedName(part)))) {
    return true;
  }
  const stem = basename(path, extname(path)).toLowerCase();
  return /(?:^|[ ._-])(?:trailers?|samples?|featurettes?|behind[ ._-]*the[ ._-]*scenes|deleted(?:[ ._-]*scenes?)?|interviews?|scenes?|shorts?)$/.test(
    stem,
  );
}

/** The `{edition-...}` tag on a filename, or null. */
export function editionTag(path: string): string | null {
  return (
    basename(path)
      .match(/\{edition-([^}]+)\}/i)?.[1]
      ?.trim() || null
  );
}
