import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import * as HLS from "hls-parser";
import type { pendiaRouter } from "../api/router.ts";
import { setupAdmin } from "../auth/accounts.ts";
import { createApiKey } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { sessionRegistry, versions } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startPendia } from "../index.ts";
import type { VideoFixtureOptions } from "../mediums/video-common/fixtures.ts";
import {
  drain,
  scanFolder,
  twoRungPolicy,
  withStoredLibrary,
} from "./testing.ts";

HLS.setOptions({ strictMode: true });

type Client = RouterClient<typeof pendiaRouter>;

// A browser: mkv is not a container it plays, and WebVTT is its only subtitle format.
const browser = {
  containers: ["mp4"],
  videoCodecs: [{ codec: "h264" }],
  audioCodecs: [{ codec: "aac", maxChannels: 2 }],
  subtitleFormats: ["webvtt"],
  hdr: ["sdr" as const],
};

describe.skipIf(!databaseUrl)("stored playback with subtitles", () => {
  /** Stores both rungs of the fixture, starts an all-role server and plans the source for a browser. */
  const planStored = (
    subtitles: VideoFixtureOptions["subtitles"],
    run: (context: {
      db: Database;
      base: string;
      server: Awaited<ReturnType<typeof startPendia>>;
      planned: Awaited<ReturnType<Client["playback"]["plan"]>>;
    }) => Promise<void>,
  ) =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const admin = await setupAdmin(db, {
        username: "admin",
        password: "admin-pass",
      });
      const { token } = await createApiKey(db, admin.id, "player");
      await withStoredLibrary(
        db,
        twoRungPolicy,
        async ({ library, itemId, version }) => {
          await scanFolder(db, library.id);
          await drain(db);
          const complete = await db
            .select({ id: versions.id })
            .from(versions)
            .where(
              and(eq(versions.origin, "stored"), eq(versions.complete, true)),
            );
          expect(complete).toHaveLength(2);
          const scratchDir = await mkdtemp(
            join(tmpdir(), "pendia-stored-subtitles-"),
          );
          const server = await startPendia("all", {
            databaseUrl: url,
            port: 0,
            transcoderOptions: { port: 0, scratchDir },
          });
          try {
            const base = `http://127.0.0.1:${server.apiServer?.port}`;
            const client = createORPCClient<Client>(
              new RPCLink({
                url: `${base}/rpc`,
                headers: { authorization: `Bearer ${token}` },
              }),
            );
            const planned = await client.playback.plan({
              itemId,
              versionId: version.id,
              profile: browser,
            });
            await run({ db, base, server, planned });
          } finally {
            await server.stop();
            await rm(scratchDir, { recursive: true, force: true });
          }
        },
        { subtitles },
      );
    });

  const decisionOf = async (db: Database, sessionId: string | null) => {
    const [row] = await db
      .select({ decision: sessionRegistry.decision })
      .from(sessionRegistry)
      .where(eq(sessionRegistry.id, sessionId ?? ""));
    return row?.decision;
  };

  test(
    "stored rungs keep the source's SRT as a WebVTT track",
    () =>
      planStored(["srt"], async ({ db, base, server, planned }) => {
        expect(planned.method).toBe("remux");
        expect(
          (await decisionOf(db, planned.sessionId))?.storedVariantIds,
        ).toHaveLength(2);
        const masterUrl = new URL(planned.url ?? "", base);
        const master = HLS.parse(await (await fetch(masterUrl)).text());
        if (!master.isMasterPlaylist) throw new Error("Expected a master.");
        expect(master.variants).toHaveLength(2);
        for (const variant of master.variants) {
          expect(variant.subtitles.map((rendition) => rendition.uri)).toEqual([
            `subs-0.m3u8${masterUrl.search}`,
          ]);
        }
        const subtitles = new URL(`subs-0.m3u8${masterUrl.search}`, masterUrl);
        const playlist = HLS.parse(await (await fetch(subtitles)).text());
        if (playlist.isMasterPlaylist) throw new Error("Expected media.");
        const vtt = await fetch(
          new URL(playlist.segments[0]?.uri ?? "", subtitles),
        );
        expect(vtt.status).toBe(200);
        expect(await vtt.text()).toContain("Fixture");
        // The transcoder only converted the track: no run, no transcode slot.
        expect(
          await server.transcoder?.sessions.inspect(planned.sessionId ?? ""),
        ).toMatchObject({ video: "copy", runs: 0, queued: false });
        // A rung's folder holds no subtitles.
        const rung = master.variants[0]?.uri.split("/")[0];
        expect(
          (
            await fetch(
              new URL(`${rung}/subs-0.vtt${masterUrl.search}`, masterUrl),
            )
          ).status,
        ).toBe(404);
      }),
    120_000,
  );

  test(
    "a PGS track the client cannot draw keeps the live burn-in over stored rungs",
    () =>
      planStored(["pgs"], async ({ db, planned }) => {
        expect(planned.method).toBe("transcode");
        const decision = await decisionOf(db, planned.sessionId);
        expect(decision?.storedVariantIds).toBeUndefined();
        expect(decision).toMatchObject({
          video: { action: "transcode", burnSubtitles: true },
        });
      }),
    120_000,
  );
});
