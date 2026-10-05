import { describe, expect, test } from "bun:test";
import { followEvents, followLibrary, type ServerEvent } from "./events.ts";

const sessionId = "11111111-1111-4111-8111-111111111111";

const starting: ServerEvent = {
  kind: "session.state",
  sessionId,
  state: "starting",
};
const stopped: ServerEvent = {
  kind: "session.state",
  sessionId,
  state: "stopped",
};

describe("followEvents", () => {
  test("delivers events, reopens a dropped stream and stops on abort", async () => {
    const controller = new AbortController();
    const seen: ServerEvent[] = [];
    let opened = 0;
    await followEvents(
      async () => {
        opened += 1;
        if (opened === 1)
          return (async function* () {
            yield starting;
            throw new Error("The stream dropped.");
          })();
        return (async function* () {
          yield stopped;
          controller.abort();
        })();
      },
      (event) => seen.push(event),
      controller.signal,
      1,
    );
    expect(seen).toEqual([starting, stopped]);
    expect(opened).toBe(2);
  });

  test("a failed open retries after the pause", async () => {
    const controller = new AbortController();
    let opened = 0;
    await followEvents(
      async () => {
        opened += 1;
        if (opened < 3) throw new Error("Unreachable.");
        controller.abort();
        return (async function* () {})();
      },
      () => {},
      controller.signal,
      1,
    );
    expect(opened).toBe(3);
  });
});

describe("followLibrary", () => {
  const libraryId = "22222222-2222-4222-8222-222222222222";
  const otherLibrary = "33333333-3333-4333-8333-333333333333";
  const changed = (id: string): ServerEvent => ({
    kind: "library.changed",
    libraryId: id,
  });

  test("calls onChange only for matching library.changed events", async () => {
    const controller = new AbortController();
    let called = 0;
    await followLibrary(
      async () =>
        (async function* () {
          yield changed(libraryId);
          yield changed(otherLibrary);
          yield starting;
          yield changed(libraryId);
          controller.abort();
        })(),
      libraryId,
      () => {
        called += 1;
      },
      controller.signal,
      1,
    );
    expect(called).toBe(2);
  });
});
