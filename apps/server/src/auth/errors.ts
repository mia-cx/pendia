const errors = {
  INVALID_INPUT: [400, "Invalid auth input."],
  INVALID_CREDENTIALS: [401, "Invalid credentials."],
  UNAUTHENTICATED: [401, "Authentication required."],
  FORBIDDEN: [403, "Permission denied."],
  NOT_FOUND: [404, "Auth record not found."],
  CONFLICT: [409, "Auth record already exists."],
  SETUP_COMPLETE: [409, "Setup is already complete."],
  RATE_LIMITED: [429, "Too many login attempts."],
} as const;

/** An auth failure carrying a stable code and HTTP status. */
export class AuthError extends Error {
  readonly status: number;
  constructor(
    readonly code: keyof typeof errors,
    readonly retryAfterSeconds?: number,
  ) {
    super(errors[code][1]);
    this.name = "AuthError";
    this.status = errors[code][0];
  }
}

/** Unwraps a Postgres error code through drizzle's cause chain. */
export function postgresCode(error: unknown): string | undefined {
  let current = error;
  while (current && typeof current === "object") {
    const record = current as Record<string, unknown>;
    if (typeof record.errno === "string") return record.errno;
    if (typeof record.code === "string") return record.code;
    current = record.cause;
  }
  return undefined;
}
