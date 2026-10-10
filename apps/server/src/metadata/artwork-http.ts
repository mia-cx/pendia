import { eq } from "drizzle-orm";
import { AuthError } from "../auth/errors.ts";
import { readSessionToken } from "../auth/http.ts";
import { requirePermission } from "../auth/permissions.ts";
import { authenticate } from "../auth/sessions.ts";
import { readAuthSettings } from "../auth/settings.ts";
import type { Database } from "../db/client.ts";
import { artwork, items, versions } from "../db/schema/index.ts";
import {
  type ArtworkStoreConfig,
  artworkStoreConfig,
} from "./artwork-backends.ts";
import { readArtworkOriginal } from "./artwork-store.ts";

/** A resize operation used by the process-local artwork cache. */
export type ArtworkResize = (
  input: Uint8Array,
  width: number,
  options?: { format?: "jpeg" | "png" | "webp"; quality?: number },
) => Promise<{ bytes: Uint8Array; contentType: string }>;

type ArtworkResult = {
  body: Blob;
  byteLength: number;
  contentType: string;
  etag: string;
};

const routePrefix = "/api/artwork/";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const widthPattern = /^[0-9]+$/;
/** The widest resize the artwork route serves. */
export const maxArtworkWidth = 4096;

const imageTypes: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  heic: "image/heic",
  jpeg: "image/jpeg",
  png: "image/png",
  tiff: "image/tiff",
  webp: "image/webp",
};

// Bun.Image needs no native addon, so it works inside the compiled binary.
const bunResize: ArtworkResize = async (
  input,
  width,
  { format, quality } = {},
) => {
  const image = new Bun.Image(input);
  const source = await image.metadata();
  // Never enlarge: a small original is served at its own width.
  const resized = image.resize(Math.min(width, source.width));
  const encoded =
    format === "jpeg"
      ? resized.jpeg({ quality })
      : format === "png"
        ? resized.png()
        : format === "webp"
          ? resized.webp({ quality })
          : resized;
  const bytes = await encoded.bytes();
  // Some formats re-encode differently (GIF becomes PNG), so the type
  // comes from the output header, not the original.
  const output = await new Bun.Image(bytes).metadata();
  return {
    bytes,
    contentType: imageTypes[output.format] ?? "application/octet-stream",
  };
};

function jsonError(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message } },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

function matchesIfNoneMatch(header: string | null, etag: string): boolean {
  if (header === null) return false;
  for (const part of header.split(",")) {
    const tag = part.trim();
    const opaqueTag = tag.startsWith("W/") ? tag.slice(2) : tag;
    if (tag === "*" || opaqueTag === etag) return true;
  }
  return false;
}

