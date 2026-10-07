import { describe, expect, test } from "bun:test";
import { readPrefs, writePrefs } from "./player-prefs.ts";

function fakeStorage(fail = false) {
  const data = new Map<string, string>();
  const deny = () => {
    if (fail) throw new Error("denied");
  };
  return {
    data,
    getItem: (key: string): string | null => {
      deny();
      return data.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      deny();
      data.set(key, value);
    },
  };
}

describe("player prefs", () => {
  test("reads defaults from empty or invalid storage", () => {
    const empty = fakeStorage();
    expect(readPrefs(empty)).toEqual({ quality: "auto", speed: 1, boost: 0 });
    empty.data.set("thalia.player", "not json");
    expect(readPrefs(empty).speed).toBe(1);
    empty.data.set("thalia.player", JSON.stringify(42));
    expect(readPrefs(empty).quality).toBe("auto");
  });

  test("round-trips and validates each field against its list", () => {
    const storage = fakeStorage();
    writePrefs(storage, { quality: "720p", speed: 1.5, boost: 2 });
    expect(readPrefs(storage)).toEqual({
      quality: "720p",
      speed: 1.5,
      boost: 2,
    });
    storage.data.set(
      "thalia.player",
      JSON.stringify({ quality: 42, speed: 3, boost: 9 }),
    );
    expect(readPrefs(storage)).toEqual({ quality: "auto", speed: 1, boost: 0 });
    storage.data.set(
      "thalia.player",
      JSON.stringify({ quality: "1080p", speed: 0.75, boost: 0.5 }),
    );
    expect(readPrefs(storage)).toEqual({
      quality: "1080p",
      speed: 0.75,
      boost: 0.5,
    });
  });

  test("storage that throws reads defaults and ignores writes", () => {
    const denied = fakeStorage(true);
    expect(readPrefs(denied)).toEqual({ quality: "auto", speed: 1, boost: 0 });
    expect(() =>
      writePrefs(denied, { quality: "720p", speed: 2, boost: 3 }),
    ).not.toThrow();
    expect(denied.data.size).toBe(0);
  });
});
