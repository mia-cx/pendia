import type { MetadataProvider } from "@pendia/plugin-api";
import {
  assertRequestLimits,
  dateYear,
  jsonDecoders,
  normalizeTitle,
  type RequestLimits,
  requestJson,
  titleConfidence,
} from "./provider-http.ts";

const baseUrl = "https://api4.thetvdb.com/v4";
const artworkBaseUrl = "https://artworks.thetvdb.com";
// Sonarr names files in aired order, which TVDB calls the official season type.
const seasonType = "official";
// TVDB pages episodes 500 at a time; 100 pages is far beyond any real Show.
const maxEpisodePages = 100;
// Artwork type ids from /artwork/types for series records.
const seriesArtworkTypes = new Map<number, Artwork["type"]>([
  [2, "poster"],
  [3, "backdrop"],
  [23, "logo"],
]);

type SearchQuery = Parameters<MetadataProvider["search"]>[0];
type FetchQuery = Parameters<MetadataProvider["fetch"]>[0];
type MetadataMatch = Awaited<ReturnType<MetadataProvider["search"]>>[number];
type MetadataResult = NonNullable<
  Awaited<ReturnType<MetadataProvider["fetch"]>>
>;
type Credit = MetadataResult["credits"][number];
type Artwork = MetadataResult["artwork"][number];

const decoders = jsonDecoders("TVDB");
// An explicit type lets `invalid()` narrow like a `never` function declaration.
const invalid: () => never = decoders.invalid;
const { asObject, requiredId, requiredString, optionalString, optionalDate } =
  decoders;

function optionalArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) invalid();
  return value;
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    invalid();
  return value;
}

/** Reads TVDB's string years, such as "2008"; anything else means none. */
function stringYear(value: unknown): number | null {
  const year = optionalString(value);
  return year !== null && /^\d{4}$/.test(year) ? Number(year) : null;
}

/** TVDB answers full artwork URLs, and older records a path on its artwork host; any other host is dropped. */
function artworkUrl(value: unknown): string | null {
  const image = optionalString(value)?.trim();
  if (!image) return null;
  // The server downloads these URLs, so a response may not point it anywhere else.
  const url = URL.parse(image, artworkBaseUrl);
  return url?.origin === artworkBaseUrl ? url.href : null;
}

function readData(body: unknown): Record<string, unknown> {
  return asObject(asObject(body).data);
}

function readGenres(value: unknown): string[] {
  const names = new Set<string>();
  for (const entry of optionalArray(value))
    names.add(requiredString(asObject(entry).name));
  return [...names];
}

function readCredits(value: unknown): Credit[] {
  const cast: { name: string; character: string | null; sort: number }[] = [];
  const crew: Credit[] = [];
  const roleCounts = new Map<string, number>();
  for (const entry of optionalArray(value)) {
    const character = asObject(entry);
    // TVDB keeps characters whose person was never filled in.
    const name = optionalString(character.personName)?.trim();
    if (!name) continue;
    const role = requiredString(character.peopleType).trim().toLowerCase();
    if (role === "actor") {
      cast.push({
        name,
        character: optionalString(character.name)?.trim() || null,
        sort: nonNegativeInteger(character.sort ?? 0),
      });
      continue;
    }
    const order = roleCounts.get(role) ?? 0;
    roleCounts.set(role, order + 1);
    crew.push({ name, role, order });
  }
  // A stable sort keeps TVDB's own order between equal sort values.
  cast.sort((a, b) => a.sort - b.sort);
  return [
    ...cast.map(({ name, character }, order): Credit => {
      const credit: Credit = { name, role: "actor", order };
      if (character !== null) credit.character = character;
      return credit;
    }),
    ...crew,
  ];
}

function readContentRating(value: unknown): string | null {
  for (const entry of optionalArray(value)) {
    const rating = asObject(entry);
    if (optionalString(rating.country)?.toLowerCase() !== "usa") continue;
    const name = optionalString(rating.name)?.trim();
    if (name) return name;
  }
  return null;
}

function readArtwork(image: unknown, artworks: unknown): Artwork[] {
  const artwork: Artwork[] = [];
  const seen = new Set<string>();
  const add = (type: Artwork["type"], url: string | null) => {
    if (url === null || seen.has(`${type}|${url}`)) return;
    seen.add(`${type}|${url}`);
    artwork.push({ type, url });
  };
  add("poster", artworkUrl(image));
  for (const entry of optionalArray(artworks)) {
    const row = asObject(entry);
    const type = seriesArtworkTypes.get(nonNegativeInteger(row.type));
    if (type !== undefined) add(type, artworkUrl(row.image));
  }
  return artwork;
}

function readProviderIds(id: number, value: unknown): Record<string, string> {
  const providerIds: Record<string, string> = { tvdb: String(id) };
  for (const entry of optionalArray(value)) {
    const remote = asObject(entry);
    if (optionalString(remote.sourceName)?.toUpperCase() !== "IMDB") continue;
    const imdb = optionalString(remote.id)?.trim();
    if (imdb) providerIds.imdb = imdb;
  }
  return providerIds;
}

