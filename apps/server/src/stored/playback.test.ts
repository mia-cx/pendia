import { describe, expect, test } from "bun:test";
import { rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import * as HLS from "hls-parser";
import type { thaliaRouter } from "../api/router.ts";
import { setupAdmin } from "../auth/accounts.ts";
import { createApiKey } from "../auth/sessions.ts";
import { migrateDatabase } from "../db/migrate.ts";
import type { JsonObject } from "../db/schema/common.ts";
import { sessionRegistry, versions } from "../db/schema/index.ts";
import {
  databaseUrl,
  runQueuedKeyframeIndexes,
  withDatabase,
} from "../db/testing.ts";
import { startThalia } from "../index.ts";
import { scanDirectory } from "../libraries/scan.ts";
import {
  drain,
  fixtureFolder,
  fixturePath,
  scanFolder,
  withStoredLibrary,
} from "./testing.ts";

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
          async ({ root, library, itemId, version }) => {
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

            const server = await startThalia("api", {
              databaseUrl: url,
              port: 0,
            });
            try {
              const base = `http://127.0.0.1:${server.apiServer?.port}`;
              const client = createORPCClient<
                RouterClient<typeof thaliaRouter>
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

              // Symlinks in a rung folder never lead reads out of the library.
              const sentinel = join(root, "..", `sentinel-${itemId}`);
              await writeFile(sentinel, "outside the library");
              try {
                const p360 = join(root, `${fixturePath}.thalia`, "360p");
                await rm(join(p360, "init.mp4"));
                await symlink(sentinel, join(p360, "init.mp4"));
                const sourceRung = join(
                  root,
                  `${fixturePath}.thalia`,
                  "source",
                );
                await rename(sourceRung, `${sourceRung}.moved`);
                await symlink(`${sourceRung}.moved`, sourceRung);
                for (const variant of master.variants) {
                  const mediaUrl = new URL(variant.uri, masterUrl);
                  const init = await fetch(
                    new URL(`init.mp4${mediaUrl.search}`, mediaUrl),
                  );
                  expect(init.status).toBe(404);
                }
              } finally {
                await rm(sentinel, { force: true });
              }

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

              // A cap under the live ladder's 1.5 Mbit/s floor has no live
              // path at all, but the 1 Mbit/s rung still fits.
              const belowLadder = await plan({
                ...remuxClient,
                maxBitrate: 1_200_000,
              });
              expect(belowLadder.method).toBe("remux");
              const [belowSession] = await db
                .select({ decision: sessionRegistry.decision })
                .from(sessionRegistry)
                .where(eq(sessionRegistry.id, belowLadder.sessionId ?? ""));
              expect(belowSession?.decision).toEqual({
                method: "stored",
                selection: { audio: 0 },
                storedVariantIds: [idOf("360p")],
              });
              const belowMaster = await get(
                new URL(belowLadder.url ?? "", base).href,
              );
              expect(await belowMaster.text()).toContain(
                `${idOf("360p")}/media.m3u8`,
              );

              // Only the incomplete 240p rung fits a 300-line screen: the live
              // path, a transcode session of its own.
              const starved = await plan({
                ...remuxClient,
                videoCodecs: [{ codec: "h264", maxHeight: 300 }],
              });
              expect(starved.method).toBe("transcode");
              expect(starved.url).toMatch(/\/hls\/master\.m3u8\?token=/);
              const [starvedRow] = await db
                .select({ decision: sessionRegistry.decision })
                .from(sessionRegistry)
                .where(eq(sessionRegistry.id, starved.sessionId ?? ""));
              expect(starvedRow?.decision?.storedVariantIds).toBeUndefined();

              // Another Version on the same timeline never borrows these rungs:
              // it may be another translation or release.
              await Bun.write(
                join(root, fixtureFolder, "Movie (2020).copy.mkv"),
                Bun.file(join(root, fixturePath)),
              );
              const rescanned = await scanDirectory(
                db,
                library.id,
                fixtureFolder,
              );
              await runQueuedKeyframeIndexes(db);
              const copyId = rescanned.versionIds.find(
                (id) => id !== version.id,
              );
              const copy = await client.playback.plan({
                itemId,
                versionId: copyId ?? "",
                profile: { ...remuxClient, maxBitrate: 1_500_000 },
              });
              expect(copy.method).toBe("transcode");
              const [copyRow] = await db
                .select({ decision: sessionRegistry.decision })
                .from(sessionRegistry)
                .where(eq(sessionRegistry.id, copy.sessionId ?? ""));
              expect(copyRow?.decision?.storedVariantIds).toBeUndefined();

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
