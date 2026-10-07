# #150 Player: quality, speed and volume boost in the settings menu

## Summary

The player's settings menu becomes one YouTube-style menu: a list of rows, each showing its current value, each opening a submenu in place with a back row. Rows: Quality, Audio, Subtitles, Playback speed, Volume boost, Version. Quality replans through the server, which resolves each rung stored-first (ADR 0009). Speed and boost are client-only and remembered on the device, as is the quality choice.

## Acceptance criteria

- [ ] The menu lists Quality, Audio, Subtitles, Playback speed, Volume boost and Version, each showing its current value. Audio and Version hide with one option; Subtitles hides with no tracks.
- [ ] Picking a quality replans at the current position, and the row shows the rung that's playing. A 720p pick on LAN plays 720p.
- [ ] With a stored 1080p rendition, or a 1080p Version file, next to a 4K source, picking 1080p plays it with no live transcode (direct play or remux).
- [ ] A live transcode is chosen only when no stored rendition or Version fits the rung.
- [ ] Speed changes take effect without a replan or a rebuffer.
- [ ] Volume boost +300% makes a quiet clip measurably louder without clipping; Off restores the original level.
- [ ] Rows and submenus work with arrow keys, Enter and Escape; each row's accessible name includes its value.
- [ ] AirPlay with boost on: not testable on this Linux box; recorded as unverified in the PR.

## Design

### Server

**Policy (`policy.ts`).** `effectiveCap` on LAN returns `sessionRequest` (or null), skipping the admin default and user caps. Off LAN unchanged.

**Quality module (`apps/server/src/playback/quality.ts`, new).** Generic over the exported `ladder` so it works before and after #147:

- `rungName(rung)`: `rung.name` when present, else `` `${rung.height}p` ``.
- `qualityLadder()`: `ladder` deduped by name, keeping the first (highest bitrate) per name.
- `findRung(name)`: the deduped rung with that name, else undefined.
- `sourceRungs(video)`: deduped rungs that don't upscale the source: `rung.width <= video.width || rung.height <= video.height` (a 3840×1600 film keeps 2160p, a 1920×800 film drops it).
- `boxProfile(profile, rung)`: the client profile with every `videoCodecs` entry's `maxWidth`/`maxHeight` lowered to the rung box. This makes `videoPasses` (direct play, stored selection, Version fit) and `decideVideo` (transcode scale) respect the rung's resolution, not only its bitrate.
- `qualityOptions(input)`: pure; builds `quality.rungs` (below).

**Plan input.** `quality?: string`: `"original"`, a rung name, or absent/`"auto"`. An unknown name plays as Auto (the client persists names across ladder changes). Bounded string, max 32.

- Rung: profile = `boxProfile(input.profile, rung)`; `sessionRequest = min(input.bitrateCapBps, rung.bitrate)`.
- Original: no session cap from quality, and stored variants are skipped so the source File plays as is.
- The requested Version is always the one planned. Version substitution is the client's call (see Web), so an explicit Version row pick is never overridden.

**Stored selection refactor (`stored/playback.ts`).** Split `selectStoredVariants` into `loadStoredCandidates(db, {itemId, fileId})` and a pure `pickStoredVariants(candidates, {segmentTimelineId, liveMethod}, client, caps)` returning the variant ids and their max video bitrate. Planning loads once and picks for the session and for each rung. Keep `selectStoredVariants` as the thin wrapper if other code or tests use it.

**Quality options (plan output `quality`).**

```ts
quality: {
  /** Null when the source File can't direct play or remux here. */
  original: { name: string; width: number; height: number; bitrate: number } | null;
  rungs: {
    name: string; width: number; height: number;
    /** Video bitrate of what this option plays. */
    bitrate: number;
    source: "stored" | "version" | "transcode";
    /** The Version to open, for source "version"; else null. */
    versionId: string | null;
    /** Stored variants within the rung, for source "stored"; else []. */
    storedVariantIds: string[];
    /** False when the server can't make this rung in real time. */
    available: boolean;
  }[];
  /** The stored variants this session serves; [] for a live or direct session. */
  storedVariantIds: string[];
}
```

Per rung of `sourceRungs(current source video)`, with `profile = boxProfile(input.profile, rung)` and caps `sessionRequest = min(input.bitrateCapBps, rung.bitrate)`:

