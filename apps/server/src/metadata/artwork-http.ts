import sharp from "sharp";
import { AuthError } from "../auth/errors.ts";
import { readSessionToken } from "../auth/http.ts";
import { authenticate } from "../auth/sessions.ts";
import { readAuthSettings } from "../auth/settings.ts";
import type { Database } from "../db/client.ts";
import { readArtworkOriginal } from "./artwork-store.ts";

/** A resize operation used by the process-local artwork cache. */
export type ArtworkResize = (
  input: Uint8Array,
  width: number,
) => Promise<{ bytes: Uint8Array; contentType: string }>;

const routePrefix = "/api/artwork/";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const widthPattern = /^[0-9]+$/;
const maxWidth = 4096;

const imageTypes: Record<string, string> = {
  avif: "image/avif",
  gif: "image/gif",
  jpeg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  tiff: "image/tiff",
  webp: "image/webp",
};

const sharpResize: ArtworkResize = async (input, width) => {
  const output = await sharp(input)
    .resize({ width, withoutEnlargement: true })
    .toBuffer({ resolveWithObject: true });
  return {
    bytes: new Uint8Array(output.data),
    contentType: imageTypes[output.info.format] ?? "application/octet-stream",
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
    if (tag === "*" || tag === etag) return true;
  }
  return false;
}

/** Creates the binary artwork HTTP handler with a process-local resize cache. */
export function createArtworkHandler(
  db: Database,
  options: { resize?: ArtworkResize; maxCacheEntries?: number } = {},
): (request: Request) => Promise<Response | undefined> {
  const maxCacheEntries = options.maxCacheEntries ?? 128;
  if (!Number.isSafeInteger(maxCacheEntries) || maxCacheEntries < 1)
    throw new Error("Invalid artwork cache size.");
  const resize = options.resize ?? sharpResize;
  const cache = new Map<string, { bytes: Uint8Array; contentType: string }>();

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
      if (config.artworkRequiresAuth)
        await authenticate(db, readSessionToken(request));
      const widths = url.searchParams.getAll("width");
      const value = widths.length === 1 ? widths[0] : undefined;
      const width =
        value === undefined || !widthPattern.test(value)
          ? Number.NaN
          : Number(value);
      if (!Number.isSafeInteger(width) || width < 1 || width > maxWidth)
        return jsonError(400, "INVALID_INPUT", "Invalid artwork request.");
      const original = await readArtworkOriginal(db, id);
      if (original === null)
        return jsonError(404, "NOT_FOUND", "Artwork not found.");

      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(original.bytes);
      hasher.update(`;w=${width}`);
      const etag = `"${hasher.digest("hex")}"`;
      const headers = {
        ETag: etag,
        "Cache-Control": cacheControl,
        "X-Content-Type-Options": "nosniff",
      };
      if (matchesIfNoneMatch(request.headers.get("if-none-match"), etag))
        return new Response(null, { status: 304, headers });

      let result = cache.get(etag);
      if (result) {
        cache.delete(etag);
        cache.set(etag, result);
      } else {
        result = await resize(original.bytes, width);
        cache.set(etag, result);
        if (cache.size > maxCacheEntries) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
      }
      return new Response(Buffer.from(result.bytes), {
        status: 200,
        headers: {
          ...headers,
          "Content-Type": result.contentType,
          "Content-Length": String(result.bytes.byteLength),
        },
      });
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
