import { describe, expect, test } from "bun:test";
import { createTmdbMetadataProvider } from "./tmdb.ts";

const apiKey = "test-key";

type Call = { input: RequestInfo | URL; init: RequestInit | undefined };

function mockRequest(handler: () => Response) {
  const calls: Call[] = [];
  const request = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return handler();
  }) as typeof fetch;
  return { calls, request };
}

function jsonRequest(body: unknown, status = 200) {
  return mockRequest(() => Response.json(body, { status }));
}

function calledUrl(call: Call | undefined) {
  if (!call) throw new Error("Expected a provider request.");
  return new URL(String(call.input));
}

describe("TMDB metadata provider", () => {
  test("trims the API key, exposes the provider identity and rejects empty keys", async () => {
    for (const key of ["", "   "]) {
      expect(() => createTmdbMetadataProvider(key)).toThrow(
        "TMDB API key is required.",
      );
    }
    const { calls, request } = jsonRequest({ results: [] });
    const provider = createTmdbMetadataProvider(" test-key ", request);
    expect(provider.id).toBe("tmdb");
    expect(provider.kinds).toEqual(["movie"]);
    await provider.search({ title: "Inception", kind: "movie" });
    expect(calledUrl(calls[0]).searchParams.get("api_key")).toBe("test-key");
  });

  test("search queries the movie endpoint with encoded title and optional year", async () => {
    const { calls, request } = jsonRequest({ results: [] });
    const provider = createTmdbMetadataProvider(apiKey, request);
    await provider.search({ title: "Héllo, World!", kind: "movie" });
    const url = calledUrl(calls[0]);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://api.themoviedb.org/3/search/movie",
    );
    expect(url.searchParams.get("api_key")).toBe(apiKey);
    expect(url.searchParams.get("query")).toBe("Héllo, World!");
    expect(url.searchParams.has("year")).toBe(false);
    expect(calls[0]?.init?.headers).toEqual({ accept: "application/json" });
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    await provider.search({ title: "Dune", year: 2021, kind: "movie" });
    expect(calledUrl(calls[1]).searchParams.get("year")).toBe("2021");
    expect(calls).toHaveLength(2);
  });

  test("search keeps TMDB order and applies settled confidence values", async () => {
    const { request } = jsonRequest({
      results: [
        { id: 11, title: "Amélie", release_date: "2001-04-25" },
        { id: 12, title: "Amelie: The Sequel", release_date: "2001-11-02" },
        { id: 13, title: "AMELIE", release_date: "1999-12-31" },
        { id: 14, title: "Amélie!", release_date: null },
        { id: 15, title: "Amélie" },
      ],
    });
    const provider = createTmdbMetadataProvider(apiKey, request);
    expect(
      await provider.search({ title: "amelie", year: 2001, kind: "movie" }),
    ).toEqual([
      { providerId: "11", title: "Amélie", year: 2001, confidence: 1 },
      {
        providerId: "12",
        title: "Amelie: The Sequel",
        year: 2001,
        confidence: 0.7,
      },
      { providerId: "13", title: "AMELIE", year: 1999, confidence: 0.8 },
      { providerId: "14", title: "Amélie!", year: null, confidence: 0.8 },
      { providerId: "15", title: "Amélie", year: null, confidence: 0.8 },
    ]);
    expect(await provider.search({ title: "amelie", kind: "movie" })).toEqual([
      { providerId: "11", title: "Amélie", year: 2001, confidence: 0.9 },
      {
        providerId: "12",
        title: "Amelie: The Sequel",
        year: 2001,
        confidence: 0.6,
      },
      { providerId: "13", title: "AMELIE", year: 1999, confidence: 0.9 },
      { providerId: "14", title: "Amélie!", year: null, confidence: 0.9 },
      { providerId: "15", title: "Amélie", year: null, confidence: 0.9 },
    ]);
  });

  test("fetch requests movie details with appended blocks", async () => {
    const { calls, request } = jsonRequest({ id: 27205, title: "Inception" });
    const provider = createTmdbMetadataProvider(apiKey, request);
    await provider.fetch({ providerId: "27205", kind: "movie" });
    const url = calledUrl(calls[0]);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://api.themoviedb.org/3/movie/27205",
    );
    expect(url.searchParams.get("api_key")).toBe(apiKey);
    expect(url.searchParams.get("append_to_response")).toBe(
      "credits,release_dates,external_ids,images",
    );
    expect(calls[0]?.init?.headers).toEqual({ accept: "application/json" });
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  test("aborts stalled requests through the request signal", async () => {
    const request = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === null || signal === undefined) {
          reject(new Error("Missing request signal."));
          return;
        }
        if (signal.aborted) {
          reject(new Error("The operation timed out."));
          return;
        }
        signal.addEventListener(
          "abort",
          () => reject(new Error("The operation timed out.")),
          { once: true },
        );
      })) as typeof fetch;
    const provider = createTmdbMetadataProvider(apiKey, request, 1);
    await expect(
      provider.search({ title: "X", kind: "movie" }),
    ).rejects.toThrow("timed out");
    await expect(
      provider.fetch({ providerId: "1", kind: "movie" }),
    ).rejects.toThrow("timed out");
  });

  test("preserves the timeout reason when a response body stalls", async () => {
    const request = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      if (signal === null || signal === undefined)
        throw new Error("Missing request signal.");
      return new Response(
        new ReadableStream({
          start(controller) {
            if (signal.aborted) {
              controller.error(signal.reason);
              return;
            }
            signal.addEventListener(
              "abort",
              () => controller.error(signal.reason),
              { once: true },
            );
          },
        }),
      );
    }) as typeof fetch;
    const provider = createTmdbMetadataProvider(apiKey, request, 1);
    const error = await provider
      .search({ title: "X", kind: "movie" })
      .catch((cause: unknown) => cause);
    expect((error as Error).name).toBe("TimeoutError");
    expect((error as Error).message).not.toBe("Invalid TMDB response.");
  });

  test("bounds declared and streamed response bodies", async () => {
    let declaredCancelled = false;
    const declared = mockRequest(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
            },
            cancel() {
              declaredCancelled = true;
            },
          }),
          { headers: { "content-length": "17" } },
        ),
    );
    await expect(
      createTmdbMetadataProvider(apiKey, declared.request, 30_000, 16).search({
        title: "X",
        kind: "movie",
      }),
    ).rejects.toThrow("TMDB response too large.");
    expect(declaredCancelled).toBe(true);

    let streamedCancelled = false;
    const streamed = mockRequest(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(9));
              controller.enqueue(new Uint8Array(9));
            },
            cancel() {
              streamedCancelled = true;
            },
          }),
        ),
    );
    await expect(
      createTmdbMetadataProvider(apiKey, streamed.request, 30_000, 16).fetch({
        providerId: "1",
        kind: "movie",
      }),
    ).rejects.toThrow("TMDB response too large.");
    expect(streamedCancelled).toBe(true);
  });

  test("rejects invalid request timeouts without a request", () => {
    const { calls, request } = jsonRequest({ results: [] });
    for (const timeoutMs of [0, -1, 1.5, Number.NaN, Number.MAX_VALUE]) {
      expect(() =>
        createTmdbMetadataProvider(apiKey, request, timeoutMs),
      ).toThrow("Invalid TMDB request timeout.");
    }
    expect(calls).toHaveLength(0);
  });

  test("rejects invalid response limits without a request", () => {
    const { calls, request } = jsonRequest({ results: [] });
    for (const maxResponseBytes of [0, -1, 1.5, Number.NaN, Number.MAX_VALUE]) {
      expect(() =>
        createTmdbMetadataProvider(apiKey, request, 30_000, maxResponseBytes),
      ).toThrow("Invalid TMDB response limit.");
    }
    expect(calls).toHaveLength(0);
  });

  test("fetch maps details, credits, rating, ids and deduped artwork", async () => {
    const { request } = jsonRequest({
      id: 27205,
      title: "Inception",
      overview: "A thief who steals secrets.",
      release_date: "2010-07-16",
      poster_path: "/poster.jpg",
      backdrop_path: "/backdrop.jpg",
      genres: [
        { name: "Science Fiction" },
        { name: "Action" },
        { name: "Science Fiction" },
      ],
      credits: {
        cast: [
          { name: "Leonardo DiCaprio", character: "Cobb", order: 0 },
          { name: "Joseph Gordon-Levitt", character: "  ", order: 1 },
          { name: "Elliot Page", character: null, order: 2 },
        ],
        crew: [
          { name: "Christopher Nolan", job: "Director" },
          { name: "Christopher Nolan", job: "Writer" },
          { name: "Second Director", job: " director " },
        ],
      },
      release_dates: {
        results: [
          { iso_3166_1: "FR", release_dates: [{ certification: "12" }] },
          {
            iso_3166_1: "US",
            release_dates: [
              { certification: "" },
              { certification: " PG-13 " },
            ],
          },
        ],
      },
      external_ids: { imdb_id: " tt1375666 " },
      images: {
        posters: [{ file_path: "/poster.jpg" }, { file_path: "/poster2.jpg" }],
        backdrops: [{ file_path: "/backdrop2.jpg" }],
        logos: [{ file_path: "/logo.png" }],
      },
    });
    const provider = createTmdbMetadataProvider(apiKey, request);
    expect(
      await provider.fetch({ providerId: "27205", kind: "movie" }),
    ).toEqual({
      title: "Inception",
      overview: "A thief who steals secrets.",
      year: 2010,
      contentRating: "PG-13",
      genres: ["Science Fiction", "Action"],
      credits: [
        {
          name: "Leonardo DiCaprio",
          role: "actor",
          character: "Cobb",
          order: 0,
        },
        { name: "Joseph Gordon-Levitt", role: "actor", order: 1 },
        { name: "Elliot Page", role: "actor", order: 2 },
        { name: "Christopher Nolan", role: "director", order: 0 },
        { name: "Christopher Nolan", role: "writer", order: 0 },
        { name: "Second Director", role: "director", order: 1 },
      ],
      artwork: [
        {
          type: "poster",
          url: "https://image.tmdb.org/t/p/original/poster.jpg",
        },
        {
          type: "backdrop",
          url: "https://image.tmdb.org/t/p/original/backdrop.jpg",
        },
        {
          type: "poster",
          url: "https://image.tmdb.org/t/p/original/poster2.jpg",
        },
        {
          type: "backdrop",
          url: "https://image.tmdb.org/t/p/original/backdrop2.jpg",
        },
        { type: "logo", url: "https://image.tmdb.org/t/p/original/logo.png" },
      ],
      providerIds: { tmdb: "27205", imdb: "tt1375666" },
    });
  });

  test("fetch maps missing optional blocks to nulls and empty lists", async () => {
    const { request } = jsonRequest({
      id: 5,
      title: "Sparse",
      overview: "",
      poster_path: "",
      backdrop_path: null,
      release_date: null,
      external_ids: { imdb_id: "  " },
    });
    const provider = createTmdbMetadataProvider(apiKey, request);
    expect(await provider.fetch({ providerId: "5", kind: "movie" })).toEqual({
      title: "Sparse",
      overview: null,
      year: null,
      contentRating: null,
      genres: [],
      credits: [],
      artwork: [],
      providerIds: { tmdb: "5" },
    });
  });

  test("rejects unsupported kinds and invalid provider ids without a request", async () => {
    const { calls, request } = jsonRequest({ results: [] });
    const provider = createTmdbMetadataProvider(apiKey, request);
    await expect(provider.search({ title: "X", kind: "show" })).rejects.toThrow(
      "TMDB only supports movies.",
    );
    await expect(
      provider.fetch({ providerId: "1", kind: "episode" }),
    ).rejects.toThrow("TMDB only supports movies.");
    for (const providerId of ["", "abc", "12.5", "-3", "0", " 12", "12 "]) {
      await expect(
        provider.fetch({ providerId, kind: "movie" }),
      ).rejects.toThrow("Invalid TMDB provider id.");
    }
    expect(calls).toHaveLength(0);
  });

  test("rejects non-2xx responses with the status and never the key", async () => {
    const { request } = mockRequest(() =>
      Response.json({ status_message: "bad key" }, { status: 401 }),
    );
    const provider = createTmdbMetadataProvider("super-secret-key", request);
    const error = await provider
      .search({ title: "X", kind: "movie" })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toBe("TMDB request failed with status 401.");
    expect(message).not.toContain("super-secret-key");
    await expect(
      provider.fetch({ providerId: "1", kind: "movie" }),
    ).rejects.toThrow("TMDB request failed with status 401.");
  });

  test("rejects a non-JSON body and malformed search shapes", async () => {
    const { request: badJson } = mockRequest(
      () => new Response("not json at all"),
    );
    await expect(
      createTmdbMetadataProvider(apiKey, badJson).search({
        title: "x",
        kind: "movie",
      }),
    ).rejects.toThrow("Invalid TMDB response.");
    const malformed = [
      "oops",
      [],
      null,
      {},
      { results: "x" },
      { results: [null] },
      { results: [{}] },
      { results: [{ title: "X" }] },
      { results: [{ id: 0, title: "X" }] },
      { results: [{ id: -2, title: "X" }] },
      { results: [{ id: 1.5, title: "X" }] },
      { results: [{ id: "1", title: "X" }] },
      { results: [{ id: 1, title: "" }] },
      { results: [{ id: 1, title: "X", release_date: 2001 }] },
      { results: [{ id: 1, title: "X", release_date: "April 2001" }] },
      { results: [{ id: 1, title: "X", release_date: "2001-13-40" }] },
    ];
    for (const body of malformed) {
      const { request } = jsonRequest(body);
      const provider = createTmdbMetadataProvider(apiKey, request);
      await expect(
        provider.search({ title: "x", kind: "movie" }),
      ).rejects.toThrow("Invalid TMDB response.");
    }
  });

  test("rejects malformed detail and nested shapes", async () => {
    const malformed = [
      "oops",
      [],
      null,
      {},
      { id: 1 },
      { id: 1, title: "" },
      { id: 1, title: "X", overview: 5 },
      { id: 1, title: "X", release_date: "garbage" },
      { id: 1, title: "X", poster_path: 4 },
      { id: 1, title: "X", genres: "x" },
      { id: 1, title: "X", genres: [{}] },
      { id: 1, title: "X", genres: [{ name: "" }] },
      { id: 1, title: "X", credits: [] },
      { id: 1, title: "X", credits: { cast: {} } },
      { id: 1, title: "X", credits: { cast: [{ name: "A" }] } },
      { id: 1, title: "X", credits: { cast: [{ name: "A", order: -1 }] } },
      { id: 1, title: "X", credits: { cast: [{ name: "A", order: 0.5 }] } },
      {
        id: 1,
        title: "X",
        credits: { cast: [{ name: "A", order: 0, character: 5 }] },
      },
      { id: 1, title: "X", credits: { crew: [{ name: "A" }] } },
      { id: 1, title: "X", credits: { crew: [{ name: "A", job: " " }] } },
      { id: 1, title: "X", release_dates: { results: {} } },
      {
        id: 1,
        title: "X",
        release_dates: {
          results: [
            { iso_3166_1: "US", release_dates: [{ certification: 5 }] },
          ],
        },
      },
      { id: 1, title: "X", external_ids: { imdb_id: 5 } },
      { id: 1, title: "X", images: { posters: "x" } },
      { id: 1, title: "X", images: { posters: [{}] } },
      { id: 1, title: "X", images: { posters: [{ file_path: "" }] } },
    ];
    for (const body of malformed) {
      const { request } = jsonRequest(body);
      const provider = createTmdbMetadataProvider(apiKey, request);
      const error = await provider
        .fetch({ providerId: "1", kind: "movie" })
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Invalid TMDB response.");
      expect((error as Error).message).not.toContain(apiKey);
    }
  });
});
