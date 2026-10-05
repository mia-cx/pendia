import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import { createApiKey } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { startPendia } from "../index.ts";

async function seed(db: Database) {
  const admin = await setupAdmin(db, {
    username: "admin",
    password: "admin-pass",
  });
  const { token } = await createApiKey(db, admin.id, "admin-key");
  const viewer = await createLocalUser(db, admin.id, {
    username: "viewer",
    password: "viewer-pass",
  });
  const { token: viewerToken } = await createApiKey(db, viewer.id, "v");
  return { admin, token, viewerToken };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe.skipIf(!databaseUrl)("folders api", () => {
  test("lists child folders, hides dots and symlinks, refuses symlink paths", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const { token } = await seed(db);
      const root = await mkdtemp(join(tmpdir(), "pendia-folders-"));
      await mkdir(join(root, "b"));
      await mkdir(join(root, "b", "inner"));
      await mkdir(join(root, "a"));
      await mkdir(join(root, "c10"));
      await mkdir(join(root, "c2"));
      await mkdir(join(root, ".hidden"));
      await writeFile(join(root, "notes.txt"), "");
      await symlink(join(root, "b"), join(root, "link"), "dir");
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const listing = await fetch(
          `${base}/api/folders?path=${encodeURIComponent(root)}`,
          { headers: bearer(token) },
        );
        expect(listing.status).toBe(200);
        expect(await listing.json()).toEqual({
          path: root,
          folders: [
            { name: "a", path: `${root}/a` },
            { name: "b", path: `${root}/b` },
            { name: "c2", path: `${root}/c2` },
            { name: "c10", path: `${root}/c10` },
          ],
        });

        for (const path of [`${root}/link`, `${root}/link/inner`]) {
          const through = await fetch(
            `${base}/api/folders?path=${encodeURIComponent(path)}`,
            { headers: bearer(token) },
          );
          expect(through.status).toBe(400);
          expect((await through.json()).message).toBe(
            "Pendia doesn't follow symbolic links.",
          );
        }

        const rootListing = await fetch(`${base}/api/folders`, {
          headers: bearer(token),
        });
        expect(rootListing.status).toBe(200);
        const body = (await rootListing.json()) as {
          path: string;
          folders: { name: string; path: string }[];
        };
        expect(body.path).toBe("/");
        expect(body.folders.length).toBeGreaterThan(0);
        expect(
          body.folders.every((folder) => folder.path.startsWith("/")),
        ).toBe(true);
      } finally {
        await server.stop();
      }
    }));

  test("a viewer cannot list folders", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const { viewerToken } = await seed(db);
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const denied = await fetch(`${base}/api/folders?path=/`, {
          headers: bearer(viewerToken),
        });
        expect(denied.status).toBe(403);
      } finally {
        await server.stop();
      }
    }));

  test("relative and missing paths answer 400 and 404", () =>
    withDatabase(async (db, url) => {
      await migrateDatabase(db);
      const { token } = await seed(db);
      const server = await startPendia("api", { databaseUrl: url, port: 0 });
      try {
        const base = `http://127.0.0.1:${server.apiServer?.port}`;
        const relative = await fetch(`${base}/api/folders?path=relative`, {
          headers: bearer(token),
        });
        expect(relative.status).toBe(400);
        const missing = await fetch(
          `${base}/api/folders?path=${encodeURIComponent("/pendia-no-such-folder")}`,
          { headers: bearer(token) },
        );
        expect(missing.status).toBe(404);
        expect((await missing.json()).message).toBe(
          "This folder doesn't exist.",
        );
      } finally {
        await server.stop();
      }
    }));

  test.skipIf(process.getuid?.() === 0)(
    "an unreadable folder answers 400",
    () =>
      withDatabase(async (db, url) => {
        await migrateDatabase(db);
        const { token } = await seed(db);
        const root = await mkdtemp(join(tmpdir(), "pendia-folders-"));
        const locked = join(root, "locked");
        await mkdir(locked);
        const server = await startPendia("api", {
          databaseUrl: url,
          port: 0,
        });
        try {
          await chmod(locked, 0);
          const base = `http://127.0.0.1:${server.apiServer?.port}`;
          const denied = await fetch(
            `${base}/api/folders?path=${encodeURIComponent(locked)}`,
            { headers: bearer(token) },
          );
          expect(denied.status).toBe(400);
          expect((await denied.json()).message).toBe(
            "Pendia can't read this folder. Check its permissions.",
          );
        } finally {
          await chmod(locked, 0o755).catch(() => {});
          await server.stop();
        }
      }),
  );
});
