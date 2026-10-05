import { describe, expect, test } from "bun:test";
import { serialQueue } from "./serial.ts";

describe("serialQueue", () => {
  test("a second job starts only after a slower first job settles", async () => {
    const run = serialQueue();
    const order: string[] = [];
    const slow = run(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            order.push("first-end");
            resolve(1);
          }, 20);
        }),
    );
    const fast = run(async () => {
      order.push("second-run");
      return 2;
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(["first-end", "second-run"]);
  });

  test("results come back in order", async () => {
    const run = serialQueue();
    const results = await Promise.all([
      run(async () => "a"),
      run(async () => "b"),
      run(async () => "c"),
    ]);
    expect(results).toEqual(["a", "b", "c"]);
  });

  test("a rejected first job still lets the second run", async () => {
    const run = serialQueue();
    const failed = run(async () => {
      throw new Error("nope");
    });
    const second = run(async () => "still ran");
    await expect(failed).rejects.toThrow("nope");
    await expect(second).resolves.toBe("still ran");
  });
});
