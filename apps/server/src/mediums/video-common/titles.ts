import { folderProviderIds, stripProviderTags } from "./provider-ids.ts";

/** Title and year of a folder or file name, provider tags removed. */
export interface ParsedTitle {
  title: string;
  year: number | null;
}

const yearInParens = /^(.*?)\s*\((\d{4})\)(?:\s.*)?$/;

/** Parses a `Title (Year)` name after removing provider id tags. */
export function parseTitle(name: string): ParsedTitle {
  const cleaned = stripProviderTags(name);
  const match = yearInParens.exec(cleaned);
  const rawTitle = (match?.[1] ?? cleaned).trim();
  const title = rawTitle.includes(" ")
    ? rawTitle
    : rawTitle.replace(/[._]/g, " ");
  return { title, year: match?.[2] ? Number(match[2]) : null };
}

// Dotted codec and audio forms split on the dot, so they are joined first.
const dottedCodecPattern =
  /(?<![a-z0-9])(ddp|dd|aac|eac|h|x|dts)(\d*)\.(\d{1,3})(?=$|[\s._-])/gi;

const releaseTokens = new Set([
  "4k",
  "8k",
  "uhd",
  "bluray",
  "blu-ray",
  "bdrip",
  "brrip",
  "bdremux",
  "remux",
  "web",
  "web-dl",
  "webdl",
  "webrip",
  "hdtv",
  "dvdrip",
  "dvd",
  "hdrip",
  "x264",
  "x265",
  "h264",
  "h265",
  "hevc",
  "avc",
  "xvid",
  "av1",
  "10bit",
  "8bit",
  "ac3",
  "eac3",
  "dts",
  "dts-hd",
  "truehd",
  "atmos",
  "flac",
  "opus",
  "hdr",
  "hdr10",
  "hdr10plus",
  "dv",
  "dovi",
  "sdr",
  "proper",
  "repack",
  "extended",
  "unrated",
  "remastered",
  "imax",
  "internal",
  "limited",
  "hybrid",
  "multi",
]);

const releaseTokenPatterns = [/^\d{3,4}p$/, /^aac\d*$/, /^dd\d*$/, /^ddp\d*$/];

/** Whether one token starts a release's quality and group tail. */
function isReleaseToken(token: string): boolean {
  const first = token.split("-")[0]?.toLowerCase() ?? "";
  return (
    releaseTokens.has(first) ||
    releaseTokenPatterns.some((pattern) => pattern.test(first))
  );
}

const yearToken = /^(?:19|20)\d{2}$/;
const bracketGroups = /\{[^}]*\}|\[[^\]]*\]/g;

/**
 * Parses title and year out of a release-style stem: a scene name, a
 * `Title (Year)` name or a plain title. Everything from the first release
 * token on is the quality tail, not the title.
 */
export function parseRelease(stem: string): ParsedTitle {
  const cleaned = stripProviderTags(stem).replace(bracketGroups, " ").trim();
  if (yearInParens.test(cleaned)) {
    return parseTitle(cleaned);
  }
  const joined = cleaned.replace(dottedCodecPattern, "$1$2$3");
  const tokens = joined.split(/[\s._]+/).filter((token) => token !== "-");
  const cut = tokens.findIndex(isReleaseToken);
  const head = cut === -1 ? tokens : tokens.slice(0, cut);
  let year: number | null = null;
  let end = head.length;
  for (const [index, token] of head.entries()) {
    if (index > 0 && yearToken.test(token)) {
      year = Number(token);
      end = index;
    }
  }
  return {
    title: head
      .slice(0, end)
      .join(" ")
      .replace(/[-\s]+$/, ""),
    year,
  };
}

/** Normalizes a title for comparison: accents removed, case and spacing folded. */
export function normalizeTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** The normalized identity key of a title, with its year when it has one. */
export function titleKey(title: string, year: number | null): string {
  const normalized = normalizeTitle(title);
  return year === null ? normalized : `${normalized} (${year})`;
}

/** Whether two titles name the same work, allowing a year or edition suffix. */
export function sameTitle(a: string, b: string): boolean {
  const first = normalizeTitle(a);
  const second = normalizeTitle(b);
  return (
    first === second ||
    first.startsWith(`${second} `) ||
    second.startsWith(`${first} `)
  );
}

/** Whether a folder name pins one title: it carries a readable year or a provider tag. */
export function namesOneTitle(name: string): boolean {
  return (
    parseTitle(name).year !== null ||
    Object.keys(folderProviderIds(name)).length > 0
  );
}
