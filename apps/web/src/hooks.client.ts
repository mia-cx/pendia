import type { HandleClientError } from "@sveltejs/kit";
import { readFailure } from "$lib/errors.ts";

/** Hands the error page the failure kind, so it can tell an unreachable server apart. */
export const handleError: HandleClientError = ({ error }) => {
  const failure = readFailure(error);
  // Unexplained failures are bugs; keep them in the console as SvelteKit would.
  if (failure.code === "UNKNOWN") console.error(error);
  return failure;
};
