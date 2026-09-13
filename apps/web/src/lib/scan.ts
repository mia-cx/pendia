import type { PendiaClient } from "./api.ts";

/** The scan status shape the libraries API answers. */
export type ScanStatus = Awaited<
  ReturnType<PendiaClient["libraries"]["scanStatus"]>
>;

/** Polls a library's scan status until it settles, the signal aborts or an optional deadline hits. */
export async function waitForScan(
  client: PendiaClient,
  libraryId: string,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    signal?: AbortSignal;
    onStatus?: (status: ScanStatus) => void;
  } = {},
) {
  const deadline =
    options.timeoutMs === undefined ? null : Date.now() + options.timeoutMs;
  const intervalMs = options.intervalMs ?? 250;
  for (;;) {
    const status = await client.libraries.scanStatus({ id: libraryId });
    options.onStatus?.(status);
    const { counts } = status;
    if (
      counts.queued === 0 &&
      counts.running === 0 &&
      (counts.completed > 0 || counts.failed > 0)
    )
      return status;
    if (options.signal?.aborted) return status;
    if (deadline !== null && Date.now() >= deadline)
      throw new Error("Timed out waiting for the first scan.");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
