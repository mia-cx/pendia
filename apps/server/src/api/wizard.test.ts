import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { AuthRouteError, readFailure } from "../../../web/src/lib/errors.ts";
import {
  createAdmin,
  runFirstRunWizard,
  setupOpen,
} from "../../../web/src/lib/wizard.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { items, versions } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startPendia } from "../index.ts";
import {
  createVideoFixture,
  withVideoFixture,
} from "../mediums/video-common/fixtures.ts";

async function populate(root: string) {
  const folder = join(root, "Alien (1979)");
  await mkdir(folder, { recursive: true });
  await createVideoFixture(join(folder, "Alien.mkv"), { width: 1920 });
  await createVideoFixture(join(folder, "Alien.720p.mkv"), {
    width: 1280,
    height: 720,
  });
}

describe.skipIf(!databaseUrl)("first-run wizard", () => {
  test("a fresh database reaches a scanned library through the wizard module", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      await withVideoFixture(async (root) => {
        await populate(root);
        const server = await startPendia("all", {
          databaseUrl: url,
          port: 0,
          workerOptions: { pollIntervalMs: 20 },
        });
        try {
          const base = `http://127.0.0.1:${server.apiServer?.port}`;
          expect(await setupOpen({ origin: base })).toBe(true);

          const { session, library, status } = await runFirstRunWizard(
            {
              username: "admin",
              password: "admin-pass",
              libraryName: "Movies",
              rootPath: root,
            },
            { origin: base, timeoutMs: 60_000 },
          );

          expect(library).toMatchObject({
            name: "Movies",
            medium: "movies",
            rootPath: root,
          });
          expect(status.counts.failed).toBe(0);
          expect(status.counts.completed).toBeGreaterThanOrEqual(2);
          expect(status.latest?.state).toBe("completed");

          const scanned = await db
            .select()
            .from(items)
            .where(eq(items.libraryId, library.id));
          expect(scanned).toHaveLength(1);
          expect(scanned[0]).toMatchObject({ title: "Alien", year: 1979 });
          expect(
            await db
              .select()
              .from(versions)
              .where(eq(versions.libraryId, library.id)),
          ).toHaveLength(2);

          const listed = await session.client.libraries.list();
          expect(listed.map((row) => row.id)).toContain(library.id);

          expect(await setupOpen({ origin: base })).toBe(false);
          const second = await createAdmin(
            { username: "other", password: "other-pass" },
            { origin: base },
          ).then(
            () => undefined,
            (error: unknown) => error,
          );
          expect(second).toBeInstanceOf(AuthRouteError);
          expect(readFailure(second).code).toBe("CONFLICT");
        } finally {
          await server.stop();
        }
      });
    }));
});
