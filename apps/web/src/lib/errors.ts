import { ORPCError } from "@orpc/client";

/** A failure from a JSON auth route carrying the server's code and message. */
export class AuthRouteError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AuthRouteError";
  }
}

/** The failure kinds the admin screens distinguish. */
export type FailureCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "BAD_REQUEST"
  | "UNKNOWN";

const unauthorized = new Set(["UNAUTHORIZED", "UNAUTHENTICATED"]);
const badCredentials = new Set(["INVALID_CREDENTIALS", "OIDC_FAILED"]);
const conflict = new Set(["CONFLICT", "SETUP_COMPLETE"]);
const badRequest = new Set([
  "BAD_REQUEST",
  "INVALID_INPUT",
  "INVALID_INVITE",
  "METHOD_NOT_ALLOWED",
  "PAYLOAD_TOO_LARGE",
  "BODY_TOO_LARGE",
  "TOO_MANY_REQUESTS",
  "RATE_LIMITED",
]);

/** Reads a thrown API or auth failure into a code and a screen-ready sentence. */
export function readFailure(error: unknown): {
  code: FailureCode;
  message: string;
} {
  const code =
    error instanceof ORPCError || error instanceof AuthRouteError
      ? error.code
      : undefined;
  const message = error instanceof Error ? error.message : "";
  if (code !== undefined && unauthorized.has(code))
    return {
      code: "UNAUTHORIZED",
      message: "Your session ended. Sign in again.",
    };
  if (code !== undefined && badCredentials.has(code))
    return {
      code: "UNAUTHORIZED",
      message: "That username and password do not match.",
    };
  if (code === "FORBIDDEN")
    return {
      code: "FORBIDDEN",
      message: "You do not have permission to do this.",
    };
  if (code === "NOT_FOUND")
    return { code: "NOT_FOUND", message: "That record does not exist." };
  if (code !== undefined && conflict.has(code))
    return {
      code: "CONFLICT",
      message: message || "That change conflicts with the current state.",
    };
  if (code !== undefined && badRequest.has(code))
    return {
      code: "BAD_REQUEST",
      message: message || "That input is not valid.",
    };
  return {
    code: "UNKNOWN",
    message: "The server could not complete that request.",
  };
}
