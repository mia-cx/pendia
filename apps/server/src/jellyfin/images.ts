import { AuthError } from "../auth/errors.ts";
import {
  type createArtworkHandler,
  maxArtworkWidth,
} from "../metadata/artwork-http.ts";
import { selectedArtworkId } from "../metadata/artwork-store.ts";
import type { RequestContext, Route } from "./http.ts";
import { parseGuid } from "./request.ts";

type ArtworkHandler = ReturnType<typeof createArtworkHandler>;

// Jellyfin image types, lowercased, and the Artwork type each one shows.
const artworkTypes = new Map([
  ["primary", "poster"],
  ["backdrop", "backdrop"],
  ["logo", "logo"],
  ["thumb", "thumb"],
]);

/**
 * Item images, anonymous because Findroid sends no token. They resolve to the
 * selected Artwork and go through the artwork handler, which resizes by width
 * and still enforces artwork auth when an admin turns it on.
 */
export function imageRoutes(artwork: ArtworkHandler): Route[] {
  const handle = async ({
    db,
    request,
    params,
    query,
    client,
  }: RequestContext) => {
    const itemId = parseGuid(params.id ?? "");
    const type = artworkTypes.get(params.type?.toLowerCase() ?? "");
    // Only one Artwork per type is selected, so only the first index exists.
    if (
      itemId === undefined ||
      type === undefined ||
      (params.index ?? "0") !== "0"
    )
      throw new AuthError("NOT_FOUND");
    const artworkId = await selectedArtworkId(db, itemId, type);
    if (artworkId === undefined) throw new AuthError("NOT_FOUND");
    const width = Math.min(
      query.count("maxWidth") ?? query.count("fillWidth") ?? maxArtworkWidth,
      maxArtworkWidth,
    );
    const headers = new Headers();
    if (client.token !== undefined)
      headers.set("authorization", `Bearer ${client.token}`);
    const etag = request.headers.get("if-none-match");
    if (etag !== null) headers.set("if-none-match", etag);
    const response = await artwork(
      new Request(
        new URL(`/api/artwork/${artworkId}?width=${width}`, request.url),
        {
          headers,
          signal: request.signal,
        },
      ),
    );
    if (response === undefined) throw new AuthError("NOT_FOUND");
    return response;
  };
  return [
    {
      method: "GET",
      path: "/Items/{id}/Images/{type}",
      anonymous: true,
      handle,
    },
    {
      method: "GET",
      path: "/Items/{id}/Images/{type}/{index}",
      anonymous: true,
      handle,
    },
  ];
}
