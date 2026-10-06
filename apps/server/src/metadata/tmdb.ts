import type { MetadataProvider } from "@thalia/plugin-api";
import {
  assertRequestLimits,
  dateYear,
  jsonDecoders,
  normalizeTitle,
  type RequestLimits,
  requestJson,
  titleConfidence,
} from "./provider-http.ts";

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

const decoders = jsonDecoders("TMDB");
// An explicit type lets `invalid()` narrow like a `never` function declaration.
const invalid: () => never = decoders.invalid;
const { asObject, requiredId, requiredString, optionalString, optionalDate } =
  decoders;

const releaseYear = (value: unknown) => dateYear(optionalDate(value));

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
    // Vector files cannot be rasterized and stored, so they are not offered.
    if (path.toLowerCase().endsWith(".svg")) return;
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

/** Reads one TMDB path; with `allowMissing`, a 404 resolves undefined. */
type TmdbGet = (
  path: string,
  params?: Record<string, string>,
  allowMissing?: boolean,
) => Promise<unknown>;

const imdbIdPattern = /^tt[0-9]+$/;

/** Resolves an IMDb id through /find; a single movie result is a certain match. */
async function findByImdb(
  get: TmdbGet,
  imdbId: string,
): Promise<MetadataMatch | undefined> {
  const data = asObject(
    await get(`/find/${imdbId}`, { external_source: "imdb_id" }),
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

/** Search candidates, in TMDB's relevance order, whose translations a search may read. */
const translationLookupLimit = 5;

/** Reads a movie's translated titles; a movie TMDB no longer knows has none. */
async function translatedTitles(get: TmdbGet, id: number): Promise<string[]> {
  const body = await get(`/movie/${id}/translations`, {}, true);
  if (body === undefined) return [];
  const data = asObject(body);
  if (!Array.isArray(data.translations)) invalid();
  const titles: string[] = [];
  for (const entry of data.translations) {
    const translation = asObject(entry);
    if (translation.data === undefined || translation.data === null) continue;
    // TMDB leaves `title` empty when a translation only covers the overview.
    const title = optionalString(asObject(translation.data).title);
    if (title) titles.push(title);
  }
  return titles;
}

async function searchMovies(
  get: TmdbGet,
  query: SearchQuery,
): Promise<MetadataMatch[]> {
  if (query.kind !== "movie") throw new Error("TMDB only supports movies.");
  // An IMDb id from the folder or an arr pins the movie before any title guess.
  const imdbId = query.providerIds?.imdb;
  if (imdbId !== undefined && imdbIdPattern.test(imdbId)) {
    const found = await findByImdb(get, imdbId);
    if (found !== undefined) return [found];
  }
  const params: Record<string, string> = { query: query.title };
  if (query.year !== undefined) params.year = String(query.year);
  const data = asObject(await get("/search/movie", params));
  if (!Array.isArray(data.results)) invalid();
  const wanted = normalizeTitle(query.title);
  const matches = (title: string) => normalizeTitle(title) === wanted;
  const candidates = data.results.map((entry) => {
    const result = asObject(entry);
    const title = requiredString(result.title);
    const originalTitle = optionalString(result.original_title);
    return {
      id: requiredId(result.id),
      title,
      year: releaseYear(result.release_date),
      // `title` follows the request language; folders often use the original.
      titleMatches:
        matches(title) || (originalTitle !== null && matches(originalTitle)),
    };
  });
  // Radarr can name folders with a translated title. Translations cost one
  // request per candidate, so only a search with no plain match reads them.
  if (!candidates.some((candidate) => candidate.titleMatches))
    await Promise.all(
      candidates.slice(0, translationLookupLimit).map(async (candidate) => {
        const titles = await translatedTitles(get, candidate.id);
        candidate.titleMatches = titles.some(matches);
      }),
    );
  return candidates.map(({ id, title, year, titleMatches }) => ({
    providerId: String(id),
    title,
    year,
    confidence: titleConfidence(titleMatches, query.year, year),
  }));
}

async function fetchMovie(
  get: TmdbGet,
  match: FetchQuery,
): Promise<MetadataResult | null> {
  if (match.kind !== "movie") throw new Error("TMDB only supports movies.");
  if (!/^\d+$/.test(match.providerId) || Number(match.providerId) <= 0)
    throw new Error("Invalid TMDB provider id.");
  // TMDB answers 404 for deleted or merged movies.
  const body = await get(
    `/movie/${match.providerId}`,
    {
      append_to_response: "credits,release_dates,external_ids,images",
      // English to match the title's language, plus language-neutral images.
      include_image_language: "en,null",
    },
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
  const limits: RequestLimits = { label: "TMDB", timeoutMs, maxResponseBytes };
  assertRequestLimits(limits);
  const get: TmdbGet = (path, params = {}, allowMissing = false) => {
    const url = new URL(`${baseUrl}${path}`);
    url.searchParams.set("api_key", key);
    for (const [name, value] of Object.entries(params))
      url.searchParams.set(name, value);
    return requestJson(request, url, limits, { allowMissing });
  };
  return {
    id: "tmdb",
    kinds: ["movie"],
    search: (query) => searchMovies(get, query),
    fetch: (match) => fetchMovie(get, match),
  };
}
