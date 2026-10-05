import { describe, expect, test } from "bun:test";
import type { ScanReader, ScanStatus } from "./scan.ts";
import { scanProgress, waitForScan } from "./scan.ts";

const libraryId = "11111111-1111-4111-8111-111111111111";

function status(
  counts: Partial<ScanStatus["counts"]>,
  latest: ScanStatus["latest"] = null,
): ScanStatus {
  return {
    libraryId,
    counts: { queued: 0, running: 0, completed: 0, failed: 0, ...counts },
    latest,
    runId: null,
  };
}

/** A reader that answers each call with the next status, and records the signals it saw. */
function reader(answers: ScanStatus[]) {
  const signals: (AbortSignal | undefined)[] = [];
  const client: ScanReader = {
    libraries: {
      scanStatus: async (_input, options) => {
        signals.push(options?.signal);
        return answers[signals.length - 1] ?? answers[answers.length - 1];
      },
    },
  };
  return { client, signals };
}

describe("waitForScan", () => {
  test("polls until the run settles", async () => {
    const { client, signals } = reader([
      status({ running: 1 }),
      status({ completed: 2 }),
    ]);
    const seen: number[] = [];
    const settled = await waitForScan(client, libraryId, {
      intervalMs: 1,
      onStatus: (reading) => seen.push(reading.counts.completed),
    });
    expect(settled.counts.completed).toBe(2);
    expect(signals).toHaveLength(2);
    expect(seen).toEqual([0, 2]);
  });

  test("issues no request once the caller has already aborted", async () => {
    const { client, signals } = reader([status({ completed: 1 })]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      waitForScan(client, libraryId, { signal: controller.signal }),
    ).rejects.toThrow();
    expect(signals).toEqual([]);
  });

  test("ends a stalled request when the deadline passes", async () => {
    let stalled: AbortSignal | undefined;
    const client: ScanReader = {
      libraries: {
        scanStatus: (_input, options) => {
          stalled = options?.signal;
          return new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () =>
              reject(options.signal?.reason),
            );
          });
        },
      },
    };
    await expect(
      waitForScan(client, libraryId, { timeoutMs: 5 }),
    ).rejects.toThrow("Timed out waiting for the first scan.");
    expect(stalled?.aborted).toBe(true);
  });
});

describe("scanProgress", () => {
  test("starting while no status has arrived", () => {
    expect(scanProgress(undefined)).toEqual({ state: "starting" });
  });

  test("running reports the finished fraction", () => {
    expect(
      scanProgress(status({ queued: 1, running: 1, completed: 2 })),
    ).toEqual({ state: "running", fraction: 0.5 });
  });

  test("running with nothing finished yet reads indeterminate", () => {
    expect(scanProgress(status({ running: 1 }))).toEqual({
      state: "running",
      fraction: null,
    });
  });

  test("a settled scan reads done", () => {
    expect(scanProgress(status({ completed: 3 }))).toEqual({ state: "done" });
  });

  test("failed carries the count and the latest job's error", () => {
    const latest = {
      id: "22222222-2222-4222-8222-222222222222",
      state: "failed" as const,
      error: "permission denied on /srv/movies",
    };
    expect(scanProgress(status({ failed: 1 }, latest))).toEqual({
      state: "failed",
      failed: 1,
      error: "permission denied on /srv/movies",
    });
  });

  test("failed without a failed latest job reads no error", () => {
    const latest = {
      id: "22222222-2222-4222-8222-222222222222",
      state: "completed" as const,
      error: null,
    };
    expect(scanProgress(status({ failed: 2 }, latest))).toEqual({
      state: "failed",
      failed: 2,
      error: null,
    });
  });

  test("a settled scan with nothing completed still reads done", () => {
    expect(scanProgress(status({}))).toEqual({ state: "done" });
  });
});
