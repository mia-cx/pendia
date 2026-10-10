import { AuthError } from "../auth/errors.ts";
import {
  type createArtworkHandler,
  maxArtworkWidth,
} from "../metadata/artwork-http.ts";
import {
  maxArtworkBytes,
  selectedArtworkId,
} from "../metadata/artwork-store.ts";
import { readBoundedBytes } from "../metadata/bounded-body.ts";
import {
  deleteItemImage,
  listItemImages,
  uploadItemImage,
} from "../metadata/images.ts";
import {
  json,
  noContent,
  type RequestContext,
  type Route,
  type UserContext,
} from "./http.ts";
import { readQuery, requiredGuid, toGuid } from "./request.ts";

const artworkTypes = new Map<string, Parameters<typeof uploadItemImage>[3]>([
  ["primary", "poster"],
  ["backdrop", "backdrop"],
  ["logo", "logo"],
  ["thumb", "thumb"],
]);
const imageTypes: Record<string, string> = {
  poster: "Primary",
  backdrop: "Backdrop",
  logo: "Logo",
  thumb: "Thumb",
};

function imageType(value: string | undefined) {
  return artworkTypes.get(value?.toLowerCase() ?? "");
}

function indexOf({ params, query }: RequestContext) {
  return readQuery(
    new URLSearchParams({
      index: params.index ?? query.get("imageIndex") ?? "0",
    }),
  ).count("index");
}

/** Item images reuse the core resize cache and its configurable authentication policy. */
export function imageRoutes(
  artwork: ReturnType<typeof createArtworkHandler>,
): Route[] {
  const handle = async (context: RequestContext) => {
    const { db, request, params, query, client } = context;
    const itemId = requiredGuid(params.id);
    const type = imageType(params.type);
    if (type === undefined || indexOf(context) !== 0)
      throw new AuthError("NOT_FOUND");
    const artworkId = await selectedArtworkId(db, itemId, type);
    if (artworkId === undefined) throw new AuthError("NOT_FOUND");
    const sizes = readQuery(
      new URLSearchParams(
        Object.entries(params).filter(([key]) =>
          ["maxWidth", "maxHeight"].includes(key),
        ),
      ),
    );
    const width = Math.min(
      maxArtworkWidth,
      ...[
        query.count("width"),
        sizes.count("maxWidth"),
        query.count("maxWidth"),
        query.count("fillWidth"),
      ].flatMap((value) => (value === undefined || value === 0 ? [] : [value])),
    );
    const height = Math.min(
      maxArtworkWidth,
      ...[
        query.count("height"),
        sizes.count("maxHeight"),
        query.count("maxHeight"),
        query.count("fillHeight"),
      ].flatMap((value) => (value === undefined || value === 0 ? [] : [value])),
    );
    const url = new URL(`/api/artwork/${artworkId}`, request.url);
    url.searchParams.set("width", String(Math.min(width, maxArtworkWidth)));
    url.searchParams.set(
      "maxHeight",
      String(Math.min(height, maxArtworkWidth)),
    );
    const format = (params.format ?? query.get("format"))?.toLowerCase();
    if (format !== undefined)
      url.searchParams.set(
        "format",
        format === "jpg"
          ? "jpeg"
          : ["jpeg", "png", "webp"].includes(format)
            ? format
            : "png",
      );
    const quality = query.count("quality");
    if (quality !== undefined && quality > 0)
      url.searchParams.set("quality", String(quality));
    const headers = new Headers();
    if (client.token !== undefined)
      headers.set("authorization", `Bearer ${client.token}`);
    const etag = request.headers.get("if-none-match");
    if (etag !== null) headers.set("if-none-match", etag);
    const response = await artwork(
      new Request(url, { headers, signal: request.signal }),
    );
    if (response === undefined) throw new AuthError("NOT_FOUND");
    return response;
  };
  const write = async (context: UserContext) => {
    const { db, caller, params, request } = context;
    const id = requiredGuid(params.id);
    const type = imageType(params.type);
    // The core has one selected original for each of its four image kinds.
    if (type === undefined || indexOf(context) !== 0) return noContent();
    if (request.method === "DELETE") {
      await deleteItemImage(db, caller.user.id, id, type);
      return noContent();
    }
    if (
      !request.headers.get("content-type")?.toLowerCase().startsWith("image/")
    )
      throw new AuthError("INVALID_INPUT");
    if (request.body === null) throw new AuthError("INVALID_INPUT");
    const input = await readBoundedBytes(
      request.body,
      Math.ceil((maxArtworkBytes * 4) / 3) + 4,
      () => new AuthError("INVALID_INPUT"),
    );
    // Jellyfin clients send base64 under image/*; raw image bodies also match the OpenAPI contract.
    const text = new TextDecoder().decode(input).replace(/\s/g, "");
    const bytes =
      text.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(text)
        ? Buffer.from(text, "base64")
        : input;
    await uploadItemImage(db, caller.user.id, id, type, bytes);
    return noContent();
  };
  const paths = [
    "/Items/{id}/Images/{type}",
    "/Items/{id}/Images/{type}/{index}",
  ];
  return [
    {
      method: "GET",
      path: "/Items/{id}/Images",
      handle: async ({ db, caller, params }) =>
        json(
          (
            await listItemImages(db, caller.user.id, requiredGuid(params.id))
          ).map((image) => ({
            ImageType: imageTypes[image.type],
            ImageIndex: 0,
            ImageTag: toGuid(image.id),
            Path: image.path,
            Height: image.height,
            Width: image.width,
            Size: image.bytes,
          })),
        ),
    },
    ...[
      ...paths,
      "/Items/{id}/Images/{type}/{index}/{tag}/{format}/{maxWidth}/{maxHeight}/{percentPlayed}/{unplayedCount}",
    ].flatMap(
      (path) =>
        [
          { method: "GET", path, anonymous: true, handle },
          { method: "HEAD", path, anonymous: true, handle },
        ] satisfies Route[],
    ),
    ...paths.flatMap(
      (path) =>
        [
          { method: "POST", path, handle: write },
          { method: "DELETE", path, handle: write },
        ] satisfies Route[],
    ),
  ];
}
