import type { PendiaClient } from "./api.ts";

/** The scan status shape the libraries API answers. */
export type ScanStatus = Awaited<
  ReturnType<PendiaClient["libraries"]["scanStatus"]>
>;

/** Polls a library's scan status until the scan settles or the deadline hits. */
export async function waitForScan(
  client: PendiaClient,
  libraryId: string,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    onStatus?: (status: ScanStatus) => void;
  } = {},
) {
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
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
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for the first scan.");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
