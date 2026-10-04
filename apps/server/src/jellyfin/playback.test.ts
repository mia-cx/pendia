import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { createVideoFixture } from "../mediums/video-common/fixtures.ts";
import { createArtworkHandler } from "../metadata/artwork-http.ts";
import { createJellyfinHandler } from "./http.ts";
import { deviceProfiles } from "./profile-fixtures.ts";
import { toGuid } from "./request.ts";
import { jellyfinRoutes } from "./routes.ts";
import { contractErrors, jellyfinLogin, seedMovies } from "./testing.ts";

const infuse =
  'MediaBrowser Client="Infuse-Direct", Version="8.5", Device="Apple TV", DeviceId="infuse-1"';
const swiftfin =
  'MediaBrowser Client="Swiftfin iOS", Version="1.3", Device="iPhone", DeviceId="swiftfin-1"';
const findroid =
  'MediaBrowser Client="Findroid", Version="0.15.4", Device="Pixel", DeviceId="findroid-1"';

type Source = {
  Id: string;
  SupportsDirectPlay: boolean;
  SupportsDirectStream: boolean;
  SupportsTranscoding: boolean;
  TranscodingUrl?: string;
  TranscodingSubProtocol: string;
  MediaStreams: {
    Type: string;
    Codec: string;
    DeliveryMethod?: string;
    DeliveryUrl?: string;
  }[];
};
type PlaybackInfo = { MediaSources: Source[]; PlaySessionId?: string };

