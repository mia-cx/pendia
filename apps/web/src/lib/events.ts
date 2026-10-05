import type { PendiaClient } from "./api.ts";

type Stream = Awaited<ReturnType<PendiaClient["events"]["stream"]>>;

/** One server event as `events.stream` delivers it. */
export type ServerEvent =
  Stream extends AsyncIterable<infer Event> ? Event : never;

/** Hands every server event to `onEvent` until the signal aborts, reopening a stream that drops. */
export async function followEvents(
  open: (signal: AbortSignal) => Promise<AsyncIterable<ServerEvent>>,
  onEvent: (event: ServerEvent) => void,
  signal: AbortSignal,
  retryMs = 3_000,
) {
  while (!signal.aborted) {
    try {
      for await (const event of await open(signal)) onEvent(event);
    } catch {
      // A dropped stream reopens after the pause; callers reload on a timer
      // too, so nothing missed in between stays missing.
    }
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, retryMs);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}

/** Calls `onChange` for every `library.changed` on the given Library until the signal aborts. */
export async function followLibrary(
  open: (signal: AbortSignal) => Promise<AsyncIterable<ServerEvent>>,
  libraryId: string,
  onChange: () => void,
  signal: AbortSignal,
  retryMs?: number,
) {
  return followEvents(
    open,
    (event) => {
      if (event.kind === "library.changed" && event.libraryId === libraryId)
        onChange();
    },
    signal,
    retryMs,
  );
}
