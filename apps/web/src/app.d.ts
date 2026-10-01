import type { FailureCode } from "$lib/errors.ts";

declare global {
  namespace App {
    /** What the error page knows about a failed load. */
    interface Error {
      message: string;
      code?: FailureCode;
    }
  }
}
