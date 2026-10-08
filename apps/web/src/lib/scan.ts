import type { ThaliaClient } from "./api.ts";

/** The scan status shape the libraries API answers. */
export type ScanStatus = Awaited<
  ReturnType<ThaliaClient["libraries"]["scanStatus"]>
>;

type ScanStatusInput = Parameters<ThaliaClient["libraries"]["scanStatus"]>[0];

/** What setup's Scan step derives from a scan status reading. */
export type ScanProgress =
  | { state: "starting" }
  | { state: "running"; fraction: number | null }
  | { state: "done" }
  | { state: "failed"; failed: number; error: string | null };

/** Reads a scan status into what the setup screen shows. */
export function scanProgress(status: ScanStatus | undefined): ScanProgress {
  if (status === undefined) return { state: "starting" };
  const { queued, running, completed, failed } = status.counts;
  if (queued + running > 0) {
    const total = queued + running + completed + failed;
    const done = completed + failed;
    // Nothing has finished yet, so a determinate bar would sit empty.
    return { state: "running", fraction: done === 0 ? null : done / total };
  }
  if (failed > 0)
    return {
      state: "failed",
      failed,
      error: status.latest?.state === "failed" ? status.latest.error : null,
    };
  return { state: "done" };
}

/** What setup's Scan step shows: a failed request outranks the last scan reading. */
export function scanPhase(
  progress: ScanProgress,
  request: { failed: boolean; runId: string | undefined },
): ScanProgress["state"] | "unstarted" | "unfollowed" {
  if (request.failed)
    return request.runId === undefined ? "unstarted" : "unfollowed";
  return progress.state;
}

/** A library's scan state as one label and tone for lists and panels. */
export function scanState(status: ScanStatus | undefined): {
  label: string;
  tone: "active" | "done" | "error" | "idle";
} {
  if (status === undefined || status.latest === null)
    return { label: "Not scanned", tone: "idle" };
  const { queued, running, completed, failed } = status.counts;
  if (running > 0) return { label: "Scanning", tone: "active" };
  if (queued > 0) return { label: "Queued", tone: "active" };
  if (failed > 0 && completed === 0)
    return { label: "Scan failed", tone: "error" };
  // The total counts failed jobs and skipped files alike.
  const errors = status.failures.total;
  if (errors > 0)
    return {
      label: `Scanned with ${errors === 1 ? "1 error" : `${errors} errors`}`,
      tone: "error",
    };
  if (completed > 0) return { label: "Scanned", tone: "done" };
  return { label: "Not scanned", tone: "idle" };
}

/** One failure a scan status lists: a skipped file or a failed scan job. */
export type ScanFailure = ScanStatus["failures"]["items"][number];

/** The most of a job's error line a failure row shows. */
const reasonLength = 120;

const fileReasons = {
  unreadable: "File is empty or corrupt",
  "no-video": "No video stream",
} as const;

/** A failure's short reason: a phrase for a skipped file, or the first line of a job's error. */
export function failureReason(
  failure: Pick<ScanFailure, "reason" | "detail">,
): string {
  if (failure.reason !== "error") return fileReasons[failure.reason];
  const line = failure.detail.trim().split("\n", 1)[0]?.trim() ?? "";
  if (line === "") return "Unknown error";
  return line.length > reasonLength
    ? `${line.slice(0, reasonLength - 1).trimEnd()}…`
    : line;
}

/** Where a failure happened, led by the root's folder name when the library has several roots. */
export function failurePath(
  failure: Pick<ScanFailure, "path" | "root">,
  withRoot: boolean,
): string {
  if (failure.path === ".") return "Whole library";
  const folder = failure.root?.split(/[\\/]/).findLast(Boolean);
  return withRoot && folder ? `${folder}/${failure.path}` : failure.path;
}

/** The run's start time, decoded from its UUIDv7 id; null while no run is known. */
export function scanStartedAt(status: ScanStatus | undefined): Date | null {
  const runId = status?.runId;
  if (runId == null) return null;
  const ms = Number.parseInt(runId.replaceAll("-", "").slice(0, 12), 16);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/** The one call the scan poller makes, so a test can stand a reader in. */
export type ScanReader = {
  libraries: {
    scanStatus: (
      input: ScanStatusInput,
      options?: { signal?: AbortSignal },
    ) => Promise<ScanStatus>;
  };
};

/** Resolves after the delay, or rejects as soon as the signal aborts. */
function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", stop);
      resolve();
    }
    function stop() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", stop, { once: true });
  });
}

/** Polls a library's scan status until it settles, and throws once the signal aborts or the deadline passes. */
export async function waitForScan(
  client: ScanReader,
  libraryId: string,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    signal?: AbortSignal;
    runId?: string;
    onStatus?: (status: ScanStatus) => void;
  } = {},
) {
  const intervalMs = options.intervalMs ?? 1000;
  const deadline =
    options.timeoutMs === undefined
      ? undefined
      : AbortSignal.timeout(options.timeoutMs);
  const signal = AbortSignal.any(
    [options.signal, deadline].filter((one) => one !== undefined),
  );
  try {
    for (;;) {
      signal.throwIfAborted();
      const status = await client.libraries.scanStatus(
        { id: libraryId, runId: options.runId },
        { signal },
      );
      options.onStatus?.(status);
      const { counts } = status;
      if (
        counts.queued === 0 &&
        counts.running === 0 &&
        (counts.completed > 0 || counts.failed > 0)
      )
        return status;
      await sleep(intervalMs, signal);
    }
  } catch (error) {
    if (deadline?.aborted === true)
      throw new Error("Timed out waiting for the first scan.");
    throw error;
  }
}
