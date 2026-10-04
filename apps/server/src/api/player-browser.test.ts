import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { setupAdmin } from "../auth/accounts.ts";
import { sessionCookieName } from "../auth/http.ts";
import { login } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { progress, sessionRegistry } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startPendia } from "../index.ts";
import { scanDirectory } from "../libraries/scan.ts";
import { createLibrary } from "../libraries/service.ts";
import { createVideoFixture } from "../mediums/video-common/fixtures.ts";

// Google Chrome comes first: Chromium builds without proprietary codecs cannot
// decode the H.264 and AAC fixtures.
const browser =
  Bun.env.PENDIA_BROWSER ??
  ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]
    .map((name) => Bun.which(name))
    .find((path) => path !== null) ??
  undefined;

const webBuild = fileURLToPath(
  new URL("../../../web/build/200.html", import.meta.url),
);

if (databaseUrl && browser === undefined)
  console.info(
    "Skipping the web player test: no Chromium found; set PENDIA_BROWSER.",
  );

const fixtureSeconds = 4;

async function run(command: string[]) {
  const proc = Bun.spawn(command, { stdout: "ignore", stderr: "pipe" });
  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${command[0]} failed: ${stderr}`);
}

async function waitForProgress(
  db: Database,
  userId: string,
  itemId: string,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await db
      .select()
      .from(progress)
      .where(and(eq(progress.userId, userId), eq(progress.itemId, itemId)));
    if (row?.completed) return row;
    await Bun.sleep(250);
  }
  return undefined;
}

describe.skipIf(!databaseUrl || browser === undefined)("web player", () => {
  let libraryRoot: string;

  beforeAll(async () => {
    libraryRoot = await mkdtemp(join(tmpdir(), "pendia-player-library-"));
    const fixture = {
      width: 1280,
      height: 720,
      durationSeconds: fixtureSeconds,
      frameRate: 25,
      gopSeconds: 2,
      pattern: "testsrc2" as const,
    };
    // The SRT stream is not WebVTT, so the planner remuxes the mkv.
    await mkdir(join(libraryRoot, "Remux (2026)"));
    await createVideoFixture(
      join(libraryRoot, "Remux (2026)", "Remux.mkv"),
      fixture,
    );
    // The same picture without subtitles, in mp4, plays directly.
    await mkdir(join(libraryRoot, "Direct (2026)"));
    await run([
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      join(libraryRoot, "Remux (2026)", "Remux.mkv"),
      "-map",
      "0:v",
      "-map",
      "0:a",
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      join(libraryRoot, "Direct (2026)", "Direct.mp4"),
    ]);
  }, 60_000);

  afterAll(async () => {
    await rm(libraryRoot, { recursive: true, force: true });
  });

  test(
    "plays a direct and a remux fixture to the end and records it",
    () =>
      withDatabase(async (db, url) => {
        if (browser === undefined) throw new Error("Expected a Chromium.");
        if (!existsSync(webBuild))
          throw new Error("Build apps/web before this test.");
        await migrateDatabase(db);
        const admin = await setupAdmin(db, {
          username: "admin",
          password: "secret",
        });
        const { token } = await login(
          db,
          {
            username: "admin",
            password: "secret",
            clientName: "Pendia Web",
            deviceId: "player-test",
            deviceName: "Chromium",
          },
          "127.0.0.1",
        );
        const library = await createLibrary(db, admin.id, {
          name: "Movies",
          medium: "movies",
          roots: [libraryRoot],
        });
        const scratchDir = await mkdtemp(
          join(tmpdir(), "pendia-player-scratch-"),
        );
        const server = await startPendia("all", {
          databaseUrl: url,
          port: 0,
          transcoderOptions: { port: 0, scratchDir },
        });
        const api = `http://127.0.0.1:${server.apiServer?.port}`;
        // Cookies ignore ports, so a page on another port can sign the
        // browser in to the api before sending it to the player.
        const signIn = Bun.serve({
          port: 0,
          hostname: "127.0.0.1",
          fetch(request) {
            const next = new URL(request.url).searchParams.get("next") ?? "/";
            return new Response(null, {
              status: 302,
              headers: {
                "set-cookie": `${sessionCookieName}=${token}; Path=/; HttpOnly; SameSite=Lax`,
                location: `${api}${next}`,
              },
            });
          },
        });
        try {
          for (const [folder, method] of [
            ["Direct (2026)", "direct-play"],
            ["Remux (2026)", "remux"],
          ] as const) {
            const scanned = await scanDirectory(db, library.id, folder);
            const versionId = scanned.versionIds[0];
            if (scanned.itemId === null || versionId === undefined)
              throw new Error(`Expected one Item and Version in ${folder}.`);
            const itemId = scanned.itemId;
            const profileDir = await mkdtemp(
              join(tmpdir(), "pendia-player-profile-"),
            );
            const next = `/play/${itemId}?version=${versionId}`;
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
                `http://127.0.0.1:${signIn.port}/?next=${encodeURIComponent(next)}`,
              ],
              { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
            );
            try {
              const row = await waitForProgress(db, admin.id, itemId, 40_000);
              expect(row?.versionId).toBe(versionId);
              expect(row?.positionSeconds).toBeGreaterThan(fixtureSeconds - 1);
              const sessions = await db
                .select({ method: sessionRegistry.playMethod })
                .from(sessionRegistry)
                .where(eq(sessionRegistry.itemId, itemId));
              expect(sessions).toEqual([{ method }]);
            } finally {
              proc.kill();
              await proc.exited;
              await rm(profileDir, { recursive: true, force: true });
            }
          }
        } finally {
          signIn.stop();
          await server.stop();
          await rm(scratchDir, { recursive: true, force: true });
        }
      }),
    120_000,
  );
});
