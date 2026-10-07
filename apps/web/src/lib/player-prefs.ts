/** The player settings remembered on this device. */
export type PlayerPrefs = {
  /** `"auto"`, `"original"` or a rung name. */
  quality: string;
  speed: number;
  /** Extra gain; 0 is Off. */
  boost: number;
};

/** The playback speeds the menu offers. */
export const speeds = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

/** The volume boosts the menu offers, as extra gain over unity. */
export const boosts = [0, 0.5, 1, 1.5, 2, 2.5, 3] as const;

const key = "thalia.player";
const defaults: PlayerPrefs = { quality: "auto", speed: 1, boost: 0 };

/** Reads and writes player prefs; localStorage in the app, memory in tests. */
export type PrefsStore = {
  read(): PlayerPrefs;
  write(prefs: PlayerPrefs): void;
};

/** Reads the stored prefs; each field falls back to its default when missing or invalid, and storage that throws reads as defaults. */
export function readPrefs(storage: Pick<Storage, "getItem">): PlayerPrefs {
  try {
    const raw = storage.getItem(key);
    if (raw === null) return { ...defaults };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { ...defaults };
    const { quality, speed, boost } = parsed as Record<string, unknown>;
    return {
      quality:
        typeof quality === "string" &&
        quality.length > 0 &&
        quality.length <= 32
          ? quality
          : defaults.quality,
      speed: (speeds as readonly number[]).includes(speed as number)
        ? (speed as number)
        : defaults.speed,
      boost: (boosts as readonly number[]).includes(boost as number)
        ? (boost as number)
        : defaults.boost,
    };
  } catch {
    return { ...defaults };
  }
}

/** Persists the prefs; storage that throws is ignored. */
export function writePrefs(
  storage: Pick<Storage, "setItem">,
  prefs: PlayerPrefs,
) {
  try {
    storage.setItem(key, JSON.stringify(prefs));
  } catch {
    // Private browsing may refuse writes; prefs stay session-only.
  }
}

/** The localStorage-backed store the Player passes to createPlayer. */
export const playerPrefs: PrefsStore = {
  read: () => readPrefs(localStorage),
  write: (prefs) => writePrefs(localStorage, prefs),
};
