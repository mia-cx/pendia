import type { PendiaClient } from "./api.ts";

/** The scan status shape the libraries API answers. */
export type ScanStatus = Awaited<
  ReturnType<PendiaClient["libraries"]["scanStatus"]>
>;

type ScanStatusInput = Parameters<PendiaClient["libraries"]["scanStatus"]>[0];

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
