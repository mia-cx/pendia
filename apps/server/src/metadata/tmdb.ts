import type { MetadataProvider } from "@pendia/plugin-api";
import { readBoundedBytes } from "./bounded-body.ts";

const baseUrl = "https://api.themoviedb.org/3";
const imageBaseUrl = "https://image.tmdb.org/t/p/original";

type SearchQuery = Parameters<MetadataProvider["search"]>[0];
type FetchQuery = Parameters<MetadataProvider["fetch"]>[0];
type MetadataMatch = Awaited<ReturnType<MetadataProvider["search"]>>[number];
type MetadataResult = NonNullable<
  Awaited<ReturnType<MetadataProvider["fetch"]>>
>;
type Credit = MetadataResult["credits"][number];
type Artwork = MetadataResult["artwork"][number];

function invalid(): never {
  throw new Error("Invalid TMDB response.");
}

function asObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalid();
  return value as Record<string, unknown>;
}

function requiredId(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0)
    invalid();
  return value;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) invalid();
  return value;
}

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") invalid();
  return value;
}

function releaseYear(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") invalid();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) invalid();
  const month = Number(match[2] ?? "");
  const day = Number(match[3] ?? "");
  if (month < 1 || month > 12 || day < 1 || day > 31) invalid();
  return Number(match[1]);
}

