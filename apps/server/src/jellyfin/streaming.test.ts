import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import * as HLS from "hls-parser";
import { sessionRegistry } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startPendia } from "../index.ts";
import { createVideoFixture } from "../mediums/video-common/fixtures.ts";
import { continueWatching } from "../playback/marks.ts";
import { deviceProfiles } from "./profile-fixtures.ts";
import { parseGuid, toGuid } from "./request.ts";
import { jellyfinLogin, seedMovies } from "./testing.ts";

HLS.setOptions({ strictMode: true });

const infuse =
  'MediaBrowser Client="Infuse-Direct", Version="8.5", Device="Apple TV", DeviceId="infuse-1"';
const swiftfin =
  'MediaBrowser Client="Swiftfin iOS", Version="1.3", Device="iPhone", DeviceId="swiftfin-1"';

type Source = {
  TranscodingUrl?: string;
  MediaStreams: { Type: string; DeliveryUrl?: string }[];
};

describe.skipIf(!databaseUrl)("jellyfin streaming", () => {
  let root: string;
  let path: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "pendia-jellyfin-streaming-"));
    await mkdir(join(root, "Atmos (2026)"));
    path = join(root, "Atmos (2026)", "Atmos.mkv");
    await createVideoFixture(path, {
      width: 320,
      height: 180,
      durationSeconds: 4,
      frameRate: 25,
      gopSeconds: 2,
      audioCodec: "truehd",
      audioChannels: 6,
    });
  }, 60_000);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test(
    "Infuse direct-plays the file and Swiftfin plays the transcode URL",
    () =>
      withDatabase(async (db, url) => {
        const { movies, viewer } = await seedMovies(db, root, ["Atmos"]);
        const movie = movies.get("Atmos");
        if (movie === undefined) throw new Error("Expected the movie.");
        const scratch = await mkdtemp(join(tmpdir(), "pendia-jellyfin-hls-"));
        const pendia = await startPendia("all", {
          databaseUrl: url,
          port: 0,
          transcoderOptions: {
            port: 0,
            scratchDir: join(scratch, "scratch"),
            idleMs: 30_000,
            waitMs: 20_000,
            transcodeSlots: 1,
          },
        });
        try {
          const base = `http://127.0.0.1:${pendia.apiServer?.port}`;
          const send = (request: Request) =>
            fetch(new URL(new URL(request.url).pathname, base), request);
          const itemGuid = toGuid(movie.itemId);
          const playbackInfo = async (
            headers: Record<string, string>,
            profile: object,
          ) => {
            const response = await fetch(
              `${base}/Items/${itemGuid}/PlaybackInfo`,
              {
                method: "POST",
                headers: { ...headers, "content-type": "application/json" },
                body: JSON.stringify({ DeviceProfile: profile }),
              },
            );
            expect(response.status).toBe(200);
            return (await response.json()) as {
              MediaSources: Source[];
              PlaySessionId: string;
            };
          };

          // Infuse: direct play, then the static stream it builds itself.
          const infuseToken = await jellyfinLogin(send, infuse);
          const infuseHeaders = {
            "X-Emby-Authorization": `${infuse}, Token="${infuseToken}"`,
          };
          await playbackInfo(infuseHeaders, deviceProfiles.infuse);
          const file = await Bun.file(path).bytes();
          const stream = `${base}/Videos/${itemGuid}/stream?static=true&mediaSourceId=${toGuid(movie.versionId)}`;
          const ranged = await fetch(stream, {
            headers: { ...infuseHeaders, range: "bytes=0-127" },
          });
          expect(ranged.status).toBe(206);
          expect(ranged.headers.get("content-range")).toBe(
            `bytes 0-127/${file.byteLength}`,
          );
          expect(await ranged.bytes()).toEqual(file.slice(0, 128));
          // jellyfin-web and Kodi spell it stream.mkv with ApiKey in the query.
          const keyed = await fetch(
            `${base}/Videos/${itemGuid}/stream.mkv?Static=true&ApiKey=${infuseToken}`,
          );
          expect(keyed.status).toBe(200);
          expect((await keyed.bytes()).byteLength).toBe(file.byteLength);
          expect((await fetch(stream)).status).toBe(401);

          // Swiftfin: follow TranscodingUrl and its playlists without headers.
          const swiftfinToken = await jellyfinLogin(send, swiftfin);
          const hls = await playbackInfo(
            { authorization: `${swiftfin}, Token="${swiftfinToken}"` },
            deviceProfiles.swiftfin,
          );
          const [source] = hls.MediaSources;
          const masterUrl = new URL(source?.TranscodingUrl ?? "", base);
          const masterResponse = await fetch(masterUrl);
          expect(masterResponse.status).toBe(200);
          const master = HLS.parse(await masterResponse.text());
          if (!master.isMasterPlaylist) throw new Error("Expected a master.");
          const variant = master.variants[0];
          if (variant === undefined) throw new Error("Expected a variant.");
          const mediaUrl = new URL(variant.uri, masterUrl);
          expect(mediaUrl.pathname).toStartWith(`/videos/${itemGuid}/`);
          const media = HLS.parse(await (await fetch(mediaUrl)).text());
          if (media.isMasterPlaylist) throw new Error("Expected media.");
          const initUri = media.segments[0]?.map?.uri;
          const firstUri = media.segments[0]?.uri;
          if (initUri === undefined || firstUri === undefined)
            throw new Error("Expected an init and a segment.");
          for (const uri of [initUri, firstUri]) {
            const segment = await fetch(new URL(uri, mediaUrl));
            expect(segment.status).toBe(200);
            expect((await segment.bytes()).byteLength).toBeGreaterThan(0);
          }
          // Jellyfin's own name for the media playlist reaches the same one.
          const main = new URL(masterUrl);
          main.pathname = main.pathname.replace("master.m3u8", "main.m3u8");
          expect((await fetch(main)).status).toBe(200);
          const forged = new URL(masterUrl);
          forged.searchParams.set("token", "forged");
          expect((await fetch(forged)).status).toBe(401);

          // The subtitle's DeliveryUrl carries the same session and token.
          const subtitle = source?.MediaStreams.find(
            (entry) => entry.Type === "Subtitle",
          );
          const vtt = await fetch(new URL(subtitle?.DeliveryUrl ?? "", base));
          expect(vtt.status).toBe(200);
          expect(vtt.headers.get("content-type")).toContain("text/vtt");
          const cues = await vtt.text();
          expect(cues).toStartWith("WEBVTT");
          expect(cues).toContain("Fixture");
          const bare = new URL(subtitle?.DeliveryUrl ?? "", base);
          bare.search = "";
          expect((await fetch(bare)).status).toBe(401);

          // Swiftfin reports against the session PlaybackInfo opened.
          const report = (path: string, seconds: number) =>
            fetch(`${base}${path}`, {
              method: "POST",
              headers: {
                authorization: `${swiftfin}, Token="${swiftfinToken}"`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                ItemId: itemGuid,
                MediaSourceId: toGuid(movie.versionId),
                PlaySessionId: hls.PlaySessionId,
                SessionId: hls.PlaySessionId,
                PositionTicks: seconds * 10_000_000,
                IsPaused: false,
              }),
            });
          expect((await report("/Sessions/Playing", 0)).status).toBe(204);
          expect((await report("/Sessions/Playing/Progress", 1)).status).toBe(
            204,
          );
          expect((await report("/Sessions/Playing/Stopped", 2)).status).toBe(
            204,
          );
          const [session] = await db
            .select()
            .from(sessionRegistry)
            .where(eq(sessionRegistry.id, parseGuid(hls.PlaySessionId) ?? ""));
          expect(session).toMatchObject({
            playMethod: "transcode",
            state: "stopped",
          });
          const shelf = await continueWatching(db, viewer.id, {});
          expect(shelf.items[0]?.progress).toMatchObject({
            itemId: movie.itemId,
            positionSeconds: 2,
            completed: false,
          });
        } finally {
          await pendia.stop();
          await rm(scratch, { recursive: true, force: true });
        }
      }),
    60_000,
  );
});
