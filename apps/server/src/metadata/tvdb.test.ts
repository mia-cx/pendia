import { describe, expect, test } from "bun:test";
import { createTvdbMetadataProvider } from "./tvdb.ts";
import { tvdbResponse, tvdbSeries } from "./tvdb-fixtures.ts";

type Call = { url: URL; init: RequestInit | undefined };

function mockRequest(
  handler: (url: URL, init?: RequestInit) => Response = tvdbResponse,
) {
  const calls: Call[] = [];
  const request = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  const paths = () => calls.map(({ url }) => `${url.pathname}${url.search}`);
  return { calls, request, paths };
}

function withSeries(changes: Record<string, unknown>) {
  return (url: URL, init?: RequestInit) =>
    url.pathname === "/v4/series/81189/extended"
      ? Response.json({ data: { ...tvdbSeries, ...changes } })
      : tvdbResponse(url, init);
}

const showContext = (seasonNumber: number, episodeNumber?: number) => ({
  providerIds: { tvdb: "81189" },
  seasonNumber,
  episodeNumber,
});

describe("TVDB metadata provider", () => {
  test("rejects empty keys and invalid limits before any request", () => {
    for (const key of ["", "  "])
      expect(() => createTvdbMetadataProvider(key)).toThrow(
        "TVDB API key is required.",
      );
    expect(() =>
      createTvdbMetadataProvider("key", undefined, fetch, 0),
    ).toThrow("Invalid TVDB request timeout.");
    expect(() =>
      createTvdbMetadataProvider("key", undefined, fetch, 1, 0),
    ).toThrow("Invalid TVDB response limit.");
  });

  test("logs in once with the key and PIN, then sends the bearer token", async () => {
    const { calls, request } = mockRequest();
    const provider = createTvdbMetadataProvider(" key ", " 1234 ", request);
    expect(provider.id).toBe("tvdb");
    expect(provider.kinds).toEqual(["show", "season", "episode"]);
    await provider.search({ title: "Breaking Bad", kind: "show" });
    await provider.search({ title: "Better Call Saul", kind: "show" });
    const logins = calls.filter(({ url }) => url.pathname === "/v4/login");
    expect(logins).toHaveLength(1);
    expect(JSON.parse(String(logins[0]?.init?.body))).toEqual({
      apikey: "key",
      pin: "1234",
    });
    expect(calls[1]?.init?.headers).toEqual({
      accept: "application/json",
      authorization: "Bearer tvdb-token",
    });
  });

  test("a failed login is retried by the next request", async () => {
    let attempts = 0;
    const { request } = mockRequest((url, init) => {
      if (url.pathname !== "/v4/login") return tvdbResponse(url, init);
      attempts += 1;
      return attempts === 1
        ? new Response("no", { status: 401 })
        : tvdbResponse(url, init);
    });
    const provider = createTvdbMetadataProvider("key", undefined, request);
    await expect(provider.search({ title: "X", kind: "show" })).rejects.toThrow(
      "TVDB request failed with status 401.",
    );
    expect(await provider.search({ title: "X", kind: "show" })).toEqual([]);
    expect(attempts).toBe(2);
  });

  test("an IMDb id pins the Show through a remote id search", async () => {
    const { request, paths } = mockRequest((url, init) =>
      url.pathname === "/v4/search/remoteid/tt0903747"
        ? Response.json({
            data: [
              { series: { id: 81189, name: "Breaking Bad", year: "2008" } },
              { episode: { id: 1 } },
            ],
          })
        : tvdbResponse(url, init),
    );
    const provider = createTvdbMetadataProvider("key", undefined, request);
    expect(
      await provider.search({
        title: "Breaking Bad",
        kind: "show",
        providerIds: { imdb: "tt0903747" },
      }),
    ).toEqual([
      { providerId: "81189", title: "Breaking Bad", year: 2008, confidence: 1 },
    ]);
    expect(paths()).toEqual(["/v4/login", "/v4/search/remoteid/tt0903747"]);
  });

  test("title search scores names, aliases and translations like TMDB", async () => {
    const { request, paths } = mockRequest((url, init) =>
      url.pathname === "/v4/search"
        ? Response.json({
            data: [
              {
                tvdb_id: "1",
                name: "Haus des Geldes",
                year: "2017",
                translations: { eng: "Money Heist" },
              },
              {
                tvdb_id: "2",
                name: "La casa de papel",
                year: "2017",
                aliases: ["Money Heist"],
              },
              { tvdb_id: "3", name: "Money Heist: Korea", year: "2022" },
            ],
          })
        : tvdbResponse(url, init),
    );
    const provider = createTvdbMetadataProvider("key", undefined, request);
    expect(
      await provider.search({ title: "Money Heist", year: 2017, kind: "show" }),
    ).toEqual([
      { providerId: "1", title: "Haus des Geldes", year: 2017, confidence: 1 },
      { providerId: "2", title: "La casa de papel", year: 2017, confidence: 1 },
      {
        providerId: "3",
        title: "Money Heist: Korea",
        year: 2022,
        confidence: 0.5,
      },
    ]);
    expect(paths()[1]).toBe(
      "/v4/search?query=Money+Heist&type=series&year=2017",
    );
  });

  test("fetches a Show with status, dates, ratings, credits and artwork", async () => {
    const { request } = mockRequest();
    const provider = createTvdbMetadataProvider("key", undefined, request);
    expect(await provider.fetch({ providerId: "81189", kind: "show" })).toEqual(
      {
        title: "Breaking Bad",
        overview: "A chemistry teacher turns to making meth.",
        year: 2008,
        contentRating: "TV-MA",
        genres: ["Drama", "Crime"],
        credits: [
          {
            name: "Bryan Cranston",
            role: "actor",
            character: "Walter White",
            order: 0,
          },
          {
            name: "Aaron Paul",
            role: "actor",
            character: "Jesse Pinkman",
            order: 1,
          },
          { name: "Vince Gilligan", role: "creator", order: 0 },
        ],
        artwork: [
          {
            type: "poster",
            url: "https://artworks.thetvdb.com/banners/posters/81189-1.jpg",
          },
          {
            type: "backdrop",
            url: "https://artworks.thetvdb.com/banners/fanart/original/81189-1.jpg",
          },
          {
            type: "logo",
            url: "https://artworks.thetvdb.com/banners/logos/81189.png",
          },
        ],
        providerIds: { tvdb: "81189", imdb: "tt0903747" },
        releaseDate: "2008-01-20",
        lastAirDate: "2013-09-29",
        status: "continuing",
      },
    );
  });

  test("one Show load serves its Seasons and Episodes by number and by id", async () => {
    const { request, paths } = mockRequest();
    const provider = createTvdbMetadataProvider("key", undefined, request);
    await provider.fetch({ providerId: "81189", kind: "show" });
    expect(
      await provider.search({
        title: "Season 1",
        kind: "season",
        show: showContext(1),
      }),
    ).toEqual([
      { providerId: "30272", title: "Season 1", year: 2008, confidence: 1 },
    ]);
    expect(
      await provider.search({
        title: "Episode 2",
        kind: "episode",
        show: showContext(1, 2),
      }),
    ).toEqual([
      {
        providerId: "349235",
        title: "Cat's in the Bag...",
        year: 2008,
        confidence: 1,
      },
    ]);
    expect(
      await provider.fetch({ providerId: "30272", kind: "season" }),
    ).toEqual({
      title: "Season 1",
      overview: null,
      year: 2008,
      contentRating: null,
      genres: [],
      credits: [],
      artwork: [
        {
          type: "poster",
          url: "https://artworks.thetvdb.com/banners/seasons/81189-1.jpg",
        },
      ],
      providerIds: { tvdb: "30272" },
      releaseDate: "2008-01-20",
    });
    expect(
      await provider.fetch({ providerId: "349232", kind: "episode" }),
    ).toEqual({
      title: "Pilot",
      overview: "Walter White begins.",
      year: 2008,
      contentRating: null,
      genres: [],
      credits: [],
      artwork: [
        {
          type: "thumb",
          url: "https://artworks.thetvdb.com/banners/episodes/81189/349232.jpg",
        },
      ],
      providerIds: { tvdb: "349232" },
      releaseDate: "2008-01-20",
    });
    // An announced Episode without a name or date keeps a numbered title.
    expect(
      await provider.fetch({ providerId: "400001", kind: "episode" }),
    ).toMatchObject({
      title: "Episode 1",
      year: null,
      releaseDate: null,
      artwork: [],
    });
    expect(paths()).toEqual([
      "/v4/login",
      "/v4/series/81189/extended",
      "/v4/series/81189/episodes/official?page=0",
      "/v4/series/81189/episodes/official?page=1",
    ]);
  });

  test("a Season or Episode id alone finds its Show first", async () => {
    const { request, paths } = mockRequest();
    const provider = createTvdbMetadataProvider("key", undefined, request);
    expect(
      await provider.fetch({ providerId: "349232", kind: "episode" }),
    ).toMatchObject({
      title: "Pilot",
    });
    expect(
      await provider.fetch({ providerId: "30272", kind: "season" }),
    ).toMatchObject({
      title: "Season 1",
    });
    expect(paths()).toEqual([
      "/v4/login",
      "/v4/episodes/349232",
      "/v4/series/81189/extended",
      "/v4/series/81189/episodes/official?page=0",
      "/v4/series/81189/episodes/official?page=1",
    ]);
  });

  test("missing records resolve null and unknown numbers match nothing", async () => {
    const { request } = mockRequest();
    const provider = createTvdbMetadataProvider("key", undefined, request);
    expect(await provider.fetch({ providerId: "5", kind: "show" })).toBeNull();
    expect(
      await provider.fetch({ providerId: "5", kind: "season" }),
    ).toBeNull();
    expect(
      await provider.fetch({ providerId: "5", kind: "episode" }),
    ).toBeNull();
    expect(
      await provider.search({
        title: "S9",
        kind: "season",
        show: showContext(9),
      }),
    ).toEqual([]);
    expect(
      await provider.search({
        title: "S1",
        kind: "season",
        show: { providerIds: {}, seasonNumber: 1 },
      }),
    ).toEqual([]);
  });

  test("rejects malformed records, mismatched ids and bad provider ids", async () => {
    for (const changes of [
      { id: 1 },
      { name: "" },
      { firstAired: "2008-13-01" },
      { characters: {} },
    ]) {
      const { request } = mockRequest(withSeries(changes));
      const provider = createTvdbMetadataProvider("key", undefined, request);
      await expect(
        provider.fetch({ providerId: "81189", kind: "show" }),
      ).rejects.toThrow("Invalid TVDB response.");
    }
    const { request } = mockRequest();
    const provider = createTvdbMetadataProvider("key", undefined, request);
    for (const providerId of ["0", "-1", "abc", ""])
      await expect(
        provider.fetch({ providerId, kind: "show" }),
      ).rejects.toThrow("Invalid TVDB provider id.");
    await expect(
      provider.search({ title: "Alien", kind: "movie" }),
    ).rejects.toThrow("TVDB only supports shows, seasons and episodes.");
  });

  test("an endless episode listing is rejected instead of followed forever", async () => {
    const { request } = mockRequest((url, init) =>
      url.pathname === "/v4/series/81189/episodes/official"
        ? Response.json({
            data: { episodes: [{ id: 1, seasonNumber: 1, number: 1 }] },
            links: { next: "more" },
          })
        : tvdbResponse(url, init),
    );
    const provider = createTvdbMetadataProvider("key", undefined, request);
    await expect(
      provider.fetch({ providerId: "81189", kind: "show" }),
    ).rejects.toThrow("Invalid TVDB response.");
  });
});
