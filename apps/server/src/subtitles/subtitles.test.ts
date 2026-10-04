import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { pendiaRouter } from "../api/router.ts";
import { setupAdmin } from "../auth/accounts.ts";
import { createApiKey } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { items, providerIds, settings } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startPendia } from "../index.ts";
import { createJobQueue } from "../jobs/queue.ts";
import { createJobRegistry } from "../jobs/registry.ts";
import { scanDirectory } from "../libraries/scan.ts";
import { createLibrary } from "../libraries/service.ts";
import { addRoot } from "../libraries/testing.ts";
import {
  createVideoFixture,
  withVideoFixture,
} from "../mediums/video-common/fixtures.ts";
import { setProviderKey } from "../providers/keys.ts";
import { queueSubtitleFetch, registerSubtitleJobs } from "./jobs.ts";
import { openSubtitlesHash } from "./opensubtitles.ts";
import {
  listSubtitles,
  readLanguage,
  readTrackName,
  writeSubtitle,
} from "./store.ts";

const profile = {
  containers: ["mkv"],
  videoCodecs: [{ codec: "h264" }],
  audioCodecs: [{ codec: "aac", maxChannels: 2 }],
  subtitleFormats: ["srt"],
  hdr: ["sdr" as const],
};

const cue = "1\n00:00:00,000 --> 00:00:01,000\nHello.\n";

/** Scans a one-movie library with a real video file and hands its ids to `run`. */
async function withScannedMovie(
  db: Database,
  run: (scanned: {
    adminId: string;
    token: string;
    itemId: string;
    versionId: string;
    root: string;
  }) => Promise<void>,
) {
  await migrateDatabase(db);
  const admin = await setupAdmin(db, { username: "admin", password: "pw" });
  const { token } = await createApiKey(db, admin.id, "player");
  await withVideoFixture(async (root) => {
    await mkdir(join(root, "Movie (2026)"));
    await createVideoFixture(join(root, "Movie (2026)", "Movie.mkv"), {
      width: 320,
      height: 180,
    });
    const library = await createLibrary(db, admin.id, {
      name: "Movies",
      medium: "movies",
      roots: [root],
    });
    const scanned = await scanDirectory(db, library.id, "Movie (2026)");
    const versionId = scanned.versionIds[0];
    if (scanned.itemId === null || versionId === undefined)
      throw new Error("Expected one scanned Item and Version.");
    await run({
      adminId: admin.id,
      token,
      itemId: scanned.itemId,
      versionId,
      root,
    });
  });
}

describe("track names", () => {
  test("read a language and a known format", () => {
    expect(readTrackName("en.srt")).toEqual({ language: "en", format: "srt" });
    expect(readTrackName("pt-br.vtt")).toEqual({
      language: "pt-br",
      format: "vtt",
    });
    expect(readTrackName("en.sub")).toBeNull();
    expect(readTrackName("../x.srt")).toBeNull();
    expect(readTrackName(".srt")).toBeNull();
  });

  test("lowercase languages and refuse what cannot name a file", () => {
    expect(readLanguage("PT-BR")).toBe("pt-br");
    expect(readLanguage("en/..")).toBeNull();
    expect(readLanguage("")).toBeNull();
  });
});

