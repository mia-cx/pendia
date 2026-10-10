import type { ApiOperation } from "./openapi.ts";

/** These tag groups need real core adapters. Each later stack layer removes its explicit gap group. */
export const gaps: Record<string, string> = {
  Subtitle: "Exercise real subtitle streams and management where supported.",
};

/** Library operations completed by the browse layer while administration and file adapters remain explicit gaps. */
export const coveredOperations = new Set([
  "RefreshItem",
  "DeleteItems",
  "DeleteItem",
  "GetLibraryOptionsInfo",
  "PostUpdatedMedia",
  "PostAddedMovies",
  "PostUpdatedMovies",
  "GetPhysicalPaths",
  "RefreshLibrary",
  "PostAddedSeries",
  "PostUpdatedSeries",
  "GetItems",
  "GetItem",
  "GetResumeItems",
  "GetAncestors",
  "GetItemCounts",
  "GetMediaFolders",
  "GetLatestMedia",
  "GetRootFolder",
  "GetSimilarItems",
  "GetSimilarMovies",
  "GetSimilarShows",
  "GetSimilarAlbums",
  "GetSimilarArtists",
  "GetSimilarTrailers",
  "GetItemCollections",
  "GetThemeMedia",
  "GetThemeSongs",
  "GetThemeVideos",
  "GetIntros",
  "GetLocalTrailers",
  "GetSpecialFeatures",
]);

/** A visible gap is never silently counted as neutral coverage. */
export function gapOf(operation: ApiOperation) {
  if (coveredOperations.has(operation.operationId)) return undefined;
  return operation.tags
    .map((tag) => gaps[tag])
    .find((reason) => reason !== undefined);
}
