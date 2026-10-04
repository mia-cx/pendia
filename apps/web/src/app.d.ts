import type { FailureCode } from "$lib/errors.ts";

declare global {
  /** Safari's power-aware MediaSource; absent elsewhere and from TypeScript's DOM types. */
  var ManagedMediaSource: typeof MediaSource | undefined;

  namespace App {
    /** What the error page knows about a failed load. */
    interface Error {
      message: string;
      code?: FailureCode;
    }
  }
}
