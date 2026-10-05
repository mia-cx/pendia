import { describe, expect, test } from "bun:test";
import { accountFailure, isValidUsername, usernameRule } from "./auth.ts";
import { AuthRouteError, readFailure } from "./errors.ts";

describe("isValidUsername", () => {
  test("a plain lowercase name passes", () => {
    expect(isValidUsername("mia")).toBe(true);
  });

  test("uppercase and padding are normalized first", () => {
    expect(isValidUsername("  MIA.Cx ")).toBe(true);
  });

  test("sixty-four characters still pass", () => {
    expect(isValidUsername("a".repeat(64))).toBe(true);
  });

  test("sixty-five characters fail", () => {
    expect(isValidUsername("a".repeat(65))).toBe(false);
  });

  test("leading punctuation fails", () => {
    expect(isValidUsername(".mia")).toBe(false);
    expect(isValidUsername("_mia")).toBe(false);
    expect(isValidUsername("-mia")).toBe(false);
  });

  test("an empty name fails", () => {
    expect(isValidUsername("")).toBe(false);
  });
});

describe("accountFailure", () => {
  test("a bad request about another field keeps the server's message", () => {
    const failure = readFailure(
      new AuthRouteError("INVALID_INPUT", "Invalid input"),
    );
    expect(accountFailure(failure, "mia")).toEqual({
      code: "BAD_REQUEST",
      message: "Invalid input",
    });
  });

  test("a rate limit keeps its own message", () => {
    const failure = readFailure(
      new AuthRouteError("RATE_LIMITED", "Too many attempts"),
    );
    expect(accountFailure(failure, "mia")).toEqual({
      code: "BAD_REQUEST",
      message: "Too many attempts",
    });
  });

  test("a bad request with a rule-breaking username explains the rule", () => {
    const failure = readFailure(
      new AuthRouteError("INVALID_INPUT", "Invalid input"),
    );
    expect(accountFailure(failure, "-mia")).toEqual({
      code: "BAD_REQUEST",
      message: usernameRule,
    });
  });

  test("a conflict is returned unchanged even with a bad username", () => {
    const failure = readFailure(
      new AuthRouteError("CONFLICT", "Username taken"),
    );
    expect(accountFailure(failure, "-mia")).toEqual(failure);
  });
});
