import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { pendiaRouter } from "../api/router.ts";
import { setupAdmin } from "../auth/accounts.ts";
import { createApiKey } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startPendia } from "../index.ts";
import { scanDirectory } from "../libraries/scan.ts";
import { createLibrary } from "../libraries/service.ts";
import {
  createVideoFixture,
  withVideoFixture,
} from "../mediums/video-common/fixtures.ts";
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
      rootPath: root,
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
});
