import { type Readable, writable } from "svelte/store";

/** Optimistic rating writes: a choice shows at once, and a failed write falls back to the last rating the server acknowledged. */
export function createRatingWrites(
  save: (rating: number | null) => Promise<{ rating: number | null }>,
): Readable<number | null | undefined> & {
  write: (rating: number | null) => Promise<boolean>;
} {
  const store = writable<number | null | undefined>(undefined);
  let latest = 0;
  let acknowledged: number | null | undefined;
  let ackTicket = 0;

  /** Shows `rating` and saves it; resolves false when the save fails. */
  async function write(rating: number | null): Promise<boolean> {
    const ticket = ++latest;
    store.set(rating);
    try {
      const saved = await save(rating);
      if (ticket > ackTicket) {
        acknowledged = saved.rating;
        ackTicket = ticket;
      }
      if (ticket === latest) store.set(acknowledged);
      return true;
    } catch {
      if (ticket === latest) store.set(acknowledged);
      return false;
    }
  }

  return { subscribe: store.subscribe, write };
}
