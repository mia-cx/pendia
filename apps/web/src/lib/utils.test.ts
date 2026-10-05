import { expect, test } from "bun:test";
import { cn } from "./utils.ts";

test("cn keeps a type-scale size next to a colour class", () => {
  expect(cn("text-footnote", "text-label")).toBe("text-footnote text-label");
});