/** One Show's decoded records: the Show, its official Seasons and Episodes. */
type Series = {
  show: MetadataResult;
  seasons: { id: number; number: number; result: MetadataResult }[];
  episodes: {
    id: number;
    seasonNumber: number;
    number: number;
    result: MetadataResult;
  }[];
};

function readShow(id: number, data: Record<string, unknown>): MetadataResult {
  const firstAired = optionalDate(data.firstAired);
  const status =
    data.status === undefined || data.status === null
      ? null
      : optionalString(asObject(data.status).name);
  return {
    title: requiredString(data.name),
    overview: optionalString(data.overview)?.trim() || null,
    year: dateYear(firstAired) ?? stringYear(data.year),
    contentRating: readContentRating(data.contentRatings),
    genres: readGenres(data.genres),
    credits: readCredits(data.characters),
    artwork: readArtwork(data.image, data.artworks),
    providerIds: readProviderIds(id, data.remoteIds),
    releaseDate: firstAired,
    lastAirDate: optionalDate(data.lastAired),
    status: status?.trim().toLowerCase() || null,
  };
}

function readEpisode(entry: unknown): Series["episodes"][number] {
  const episode = asObject(entry);
  const id = requiredId(episode.id);
  const number = nonNegativeInteger(episode.number);
  const aired = optionalDate(episode.aired);
  const thumb = artworkUrl(episode.image);
  return {
    id,
    seasonNumber: nonNegativeInteger(episode.seasonNumber),
    number,
    result: {
      // TVDB lists announced Episodes before they have a name.
      title: optionalString(episode.name)?.trim() || `Episode ${number}`,
      overview: optionalString(episode.overview)?.trim() || null,
      year: dateYear(aired),
      contentRating: null,
      genres: [],
      credits: [],
      artwork: thumb === null ? [] : [{ type: "thumb", url: thumb }],
      providerIds: { tvdb: String(id) },
      releaseDate: aired,
    },
  };
}

function readSeason(
  entry: Record<string, unknown>,
  episodes: Series["episodes"],
): Series["seasons"][number] {
  const id = requiredId(entry.id);
  const number = nonNegativeInteger(entry.number);
  // A Season airs when its first Episode does.
  const releaseDate =
    episodes
      .filter((episode) => episode.seasonNumber === number)
      .map((episode) => episode.result.releaseDate ?? null)
      .filter((date) => date !== null)
      .sort()[0] ?? null;
  const poster = artworkUrl(entry.image);
  return {
    id,
    number,
    result: {
      title:
        optionalString(entry.name)?.trim() ||
        (number === 0 ? "Specials" : `Season ${number}`),
      overview: null,
      year: dateYear(releaseDate) ?? stringYear(entry.year),
      contentRating: null,
      genres: [],
      credits: [],
      artwork: poster === null ? [] : [{ type: "poster", url: poster }],
      providerIds: { tvdb: String(id) },
      releaseDate,
    },
  };
}

const unsupportedKind = "TVDB only supports shows, seasons and episodes.";

function parseId(providerId: string): number {
  if (!/^\d+$/.test(providerId) || Number(providerId) <= 0)
    throw new Error("Invalid TVDB provider id.");
  return Number(providerId);
}