describe("openSubtitlesHash", () => {
  test("adds the size and the little-endian words of the first and last 64 KiB", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pendia-hash-"));
    try {
      const bytes = new Uint8Array(3 * 64 * 1024);
      const view = new DataView(bytes.buffer);
      view.setBigUint64(0, 1n, true);
      // The middle 64 KiB is never read.
      view.setBigUint64(64 * 1024, 0xffn, true);
      view.setBigUint64(bytes.length - 8, 0xffffffffffffffffn, true);
      await Bun.write(join(dir, "a.mkv"), bytes);
      // 196608 + 1 + (2^64 - 1) wraps to 196608.
      expect(await openSubtitlesHash(join(dir, "a.mkv"))).toBe(
        "0000000000030000",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!databaseUrl)("OpenSubtitles", () => {
  test("fetches the best match per language for a fixture, and the plan lists it", () =>
    withDatabase((db, url) =>
      withScannedMovie(db, async ({ adminId, token, itemId, versionId }) => {
        await setProviderKey(db, adminId, "opensubtitles", "os-key");
        await db.insert(settings).values({
          key: "metadata",
          value: { subtitleLanguages: ["nl", "en"] },
        });
        await db
          .insert(providerIds)
          .values({ itemId, provider: "imdb", value: "tt0078748" });

        const calls: { url: string; headers: Headers; body: string }[] = [];
        const api = (async (input: string | URL, init?: RequestInit) => {
          const href = String(input);
          calls.push({
            url: href,
            headers: new Headers(init?.headers),
            body: typeof init?.body === "string" ? init.body : "",
          });
          const { pathname, searchParams } = new URL(href);
          const language = searchParams.get("languages");
          const page = searchParams.get("page") ?? "1";
          if (pathname === "/api/v1/subtitles" && language === "nl")
            return Response.json({
              data: [
                // A split release holds half the dialogue per file.
                result("nl", 15, {
                  moviehash_match: true,
                  files: [{ file_id: 15 }, { file_id: 16 }],
                }),
                result("nl", 11, { moviehash_match: true, download_count: 5 }),
                result("nl", 12, { download_count: 90_000 }),
              ],
            });
          // English page one holds nothing usable; page two has a full track.
          if (pathname === "/api/v1/subtitles" && language === "en")
            return Response.json({
              total_pages: 2,
              data:
                page === "1"
                  ? [
                      result("en", 13, { machine_translated: true }),
                      result("en", 14, { foreign_parts_only: true }),
                    ]
                  : [result("en", 17, {})],
            });
          if (pathname === "/api/v1/download") {
            const { file_id } = JSON.parse(String(init?.body));
            return Response.json({
              link: `https://dl.example/abc/${file_id}.srt`,
              file_name: `${file_id}.srt`,
            });
          }
          if (href.startsWith("https://dl.example/abc/"))
            return new Response(cue);
          return new Response(null, { status: 404 });
        }) as typeof fetch;

        await queueSubtitleFetch(db, { id: itemId, kind: "movie" });
        const registry = createJobRegistry();
        registerSubtitleJobs(db, registry, api);
        const job = await createJobQueue(db).claim(["subtitle-fetch"]);
        if (job === undefined) throw new Error("No subtitle-fetch job queued.");
        await registry.run(job);

        const [search, ...rest] = calls;
        expect(
          rest.map(({ url, body }) => {
            const { pathname, searchParams } = new URL(url);
            return pathname === "/api/v1/subtitles"
              ? `search ${searchParams.get("languages")} ${searchParams.get("page") ?? 1}`
              : pathname === "/api/v1/download"
                ? `download ${JSON.parse(body).file_id}`
                : url;
          }),
        ).toEqual([
          "search en 1",
          "search en 2",
          "download 11",
          "https://dl.example/abc/11.srt",
          "download 17",
          "https://dl.example/abc/17.srt",
        ]);
        const query = new URL(search?.url ?? "").searchParams;
        expect([...query.keys()]).toEqual([
          "imdb_id",
          "languages",
          "moviehash",
          "query",
          "type",
          "year",
        ]);
        expect(Object.fromEntries(query)).toMatchObject({
          imdb_id: "78748",
          languages: "nl",
          moviehash: expect.stringMatching(/^[0-9a-f]{16}$/),
          query: "movie",
          type: "movie",
          year: "2026",
        });
        expect(search?.headers.get("api-key")).toBe("os-key");
        expect(search?.headers.get("user-agent")).toStartWith("Pendia");
        expect(await listSubtitles(db, itemId)).toEqual([
          { language: "en", format: "srt" },
          { language: "nl", format: "srt" },
        ]);

        const server = await startPendia("api", { databaseUrl: url, port: 0 });
        try {
          const client = createORPCClient<RouterClient<typeof pendiaRouter>>(
            new RPCLink({
              url: `http://127.0.0.1:${server.apiServer?.port}/rpc`,
              headers: { authorization: `Bearer ${token}` },
            }),
          );
          const planned = await client.playback.plan({
            itemId,
            versionId,
            profile,
          });
          expect(planned.subtitles).toEqual([
            {
              language: "en",
              format: "srt",
              url: `/api/subtitles/${itemId}/en.srt`,
            },
            {
              language: "nl",
              format: "srt",
              url: `/api/subtitles/${itemId}/nl.srt`,
            },
          ]);
        } finally {
          await server.stop();
        }
      }),
    ));
});

function result(
  language: string,
  fileId: number,
  attributes: Record<string, unknown>,
) {
  return {
    id: String(fileId),
    type: "subtitle",
    attributes: { language, files: [{ file_id: fileId }], ...attributes },
  };
}

describe.skipIf(!databaseUrl)("stored subtitle tracks", () => {
  test("a stored track shows in the play plan and is served to a viewer", () =>
    withDatabase((db, url) =>
      withScannedMovie(db, async ({ token, itemId, versionId, root }) => {
        await writeSubtitle(db, itemId, { language: "nl", format: "srt" }, cue);
        expect(await listSubtitles(db, itemId)).toEqual([
          { language: "nl", format: "srt" },
        ]);
        expect(
          await Bun.file(
            join(root, "Movie (2026)/.pendia/subtitles", `${itemId}.nl.srt`),
          ).text(),
        ).toBe(cue);

        const server = await startPendia("api", { databaseUrl: url, port: 0 });
        try {
          const base = `http://127.0.0.1:${server.apiServer?.port}`;
          const client = createORPCClient<RouterClient<typeof pendiaRouter>>(
            new RPCLink({
              url: `${base}/rpc`,
              headers: { authorization: `Bearer ${token}` },
            }),
          );
          const planned = await client.playback.plan({
            itemId,
            versionId,
            profile,
          });
          const url = `/api/subtitles/${itemId}/nl.srt`;
          expect(planned.subtitles).toEqual([
            { language: "nl", format: "srt", url },
          ]);

          const served = await fetch(`${base}${url}`, {
            headers: { authorization: `Bearer ${token}` },
          });
          expect(served.status).toBe(200);
          expect(served.headers.get("content-type")).toBe(
            "application/x-subrip; charset=utf-8",
          );
          expect(await served.text()).toBe(cue);
          expect((await fetch(`${base}${url}`)).status).toBe(401);
          expect(
            (
              await fetch(`${base}/api/subtitles/${itemId}/de.srt`, {
                headers: { authorization: `Bearer ${token}` },
              })
            ).status,
          ).toBe(404);
        } finally {
          await server.stop();
        }
      }),
    ));

  test.skipIf(process.getuid?.() === 0)(
    "an unsearchable root does not hide tracks in the readable one",
    () =>
      withDatabase((db) =>
        withScannedMovie(db, async ({ itemId }) => {
          const [item] = await db
            .select({ libraryId: items.libraryId })
            .from(items);
          if (!item) throw new Error("Item missing.");
          const extra = await mkdtemp(join(tmpdir(), "pendia-sub-extra-"));
          await addRoot(db, item.libraryId, extra);
          await writeSubtitle(
            db,
            itemId,
            { language: "en", format: "srt" },
            cue,
          );
          try {
            await chmod(extra, 0o000);
            expect(await listSubtitles(db, itemId)).toEqual([
              { language: "en", format: "srt" },
            ]);
          } finally {
            await chmod(extra, 0o755);
            await rm(extra, { recursive: true, force: true });
          }
        }),
      ),
  );
});
