import { json } from "./http.ts";
import { type ApiOperation, defaultValue, successResponse } from "./openapi.ts";

// A real transparent PNG lets image callers decode a neutral image successfully.
const emptyImage = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

/** Answers a documented success shape for a concept that Thalia does not implement. */
export function neutralResponse(operation: ApiOperation): Response {
  const { status, mediaType, schema } = successResponse(operation);
  if (status === 204 || mediaType === undefined)
    return new Response(null, { status });
  if (mediaType.startsWith("application/json"))
    return json(defaultValue(schema ?? {}), status);
  const body = mediaType.startsWith("image/")
    ? emptyImage
    : mediaType.toLowerCase().includes("mpegurl")
      ? "#EXTM3U\n#EXT-X-ENDLIST\n"
      : "";
  const contentType = mediaType.startsWith("image/")
    ? "image/png"
    : mediaType.replace("*", "plain");
  return new Response(operation.method === "HEAD" ? null : body, {
    status,
    headers: { "Content-Type": contentType, "Cache-Control": "no-store" },
  });
}
