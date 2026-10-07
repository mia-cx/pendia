import { describe, expect, test } from "bun:test";
import { access, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  artworkBackend,
  describeArtworkStore,
  readArtworkStoreConfig,
  writeArtworkOriginal,
} from "./artwork-backends.ts";

describe("readArtworkStoreConfig", () => {
  test("defaults to colocated without a fallback path", () => {
    expect(readArtworkStoreConfig({})).toEqual({ backend: "colocated" });
  });

  test("keeps the path as the colocated read-only fallback", () => {
    expect(
      readArtworkStoreConfig({ THALIA_ARTWORK_PATH: "/srv/artwork" }),
    ).toEqual({ backend: "colocated", path: "/srv/artwork" });
  });

  test("selects the configured path", () => {
    expect(
      readArtworkStoreConfig({
        THALIA_ARTWORK_STORE: "path",
        THALIA_ARTWORK_PATH: "/srv/artwork",
      }),
    ).toEqual({ backend: "configured-path", path: "/srv/artwork" });
  });

  test("selects S3 using S3_ or AWS_ configuration", () => {
    for (const prefix of ["S3", "AWS"]) {
      const config = readArtworkStoreConfig({
        THALIA_ARTWORK_STORE: "s3",
        [`${prefix}_BUCKET`]: "art",
        [`${prefix}_ACCESS_KEY_ID`]: "test-key",
        [`${prefix}_SECRET_ACCESS_KEY`]: "test-secret",
      });
      expect(config.backend).toBe("s3");
      if (config.backend === "s3")
        expect(config.client).toBeInstanceOf(Bun.S3Client);
      expect(describeArtworkStore(config)).toEqual({
        backend: "s3",
        path: null,
        bucket: "art",
        endpoint: null,
      });
    }
  });

  test("describes a directory store by its path", () => {
    expect(
      describeArtworkStore(
        readArtworkStoreConfig({
          THALIA_ARTWORK_STORE: "path",
          THALIA_ARTWORK_PATH: "/srv/artwork",
        }),
      ),
    ).toEqual({
      backend: "configured-path",
      path: "/srv/artwork",
      bucket: null,
      endpoint: null,
    });
  });

  test("rejects missing, partial and blank S3 credentials", () => {
    for (const credentials of [
      {},
      { S3_ACCESS_KEY_ID: "test-key" },
      { S3_SECRET_ACCESS_KEY: "test-secret" },
      { AWS_ACCESS_KEY_ID: "test-key" },
      { AWS_SECRET_ACCESS_KEY: "test-secret" },
      { S3_ACCESS_KEY_ID: " ", S3_SECRET_ACCESS_KEY: " " },
    ]) {
      expect(() =>
        readArtworkStoreConfig({
          THALIA_ARTWORK_STORE: "s3",
          S3_BUCKET: "art",
          ...credentials,
        }),
      ).toThrow(
        "THALIA_ARTWORK_STORE=s3 needs S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY (or AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY).",
      );
    }
  });

  test("rejects incomplete and unknown choices", () => {
    expect(() =>
      readArtworkStoreConfig({ THALIA_ARTWORK_STORE: "path" }),
    ).toThrow("THALIA_ARTWORK_STORE=path needs THALIA_ARTWORK_PATH.");
    expect(() =>
      readArtworkStoreConfig({ THALIA_ARTWORK_PATH: "artwork" }),
    ).toThrow("THALIA_ARTWORK_PATH must be an absolute path.");
    expect(() =>
      readArtworkStoreConfig({ THALIA_ARTWORK_STORE: "s3" }),
    ).toThrow("THALIA_ARTWORK_STORE=s3 needs S3_BUCKET.");
    expect(() =>
      readArtworkStoreConfig({ THALIA_ARTWORK_STORE: "configured-path" }),
    ).toThrow(
      'THALIA_ARTWORK_STORE must be colocated, path or s3. Found "configured-path".',
    );
  });
});

describe("configured artwork directory", () => {
  test("creates a missing root and round-trips an original", async () => {
    const parent = await mkdtemp(join(tmpdir(), "thalia-artwork-"));
    try {
      const store = {
        backend: "configured-path",
        path: join(parent, "new", "artwork"),
      } as const;
      const bytes = new Uint8Array([1, 2, 3]);
      await writeArtworkOriginal(store, "/unused", "Film", "poster", bytes);
      const backend = artworkBackend(store, "configured-path", "/unused");
      expect(await backend?.read("poster")).toEqual(bytes);
      expect(await backend?.exists("poster")).toBe(true);
      await backend?.remove("poster");
      expect(await backend?.exists("poster")).toBe(false);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("rejects symlinks in a configured root or its ancestors", async () => {
    const parent = await mkdtemp(join(tmpdir(), "thalia-artwork-"));
    try {
      await symlink(parent, join(parent, "link"));
      for (const path of [join(parent, "link"), join(parent, "link", "new")]) {
        await expect(
          writeArtworkOriginal(
            { backend: "configured-path", path },
            "/unused",
            "Film",
            "poster",
            new Uint8Array([1]),
          ),
        ).rejects.toThrow("Invalid artwork storage path.");
      }
      expect(await readdir(parent)).toEqual(["link"]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("does not create a missing colocated Library root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "thalia-artwork-"));
    try {
      const root = join(parent, "missing-library");
      await expect(
        writeArtworkOriginal(
          { backend: "colocated", path: join(parent, "fallback") },
          root,
          "Film",
          "poster",
          new Uint8Array([1]),
        ),
      ).rejects.toThrow("Invalid artwork storage path.");
      await expect(access(root)).rejects.toThrow();
      expect(await readdir(parent)).toEqual([]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
