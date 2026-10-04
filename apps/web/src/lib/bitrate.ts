const bitsPerMegabit = 1_000_000;

/** Bits per second as the Mbit/s figure a field shows, such as `2.5`. */
export function toMbps(bps: number): string {
  return String(bps / bitsPerMegabit);
}

/** Reads a Mbit/s field into bits per second: null when empty, undefined when not a positive number. */
export function fromMbps(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const mbps = Number(trimmed);
  if (!Number.isFinite(mbps) || mbps <= 0) return undefined;
  const bps = Math.round(mbps * bitsPerMegabit);
  return bps < 1 || !Number.isSafeInteger(bps) ? undefined : bps;
}
