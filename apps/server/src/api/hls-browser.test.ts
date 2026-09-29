import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import { createApiKey, login } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startPendia } from "../index.ts";
import { scanDirectory } from "../libraries/scan.ts";
import { createLibrary } from "../libraries/service.ts";
import { createVideoFixture } from "../mediums/video-common/fixtures.ts";
import type { pendiaRouter } from "./router.ts";

const device = {
  clientName: "Test Client",
  deviceId: "device-1",
  deviceName: "Living Room",
};

// The mkv container is not in the profile, so the engine decides remux.
const profile = {
  containers: ["mp4"],
  videoCodecs: [{ codec: "h264" }],
  audioCodecs: [{ codec: "aac", maxChannels: 2 }],
  subtitleFormats: ["srt"],
  hdr: ["sdr" as const],
};

function rpcClient(base: string, token?: string) {
  const link = new RPCLink({
    url: `${base}/rpc`,
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
  return createORPCClient<RouterClient<typeof pendiaRouter>>(link);
}

async function seed(db: Database) {
  const admin = await setupAdmin(db, {
    username: "admin",
    password: "secret",
  });
  const owner = await createLocalUser(db, admin.id, {
    username: "owner",
    password: "owner-pass",
  });
  const { token: accountToken } = await login(
    db,
    { username: "owner", password: "owner-pass", ...device },
    "127.0.0.1",
  );
  const { token: keyToken } = await createApiKey(db, owner.id, "player");
  return { admin, owner, accountToken, keyToken };
}

// Google Chrome comes first: Chromium builds without proprietary codecs cannot
// decode the H.264 and AAC fixture and fail with manifestIncompatibleCodecsError.
const browser =
  Bun.env.PENDIA_BROWSER ??
  ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]
    .map((name) => Bun.which(name))
    .find((path) => path !== null) ??
  undefined;

if (databaseUrl && browser === undefined)
  console.info(
    "Skipping browser playback test: no Chromium found; set PENDIA_BROWSER.",
  );
if (databaseUrl && browser !== undefined)
  console.info(`Browser playback test uses ${browser}.`);

type Report = {
  errors: string[];
  playedTo: number;
  seekedTo: number;
  width: number;
  height: number;
};

// The api sets no CORS headers, so the harness serves the page, hls.js and the
// report endpoint itself and proxies everything else to the api.
const page = (masterUrl: string) => `<!doctype html>
<video id="video" muted playsinline></video>
<script src="/hls.js"></script>
<script>
  const video = document.getElementById("video");
  const report = { errors: [], playedTo: 0, seekedTo: 0, width: 0, height: 0 };
  let seeked = false;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    report.width = video.videoWidth;
    report.height = video.videoHeight;
    fetch("/report", { method: "POST", body: JSON.stringify(report) });
  };
  const hls = new Hls();
  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (!data.fatal) return;
    report.errors.push(data.type + ":" + data.details);
    finish();
  });
  hls.on(Hls.Events.MANIFEST_PARSED, () => { video.play(); });
  video.addEventListener("timeupdate", () => {
    if (!seeked && video.currentTime >= 1) {
      seeked = true;
      report.playedTo = video.currentTime;
      video.currentTime = 9.5;
      return;
    }
    if (seeked && video.currentTime >= 10) {
      report.seekedTo = video.currentTime;
      finish();
    }
  });
  setTimeout(finish, 40000);
  hls.loadSource(${JSON.stringify(masterUrl)});
  hls.attachMedia(video);
</script>
`;

describe.skipIf(!databaseUrl || browser === undefined)(
  "hls.js playback",
  () => {
    let libraryRoot: string;

    beforeAll(async () => {
      libraryRoot = await mkdtemp(
        join(tmpdir(), "pendia-hls-browser-library-"),
      );
      const folder = join(libraryRoot, "Movie (2026)");
      await mkdir(folder);
      await createVideoFixture(join(folder, "Movie.mkv"), {
        width: 1920,
        height: 1080,
        durationSeconds: 12,
        frameRate: 25,
        gopSeconds: 3,
        pattern: "testsrc2",
      });
    }, 60_000);

    afterAll(async () => {
      await rm(libraryRoot, { recursive: true, force: true });
    });

    test(
      "plays a 1080p fixture in hls.js",
      () =>
        withDatabase(async (db, url) => {
          if (browser === undefined) {
            throw new Error("Expected a Chromium binary.");
          }
          await migrateDatabase(db);
          const fx = await seed(db);
          const library = await createLibrary(db, fx.admin.id, {
            name: "Movies",
            medium: "movies",
            rootPath: libraryRoot,
          });
          const scanned = await scanDirectory(db, library.id, "Movie (2026)");
          const versionId = scanned.versionIds[0];
          if (scanned.itemId === null || versionId === undefined) {
            throw new Error("Expected exactly one scanned item and version.");
          }
          const scratchDir = await mkdtemp(
            join(tmpdir(), "pendia-hls-browser-scratch-"),
          );
          const profileDir = await mkdtemp(
            join(tmpdir(), "pendia-hls-browser-profile-"),
          );
          const server = await startPendia("all", {
            databaseUrl: url,
            port: 0,
            transcoderOptions: {
              port: 0,
              scratchDir,
              idleMs: 10_000,
              waitMs: 5_000,
              readRate: { rate: 1, initialBurstSeconds: 3.5 },
            },
          });
          let resolveReport: (report: Report) => void = () => {};
          const reported = new Promise<Report>((resolve) => {
            resolveReport = resolve;
          });
          const apiBase = `http://127.0.0.1:${server.apiServer?.port}`;
          const client = rpcClient(apiBase, fx.keyToken);
          const planned = await client.playback.plan({
            itemId: scanned.itemId,
            versionId,
            profile,
          });
          if (planned.sessionId === null || planned.url === null) {
            throw new Error("Remux must return a session and URL.");
          }
          const sessionId = planned.sessionId;
          const master = new URL(planned.url, apiBase);
          const masterUrl = master.pathname + master.search;
          const harness = Bun.serve({
            port: 0,
            async fetch(request) {
              const requestUrl = new URL(request.url);
              if (requestUrl.pathname === "/") {
                return new Response(page(masterUrl), {
                  headers: { "content-type": "text/html" },
                });
              }
              if (requestUrl.pathname === "/hls.js") {
                return new Response(
                  Bun.file(
                    Bun.resolveSync("hls.js/dist/hls.min.js", import.meta.dir),
                  ),
                );
              }
              if (requestUrl.pathname === "/report") {
                resolveReport((await request.json()) as Report);
                return new Response(null, { status: 204 });
              }
              const upstream = await fetch(
                new URL(requestUrl.pathname + requestUrl.search, apiBase),
                { method: request.method },
              );
              return new Response(upstream.body, {
                status: upstream.status,
                headers: {
                  "content-type":
                    upstream.headers.get("content-type") ??
                    "application/octet-stream",
                },
              });
            },
          });
          const proc = Bun.spawn(
            [
              browser,
              "--headless=new",
              "--no-sandbox",
              "--disable-gpu",
              "--disable-dev-shm-usage",
              "--no-first-run",
              "--mute-audio",
              "--autoplay-policy=no-user-gesture-required",
              `--user-data-dir=${profileDir}`,
              `http://127.0.0.1:${harness.port}/`,
            ],
            { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
          );
          const stderr = new Response(proc.stderr).text();
          try {
            const report = await Promise.race([
              reported,
              Bun.sleep(45_000).then(() => "timeout" as const),
            ]);
            if (report === "timeout") {
              proc.kill();
              await proc.exited;
              throw new Error(
                `Timed out waiting for the browser report.\n${await stderr}`,
              );
            }
            expect(report.errors).toEqual([]);
            expect(report.width).toBe(1920);
            expect(report.height).toBe(1080);
            expect(report.playedTo).toBeGreaterThanOrEqual(1);
            expect(report.seekedTo).toBeGreaterThanOrEqual(10);
            console.info(
              "runs",
              (await server.transcoder?.sessions.inspect(sessionId))?.runs,
            );
          } finally {
            proc.kill();
            await proc.exited;
            harness.stop();
            await server.stop();
            await rm(profileDir, { recursive: true, force: true });
            await rm(scratchDir, { recursive: true, force: true });
          }
        }),
      60_000,
    );
  },
);
