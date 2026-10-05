import { type Readable, writable } from "svelte/store";

/** Optimistic rating writes: a choice shows at once, and a failed write falls back to the last rating the server acknowledged. */
export function createRatingWrites(
  save: (rating: number | null) => Promise<{ rating: number | null }>,
): Readable<number | null | undefined> & {
  write: (rating: number | null) => Promise<boolean>;
} {
  const store = writable<number | null | undefined>(undefined);
  let ticket = 0;
  const pending: { ticket: number; rating: number | null }[] = [];
  let acknowledged: number | null | undefined;
  let ackTicket = 0;

  /** Shows `rating` and saves it; resolves false when the save fails. */
  async function write(rating: number | null): Promise<boolean> {
    const mine = ++ticket;
    pending.push({ ticket: mine, rating });
    store.set(rating);
    let saved: boolean;
    try {
      const result = await save(rating);
      if (mine > ackTicket) {
        acknowledged = result.rating;
        ackTicket = mine;
      }
      saved = true;
    } catch {
      saved = false;
    }
    pending.splice(
      pending.findIndex((entry) => entry.ticket === mine),
      1,
    );
    const last = pending[pending.length - 1];
    // A pending choice shows only while it is newer than the last acknowledged one.
    store.set(
      last !== undefined && last.ticket > ackTicket
        ? last.rating
        : acknowledged,
    );
    return saved;
  }

  return { subscribe: store.subscribe, write };
}
