import type { PendiaClient } from "./api.ts";

/** What the folder scan preview endpoint answers, as the client decodes it. */
export type FolderPreview = Awaited<
  ReturnType<PendiaClient["libraries"]["preview"]>
>;

type Medium = "movies" | "shows";

/** A path's breadcrumb entries, root first. `/` is the one root crumb. */
export function crumbs(path: string): { name: string; path: string }[] {
  const entries = [{ name: "/", path: "/" }];
  let current = "";
  for (const part of path.split("/")) {
    if (part === "") continue;
    current += `/${part}`;
    entries.push({ name: part, path: current });
  }
  return entries;
}

/** The folder one level up; `/` is its own parent. */
export function parentFolder(path: string): string {
  const parts = path.split("/").filter((part) => part !== "");
  parts.pop();
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

/** True when two folder paths are equal or one contains the other. */
export function overlapping(path: string, others: readonly string[]): boolean {
  const encloses = (outer: string, inner: string) =>
    outer === inner ||
    inner.startsWith(outer.endsWith("/") ? outer : `${outer}/`);
  return others.some((other) => encloses(path, other) || encloses(other, path));
}

const plural = (count: number, one: string) =>
  `${count} ${count === 1 ? one : `${one}s`}`;

const unrecognisedDetail = (count: number) =>
  count === 1
    ? "1 video wasn't recognised"
    : `${count} videos weren't recognised`;

const itemTitle = (title: string, year: number | null) =>
  year === null ? title : `${title} (${year})`;

/** What a scan preview reads as in the folder browser: a headline, an optional detail line and example rows. */
export function describePreview(
  preview: FolderPreview,
  medium: Medium,
): {
  headline: string;
  detail: string | null;
  examples: { title: string; caption: string | null }[];
} {
  const examples = preview.examples.map((example) =>
    example.kind === "movie"
      ? {
          title: itemTitle(example.title, example.year),
          caption: example.files > 1 ? plural(example.files, "version") : null,
        }
      : {
          title: itemTitle(example.title, example.year),
          caption: `${plural(example.seasons.length, "season")}, ${plural(example.episodes, "episode")}`,
        },
  );
  if (preview.reason === "missing")
    return {
      headline: "This folder doesn't exist",
      detail: null,
      examples,
    };
  if (preview.reason === "not-a-folder")
    return {
      headline: "This is a file, not a folder",
      detail: null,
      examples,
    };
  if (preview.reason === "empty")
    return {
      headline: "Nothing to scan here",
      detail: "This folder has no videos.",
      examples,
    };
  if (preview.reason === "unrecognised")
    return {
      headline:
        medium === "movies" ? "No movies recognised" : "No shows recognised",
      detail:
        medium === "movies"
          ? "Name each movie like Title (Year), in its own folder or on its own."
          : "Name episodes like Show/Season 01/Show S01E01.",
      examples,
    };

  const detailParts: string[] = [];
  if ("show" in preview.counts)
    detailParts.push(
      `${plural(preview.counts.season, "season")}, ${plural(preview.counts.episode, "episode")}`,
    );
  if (preview.unrecognised > 0)
    detailParts.push(unrecognisedDetail(preview.unrecognised));
  return {
    headline:
      "movie" in preview.counts
        ? plural(preview.counts.movie, "movie")
        : plural(preview.counts.show, "show"),
    detail: detailParts.length === 0 ? null : detailParts.join(" · "),
    examples,
  };
}
