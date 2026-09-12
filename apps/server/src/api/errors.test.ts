import { describe, expect, spyOn, test } from "bun:test";
import { ORPCError } from "@orpc/server";
import { Effect } from "effect";
import { AuthError } from "../auth/errors.ts";
import { ApiError, fromHost, runApi } from "./errors.ts";

const cases: [AuthError["code"], string, number][] = [
  ["INVALID_INPUT", "BAD_REQUEST", 400],
  ["INVALID_INVITE", "BAD_REQUEST", 400],
  ["INVALID_CREDENTIALS", "UNAUTHORIZED", 401],
  ["UNAUTHENTICATED", "UNAUTHORIZED", 401],
  ["OIDC_FAILED", "UNAUTHORIZED", 401],
  ["FORBIDDEN", "FORBIDDEN", 403],
  ["NOT_FOUND", "NOT_FOUND", 404],
  ["CONFLICT", "CONFLICT", 409],
  ["SETUP_COMPLETE", "CONFLICT", 409],
  ["BODY_TOO_LARGE", "PAYLOAD_TOO_LARGE", 413],
  ["METHOD_NOT_ALLOWED", "BAD_REQUEST", 400],
  ["RATE_LIMITED", "TOO_MANY_REQUESTS", 429],
];

async function capture(
  promise: Promise<unknown>,
): Promise<ORPCError<string, unknown>> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ORPCError) return error;
    throw new Error(`Expected an ORPCError, caught ${String(error)}`);
  }
  throw new Error("Expected the promise to reject.");
}

describe("api errors", () => {
  test("each auth code maps to its oRPC code and HTTP status", async () => {
    for (const [authCode, code, status] of cases) {
      const error = await capture(
        runApi(
          fromHost(async () => {
            throw new AuthError(authCode);
          }),
        ),
      );
      expect(error.code).toBe(code);
      expect(error.status).toBe(status);
    }
  });

  test("a thrown host error answers 500 without leaking its message", async () => {
    const secret = "the connection string lives here";
    const spy = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const error = await capture(
        runApi(
          fromHost(async () => {
            throw new Error(secret);
          }),
        ),
      );
      expect(error.code).toBe("INTERNAL_SERVER_ERROR");
      expect(error.status).toBe(500);
      expect(error.message).not.toContain(secret);
      expect(spy).toHaveBeenCalledTimes(1);
      const line = JSON.parse(String(spy.mock.calls[0]?.[0])) as {
        level: string;
        message: string;
        error: string;
      };
      expect(line).toMatchObject({
        level: "error",
        message: "api.request.failed",
      });
      expect(line.error).toContain(secret);
    } finally {
      spy.mockRestore();
    }
  });

  test("a synchronous throw inside the host call becomes a defect too", async () => {
    const secret = "synchronous failure detail";
    const spy = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const error = await capture(
        runApi(
          fromHost(() => {
            throw new Error(secret);
          }),
        ),
      );
      expect(error.status).toBe(500);
      expect(error.message).not.toContain(secret);
      const line = JSON.parse(String(spy.mock.calls[0]?.[0])) as {
        error: string;
      };
      expect(line.error).toContain(secret);
    } finally {
      spy.mockRestore();
    }
  });

  test("a directly failed ApiError maps to its status and reason", async () => {
    const error = await capture(
      runApi(
        Effect.fail(
          new ApiError({ code: "NOT_FOUND", reason: "Item not here." }),
        ),
      ),
    );
    expect(error.code).toBe("NOT_FOUND");
    expect(error.status).toBe(404);
    expect(error.message).toBe("Item not here.");
  });

  test("a successful effect returns its value", async () => {
    await expect(runApi(Effect.succeed(41))).resolves.toBe(41);
  });
});
