import { describe, expect, test } from "bun:test";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import * as HLS from "hls-parser";
import type { pendiaRouter } from "../api/router.ts";
import { setupAdmin } from "../auth/accounts.ts";
import { createApiKey } from "../auth/sessions.ts";
import { migrateDatabase } from "../db/migrate.ts";
import type { JsonObject } from "../db/schema/common.ts";
import { sessionRegistry, versions } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startPendia } from "../index.ts";
import { drain, scanFolder, withStoredLibrary } from "./testing.ts";

HLS.setOptions({ strictMode: true });

// mkv is not in the profile, so the source plays by remux.
const remuxClient = {
  containers: ["mp4"],
  videoCodecs: [{ codec: "h264" }],
  audioCodecs: [{ codec: "aac", maxChannels: 2 }],
  subtitleFormats: ["srt"],
  hdr: ["sdr" as const],
};

const threeRungs: JsonObject = {
  rungs: [
    { name: "source" },
    { name: "360p", height: 360, bitrate: 1_000_000 },
    { name: "240p", height: 240, bitrate: 400_000 },
  ],
};

describe.skipIf(!databaseUrl)("stored playback", () => {
  test(
    "plans complete stored rungs as variants served from disk, else falls back to the live path",
    () =>
      withDatabase(async (db, url) => {
        await migrateDatabase(db);
        const admin = await setupAdmin(db, {
          username: "admin",
          password: "admin-pass",
        });
        const { token } = await createApiKey(db, admin.id, "player");
        await withStoredLibrary(
          db,
          threeRungs,
          async ({ library, itemId, version }) => {
            await scanFolder(db, library.id);
            await drain(db);
            // An incomplete rung is never offered.
            await db
              .update(versions)
              .set({ complete: false })
              .where(
                and(eq(versions.origin, "stored"), eq(versions.rung, "240p")),
              );
            const rungs = await db
              .select({ id: versions.id, rung: versions.rung })
              .from(versions)
              .where(eq(versions.origin, "stored"));
            const idOf = (rung: string) =>
              rungs.find((row) => row.rung === rung)?.id ?? "";

            const server = await startPendia("api", {
              databaseUrl: url,
              port: 0,
            });
            try {
              const base = `http://127.0.0.1:${server.apiServer?.port}`;
              const client = createORPCClient<
                RouterClient<typeof pendiaRouter>
              >(
                new RPCLink({
                  url: `${base}/rpc`,
                  headers: { authorization: `Bearer ${token}` },
                }),
              );
              const plan = (
                profile: Parameters<typeof client.playback.plan>[0]["profile"],
              ) =>
                client.playback.plan({
                  itemId,
                  versionId: version.id,
                  profile,
                });
              const get = async (path: string) => {
                const response = await fetch(new URL(path, base));
                expect(response.status).toBe(200);
                return response;
              };

              const remux = await plan(remuxClient);
              expect(remux.method).toBe("remux");
              const masterUrl = new URL(remux.url ?? "", base);
              const master = HLS.parse(
                await (await get(masterUrl.href)).text(),
              );
              if (!master.isMasterPlaylist)
                throw new Error("Expected a master.");
              expect(
                master.variants.map((variant) => [
                  variant.uri.split("/")[0],
                  variant.resolution?.height,
                ]),
              ).toEqual([
                [idOf("360p"), 360],
                [idOf("source"), 720],
              ]);
              expect(master.variants[0]?.codecs).toMatch(
                /^avc1\.64.*,mp4a\.40\.2$/,
              );

              // Both rungs cut on the same boundaries, so hls.js can switch at any segment.
              const media = await Promise.all(
                master.variants.map(async (variant) => {
                  const mediaUrl = new URL(variant.uri, masterUrl);
                  const playlist = HLS.parse(
                    await (await get(mediaUrl.href)).text(),
                  );
                  if (playlist.isMasterPlaylist)
                    throw new Error("Expected media.");
                  const init = await get(
                    new URL(`init.mp4${mediaUrl.search}`, mediaUrl).href,
                  );
                  expect(init.headers.get("content-type")).toBe("video/mp4");
                  const segment = await get(
                    new URL(`3.m4s${mediaUrl.search}`, mediaUrl).href,
                  );
                  expect(
                    (await segment.arrayBuffer()).byteLength,
                  ).toBeGreaterThan(0);
                  const missing = await fetch(
                    new URL(`4.m4s${mediaUrl.search}`, mediaUrl),
                  );
                  expect(missing.status).toBe(404);
                  return playlist.segments.map((segment) => segment.duration);
                }),
              );
              expect(media[0]?.map(Math.round)).toEqual([3, 3, 3, 3]);
              expect(media[1]).toEqual(media[0]);
              // A rung outside the session is not served.
              const outside = new URL(
                `${idOf("240p")}/media.m3u8${masterUrl.search}`,
                masterUrl,
              );
              expect((await fetch(outside)).status).toBe(404);

              // A capped client cannot take the source, so a transcode decision
              // gets the one stored rung that fits instead of a live encode.
              const capped = await plan({
                ...remuxClient,
                maxBitrate: 1_500_000,
              });
              expect(capped.method).toBe("remux");
              const [cappedSession] = await db
                .select({ decision: sessionRegistry.decision })
                .from(sessionRegistry)
                .where(eq(sessionRegistry.id, capped.sessionId ?? ""));
              expect(cappedSession?.decision?.method).toBe("transcode");
              expect(cappedSession?.decision?.storedVariantIds).toEqual([
                idOf("360p"),
              ]);

              // Only the incomplete 240p rung fits a 300-line screen: the live
              // path, as before.
              const starved = await plan({
                ...remuxClient,
                videoCodecs: [{ codec: "h264", maxHeight: 300 }],
              });
              expect(starved).toMatchObject({ method: "transcode", url: null });

              // Without the source rung, a remux keeps the source over lower rungs.
              await db.delete(versions).where(eq(versions.id, idOf("source")));
              const live = await plan(remuxClient);
              expect(live.method).toBe("remux");
              const [liveSession] = await db
                .select({ decision: sessionRegistry.decision })
                .from(sessionRegistry)
                .where(eq(sessionRegistry.id, live.sessionId ?? ""));
              expect(liveSession?.decision?.storedVariantIds).toBeUndefined();
            } finally {
              await server.stop();
            }
          },
        );
      }),
    120_000,
  );
});
