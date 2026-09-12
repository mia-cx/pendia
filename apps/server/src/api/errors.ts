import { ORPCError } from "@orpc/server";
import { Cause, Data, Effect, Exit, Option } from "effect";
import { AuthError } from "../auth/errors.ts";

/** The oRPC error codes this API raises. */
export type ApiErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "TOO_MANY_REQUESTS";

/** A typed host failure carrying the oRPC code the boundary answers with. */
export class ApiError extends Data.TaggedError("ApiError")<{
  readonly code: ApiErrorCode;
  readonly reason?: string;
}> {}

const authCodeMap = {
  INVALID_INPUT: "BAD_REQUEST",
  INVALID_CREDENTIALS: "UNAUTHORIZED",
  UNAUTHENTICATED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  SETUP_COMPLETE: "CONFLICT",
  BODY_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  METHOD_NOT_ALLOWED: "BAD_REQUEST",
  RATE_LIMITED: "TOO_MANY_REQUESTS",
} satisfies Record<AuthError["code"], ApiErrorCode>;

/** Adapts an auth failure into a typed API error. */
export function fromAuthError(error: AuthError): ApiError {
  return new ApiError({ code: authCodeMap[error.code], reason: error.message });
}

/** Runs a host module promise as an effect: auth failures become typed, the rest die. */
export function fromHost<A>(run: () => Promise<A>): Effect.Effect<A, ApiError> {
  return Effect.tryPromise({
    try: async () => await run(),
    catch: (error) => error,
  }).pipe(
    Effect.catchAll((error) =>
      error instanceof AuthError
        ? Effect.fail(fromAuthError(error))
        : Effect.die(error),
    ),
  );
}

/** Runs an API effect to a promise: typed failures become ORPCErrors, defects a bare 500. */
export async function runApi<A>(
  effect: Effect.Effect<A, ApiError>,
): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Cause.failureOption(exit.cause);
  if (Option.isSome(failure)) {
    const { code, reason } = failure.value;
    throw new ORPCError(code, { message: reason });
  }
  console.error(
    JSON.stringify({
      level: "error",
      message: "api.request.failed",
      error: Cause.pretty(exit.cause),
    }),
  );
  throw new ORPCError("INTERNAL_SERVER_ERROR");
}
