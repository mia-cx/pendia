import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { asc, eq } from "drizzle-orm";
import * as HLS from "hls-parser";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import { createApiKey } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { events, sessionRegistry } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startPendia } from "../index.ts";
import { scanDirectory } from "../libraries/scan.ts";
import { createLibrary } from "../libraries/service.ts";
import {
  createVideoFixture,
  type VideoFixtureOptions,
} from "../mediums/video-common/fixtures.ts";
import { probeVideo } from "../mediums/video-common/probe.ts";
import type { pendiaRouter } from "./router.ts";

HLS.setOptions({ strictMode: true });

type Client = RouterClient<typeof pendiaRouter>;
type Profile = Parameters<Client["playback"]["plan"]>[0]["profile"];

// A browser without HEVC or AC-3 that renders only WebVTT.
const browser: Profile = {
  containers: ["mp4"],
  videoCodecs: [{ codec: "h264" }],
  audioCodecs: [{ codec: "aac", maxChannels: 2 }],
  subtitleFormats: ["webvtt"],
  hdr: ["sdr"],
};

const fixtures: Record<string, VideoFixtureOptions> = {
  // HEVC with SRT and ASS tracks: the video re-encodes, the text converts.
  Hevc: {
    width: 640,
    height: 360,
    durationSeconds: 6,
    frameRate: 25,
    gopSeconds: 3,
    pattern: "testsrc2",
    videoCodec: "hevc",
    subtitles: ["srt", "ass"],
  },
  // H.264 with AC-3 5.1: only the audio mismatches the browser.
  Surround: {
    width: 640,
    height: 360,
    durationSeconds: 6,
    frameRate: 25,
    gopSeconds: 3,
    pattern: "testsrc2",
    audioCodec: "ac3",
    audioChannels: 6,
  },
  // H.264 with a PGS track the browser cannot draw.
  Signs: {
    width: 320,
    height: 180,
    durationSeconds: 3,
    frameRate: 25,
    gopSeconds: 3,
    subtitles: ["pgs"],
  },
};

