import { describe, expect, test } from "bun:test";
import type { ScanReader, ScanStatus } from "./scan.ts";
import {
  failurePath,
  failureReason,
  type ScanProgress,
  scanPhase,
  scanProgress,
  scanStartedAt,
  scanState,
  waitForScan,
} from "./scan.ts";

const libraryId = "11111111-1111-4111-8111-111111111111";

/** A status whose failure total counts its failed jobs plus `skipped` files, as the server's does. */
function status(
  counts: Partial<ScanStatus["counts"]>,
  latest: ScanStatus["latest"] = null,
  skipped = 0,
): ScanStatus {
  return {
    libraryId,
    counts: { queued: 0, running: 0, completed: 0, failed: 0, ...counts },
    latest,
    runId: null,
    failures: { total: (counts.failed ?? 0) + skipped, items: [] },
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

describe("scanState", () => {
  function withLatest(
    counts: Partial<ScanStatus["counts"]>,
    skipped = 0,
  ): ScanStatus {
    return {
      ...status(counts, null, skipped),
      latest: { id: libraryId, state: "completed", error: null },
    };
  }

  test("undefined or no finished scan is idle", () => {
    expect(scanState(undefined)).toEqual({
      label: "Not scanned",
      tone: "idle",
    });
    expect(scanState(status({}))).toEqual({
      label: "Not scanned",
      tone: "idle",
    });
  });

  test("running or queued scans are active", () => {
    expect(scanState(withLatest({ running: 1 }))).toEqual({
      label: "Scanning",
      tone: "active",
    });
    expect(scanState(withLatest({ queued: 2 }))).toEqual({
      label: "Queued",
      tone: "active",
    });
  });

  test("only failures read Scan failed", () => {
    expect(scanState(withLatest({ failed: 2 }))).toEqual({
      label: "Scan failed",
      tone: "error",
    });
  });

  test("failures beside completions read a real plural", () => {
    expect(scanState(withLatest({ completed: 3, failed: 1 })).label).toBe(
      "Scanned with 1 error",
    );
    expect(scanState(withLatest({ completed: 3, failed: 4 })).label).toBe(
      "Scanned with 4 errors",
    );
  });

  test("skipped files count as errors beside failed jobs", () => {
    expect(scanState(withLatest({ completed: 3 }, 2))).toEqual({
      label: "Scanned with 2 errors",
      tone: "error",
    });
    expect(scanState(withLatest({ completed: 3, failed: 1 }, 2)).label).toBe(
      "Scanned with 3 errors",
    );
    expect(scanState(withLatest({ failed: 1 }, 2)).label).toBe("Scan failed");
  });

  test("a clean scan reads Scanned", () => {
    expect(scanState(withLatest({ completed: 9 }))).toEqual({
      label: "Scanned",
      tone: "done",
    });
  });
});

describe("failureReason", () => {
  test("skipped files read a fixed phrase", () => {
    expect(failureReason({ reason: "unreadable", detail: "moov atom" })).toBe(
      "File is empty or corrupt",
    );
    expect(failureReason({ reason: "no-video", detail: "" })).toBe(
      "No video stream",
    );
  });

  test("a job error reads its first line", () => {
    expect(
      failureReason({
        reason: "error",
        detail: "\n  permission denied on /srv/movies \nstack trace",
      }),
    ).toBe("permission denied on /srv/movies");
    expect(failureReason({ reason: "error", detail: " \n" })).toBe(
      "Unknown error",
    );
  });

  test("a long job error is trimmed to 120 characters", () => {
    const reason = failureReason({ reason: "error", detail: "x".repeat(300) });
    expect(reason).toHaveLength(120);
    expect(reason.endsWith("…")).toBe(true);
    const fits = "y".repeat(120);
    expect(failureReason({ reason: "error", detail: fits })).toBe(fits);
  });
});

describe("failurePath", () => {
  const file = { path: "Alien (1979)/Alien.mkv", root: "/srv/movies/hq/" };

  test("leads with the root's folder name only when asked", () => {
    expect(failurePath(file, true)).toBe("hq/Alien (1979)/Alien.mkv");
    expect(failurePath(file, false)).toBe("Alien (1979)/Alien.mkv");
  });

  test("a job keeps its own path, and the run's root job reads Whole library", () => {
    expect(failurePath({ path: "Heat (1995)", root: null }, true)).toBe(
      "Heat (1995)",
    );
    expect(failurePath({ path: ".", root: null }, true)).toBe("Whole library");
  });
});

describe("scanPhase", () => {
  test("a failed request with no run id is unstarted, even over a failed scan", () => {
    const failed: ScanProgress = { state: "failed", failed: 2, error: "x" };
    expect(scanPhase(failed, { failed: true, runId: undefined })).toBe(
      "unstarted",
    );
  });

  test("a failed request with a run id is unfollowed", () => {
    expect(
      scanPhase(
        { state: "running", fraction: 0.5 },
        { failed: true, runId: "abc" },
      ),
    ).toBe("unfollowed");
  });

  test("a live request passes the progress state through", () => {
    const cases: ScanProgress[] = [
      { state: "starting" },
      { state: "running", fraction: null },
      { state: "running", fraction: 0.25 },
      { state: "done" },
      { state: "failed", failed: 1, error: null },
    ];
    for (const progress of cases)
      expect(scanPhase(progress, { failed: false, runId: "abc" })).toBe(
        progress.state,
      );
  });
});

describe("scanStartedAt", () => {
  test("decodes the run's start from its UUIDv7 id", () => {
    const ms = 1_757_600_000_000;
    const hex = ms.toString(16).padStart(12, "0");
    const runId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7abc-8def-0123456789ab`;
    expect(scanStartedAt({ ...status({ completed: 2 }), runId })).toEqual(
      new Date(ms),
    );
  });

  test("answers null without a run", () => {
    expect(scanStartedAt(undefined)).toBeNull();
    expect(scanStartedAt(status({ completed: 2 }))).toBeNull();
  });
});