1. `live = decidePlayback(current, profile, caps, capabilities)` in try/catch (null on throw). If `live.method !== "transcode"`, the current File already plays as is at this rung: skip the rung, Original covers it.
2. Stored: `pickStoredVariants(...)` with `liveMethod = live?.method ?? null`, unless the session burns subtitles in or plays a non-first audio Stream (same gate planning uses). Non-empty → `source: "stored"`, `bitrate` = max variant bitrate.
3. Version: other imported video Versions of the Item whose duration is within `versionDurationToleranceSeconds = 5` of the current one, whose decision under `profile`/caps is not a transcode, and which can stream (`direct-play`, or `profile.progressive`, or an aligned segment timeline). Pick the highest video bitrate. → `source: "version"`.
4. Else `source: "transcode"`, `bitrate = rung.bitrate`, `available = live !== null && live.video.action === "transcode" && rungName(live.video.rung) === rungName(rung)`. A planner that throws or falls to a lower rung (the #147 CPU ceiling) disables the option.

`original`: `decidePlayback(current, input.profile, caps without quality)` is not a transcode and can stream → `{ name: the smallest deduped rung whose box contains the source, else `${height}p`; width; height; bitrate: source video bitrate }`.

Loading other Versions: imported video Versions of the Item except the current one, each through `loadPlaybackSource` (skip any that throw).

### Web

**Prefs (`apps/web/src/lib/player-prefs.ts`, new).** One localStorage key `thalia.player`, JSON `{ quality, speed, boost }`. `speeds = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]`, `boosts = [0, 0.5, 1, 1.5, 2, 2.5, 3]` (extra gain; 0 is Off). Reading validates against the lists, defaults `{ quality: "auto", speed: 1, boost: 0 }`, and tolerates storage that throws. `createPlayer` takes a `prefs?: { read(): PlayerPrefs; write(prefs: PlayerPrefs): void }`; Player.svelte passes the localStorage one, tests an in-memory one.

**Boost (`apps/web/src/lib/audio-boost.ts`, new).** `createBoost(media, createContext = () => new AudioContext())` → `(gain: number) => void`. First call with gain > 1 builds `createMediaElementSource → GainNode → DynamicsCompressorNode (limiter: threshold -1 dB, knee 0, ratio 20, attack 0.003 s, release 0.25 s) → destination`, once per element. Gain 1 with no graph is a no-op. Gain 1 with a graph sets gain to 1 and routes gain straight to destination, bypassing the compressor (its makeup gain would change the level). Resumes the context on each call and on the media's `play`. `createPlayer` takes `amplify?: (gain: number) => void`.

**Player session (`player.ts`).** `PlaybackOptions` gains `quality: string` sent as the plan's `quality`. `play()` also returns `capLevels(variantIds: readonly string[] | null): boolean`: with hls.js attached, caps ABR to the highest level whose URL contains one of the ids (`autoLevelCapping`, plus `nextLevel` when the current level is above it); null clears the cap. Returns false when there's no hls.js or no level matches.

**State (`player-state.ts`).**

- `Media` gains `playbackRate`, `defaultPlaybackRate`, `preservesPitch`, `videoWidth`, `videoHeight`.
- `PlannedTracks` adds `"quality"` to its Pick.
- `PlayerState` gains `quality: string` (the choice), `videoSize: { width; height } | null` (from `loadedmetadata`/`resize`), `speed: number`, `boost: number`.
- `SessionRequest` gains `quality`.
- `chooseQuality(choice, versionId?)`: persist the choice. When the session was planned with `"auto"`, the target is a stored option whose `storedVariantIds` are all in the session's `quality.storedVariantIds`, or the target is `"auto"` after a local cap, call `capLevels` and skip the replan if it returns true. Otherwise restart at the current position with the new quality; a different `versionId` resets streams like `chooseVersion`.
- `setSpeed(rate)`: sets `defaultPlaybackRate` (survives a session's `load()`), `playbackRate`, `preservesPitch = true`; persists. No restart.
- `setBoost(level)`: `amplify(1 + level)`; persists.
- On creation: apply the stored speed, call `amplify` when the stored boost > 0, and open the first session with the stored quality.

**Labels (`apps/web/src/lib/quality.ts`, new).**

- `speedLabel`: `Normal` for 1, else `1.5×`.
- `boostLabel`: `Off`, else `+200%`.
- `formatMbps(bps)`: `8 Mbit/s`, at most one decimal.
- `playingName(size, quality)`: the smallest rung or original box containing the size, else `${height}p`.
- `qualityValue(state, quality)`: `Auto · 1080p` (or `Auto` before a frame), `Original`, or the rung name.
- `qualityEntries(quality, versions)`: Auto; Original with detail `2160p · 40 Mbit/s`; rungs with detail `Stored · 8 Mbit/s`, `Transcode · 3 Mbit/s`, or the Version's label for `version`.

**Menu (`PlayerSettings.svelte`).** One `DropdownMenu.Content` (w-80) with a `view` state: `"root"` or a row key, reset to root on close.

- Root rows are `DropdownMenu.Item` with `closeOnSelect={false}`: heading left; value right in `text-footnote text-label-secondary`, truncated; `ChevronRight`. Accessible name `Quality, Auto, 1080p` (the value with ` · ` read as `, `). Enter, Space, click or ArrowRight opens the submenu. Disabled while `state.switching`.
- A submenu opens with a back row: `ChevronLeft` and the row's heading, accessible name `Quality, back to settings`. Then a separator, then a `RadioGroup` (aria-label = heading) of `RadioItem`s with `closeOnSelect`, the detail right-aligned as today, and unavailable rungs disabled.
- In a submenu, Escape and ArrowLeft go back to root, Escape via `onEscapeKeydown` + `preventDefault`. Escape at root closes. After each view change, focus the checked option (submenu) or the row just left (root) after `tick()`.
- Row order: Quality, Audio (>1 track), Subtitles (≥1 track), Playback speed, Volume boost, Version (>1). The trigger shows whenever the player has state.
- Match the existing dropdown primitives and tokens; no new colors or motion.

## TODOs

- [ ] Server: an explicit session cap applies on LAN in `effectiveCap`; spec line in `docs/spec/playback.md`. Validation: `policy.test.ts`.
- [ ] Server: stored selection split into load + pick; quality module with options; plan input `quality` and output `quality`. Validation: `quality.test.ts`, existing stored/planning/playback tests, a DB test for a 720p pick on LAN.
- [ ] Web: prefs, boost and quality-label modules. Validation: `player-prefs.test.ts`, `audio-boost.test.ts`, `quality.test.ts`.
- [ ] Web: player session `quality` + `capLevels`; player-state quality, speed, boost. Validation: `player-state.test.ts`.
- [ ] Web: settings menu redesign and Player wiring. Validation: web check, browser run.
- [ ] Gate and screenshots: lint, check, tests; root menu, Quality and Volume boost submenus in Chromium; boost loudness measured.

## Notes

- Auto keeps the Version the viewer opened. Version substitution happens only on a picked rung, whose option names the Version, so it never fights an explicit Version row pick.
- A transcode starts from the opened Version.