const runProcess = async (command: string[]) => {
  const proc = Bun.spawn(command, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command[0]} failed (${exitCode}): ${stderr.trim()}`);
  }
  return output;
};

/** Every video packet's timestamps and payload hash, for a packet-for-packet comparison. */
const videoPackets = async (path: string) =>
  (
    await runProcess([
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v",
      "-show_entries",
      "packet=pts,dts,data_hash",
      "-show_data_hash",
      "md5",
      "-of",
      "csv=p=0",
      "-i",
      path,
    ])
  )
    .split("\n")
    .filter((line) => line !== "");

describe.skipIf(!databaseUrl)("live transcode over HLS", () => {
  let libraryRoot: string;

  beforeAll(async () => {
    libraryRoot = await mkdtemp(join(tmpdir(), "pendia-transcode-library-"));
    await Promise.all(
      Object.entries(fixtures).map(async ([title, options]) => {
        const folder = join(libraryRoot, `${title} (2026)`);
        await mkdir(folder);
        await createVideoFixture(join(folder, `${title}.mkv`), options);
      }),
    );
  }, 60_000);

  afterAll(async () => {
    await rm(libraryRoot, { recursive: true, force: true });
  });

  const withServer = (
    run: (context: {
      db: Database;
      base: string;
      client: Client;
      server: Awaited<ReturnType<typeof startPendia>>;
      scan: (title: string) => Promise<{ itemId: string; versionId: string }>;
      dir: string;
    }) => Promise<void>,
  ) =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const admin = await setupAdmin(db, {
        username: "admin",
        password: "secret",
      });
      const owner = await createLocalUser(db, admin.id, {
        username: "owner",
        password: "owner-pass",
      });
      const { token } = await createApiKey(db, owner.id, "player");
      const library = await createLibrary(db, admin.id, {
        name: "Movies",
        medium: "movies",
        roots: [libraryRoot],
      });
      const dir = await mkdtemp(join(tmpdir(), "pendia-transcode-scratch-"));
      const server = await startPendia("all", {
        databaseUrl: url,
        port: 0,
        transcoderOptions: {
          port: 0,
          scratchDir: join(dir, "scratch"),
          idleMs: 30_000,
          waitMs: 10_000,
          transcodeSlots: 2,
        },
      });
      const base = `http://127.0.0.1:${server.apiServer?.port}`;
      try {
        await run({
          db,
          base,
          client: createORPCClient<Client>(
            new RPCLink({
              url: `${base}/rpc`,
              headers: { authorization: `Bearer ${token}` },
            }),
          ),
          server,
          dir,
          async scan(title) {
            const scanned = await scanDirectory(
              db,
              library.id,
              `${title} (2026)`,
            );
            const versionId = scanned.versionIds[0];
            if (scanned.itemId === null || versionId === undefined) {
              throw new Error(`Expected one item and Version in ${title}.`);
            }
            return { itemId: scanned.itemId, versionId };
          },
        });
      } finally {
        await server.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });

  /** Plans, then fetches the master, media, init and every segment the way a player would. */
  const play = async (
    context: { base: string; client: Client; dir: string },
    media: { itemId: string; versionId: string },
    profile: Profile,
  ) => {
    const planned = await context.client.playback.plan({ ...media, profile });
    if (planned.sessionId === null || planned.url === null) {
      throw new Error("An HLS plan must return a session and URL.");
    }
    const masterUrl = new URL(planned.url, context.base);
    const master = HLS.parse(await (await fetch(masterUrl)).text());
    if (!master.isMasterPlaylist) throw new Error("Expected a master.");
    const variant = master.variants[0];
    if (variant === undefined) throw new Error("Expected a variant.");
    const mediaUrl = new URL(variant.uri, masterUrl);
    const playlist = HLS.parse(await (await fetch(mediaUrl)).text());
    if (playlist.isMasterPlaylist) throw new Error("Expected media.");
    const parts: Uint8Array[] = [];
    const initUri = playlist.segments[0]?.map?.uri;
    if (initUri === undefined) throw new Error("Expected an init.");
    for (const uri of [initUri, ...playlist.segments.map((s) => s.uri)]) {
      const response = await fetch(new URL(uri, mediaUrl));
      expect(response.status).toBe(200);
      parts.push(await response.bytes());
    }
    const path = join(context.dir, `${planned.sessionId}.mp4`);
    await Bun.write(path, parts);
    return { planned, master, variant, masterUrl, path };
  };

  test(
    "an HEVC source plays as H.264 for a browser without HEVC, with its SRT and ASS as WebVTT",
    () =>
      withServer(async ({ db, base, client, dir, server, scan }) => {
        const media = await scan("Hevc");
        const { planned, variant, masterUrl, path } = await play(
          { base, client, dir },
          media,
          browser,
        );
        expect(planned.method).toBe("transcode");
        expect(variant.resolution).toEqual({ width: 640, height: 360 });
        const probe = await probeVideo(path);
        expect(
          probe.streams.find((stream) => stream.kind === "video"),
        ).toMatchObject({ codec: "h264", width: 640, height: 360 });
        expect(probe.durationSeconds).toBeCloseTo(6, 0);
        expect(
          (await server.transcoder?.sessions.inspect(planned.sessionId ?? ""))
            ?.video,
        ).toBe("transcode");

        expect(
          variant.subtitles.map((rendition) => rendition.language),
        ).toEqual(["nld", "eng"]);
        for (const rendition of variant.subtitles) {
          if (rendition.uri === undefined) throw new Error("Expected a URI.");
          const playlistUrl = new URL(rendition.uri, masterUrl);
          const playlist = HLS.parse(await (await fetch(playlistUrl)).text());
          if (playlist.isMasterPlaylist) throw new Error("Expected media.");
          const [segment] = playlist.segments;
          if (segment === undefined) throw new Error("Expected a segment.");
          const vtt = await fetch(new URL(segment.uri, playlistUrl));
          expect(vtt.headers.get("content-type")).toBe("text/vtt");
          const text = await vtt.text();
          expect(text.startsWith("WEBVTT")).toBe(true);
          expect(text).toContain("00:00.000 --> 00:00.800");
          expect(text).toContain("Fixture");
        }
        const [row] = await db
          .select({ decision: sessionRegistry.decision })
          .from(sessionRegistry)
          .where(eq(sessionRegistry.id, planned.sessionId ?? ""));
        expect(row?.decision).toMatchObject({
          subtitles: [
            { action: "convert", format: "webvtt", delivery: "sidecar" },
            { action: "convert", format: "webvtt", delivery: "sidecar" },
          ],
        });
      }),
    90_000,
  );

  test(
    "an audio-only mismatch re-encodes the audio and passes every video packet untouched",
    () =>
      withServer(async ({ base, client, dir, scan }) => {
        const media = await scan("Surround");
        const copied = await play({ base, client, dir }, media, {
          ...browser,
          audioCodecs: [{ codec: "ac3", maxChannels: 6 }],
        });
        expect(copied.planned.method).toBe("remux");
        const downmixed = await play({ base, client, dir }, media, browser);
        expect(downmixed.planned.method).toBe("transcode");

        const audio = (path: string) =>
          probeVideo(path).then((probe) =>
            probe.streams.find((stream) => stream.kind === "audio"),
          );
        expect(await audio(copied.path)).toMatchObject({
          codec: "ac3",
          channels: 6,
        });
        expect(await audio(downmixed.path)).toMatchObject({
          codec: "aac",
          channels: 2,
        });
        const packets = await videoPackets(downmixed.path);
        expect(packets.length).toBe(150);
        expect(packets).toEqual(await videoPackets(copied.path));
      }),
    90_000,
  );

  test(
    "a PGS track takes the burn-in path",
    () =>
      withServer(async ({ base, client, dir, server, scan }) => {
        const media = await scan("Signs");
        const { planned, variant, path } = await play(
          { base, client, dir },
          media,
          browser,
        );
        expect(planned.method).toBe("transcode");
        expect(variant.subtitles).toEqual([]);
        expect(
          await server.transcoder?.sessions.inspect(planned.sessionId ?? ""),
        ).toMatchObject({ video: "transcode", burnSubtitle: 0 });
        const probe = await probeVideo(path);
        expect(probe.streams.map((stream) => stream.kind)).toEqual([
          "video",
          "audio",
        ]);
      }),
    90_000,
  );

  test(
    "a third concurrent transcode queues and starts when the client stops one",
    () =>
      withServer(async ({ db, base, client, scan }) => {
        const media = await scan("Hevc");
        const plans = [];
        for (let count = 0; count < 3; count++) {
          const planned = await client.playback.plan({
            ...media,
            profile: browser,
          });
          if (planned.sessionId === null || planned.url === null) {
            throw new Error("Expected a session and URL.");
          }
          plans.push({ sessionId: planned.sessionId, url: planned.url });
        }
        const [first, second, third] = plans;
        if (!first || !second || !third) throw new Error("Expected three.");
        const segment = (plan: { url: string }, name: string) =>
          fetch(new URL(plan.url.replace("master.m3u8", name), base));

        for (const plan of [first, second]) {
          expect((await segment(plan, "master.m3u8")).status).toBe(200);
          expect((await segment(plan, "0.m4s")).status).toBe(200);
        }
        expect((await segment(third, "master.m3u8")).status).toBe(200);
        const state = async (sessionId: string) => {
          const [row] = await db
            .select({ state: sessionRegistry.state })
            .from(sessionRegistry)
            .where(eq(sessionRegistry.id, sessionId));
          return row?.state;
        };
        const until = async (sessionId: string, expected: string) => {
          const deadline = Date.now() + 5_000;
          while ((await state(sessionId)) !== expected) {
            if (Date.now() > deadline) {
              throw new Error(`${sessionId} never became ${expected}.`);
            }
            await Bun.sleep(20);
          }
        };
        await until(third.sessionId, "queued");

        const waiting = segment(third, "0.m4s");
        await Bun.sleep(300);
        await client.playback.stop({
          sessionId: first.sessionId,
          itemId: media.itemId,
          positionSeconds: 0,
        });
        const started = Date.now();
        const response = await waiting;
        expect(response.status).toBe(200);
        console.info(
          `queued session served ${Date.now() - started} ms after the stop`,
        );
        await until(third.sessionId, "starting");
        const kinds = (
          await db
            .select({ payload: events.payload })
            .from(events)
            .orderBy(asc(events.id))
        )
          .map(({ payload }) => payload)
          .filter(
            (payload) =>
              payload.kind === "session.state" &&
              payload.sessionId === third.sessionId,
          )
          .map((payload) => payload.state);
        // The plan announces the session, admission queues it, a free slot starts it.
        expect(kinds).toEqual(["starting", "queued", "starting"]);
      }),
    90_000,
  );
});
