import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { thaliaRouter } from "../api/router.ts";
import { setupAdmin } from "../auth/accounts.ts";
import { createApiKey } from "../auth/sessions.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startThalia } from "../index.ts";
import {
  drain,
  scanFolder,
  twoRungPolicy,
  withStoredLibrary,
} from "./testing.ts";

// mkv is not in the profile, so a remux plan picks up both stored rungs.
const profile = {
  containers: ["mp4"],
  videoCodecs: [{ codec: "h264" }],
  audioCodecs: [{ codec: "aac", maxChannels: 2 }],
  subtitleFormats: ["srt"],
  hdr: ["sdr" as const],
};

// Chromium builds without proprietary codecs cannot decode H.264; prefer Chrome.
const browser =
  Bun.env.THALIA_BROWSER ??
  ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]
    .map((name) => Bun.which(name))
    .find((path) => path !== null) ??
  undefined;

type Report = {
  errors: string[];
  stalls: number;
  levels: number;
  heights: { at: number; height: number }[];
  playedTo: number;
};

// Starts on the 360p rung, asks for the source rung at 2 s and back for 360p
// at 6 s, then plays to the end. Heights are sampled as frames change size.
const page = (masterUrl: string) => `<!doctype html>
<video id="video" muted playsinline></video>
<script src="/hls.js"></script>
<script>
  const video = document.getElementById("video");
  const report = { errors: [], stalls: 0, levels: 0, heights: [], playedTo: 0 };
  let done = false;
  let step = 0;
  const finish = () => {
    if (done) return;
    done = true;
    report.playedTo = video.currentTime;
    fetch("/report", { method: "POST", body: JSON.stringify(report) });
  };
  const hls = new Hls({ startLevel: 0, capLevelToPlayerSize: false });
  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR) report.stalls++;
    if (!data.fatal) return;
    report.errors.push(data.type + ":" + data.details);
    finish();
  });
  hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
    report.levels = data.levels.length;
    hls.currentLevel = 0;
    video.play();
  });
  video.addEventListener("resize", () => {
    report.heights.push({ at: video.currentTime, height: video.videoHeight });
  });
  video.addEventListener("timeupdate", () => {
    if (step === 0 && video.currentTime >= 2) { step = 1; hls.nextLevel = 1; }
    if (step === 1 && video.currentTime >= 6) { step = 2; hls.nextLevel = 0; }
  });
  video.addEventListener("ended", finish);
  setTimeout(finish, 40000);
  hls.loadSource(${JSON.stringify(masterUrl)});
  hls.attachMedia(video);
</script>
`;

describe.skipIf(!databaseUrl || browser === undefined)(
  "hls.js on stored rungs",
  () => {
    test(
      "switches between two stored rungs both ways without a stall",
      () =>
        withDatabase(async (db, url) => {
          if (browser === undefined) throw new Error("Expected a browser.");
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
              // The api alone serves stored rungs; no transcoder runs.
              const server = await startThalia("api", {
                databaseUrl: url,
                port: 0,
              });
              const apiBase = `http://127.0.0.1:${server.apiServer?.port}`;
              const client = createORPCClient<
                RouterClient<typeof thaliaRouter>
              >(
                new RPCLink({
                  url: `${apiBase}/rpc`,
                  headers: { authorization: `Bearer ${token}` },
                }),
              );
              const planned = await client.playback.plan({
                itemId,
                versionId: version.id,
                profile,
              });
              const master = new URL(planned.url ?? "", apiBase);
              let resolveReport: (report: Report) => void = () => {};
              const reported = new Promise<Report>((resolve) => {
                resolveReport = resolve;
              });
              // The api sets no CORS headers, so the harness serves the page and
              // hls.js itself and proxies everything else to the api.
              const harness = Bun.serve({
                port: 0,
                async fetch(request) {
                  const requestUrl = new URL(request.url);
                  if (requestUrl.pathname === "/")
                    return new Response(page(master.pathname + master.search), {
                      headers: { "content-type": "text/html" },
                    });
                  if (requestUrl.pathname === "/hls.js")
                    return new Response(
                      Bun.file(
                        Bun.resolveSync(
                          "hls.js/dist/hls.min.js",
                          import.meta.dir,
                        ),
                      ),
                    );
                  if (requestUrl.pathname === "/report") {
                    resolveReport((await request.json()) as Report);
                    return new Response(null, { status: 204 });
                  }
                  const upstream = await fetch(
                    new URL(requestUrl.pathname + requestUrl.search, apiBase),
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
              const profileDir = await mkdtemp(
                join(tmpdir(), "thalia-stored-browser-"),
              );
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
                { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
              );
              try {
                const report = await Promise.race([
                  reported,
                  Bun.sleep(45_000).then(() => null),
                ]);
                if (report === null)
                  throw new Error("Timed out waiting for the browser report.");
                console.info("frame sizes", JSON.stringify(report.heights));
                expect(planned.method).toBe("remux");
                expect(report.levels).toBe(2);
                expect(report.errors).toEqual([]);
                expect(report.stalls).toBe(0);
                expect(report.playedTo).toBeGreaterThanOrEqual(11.9);
                // 360p, up to the 720p source, and back down.
                const heights = report.heights
                  .map((entry) => entry.height)
                  .filter((height, index, all) => height !== all[index - 1]);
                expect(heights).toEqual([360, 720, 360]);
                // Each switch lands on a segment boundary of the shared timeline.
                for (const entry of report.heights.slice(1))
                  expect(
                    Math.abs(entry.at - Math.round(entry.at / 3) * 3),
                  ).toBeLessThan(0.3);
              } finally {
                proc.kill();
                await proc.exited;
                harness.stop();
                await server.stop();
                await rm(profileDir, { recursive: true, force: true });
              }
            },
          );
        }),
      90_000,
    );
  },
);
