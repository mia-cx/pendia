import { isAbsolute } from "node:path";

/** Where this process stores new artwork originals, chosen once at setup. */
export type ArtworkStoreConfig =
  // path is the fallback for a read-only media share.
  | { backend: "colocated"; path?: string }
  | { backend: "configured-path"; path: string }
  | { backend: "s3"; client: Bun.S3Client };

/** Reads the artwork store choice from environment variables. */
export function readArtworkStoreConfig(
  env: Record<string, string | undefined>,
): ArtworkStoreConfig {
  const path = env.PENDIA_ARTWORK_PATH?.trim() || undefined;
  if (path !== undefined && !isAbsolute(path))
    throw new Error("PENDIA_ARTWORK_PATH must be an absolute path.");
  const store = env.PENDIA_ARTWORK_STORE?.trim() || "colocated";
  if (store === "colocated")
    return path === undefined
      ? { backend: "colocated" }
      : { backend: "colocated", path };
  if (store === "path") {
    if (path === undefined)
      throw new Error("PENDIA_ARTWORK_STORE=path needs PENDIA_ARTWORK_PATH.");
    return { backend: "configured-path", path };
  }
  if (store === "s3") {
    // The same names Bun's S3 client reads, S3_ first, then AWS_.
    const s3 = (name: string) =>
      env[`S3_${name}`]?.trim() || env[`AWS_${name}`]?.trim() || undefined;
    const bucket = s3("BUCKET");
    if (bucket === undefined)
      throw new Error("PENDIA_ARTWORK_STORE=s3 needs S3_BUCKET.");
    return {
      backend: "s3",
      client: new Bun.S3Client({
        bucket,
        endpoint: s3("ENDPOINT"),
        region: s3("REGION"),
        accessKeyId: s3("ACCESS_KEY_ID"),
        secretAccessKey: s3("SECRET_ACCESS_KEY"),
      }),
    };
  }
  throw new Error(
    `PENDIA_ARTWORK_STORE must be colocated, path or s3. Found "${store}".`,
  );
}

let fromEnvironment: ArtworkStoreConfig | undefined;

/** The process artwork store, read from the environment on first use. */
export function artworkStoreConfig(): ArtworkStoreConfig {
  fromEnvironment ??= readArtworkStoreConfig(Bun.env);
  return fromEnvironment;
}