/** Creates the binary artwork HTTP handler with a process-local resize cache. */
export function createArtworkHandler(
  db: Database,
  options: {
    resize?: ArtworkResize;
    maxCacheEntries?: number;
    maxCacheBytes?: number;
    maxConcurrentResizes?: number;
    maxQueuedResizes?: number;
    store?: ArtworkStoreConfig;
  } = {},
): (request: Request) => Promise<Response | undefined> {
  const store = options.store ?? artworkStoreConfig();
  const maxCacheEntries = options.maxCacheEntries ?? 128;
  const maxCacheBytes = options.maxCacheBytes ?? 64 * 1024 * 1024;
  const maxConcurrentResizes = options.maxConcurrentResizes ?? 4;
  const maxQueuedResizes = options.maxQueuedResizes ?? 128;
  if (
    !Number.isSafeInteger(maxCacheEntries) ||
    maxCacheEntries < 1 ||
    !Number.isSafeInteger(maxCacheBytes) ||
    maxCacheBytes < 1 ||
    !Number.isSafeInteger(maxConcurrentResizes) ||
    maxConcurrentResizes < 1 ||
    !Number.isSafeInteger(maxQueuedResizes) ||
    maxQueuedResizes < 0
  )
    throw new Error("Invalid artwork cache size.");
  let active = 0;
  type ResizeWaiter = {
    signal: AbortSignal;
    onAbort: () => void;
    grant: (acquired: boolean) => void;
  };
  const waiters: ResizeWaiter[] = [];
  const releaseSlot = () => {
    for (;;) {
      const next = waiters.shift();
      if (next === undefined) {
        active -= 1;
        return;
      }
      next.signal.removeEventListener("abort", next.onAbort);
      if (next.signal.aborted) {
        next.grant(false);
        continue;
      }
      next.grant(true);
      return;
    }
  };
  const makeRelease = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseSlot();
    };
  };
  const acquireSlot = async (
    signal: AbortSignal,
  ): Promise<(() => void) | undefined> => {
    if (signal.aborted) return undefined;
    if (active < maxConcurrentResizes) {
      active += 1;
      return makeRelease();
    }
    if (waiters.length >= maxQueuedResizes) return undefined;
    return new Promise<(() => void) | undefined>((resolvePromise) => {
      const waiter: ResizeWaiter = {
        signal,
        onAbort: () => {
          const index = waiters.indexOf(waiter);
          if (index < 0) return;
          waiters.splice(index, 1);
          resolvePromise(undefined);
        },
        grant: (acquired) => {
          resolvePromise(acquired ? makeRelease() : undefined);
        },
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      waiters.push(waiter);
    });
  };
  const resize = options.resize ?? bunResize;
  const cache = new Map<string, ArtworkResult>();
  const inFlight = new Map<string, Promise<ArtworkResult>>();
  let cacheBytes = 0;

  return async (request) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(routePrefix)) return undefined;
    try {
      const id = url.pathname.slice(routePrefix.length);
      if (id.length === 0 || id.includes("/") || !uuidPattern.test(id))
        return jsonError(400, "INVALID_INPUT", "Invalid artwork request.");
      const config = await readAuthSettings(db);
      const cacheControl = config.artworkRequiresAuth
        ? "private, max-age=0, must-revalidate"
        : "public, max-age=0, must-revalidate";
      if (request.method !== "GET")
        return Response.json(
          {
            error: {
              code: "METHOD_NOT_ALLOWED",
              message: "Method not allowed.",
            },
          },
          {
            status: 405,
            headers: {
              Allow: "GET",
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
            },
          },
        );
      let caller: { user: { id: string } } | undefined;
      if (config.artworkRequiresAuth)
        caller = await authenticate(db, readSessionToken(request));
      const widths = url.searchParams.getAll("width");
      const value = widths.length === 1 ? widths[0] : undefined;
      const width =
        value === undefined || !widthPattern.test(value)
          ? Number.NaN
          : Number(value);
      if (!Number.isSafeInteger(width) || width < 1 || width > maxArtworkWidth)
        return jsonError(400, "INVALID_INPUT", "Invalid artwork request.");
      const maxHeight = Number(
        url.searchParams.get("maxHeight") ?? maxArtworkWidth,
      );
      const quality = Number(url.searchParams.get("quality") ?? 90);
      const requestedFormat = url.searchParams.get("format");
      if (
        !Number.isSafeInteger(maxHeight) ||
        maxHeight < 1 ||
        maxHeight > maxArtworkWidth ||
        !Number.isSafeInteger(quality) ||
        quality < 1 ||
        quality > 100 ||
        (requestedFormat !== null &&
          !["jpeg", "png", "webp"].includes(requestedFormat))
      )
        return jsonError(400, "INVALID_INPUT", "Invalid artwork request.");
      const format =
        requestedFormat === "jpeg" ||
        requestedFormat === "png" ||
        requestedFormat === "webp"
          ? requestedFormat
          : undefined;
      if (caller !== undefined) {
        // Auth enabled: the caller needs view on the artwork owner's Library.
        const [row] = await db
          .select({ itemId: artwork.itemId, versionId: artwork.versionId })
          .from(artwork)
          .where(eq(artwork.id, id))
          .limit(1);
        let libraryId: string | null = null;
        if (row?.itemId) {
          const [owner] = await db
            .select({ libraryId: items.libraryId })
            .from(items)
            .where(eq(items.id, row.itemId))
            .limit(1);
          libraryId = owner?.libraryId ?? null;
        } else if (row?.versionId) {
          const [owner] = await db
            .select({ libraryId: versions.libraryId })
            .from(versions)
            .where(eq(versions.id, row.versionId))
            .limit(1);
          libraryId = owner?.libraryId ?? null;
        }
        if (libraryId === null)
          return jsonError(404, "NOT_FOUND", "Artwork not found.");
        await requirePermission(db, caller.user.id, "view", libraryId);
      }
      const release = await acquireSlot(request.signal);
      if (release === undefined)
        return jsonError(
          503,
          "SERVICE_UNAVAILABLE",
          "Artwork service is busy.",
        );
      try {
        const original = await readArtworkOriginal(db, id, store);
        if (original === null)
          return jsonError(404, "NOT_FOUND", "Artwork not found.");

        const dimensions =
          original.artwork.width !== null && original.artwork.height !== null
            ? { width: original.artwork.width, height: original.artwork.height }
            : await new Bun.Image(original.bytes).metadata();
        const effectiveWidth = Math.max(
          1,
          Math.floor(
            Math.min(
              width,
              dimensions.width,
              (maxHeight * dimensions.width) / dimensions.height,
            ),
          ),
        );
        const hasher = new Bun.CryptoHasher("sha256");
        hasher.update(original.bytes);
        hasher.update(
          `;w=${effectiveWidth};f=${format ?? "original"};q=${quality}`,
        );
        const sourceKey = hasher.digest("hex");

        let result = cache.get(sourceKey);
        if (result) {
          cache.delete(sourceKey);
          cache.set(sourceKey, result);
        } else {
          let pending = inFlight.get(sourceKey);
          if (pending === undefined) {
            pending = resize(original.bytes, effectiveWidth, {
              format,
              quality,
            }).then((resized) => {
              const etagHasher = new Bun.CryptoHasher("sha256");
              etagHasher.update(resized.contentType);
              etagHasher.update(":");
              etagHasher.update(resized.bytes);
              return {
                body: new Blob([new Uint8Array(resized.bytes)]),
                byteLength: resized.bytes.byteLength,
                contentType: resized.contentType,
                etag: `"${etagHasher.digest("hex")}"`,
              };
            });
            inFlight.set(sourceKey, pending);
            const cleanup = () => {
              if (inFlight.get(sourceKey) === pending)
                inFlight.delete(sourceKey);
            };
            pending.then(cleanup, cleanup);
          }
          const resized = await pending;
          result = cache.get(sourceKey);
          if (result) {
            cache.delete(sourceKey);
            cache.set(sourceKey, result);
          } else {
            result = resized;
            if (result.byteLength <= maxCacheBytes) {
              cache.set(sourceKey, result);
              cacheBytes += result.byteLength;
              while (
                cache.size > maxCacheEntries ||
                cacheBytes > maxCacheBytes
              ) {
                const oldest = cache.keys().next().value;
                if (oldest === undefined) break;
                const evicted = cache.get(oldest);
                cache.delete(oldest);
                if (evicted !== undefined) cacheBytes -= evicted.byteLength;
              }
            }
          }
        }
        const headers = {
          ETag: result.etag,
          "Cache-Control": cacheControl,
          "X-Content-Type-Options": "nosniff",
        };
        if (
          matchesIfNoneMatch(request.headers.get("if-none-match"), result.etag)
        )
          return new Response(null, { status: 304, headers });
        return new Response(result.body, {
          status: 200,
          headers: {
            ...headers,
            "Content-Type": result.contentType,
            "Content-Length": String(result.byteLength),
          },
        });
      } finally {
        release();
      }
    } catch (error) {
      if (error instanceof AuthError)
        return jsonError(error.status, error.code, error.message);
      console.error(
        JSON.stringify({ level: "error", message: "artwork.request.failed" }),
      );
      return jsonError(500, "INTERNAL_ERROR", "Artwork request failed.");
    }
  };
}
