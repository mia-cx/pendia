import type { PendiaClient } from "./api.ts";

/** One Item as the detail pages read it. */
export type ItemDetail = Awaited<ReturnType<PendiaClient["items"]["get"]>>;

/** A grid or search card: a Movie or Show. */
export type ItemCard = Awaited<
  ReturnType<PendiaClient["items"]["list"]>
>["items"][number];

/** A card that also knows its Season, Episode numbers and Show. */
export type BrowseCard = ItemDetail["children"][number];

/** One Home shelf with its entries. */
export type Shelf = Awaited<
  ReturnType<PendiaClient["shelves"]["home"]>
>[number];

/** The page for a card, or null when a Season or Episode lacks its Show. */
export function itemHref(card: ItemCard | BrowseCard): string | null {
  if (card.kind === "movie") return `/movies/${card.id}`;
  if (card.kind === "show") return `/shows/${card.id}`;
  if (!("show" in card) || card.show === null || card.parentId === null)
    return null;
  if (card.kind === "season")
    return `/shows/${card.show.id}/seasons/${card.id}`;
  return `/shows/${card.show.id}/seasons/${card.parentId}/episodes/${card.id}`;
}

/** The resized artwork URL at a pixel width. */
export function artworkUrl(id: string, width: number): string {
  return `/api/artwork/${id}?width=${width}`;
}

/** A `srcset` over the widths a poster renders at on any screen density. */
export function posterSrcset(id: string): string {
  return [160, 240, 320, 480]
    .map((width) => `${artworkUrl(id, width)} ${width}w`)
    .join(", ");
}

/** The short code for an Episode, such as `S1 E2` or `S1 E2–E3`. */
export function episodeCode(card: BrowseCard): string | null {
  if (card.seasonNumber === null || card.episodeNumber === null) return null;
  const end =
    card.episodeEndNumber === null ? "" : `–E${card.episodeEndNumber}`;
  return `S${card.seasonNumber} E${card.episodeNumber}${end}`;
}

/** A running time in hours and minutes, such as `2 h 46 min` or `55 min`. */
export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes} min`;
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

const byteUnits = ["B", "KB", "MB", "GB", "TB"];

/** A file size in decimal units, such as `4.7 GB`. */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < byteUnits.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${byteUnits[unit]}`;
}