/** Creates the in-tree TVDB metadata provider for Shows, Seasons and Episodes. */
export function createTvdbMetadataProvider(
  apiKey: string,
  pin?: string,
  request: typeof fetch = fetch,
  timeoutMs = 30_000,
  maxResponseBytes = 8 * 1024 * 1024,
): MetadataProvider {
  const key = apiKey.trim();
  if (key.length === 0) throw new Error("TVDB API key is required.");
  const subscriberPin = pin?.trim() || undefined;
  const limits: RequestLimits = { label: "TVDB", timeoutMs, maxResponseBytes };
  assertRequestLimits(limits);

  // One instance serves one job, so its token and records live as long as it.
  let token: Promise<string> | undefined;
  const series = new Map<number, Promise<Series | null>>();
  const seasonsById = new Map<number, MetadataResult>();
  const episodesById = new Map<number, MetadataResult>();

  const login = async () => {
    const body = await requestJson(
      request,
      new URL(`${baseUrl}/login`),
      limits,
      {
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ apikey: key, pin: subscriberPin }),
        },
      },
    );
    return requiredString(readData(body).token);
  };

  const get = async (
    path: string,
    params: Record<string, string> = {},
    allowMissing = false,
  ) => {
    token ??= login().catch((error: unknown) => {
      token = undefined;
      throw error;
    });
    const url = new URL(`${baseUrl}${path}`);
    for (const [name, value] of Object.entries(params))
      url.searchParams.set(name, value);
    return requestJson(request, url, limits, {
      init: { headers: { authorization: `Bearer ${await token}` } },
      allowMissing,
    });
  };

  const fetchSeries = async (id: number): Promise<Series | null> => {
    const body = await get(`/series/${id}/extended`, {}, true);
    if (body === undefined) return null;
    const data = readData(body);
    // A record for another Show must never land on this Item.
    if (requiredId(data.id) !== id) invalid();
    const episodes: Series["episodes"] = [];
    for (let page = 0; ; page += 1) {
      if (page === maxEpisodePages) invalid();
      const listing = asObject(
        await get(`/series/${id}/episodes/${seasonType}`, {
          page: String(page),
        }),
      );
      const rows = optionalArray(asObject(listing.data).episodes);
      episodes.push(...rows.map(readEpisode));
      const links =
        listing.links === undefined || listing.links === null
          ? {}
          : asObject(listing.links);
      if (rows.length === 0 || !optionalString(links.next)) break;
    }
    const seasons = optionalArray(data.seasons)
      .map(asObject)
      .filter(
        (season) =>
          season.type !== undefined &&
          season.type !== null &&
          optionalString(asObject(season.type).type) === seasonType,
      )
      .map((season) => readSeason(season, episodes));
    for (const season of seasons) seasonsById.set(season.id, season.result);
    for (const episode of episodes)
      episodesById.set(episode.id, episode.result);
    return { show: readShow(id, data), seasons, episodes };
  };

  const loadSeries = (id: number) => {
    let cached = series.get(id);
    if (cached === undefined) {
      cached = fetchSeries(id).catch((error: unknown) => {
        series.delete(id);
        throw error;
      });
      series.set(id, cached);
    }
    return cached;
  };

  /** Finds the Show of a Season or Episode TVDB id, then reads it from that Show. */
  const fetchChild = async (
    kind: "seasons" | "episodes",
    id: number,
    cache: Map<number, MetadataResult>,
  ) => {
    const cached = cache.get(id);
    if (cached !== undefined) return cached;
    const body = await get(`/${kind}/${id}`, {}, true);
    if (body === undefined) return null;
    const data = readData(body);
    if (requiredId(data.id) !== id) invalid();
    await loadSeries(requiredId(data.seriesId));
    // Outside the official order the record is not one Pendia can place.
    return cache.get(id) ?? null;
  };

  const searchShows = async (query: SearchQuery): Promise<MetadataMatch[]> => {
    // An IMDb id from the folder or an arr pins the Show before any title guess.
    const imdbId = query.providerIds?.imdb;
    if (imdbId !== undefined && /^tt[0-9]+$/.test(imdbId)) {
      const found = optionalArray(
        asObject(await get(`/search/remoteid/${imdbId}`)).data,
      )
        .map((entry) => asObject(entry).series)
        .filter((entry) => entry !== undefined && entry !== null)
        .map(asObject);
      const [only] = found;
      if (found.length === 1 && only !== undefined)
        return [
          {
            providerId: String(requiredId(only.id)),
            title: requiredString(only.name),
            year:
              dateYear(optionalDate(only.firstAired)) ?? stringYear(only.year),
            confidence: 1,
          },
        ];
    }
    const params: Record<string, string> = {
      query: query.title,
      type: "series",
    };
    if (query.year !== undefined) params.year = String(query.year);
    const wanted = normalizeTitle(query.title);
    const matches = (title: unknown) =>
      typeof title === "string" && normalizeTitle(title) === wanted;
    return optionalArray(asObject(await get("/search", params)).data).map(
      (entry) => {
        const result = asObject(entry);
        const id = requiredString(result.tvdb_id);
        if (!/^\d+$/.test(id)) invalid();
        const title = requiredString(result.name);
        const year = stringYear(result.year);
        // Sonarr can name folders with an alias or a translated title.
        const translations =
          result.translations === undefined || result.translations === null
            ? []
            : Object.values(asObject(result.translations));
        const titleMatches =
          matches(title) ||
          optionalArray(result.aliases).some(matches) ||
          translations.some(matches);
        return {
          providerId: id,
          title,
          year,
          confidence: titleConfidence(titleMatches, query.year, year),
        };
      },
    );
  };

  const searchChildren = async (
    query: SearchQuery,
  ): Promise<MetadataMatch[]> => {
    const showId = query.show?.providerIds.tvdb;
    if (query.show === undefined || showId === undefined) return [];
    const record = await loadSeries(parseId(showId));
    if (record === null) return [];
    const { seasonNumber, episodeNumber } = query.show;
    const found =
      query.kind === "season"
        ? record.seasons.find((season) => season.number === seasonNumber)
        : record.episodes.find(
            (episode) =>
              episode.seasonNumber === seasonNumber &&
              episode.number === episodeNumber,
          );
    if (found === undefined) return [];
    return [
      {
        providerId: String(found.id),
        title: found.result.title,
        year: found.result.year,
        confidence: 1,
      },
    ];
  };

  return {
    id: "tvdb",
    kinds: ["show", "season", "episode"],
    search: async (query) => {
      if (query.kind === "show") return searchShows(query);
      if (query.kind === "season" || query.kind === "episode")
        return searchChildren(query);
      throw new Error(unsupportedKind);
    },
    fetch: async ({ providerId, kind }: FetchQuery) => {
      const id = parseId(providerId);
      if (kind === "show") return (await loadSeries(id))?.show ?? null;
      if (kind === "season") return fetchChild("seasons", id, seasonsById);
      if (kind === "episode") return fetchChild("episodes", id, episodesById);
      throw new Error(unsupportedKind);
    },
  };
}
