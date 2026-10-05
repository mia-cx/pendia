import { describe, expect, test } from "bun:test";
import {
  type BrowseCard,
  cardLabel,
  episodeCode,
  formatBytes,
  formatDuration,
  itemHref,
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
      "S1 E2",
    );
    expect(
      episodeCode(
        card({ seasonNumber: 0, episodeNumber: 2, episodeEndNumber: 3 }),
      ),
    ).toBe("S0 E2–E3");
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
    ).toBe("Severance · S1 E1 · Good News About Hell");
    expect(cardLabel(card({ kind: "season", title: "Season 1", show }))).toBe(
      "Severance · Season 1",
    );
  });

  test("durations and sizes read as people say them", () => {
    expect(formatDuration(3300)).toBe("55 min");
    expect(formatDuration(7200)).toBe("2 h");
    expect(formatDuration(9960)).toBe("2 h 46 min");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(4_700_000_000)).toBe("4.7 GB");
    expect(formatBytes(123_400_000)).toBe("123 MB");
  });
});