describe.skipIf(!databaseUrl)("jellyfin PlaybackInfo", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "pendia-jellyfin-playback-"));
    await mkdir(join(root, "Atmos (2026)"));
    // H.264 with 5.1 TrueHD and an SRT: an Infuse file, but not HLS-safe audio.
    await createVideoFixture(join(root, "Atmos (2026)", "Atmos.mkv"), {
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

  test("offers TrueHD direct play only to Infuse and a transcode to Swiftfin", () =>
    withDatabase(async (db) => {
      const { movies } = await seedMovies(db, root, ["Atmos"]);
      const movie = movies.get("Atmos");
      if (movie === undefined) throw new Error("Expected the movie.");
      const handle = createJellyfinHandler(
        db,
        jellyfinRoutes(createArtworkHandler(db)),
      );
      const send = async (request: Request) => {
        const response = await handle(request, "127.0.0.1");
        if (response === undefined) throw new Error("Unrouted.");
        return response;
      };
      const playbackInfo = async (
        name: string,
        header: string,
        token: string,
        body: object,
      ) => {
        const response = await send(
          new Request(
            `http://pendia.test/Items/${toGuid(movie.itemId)}/PlaybackInfo`,
            {
              method: "POST",
              headers: {
                [name]: `${header}, Token="${token}"`,
                "content-type": "application/json",
              },
              body: JSON.stringify(body),
            },
          ),
        );
        return { status: response.status, body: await response.json() };
      };

      // Infuse sends its header as X-Emby-Authorization.
      const infuseToken = await jellyfinLogin(send, infuse);
      const direct = await playbackInfo(
        "X-Emby-Authorization",
        infuse,
        infuseToken,
        {
          DeviceProfile: deviceProfiles.infuse,
          MediaSourceId: toGuid(movie.itemId),
        },
      );
      expect(direct.status).toBe(200);
      expect(contractErrors("PlaybackInfoResponse", direct.body)).toEqual([]);
      const directInfo = direct.body as PlaybackInfo;
      expect(directInfo.PlaySessionId).toMatch(/^[0-9a-f]{32}$/);
      const [directSource] = directInfo.MediaSources;
      expect(directSource).toMatchObject({
        Id: toGuid(movie.versionId),
        Protocol: "File",
        Container: "mkv",
        SupportsDirectPlay: true,
        SupportsDirectStream: false,
        SupportsTranscoding: false,
        TranscodingSubProtocol: "http",
      });
      expect(directSource?.TranscodingUrl).toBeUndefined();
      expect(
        directSource?.MediaStreams.map((stream) => [
          stream.Type,
          stream.Codec,
          stream.DeliveryMethod,
        ]),
      ).toEqual([
        ["Video", "h264", undefined],
        ["Audio", "truehd", undefined],
        ["Subtitle", "subrip", "Embed"],
      ]);

      // Swiftfin's AVPlayer takes only HLS and cannot decode TrueHD.
      const swiftfinToken = await jellyfinLogin(send, swiftfin);
      const hls = await playbackInfo("Authorization", swiftfin, swiftfinToken, {
        DeviceProfile: deviceProfiles.swiftfin,
        MaxStreamingBitrate: 20_000_000,
      });
      expect(hls.status).toBe(200);
      expect(contractErrors("PlaybackInfoResponse", hls.body)).toEqual([]);
      const hlsInfo = hls.body as PlaybackInfo;
      const [hlsSource] = hlsInfo.MediaSources;
      expect(hlsSource).toMatchObject({
        SupportsDirectPlay: false,
        SupportsDirectStream: false,
        SupportsTranscoding: true,
        TranscodingSubProtocol: "hls",
        TranscodingContainer: "mp4",
      });
      const url = new URL(
        hlsSource?.TranscodingUrl ?? "",
        "http://pendia.test",
      );
      expect(url.pathname).toBe(`/videos/${toGuid(movie.itemId)}/master.m3u8`);
      expect(url.searchParams.get("PlaySessionId")).toBe(
        hlsInfo.PlaySessionId ?? "",
      );
      expect(url.searchParams.get("MediaSourceId")).toBe(
        toGuid(movie.versionId),
      );
      expect(url.searchParams.get("token")).toBeTruthy();
      const subtitle = hlsSource?.MediaStreams.find(
        (stream) => stream.Type === "Subtitle",
      );
      expect(subtitle?.DeliveryMethod).toBe("Hls");
      expect(subtitle?.DeliveryUrl).toStartWith(
        `/videos/${toGuid(movie.itemId)}/${toGuid(movie.versionId)}/Subtitles/2/Stream.vtt?`,
      );

      // Findroid's empty profile plans nothing, and still gets its source.
      const findroidToken = await jellyfinLogin(send, findroid);
      const none = await playbackInfo(
        "Authorization",
        findroid,
        findroidToken,
        {
          DeviceProfile: deviceProfiles.findroid,
        },
      );
      expect(none.status).toBe(200);
      expect(contractErrors("PlaybackInfoResponse", none.body)).toEqual([]);
      expect(none.body).not.toHaveProperty("PlaySessionId");
      expect((none.body as PlaybackInfo).MediaSources[0]).toMatchObject({
        SupportsDirectPlay: false,
        SupportsDirectStream: false,
        SupportsTranscoding: false,
      });

      const unknown = await playbackInfo(
        "Authorization",
        findroid,
        findroidToken,
        {
          DeviceProfile: deviceProfiles.findroid,
          MediaSourceId: toGuid(crypto.randomUUID()),
        },
      );
      expect(unknown.status).toBe(404);
      const anonymous = await send(
        new Request(
          `http://pendia.test/Items/${toGuid(movie.itemId)}/PlaybackInfo`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          },
        ),
      );
      expect(anonymous.status).toBe(401);

      // The detail lists every Version as a source before anything is planned.
      const detail = await send(
        new Request(`http://pendia.test/Items/${toGuid(movie.itemId)}`, {
          headers: { authorization: `${findroid}, Token="${findroidToken}"` },
        }),
      );
      const detailBody = (await detail.json()) as {
        MediaSources: Source[];
        MediaStreams: unknown[];
      };
      expect(contractErrors("BaseItemDto", detailBody)).toEqual([]);
      expect(detailBody.MediaSources.map((source) => source.Id)).toEqual([
        toGuid(movie.versionId),
      ]);
      expect(detailBody.MediaStreams).toHaveLength(3);
    }));
});
