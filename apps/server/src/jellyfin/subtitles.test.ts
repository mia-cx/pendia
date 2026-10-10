import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { createHlsHandler } from "../api/hls.ts";
import type { Database } from "../db/client.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import {
  createVideoFixture,
  withVideoFixture,
} from "../mediums/video-common/fixtures.ts";
import { createArtworkHandler } from "../metadata/artwork-http.ts";
import { listSubtitles } from "../subtitles/store.ts";
import { createJellyfinHandler } from "./http.ts";
import { deviceProfiles } from "./profile-fixtures.ts";
import { toGuid } from "./request.ts";
import { jellyfinRoutes } from "./routes.ts";
import {
  fixtureSubtitleProvider,
  jellyfinLogin,
  seedMovies,
} from "./testing.ts";

const header =
  'MediaBrowser Client="Subtitles", Device="Player", DeviceId="subtitles-1"';

async function fixture(db: Database, root: string) {
  await mkdir(`${root}/Subtitles (2026)`);
  await createVideoFixture(`${root}/Subtitles (2026)/Subtitles.mkv`, {
    width: 64,
    height: 64,
    durationSeconds: 2,
    gopSeconds: 1,
    subtitles: ["srt"],
  });
  const { movies } = await seedMovies(db, root, ["Subtitles"]);
  const movie = movies.get("Subtitles");
  if (movie === undefined) throw new Error("Missing subtitle movie");
  const handler = createJellyfinHandler(
    db,
    jellyfinRoutes(
      createArtworkHandler(db),
      createHlsHandler(db),
      {},
      {
        plugins: { subtitleProviders: async () => [fixtureSubtitleProvider] },
      },
    ),
  );
  const send = async (request: Request) => {
    const response = await handler(request, "127.0.0.1");
    if (response === undefined) throw new Error("Unrouted subtitle request");
    return response;
  };
  const admin = await jellyfinLogin(send, header, "admin", "admin-pass");
  const viewer = await jellyfinLogin(send, header);
  const call = (method: string, path: string, body?: object, token = admin) =>
    send(
      new Request(new URL(path, "http://thalia.test"), {
        method,
        headers: {
          Authorization: header,
          "X-Emby-Token": token,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  return {
    ...movie,
    id: toGuid(movie.itemId),
    source: toGuid(movie.versionId),
    send,
    call,
    admin,
    viewer,
  };
}

type MediaSource = {
  DefaultSubtitleStreamIndex?: number;
  SupportsDirectPlay: boolean;
  MediaStreams: {
    Index: number;
    Type: string;
    Language?: string;
    IsExternal?: boolean;
    IsForced?: boolean;
    IsHearingImpaired?: boolean;
    DeliveryUrl?: string;
  }[];
};
type PlaybackInfo = { MediaSources: MediaSource[] };

describe.skipIf(!databaseUrl)("Jellyfin subtitles", () => {
  test(
    "configured provider matches and flagged uploads become playable external tracks; management permissions apply",
    () =>
      withDatabase((db) =>
        withVideoFixture(async (root) => {
          const f = await fixture(db, root);
          const searchPath = `/Items/${f.id}/RemoteSearch/Subtitles/eng`;
          const response = await f.call("GET", searchPath);
          expect(response.status).toBe(200);
          const matches = (await response.json()) as {
            Id: string;
            ProviderName: string;
            ThreeLetterISOLanguageName: string;
          }[];
          expect(matches).toMatchObject([
            {
              ProviderName: "fixture-subtitles",
              ThreeLetterISOLanguageName: "eng",
            },
          ]);
          const remoteId = matches[0]?.Id;
          if (remoteId === undefined) throw new Error("Missing provider match");
          expect(
            (await f.call("GET", searchPath, undefined, f.viewer)).status,
          ).toBe(403);
          expect(
            (
              await f.call(
                "GET",
                `/Providers/Subtitles/Subtitles/${remoteId}`,
                undefined,
                f.viewer,
              )
            ).status,
          ).toBe(403);
          const remote = await f.call(
            "GET",
            `/Providers/Subtitles/Subtitles/${remoteId}`,
          );
          expect(remote.status).toBe(200);
          expect(await remote.text()).toContain("Provider subtitle.");
          expect(
            (
              await f.call(
                "POST",
                `/Items/${f.id}/RemoteSearch/Subtitles/${remoteId}`,
              )
            ).status,
          ).toBe(204);
          expect(await listSubtitles(db, f.itemId)).toEqual([
            { language: "en", format: "srt" },
          ]);

          const upload = {
            Language: "nl",
            Format: "srt",
            IsForced: true,
            IsHearingImpaired: true,
            Data: Buffer.from(
              "1\n00:00:00,200 --> 00:00:01,600\nUploaded subtitle.\n",
            ).toString("base64"),
          };
          const uploadPath = `/Videos/${f.id}/Subtitles`;
          expect(
            (await f.call("POST", uploadPath, upload, f.viewer)).status,
          ).toBe(403);
          expect(
            (await f.call("POST", uploadPath, { ...upload, Data: "%%%" }))
              .status,
          ).toBe(400);
          expect(
            (
              await f.call("POST", uploadPath, {
                ...upload,
                Language: "../escape",
              })
            ).status,
          ).toBe(400);
          expect((await f.call("POST", uploadPath, upload)).status).toBe(204);
          expect(await listSubtitles(db, f.itemId)).toContainEqual({
            language: "nl",
            format: "srt",
            forced: true,
            hearingImpaired: true,
          });
          const info = (await (
            await f.call("GET", `/Items/${f.id}/PlaybackInfo`)
          ).json()) as PlaybackInfo;
          const external = info.MediaSources[0]?.MediaStreams.find(
            (stream) => stream.IsExternal && stream.Language === "nl",
          );
          expect(external).toMatchObject({
            Type: "Subtitle",
            IsForced: true,
            IsHearingImpaired: true,
          });
          if (external === undefined) throw new Error("Missing uploaded track");
          const plannedResponse = await f.call(
            "POST",
            `/Items/${f.id}/PlaybackInfo`,
            {
              DeviceProfile: deviceProfiles.infuse,
              SubtitleStreamIndex: external.Index,
            },
          );
          expect(plannedResponse.status).toBe(200);
          const planned = (await plannedResponse.json()) as PlaybackInfo;
          expect(planned.MediaSources[0]).toMatchObject({
            SupportsDirectPlay: true,
            DefaultSubtitleStreamIndex: external.Index,
          });
          const delivery = planned.MediaSources[0]?.MediaStreams.find(
            (stream) => stream.Index === external.Index,
          )?.DeliveryUrl;
          if (delivery === undefined)
            throw new Error("Missing subtitle delivery URL");
          const track = await f.send(
            new Request(new URL(delivery, "http://thalia.test")),
          );
          expect(track.status).toBe(200);
          expect(await track.text()).toContain("Uploaded subtitle.");
          expect(
            (
              await f.call("POST", uploadPath, {
                ...upload,
                Data: Buffer.from(
                  "1\n00:00:00,200 --> 00:00:01,600\nReplaced subtitle.\n",
                ).toString("base64"),
              })
            ).status,
          ).toBe(204);
          const replaced = await f.send(
            new Request(new URL(delivery, "http://thalia.test")),
          );
          expect(replaced.status).toBe(200);
          expect(await replaced.text()).toContain("Replaced subtitle.");
          expect(
            (
              await f.call(
                "DELETE",
                `/Videos/${f.id}/Subtitles/${external.Index}`,
                undefined,
                f.viewer,
              )
            ).status,
          ).toBe(403);
          expect(
            (
              await f.call(
                "DELETE",
                `/Videos/${f.id}/Subtitles/${external.Index}`,
              )
            ).status,
          ).toBe(204);
          expect(await listSubtitles(db, f.itemId)).toEqual([
            { language: "en", format: "srt" },
          ]);
        }),
      ),
    60_000,
  );

  test(
    "embedded streams convert formats and clip/rebase windows; HLS subtitle segments retain authentication and timestamps",
    () =>
      withDatabase((db) =>
        withVideoFixture(async (root) => {
          const f = await fixture(db, root);
          const path = `/Videos/${f.id}/${f.source}/Subtitles/2`;
          for (const [format, marker] of [
            ["vtt", "WEBVTT"],
            ["srt", "00:00:00,000"],
            ["ass", "Dialogue:"],
          ] as const) {
            const response = await f.call(
              "GET",
              `${path}/Stream.${format}`,
              undefined,
              f.viewer,
            );
            expect(response.status).toBe(200);
            const text = await response.text();
            expect(text).toContain(marker);
            expect(text).toContain("Fixture");
          }
          const relative = await f.call(
            "GET",
            `${path}/2000000/Stream.vtt?endPositionTicks=7000000`,
          );
          expect(relative.status).toBe(200);
          expect(await relative.text()).toContain(
            "00:00:00.000 --> 00:00:00.500",
          );
          const copied = await f.call(
            "GET",
            `${path}/2000000/Stream.vtt?endPositionTicks=7000000&copyTimestamps=true&addVttTimeMap=true`,
          );
          expect(copied.status).toBe(200);
          const copiedText = await copied.text();
          expect(copiedText).toContain("00:00:00.200 --> 00:00:00.700");
          expect(copiedText).toContain(
            "X-TIMESTAMP-MAP=LOCAL:00:00:00.200,MPEGTS:18000",
          );
          expect(
            (
              await f.call(
                "GET",
                `${path}/Stream.vtt?startPositionTicks=7000000&endPositionTicks=2000000`,
              )
            ).status,
          ).toBe(400);
          expect(
            (await f.send(new Request(`http://thalia.test${path}/Stream.vtt`)))
              .status,
          ).toBe(401);
          const playlistUrl = new URL(
            `http://thalia.test${path}/subtitles.m3u8?segmentLength=1&api_key=${f.admin}`,
          );
          const playlist = await f.send(new Request(playlistUrl));
          expect(playlist.status).toBe(200);
          const text = await playlist.text();
          expect(text).toContain("#EXT-X-TARGETDURATION:1");
          expect(text).toContain("#EXT-X-ENDLIST");
          const segments = text
            .split("\n")
            .filter((line) => line !== "" && !line.startsWith("#"));
          expect(segments.length).toBeGreaterThanOrEqual(2);
          for (const [index, segment] of segments.slice(0, 2).entries()) {
            const response = await f.send(
              new Request(new URL(segment, playlistUrl)),
            );
            expect(response.status).toBe(200);
            const body = await response.text();
            expect(body).toContain(`MPEGTS:${index * 90_000}`);
            if (index === 0) expect(body).toContain("Fixture");
            else expect(body).not.toContain("Fixture");
          }
        }),
      ),
    60_000,
  );
});