function normalizeTitle(title: string): string {
  return (
    title
      .normalize("NFKD")
      .toLowerCase()
      .replace(/\p{M}/gu, "")
      // Radarr's CleanTitle writes "&" as "and" and drops apostrophes.
      .replace(/&/g, " and ")
      .replace(/['’]/g, "")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()
  );
}

async function readJsonBody(
  response: Response,
  signal: AbortSignal,
  maxResponseBytes: number,
): Promise<unknown> {
  const declared = response.headers.get("content-length")?.trim() ?? "";
  if (/^\d+$/.test(declared) && Number(declared) > maxResponseBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error("TMDB response too large.");
  }
  if (response.body === null) invalid();
  let bytes: Uint8Array;
  try {
    bytes = await readBoundedBytes(
      response.body,
      maxResponseBytes,
      () => new Error("TMDB response too large."),
    );
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw error;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    if (signal.aborted) throw signal.reason;
    invalid();
  }
}

const notFoundStatus = 404;

/** Reads one TMDB JSON body; with `allowMissing`, a 404 resolves undefined, which no JSON body can produce. */
async function requestJson(
  request: typeof fetch,
  url: URL,
  timeoutMs: number,
  maxResponseBytes: number,
  allowMissing = false,
): Promise<unknown> {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await request(url, {
    headers: { accept: "application/json" },
    signal,
  });
  if (allowMissing && response.status === notFoundStatus) {
    await response.body?.cancel();
    return undefined;
  }
  if (!response.ok)
    throw new Error(`TMDB request failed with status ${response.status}.`);
  return readJsonBody(response, signal, maxResponseBytes);
}

function readGenres(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalid();
  // A Set keeps first-seen order and dedupes in linear time, however many
  // genres a response carries.
  const names = new Set<string>();
  for (const entry of value) {
    const genre = asObject(entry);
    names.add(requiredString(genre.name));
  }
  return [...names];
}

function readCredits(value: unknown): Credit[] {
  if (value === undefined) return [];
  const credits = asObject(value);
  const result: Credit[] = [];
  if (credits.cast !== undefined) {
    if (!Array.isArray(credits.cast)) invalid();
    for (const entry of credits.cast) {
      const cast = asObject(entry);
      const name = requiredString(cast.name);
      const order = cast.order;
      if (typeof order !== "number" || !Number.isInteger(order) || order < 0)
        invalid();
      const credit: Credit = { name, role: "actor", order };
      if (cast.character !== undefined && cast.character !== null) {
        if (typeof cast.character !== "string") invalid();
        const character = cast.character.trim();
        if (character.length > 0) credit.character = character;
      }
      result.push(credit);
    }
  }
  if (credits.crew !== undefined) {
    if (!Array.isArray(credits.crew)) invalid();
    const roleCounts = new Map<string, number>();
    for (const entry of credits.crew) {
      const crew = asObject(entry);
      const name = requiredString(crew.name);
      const role = requiredString(crew.job).trim().toLowerCase();
      const order = roleCounts.get(role) ?? 0;
      roleCounts.set(role, order + 1);
      result.push({ name, role, order });
    }
  }
  return result;
}

function readContentRating(value: unknown): string | null {
  if (value === undefined) return null;
  const releaseDates = asObject(value);
  if (releaseDates.results === undefined) return null;
  if (!Array.isArray(releaseDates.results)) invalid();
  for (const entry of releaseDates.results) {
    const row = asObject(entry);
    const country = row.iso_3166_1;
    if (
      country !== undefined &&
      country !== null &&
      typeof country !== "string"
    )
      invalid();
    if (country !== "US") continue;
    if (row.release_dates === undefined || row.release_dates === null)
      return null;
    if (!Array.isArray(row.release_dates)) invalid();
    for (const release of row.release_dates) {
      const info = asObject(release);
      const certification = info.certification;
      if (certification === undefined || certification === null) continue;
      if (typeof certification !== "string") invalid();
      const trimmed = certification.trim();
      if (trimmed.length > 0) return trimmed;
    }
    return null;
  }
  return null;
}

function readProviderIds(id: number, value: unknown): Record<string, string> {
  const providerIds: Record<string, string> = { tmdb: String(id) };
  if (value === undefined) return providerIds;
  const external = asObject(value);
  const imdb = external.imdb_id;
  if (imdb === undefined || imdb === null) return providerIds;
  if (typeof imdb !== "string") invalid();
  const trimmed = imdb.trim();
  if (trimmed.length > 0) providerIds.imdb = trimmed;
  return providerIds;
}

function readArtwork(
  posterPath: string | null,
  backdropPath: string | null,
  value: unknown,
): Artwork[] {
  const artwork: Artwork[] = [];
  const seen = new Set<string>();
  const add = (type: Artwork["type"], path: string) => {
    const url = `${imageBaseUrl}${path}`;
    const key = `${type}|${url}`;
    if (seen.has(key)) return;
    seen.add(key);
    artwork.push({ type, url });
  };
  if (posterPath !== null && posterPath.trim().length > 0)
    add("poster", posterPath);
  if (backdropPath !== null && backdropPath.trim().length > 0)
    add("backdrop", backdropPath);
  if (value === undefined) return artwork;
  const images = asObject(value);
  const groups = [
    ["posters", "poster"],
    ["backdrops", "backdrop"],
    ["logos", "logo"],
  ] as const;
  for (const [key, type] of groups) {
    const rows = images[key];
    if (rows === undefined) continue;
    if (!Array.isArray(rows)) invalid();
    for (const entry of rows) {
      const image = asObject(entry);
      const path = image.file_path;
      if (typeof path !== "string" || path.trim().length === 0) invalid();
      add(type, path);
    }
  }
  return artwork;
}

const imdbIdPattern = /^tt[0-9]+$/;

/** Resolves an IMDb id through /find; a single movie result is a certain match. */
async function findByImdb(
  request: typeof fetch,
  key: string,
  imdbId: string,
  timeoutMs: number,
  maxResponseBytes: number,
): Promise<MetadataMatch | undefined> {
  const url = new URL(`${baseUrl}/find/${imdbId}`);
  url.searchParams.set("api_key", key);
  url.searchParams.set("external_source", "imdb_id");
  const data = asObject(
    await requestJson(request, url, timeoutMs, maxResponseBytes),
  );
  if (!Array.isArray(data.movie_results)) invalid();
  if (data.movie_results.length !== 1) return undefined;
  const result = asObject(data.movie_results[0]);
  return {
    providerId: String(requiredId(result.id)),
    title: requiredString(result.title),
    year: releaseYear(result.release_date),
    confidence: 1,
  };
}

async function searchMovies(
  request: typeof fetch,
  key: string,
  query: SearchQuery,
  timeoutMs: number,
  maxResponseBytes: number,
): Promise<MetadataMatch[]> {
  if (query.kind !== "movie") throw new Error("TMDB only supports movies.");
  // An IMDb id from the folder or an arr pins the movie before any title guess.
  const imdbId = query.providerIds?.imdb;
  if (imdbId !== undefined && imdbIdPattern.test(imdbId)) {
    const found = await findByImdb(
      request,
      key,
      imdbId,
      timeoutMs,
      maxResponseBytes,
    );
    if (found !== undefined) return [found];
  }
  const url = new URL(`${baseUrl}/search/movie`);
  url.searchParams.set("api_key", key);
  url.searchParams.set("query", query.title);
  if (query.year !== undefined)
    url.searchParams.set("year", String(query.year));
  const data = asObject(
    await requestJson(request, url, timeoutMs, maxResponseBytes),
  );
  if (!Array.isArray(data.results)) invalid();
  const wanted = normalizeTitle(query.title);
  return data.results.map((entry) => {
    const result = asObject(entry);
    const id = requiredId(result.id);
    const title = requiredString(result.title);
    const originalTitle = optionalString(result.original_title);
    const year = releaseYear(result.release_date);
    // `title` follows the request language; folders often use the original.
    const titleMatches =
      normalizeTitle(title) === wanted ||
      (originalTitle !== null && normalizeTitle(originalTitle) === wanted);
    let confidence = titleMatches ? 0.8 : 0.5;
    if (query.year === undefined) confidence += 0.1;
    else if (year === query.year) confidence += 0.2;
    return {
      providerId: String(id),
      title,
      year,
      confidence: Math.min(confidence, 1),
    };
  });
}

async function fetchMovie(
  request: typeof fetch,
  key: string,
  match: FetchQuery,
  timeoutMs: number,
  maxResponseBytes: number,
): Promise<MetadataResult | null> {
  if (match.kind !== "movie") throw new Error("TMDB only supports movies.");
  if (!/^\d+$/.test(match.providerId) || Number(match.providerId) <= 0)
    throw new Error("Invalid TMDB provider id.");
  const url = new URL(`${baseUrl}/movie/${match.providerId}`);
  url.searchParams.set("api_key", key);
  url.searchParams.set(
    "append_to_response",
    "credits,release_dates,external_ids,images",
  );
  // TMDB answers 404 for deleted or merged movies.
  const body = await requestJson(
    request,
    url,
    timeoutMs,
    maxResponseBytes,
    true,
  );
  if (body === undefined) return null;
  const data = asObject(body);
  const id = requiredId(data.id);
  // A record for another movie must never land on this Item.
  if (id !== Number(match.providerId)) invalid();
  const overview = optionalString(data.overview);
  return {
    title: requiredString(data.title),
    overview: overview || null,
    year: releaseYear(data.release_date),
    contentRating: readContentRating(data.release_dates),
    genres: readGenres(data.genres),
    credits: readCredits(data.credits),
    artwork: readArtwork(
      optionalString(data.poster_path),
      optionalString(data.backdrop_path),
      data.images,
    ),
    providerIds: readProviderIds(id, data.external_ids),
  };
}

/** Creates the in-tree TMDB metadata provider for movies. */
export function createTmdbMetadataProvider(
  apiKey: string,
  request: typeof fetch = fetch,
  timeoutMs = 30_000,
  maxResponseBytes = 8 * 1024 * 1024,
): MetadataProvider {
  const key = apiKey.trim();
  if (key.length === 0) throw new Error("TMDB API key is required.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new Error("Invalid TMDB request timeout.");
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1)
    throw new Error("Invalid TMDB response limit.");
  return {
    id: "tmdb",
    kinds: ["movie"],
    search: (query) =>
      searchMovies(request, key, query, timeoutMs, maxResponseBytes),
    fetch: (match) =>
      fetchMovie(request, key, match, timeoutMs, maxResponseBytes),
  };
}
