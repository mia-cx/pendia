import { describe, expect, test } from "bun:test";
import { readArtworkStoreConfig } from "./artwork-backends.ts";

describe("readArtworkStoreConfig", () => {
  test("defaults to colocated without a fallback path", () => {
    expect(readArtworkStoreConfig({})).toEqual({ backend: "colocated" });
  });

  test("keeps the path as the colocated read-only fallback", () => {
    expect(
      readArtworkStoreConfig({ PENDIA_ARTWORK_PATH: "/srv/artwork" }),
    ).toEqual({ backend: "colocated", path: "/srv/artwork" });
  });

  test("selects the configured path", () => {
    expect(
      readArtworkStoreConfig({
        PENDIA_ARTWORK_STORE: "path",
        PENDIA_ARTWORK_PATH: "/srv/artwork",
      }),
    ).toEqual({ backend: "configured-path", path: "/srv/artwork" });
  });

  test("selects S3 from the bucket Bun's client reads", () => {
    for (const bucket of [{ S3_BUCKET: "art" }, { AWS_BUCKET: "art" }]) {
      const config = readArtworkStoreConfig({
        PENDIA_ARTWORK_STORE: "s3",
        ...bucket,
      });
      expect(config.backend).toBe("s3");
      if (config.backend === "s3")
        expect(config.client).toBeInstanceOf(Bun.S3Client);
    }
  });

  test("rejects incomplete and unknown choices", () => {
    expect(() =>
      readArtworkStoreConfig({ PENDIA_ARTWORK_STORE: "path" }),
    ).toThrow("PENDIA_ARTWORK_STORE=path needs PENDIA_ARTWORK_PATH.");
    expect(() =>
      readArtworkStoreConfig({ PENDIA_ARTWORK_PATH: "artwork" }),
    ).toThrow("PENDIA_ARTWORK_PATH must be an absolute path.");
    expect(() =>
      readArtworkStoreConfig({ PENDIA_ARTWORK_STORE: "s3" }),
    ).toThrow("PENDIA_ARTWORK_STORE=s3 needs S3_BUCKET.");
    expect(() =>
      readArtworkStoreConfig({ PENDIA_ARTWORK_STORE: "configured-path" }),
    ).toThrow(
      'PENDIA_ARTWORK_STORE must be colocated, path or s3. Found "configured-path".',
    );
  });
});
