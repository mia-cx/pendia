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

/** A `srcset` over the given widths. */
export function artworkSrcset(id: string, widths: readonly number[]): string {
  return widths.map((width) => `${artworkUrl(id, width)} ${width}w`).join(", ");
}

/** The widths a poster renders at on any screen density. */
export const posterWidths = [160, 240, 320, 480] as const;

/** The widths landscape cards render at. */
export const landscapeWidths = [320, 480, 640, 960, 1280] as const;

/** The widths heroes and detail backdrops render at. */
export const backdropWidths = [960, 1440, 1920, 2560] as const;

const hueRange = 360;

/** A quiet, stable hue per title for the fallback surface behind missing artwork. */
export function fallbackHue(title: string): number {
  let hash = 0;
  for (const char of title) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) | 0;
  return ((hash % hueRange) + hueRange) % hueRange;
}

/** The landscape artwork a card leads with: an Episode's thumb, else its backdrop. */
export function landscapeArtwork(card: BrowseCard): string | null {
  if (card.kind === "episode")
    return card.thumbArtworkId ?? card.show?.backdropArtworkId ?? null;
  if (card.kind === "season") return card.show?.backdropArtworkId ?? null;
  return card.backdropArtworkId;
}

/** The logo and name a card leads with: a Season or Episode wears its Show's. */
export function titleArt(card: BrowseCard): {
  logoId: string | null;
  title: string;
} {
  if (card.show !== null && (card.kind === "episode" || card.kind === "season"))
    return { logoId: card.show.logoArtworkId, title: card.show.title };
  return { logoId: card.logoArtworkId, title: card.title };
}

const freshWindowMs = 7 * 24 * 60 * 60 * 1000;

/** Whether a card joined the library within the last week. */
export function isFresh(card: BrowseCard, now: Date): boolean {
  return now.getTime() - new Date(card.addedAt).getTime() <= freshWindowMs;
}

/** The hero's slides: continue-watching then recently-added entries, deduped, artwork first. */
export function heroSlides(
  shelves: readonly Shelf[],
  limit = 5,
): {
  card: BrowseCard;
  progress: { positionSeconds: number; durationSeconds: number | null } | null;
}[] {
  const seen = new Set<string>();
  const candidates = ["continue-watching", "recently-added"].flatMap(
    (id) =>
      shelves
        .find((shelf) => shelf.id === id)
        ?.entries.flatMap((entry) => {
          if (seen.has(entry.item.id)) return [];
          seen.add(entry.item.id);
          return [{ card: entry.item, progress: entry.progress }];
        }) ?? [],
  );
  const withArtwork = candidates.filter(
    (slide) => landscapeArtwork(slide.card) !== null,
  );
  const slides = withArtwork.length === 0 ? candidates : withArtwork;
  return slides.slice(0, withArtwork.length === 0 ? 3 : limit);
}

/** The short code for an Episode, such as `S1, E2` or `S1, E2–E3`. */
export function episodeCode(card: BrowseCard): string | null {
  if (card.seasonNumber === null || card.episodeNumber === null) return null;
  const end =
    card.episodeEndNumber === null ? "" : `–E${card.episodeEndNumber}`;
  return `S${card.seasonNumber}, E${card.episodeNumber}${end}`;
}

/** A card's full name on one line: the Show and code before an Episode, the year after a Movie. */
export function cardLabel(card: ItemCard | BrowseCard): string {
  if ("show" in card) {
    const code = episodeCode(card);
    if (card.show !== null && card.kind === "episode")
      return [card.show.title, code, card.title]
        .filter((part) => part !== null)
        .join(" · ");
    if (card.show !== null && card.kind === "season")
      return `${card.show.title} · ${card.title}`;
  }
  return card.year === null ? card.title : `${card.title} (${card.year})`;
}

const kindHeadings = { movie: "Movies", show: "Shows" } as const;

/** Search results grouped by medium, in the order each kind first ranks. */
export function groupByKind(cards: readonly ItemCard[]): {
  kind: "movie" | "show";
  heading: "Movies" | "Shows";
  cards: ItemCard[];
}[] {
  const groups = new Map<
    "movie" | "show",
    { kind: "movie" | "show"; heading: "Movies" | "Shows"; cards: ItemCard[] }
  >();
  for (const card of cards) {
    if (card.kind !== "movie" && card.kind !== "show") continue;
    let group = groups.get(card.kind);
    if (group === undefined) {
      group = { kind: card.kind, heading: kindHeadings[card.kind], cards: [] };
      groups.set(card.kind, group);
    }
    group.cards.push(card);
  }
  return [...groups.values()];
}

/** A running time in compact hours and minutes, such as `2h 46m` or `55m`. */
export function formatDuration(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m`;
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** The time left in a partly watched item, such as `38m left`. */
export function timeLeft(progress: {
  positionSeconds: number;
  durationSeconds: number | null;
}): string | null {
  if (progress.durationSeconds === null) return null;
  return `${formatDuration(progress.durationSeconds - progress.positionSeconds)} left`;
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
