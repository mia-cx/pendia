import { describe, expect, test } from "bun:test";
import { get } from "svelte/store";
import { createRatingWrites } from "./rating.ts";

describe("createRatingWrites", () => {
  function saves() {
    const pending: {
      rating: number | null;
      resolve: (saved: { rating: number | null }) => void;
      reject: (error: unknown) => void;
    }[] = [];
    const save = (rating: number | null) =>
      new Promise<{ rating: number | null }>((resolve, reject) => {
        pending.push({ rating, resolve, reject });
      });
    return { pending, save };
  }

  test("a failed save after a successful one shows the saved rating", async () => {
    const { pending, save } = saves();
    const writes = createRatingWrites(save);

    const first = writes.write(8);
    pending[0]?.resolve({ rating: 8 });
    expect(await first).toBe(true);
    expect(get(writes)).toBe(8);

    const second = writes.write(4);
    expect(get(writes)).toBe(4);
    pending[1]?.reject(new Error("offline"));
    expect(await second).toBe(false);
    expect(get(writes)).toBe(8);
  });

  test("a failed clear restores the saved rating", async () => {
    const { pending, save } = saves();
    const writes = createRatingWrites(save);

    const first = writes.write(8);
    pending[0]?.resolve({ rating: 8 });
    await first;

    const cleared = writes.write(null);
    expect(get(writes)).toBe(null);
    pending[1]?.reject(new Error("offline"));
    expect(await cleared).toBe(false);
    expect(get(writes)).toBe(8);
  });

  test("a failed first write falls back to the loaded marks", async () => {
    const { pending, save } = saves();
    const writes = createRatingWrites(save);

    const attempt = writes.write(8);
    expect(get(writes)).toBe(8);
    pending[0]?.reject(new Error("offline"));
    expect(await attempt).toBe(false);
    expect(get(writes)).toBeUndefined();
  });

  test("an earlier write settling late does not override a newer choice", async () => {
    const { pending, save } = saves();
    const writes = createRatingWrites(save);

    const first = writes.write(8);
    const second = writes.write(4);
    pending[0]?.resolve({ rating: 8 });
    expect(await first).toBe(true);
    expect(get(writes)).toBe(4);
    pending[1]?.reject(new Error("offline"));
    expect(await second).toBe(false);
    expect(get(writes)).toBe(8);
  });
});
