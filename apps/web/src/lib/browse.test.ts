import { describe, expect, test } from "bun:test";
import {
  artworkSrcset,
  type BrowseCard,
  cardLabel,
  episodeCode,
  fallbackHue,
  formatBadges,
  formatBytes,
  formatDuration,
  groupByKind,
  heroSlides,
  type ItemCard,
  isFresh,
  itemHref,
  landscapeArtwork,
  type Shelf,
  timeLeft,
  titleArt,
} from "./browse.ts";

const show = {
  id: "show-1",
  title: "Severance",
  posterArtworkId: null,
  backdropArtworkId: null,
  logoArtworkId: null,
};

function card(overrides: Partial<BrowseCard>): BrowseCard {
  return {
    id: "item-1",
    kind: "movie",
    libraryId: "library-1",
    title: "Arrival",
    year: 2016,
    addedAt: "2026-01-01T00:00:00.000000Z",
    posterArtworkId: null,
    backdropArtworkId: null,
    logoArtworkId: null,
    thumbArtworkId: null,
    parentId: null,
    seasonNumber: null,
    episodeNumber: null,
    episodeEndNumber: null,
    show: null,
    ...overrides,
  };
}

describe("browse helpers", () => {
  test("cards link to the route their medium declares", () => {
    expect(itemHref(card({}))).toBe("/movies/item-1");
    expect(itemHref(card({ kind: "show" }))).toBe("/shows/item-1");
    expect(itemHref(card({ kind: "season", parentId: "show-1", show }))).toBe(
      "/shows/show-1/seasons/item-1",
    );
    expect(
      itemHref(card({ kind: "episode", parentId: "season-1", show })),
    ).toBe("/shows/show-1/seasons/season-1/episodes/item-1");
    expect(itemHref(card({ kind: "episode", parentId: "season-1" }))).toBe(
      null,
    );
  });

  test("an Episode code names its Season and range", () => {
    expect(episodeCode(card({ seasonNumber: 1, episodeNumber: 2 }))).toBe(
      "S1, E2",
    );
    expect(
      episodeCode(
        card({ seasonNumber: 0, episodeNumber: 2, episodeEndNumber: 3 }),
      ),
    ).toBe("S0, E2–E3");
    expect(episodeCode(card({}))).toBeNull();
  });

  test("a card label places an Episode in its Show", () => {
    expect(cardLabel(card({}))).toBe("Arrival (2016)");
    expect(
      cardLabel(
        card({
          kind: "episode",
          title: "Good News About Hell",
          seasonNumber: 1,
          episodeNumber: 1,
          show,
        }),
      ),
    ).toBe("Severance · S1, E1 · Good News About Hell");
    expect(cardLabel(card({ kind: "season", title: "Season 1", show }))).toBe(
      "Severance · Season 1",
    );
    const item = { ...card({}) } as unknown as ItemCard;
    delete (item as { show?: unknown }).show;
    expect(cardLabel(item)).toBe("Arrival (2016)");
  });

  test("a fallback hue is stable for a title and varies across titles", () => {
    expect(fallbackHue("Her")).toBe(fallbackHue("Her"));
    expect(fallbackHue("")).toBe(0);
    const hues = new Set(
      ["Her", "Dune", "Severance", "Past Lives", "The Bear"].map(fallbackHue),
    );
    expect(hues.size).toBe(5);
    for (const hue of hues) {
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  test("search groups order by each kind's first rank", () => {
    const item = (kind: "movie" | "show", id: string) =>
      ({ ...card({ kind, id }) }) as unknown as ItemCard;
    const groups = groupByKind([
      item("show", "s1"),
      item("movie", "m1"),
      item("show", "s2"),
      item("movie", "m2"),
    ]);
    expect(groups.map((group) => group.heading)).toEqual(["Shows", "Movies"]);
    expect(groups[0]?.cards.map((c) => c.id)).toEqual(["s1", "s2"]);
    expect(groups[1]?.cards.map((c) => c.id)).toEqual(["m1", "m2"]);
    expect(groupByKind([])).toEqual([]);
    expect(groupByKind([item("movie", "m1")])).toHaveLength(1);
  });

  test("durations and sizes read as people say them", () => {
    expect(formatDuration(3300)).toBe("55m");
    expect(formatDuration(7200)).toBe("2h");
    expect(formatDuration(9960)).toBe("2h 46m");
    expect(formatDuration(30)).toBe("1m");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(4_700_000_000)).toBe("4.7 GB");
    expect(formatBytes(123_400_000)).toBe("123 MB");
  });

  test("timeLeft names the remaining time, or nothing without a duration", () => {
    expect(timeLeft({ positionSeconds: 2640, durationSeconds: 6600 })).toBe(
      "1h 6m left",
    );
    expect(
      timeLeft({ positionSeconds: 2640, durationSeconds: null }),
    ).toBeNull();
  });

  test("artworkSrcset lists each width once", () => {
    expect(artworkSrcset("art-1", [320, 640])).toBe(
      "/api/artwork/art-1?width=320 320w, /api/artwork/art-1?width=640 640w",
    );
  });

  test("a card's landscape artwork prefers its thumb, then its backdrop", () => {
    const episode = card({
      kind: "episode",
      thumbArtworkId: "thumb-1",
      show: { ...show, backdropArtworkId: "show-back" },
    });
    expect(landscapeArtwork(episode)).toBe("thumb-1");
    expect(landscapeArtwork({ ...episode, thumbArtworkId: null })).toBe(
      "show-back",
    );
    expect(landscapeArtwork(card({ kind: "season", show: episode.show }))).toBe(
      "show-back",
    );
    expect(landscapeArtwork(card({ backdropArtworkId: "back-1" }))).toBe(
      "back-1",
    );
  });

  test("title art names a child card's Show, or the card itself", () => {
    expect(
      titleArt(
        card({
          kind: "episode",
          show: { ...show, logoArtworkId: "logo-1" },
        }),
      ),
    ).toEqual({ logoId: "logo-1", title: "Severance" });
    expect(
      titleArt(card({ title: "Arrival", logoArtworkId: "logo-2" })),
    ).toEqual({ logoId: "logo-2", title: "Arrival" });
    expect(titleArt(card({ kind: "episode", title: "Pilot" }))).toEqual({
      logoId: null,
      title: "Pilot",
    });
  });

  test("a card added in the last week is fresh", () => {
    const now = new Date("2026-10-05T12:00:00Z");
    expect(isFresh(card({ addedAt: "2026-10-03T00:00:00Z" }), now)).toBe(true);
    expect(isFresh(card({ addedAt: "2026-09-20T00:00:00Z" }), now)).toBe(false);
  });

  test("hero slides dedupe, lead with artwork and keep progress", () => {
    const progress = { positionSeconds: 600, durationSeconds: 6600 };
    const shelves: Shelf[] = [
      {
        id: "continue-watching",
        title: "Continue watching",
        entries: [
          {
            item: card({ id: "no-art", title: "Bare" }),
            progress: null,
          },
          {
            item: card({ id: "art-1", backdropArtworkId: "b1" }),
            progress,
          },
        ],
      },
      {
        id: "recently-added",
        title: "Recently added",
        entries: [
          {
            item: card({ id: "art-1", backdropArtworkId: "b1" }),
            progress: null,
          },
          {
            item: card({ id: "art-2", backdropArtworkId: "b2" }),
            progress: null,
          },
          {
            item: card({ id: "no-art-2", title: "Bare two" }),
            progress: null,
          },
        ],
      },
    ];
    const slides = heroSlides(shelves);
    expect(slides.map((slide) => slide.card.id)).toEqual(["art-1", "art-2"]);
    expect(slides[0]?.progress).toBe(progress);

    // Without any artwork the first three candidates still fill the hero.
    const bare = heroSlides([
      {
        id: "recently-added",
        title: "",
        entries: ["a", "b", "c", "d"].map((id) => ({
          item: card({ id }),
          progress: null,
        })),
      },
    ]);
    expect(bare.map((slide) => slide.card.id)).toEqual(["a", "b", "c"]);
  });
});

describe("formatBadges", () => {
  test("collects 4K and HDR formats across versions, best first", () => {
    expect(
      formatBadges(["1080p · HEVC · HDR10", "4K · Dolby Vision · TRUEHD"]),
    ).toEqual(["4K", "Dolby Vision", "HDR10"]);
  });

  test("a 1080p or 720p version earns HD", () => {
    expect(formatBadges(["1080p · H264"])).toEqual(["HD"]);
    expect(formatBadges(["720p"])).toEqual(["HD"]);
  });

  test("an SD version earns no resolution badge", () => {
    expect(formatBadges(["480p · H264"])).toEqual([]);
  });

  test("an edition tag is not a format", () => {
    expect(formatBadges(["Director's Cut · 4K"])).toEqual(["4K"]);
  });
});
