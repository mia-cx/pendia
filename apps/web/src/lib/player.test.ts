import { describe, expect, test } from "bun:test";
import type Hls from "hls.js";
import { capHlsLevels } from "./player.ts";

type FakeHls = Pick<Hls, "levels" | "autoLevelCapping">;

// Level setters must never run: they would lock hls.js into manual mode.
function fakeHls(urls: readonly string[][]): FakeHls {
  const hls = {
    levels: urls.map((url) => ({ url })),
    autoLevelCapping: -1,
    set nextLevel(_: number) {
      throw new Error("manual mode");
    },
    set currentLevel(_: number) {
      throw new Error("manual mode");
    },
    set loadLevel(_: number) {
      throw new Error("manual mode");
    },
  };
  return hls as unknown as FakeHls;
}

describe("capHlsLevels", () => {
  test("a downward cap picks the highest matching level", () => {
    const hls = fakeHls([["/stored/v-720/"], ["/stored/v-1080/"], ["/other/"]]);
    expect(capHlsLevels(hls, ["v-1080", "v-720"])).toBe(true);
    expect(hls.autoLevelCapping).toBe(1);
  });

  test("null restores the ceiling", () => {
    const hls = fakeHls([["/stored/v-720/"]]);
    capHlsLevels(hls, ["v-720"]);
    expect(capHlsLevels(hls, null)).toBe(true);
    expect(hls.autoLevelCapping).toBe(-1);
  });

  test("no matching level leaves the ceiling alone and fails", () => {
    const hls = fakeHls([["/other/"]]);
    expect(capHlsLevels(hls, ["v-720"])).toBe(false);
    expect(hls.autoLevelCapping).toBe(-1);
  });
});
