import { AuthRouteError } from "./errors.ts";

/** The extra arguments every auth wrapper accepts for tests. */
export type AuthOptions = {
  origin?: string;
  fetch?: typeof globalThis.fetch;
};

/** The public account shape the auth routes return. */
export type PublicUser = {
  id: string;
  username: string;
  displayName: string;
};

type SessionInfo = {
  id: string;
  userId: string;
  clientName: string;
  deviceId: string;
  deviceName: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
};

type Invite = {
  id: string;
  email: string;
  invitedBy: string;
  expiresAt: string;
  acceptedAt: string | null;
};

async function raiseAuthError(response: Response): Promise<never> {
  let code = "UNKNOWN";
  let message = response.statusText;
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null) {
      const record = body as {
        error?: { code?: unknown; message?: unknown };
      };
      if (typeof record.error?.code === "string") code = record.error.code;
      if (typeof record.error?.message === "string")
        message = record.error.message;
    }
  } catch {
    // A non-JSON failure body keeps the status text as the message.
  }
  throw new AuthRouteError(code, message);
}

async function postJson<T>(
  path: string,
  body: Record<string, unknown> | undefined,
  options: AuthOptions,
): Promise<T> {
  const call = options.fetch ?? fetch;
  const response = await call(`${options.origin ?? ""}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) await raiseAuthError(response);
  return (await response.json()) as T;
}

/** The device identity this browser keeps across reloads. */
export function deviceInfo() {
  const store = typeof localStorage === "undefined" ? null : localStorage;
  let deviceId = store?.getItem("pendia.deviceId") ?? null;
  if (deviceId === null) {
    deviceId = crypto.randomUUID();
    store?.setItem("pendia.deviceId", deviceId);
  }
  const agent = (typeof navigator === "undefined" ? "" : navigator.userAgent)
    .trim()
    .slice(0, 128);
  return {
    clientName: "Pendia Web",
    deviceId,
    deviceName: agent === "" ? "Browser" : agent,
  };
}

/** Creates the first admin; the route answers 409 once setup is closed. */
export function createFirstAdmin(
  input: { username: string; password: string; displayName?: string },
  options: AuthOptions = {},
) {
  return postJson<{ user: PublicUser }>("/api/auth/setup", input, options);
}

/** Signs in with a local password and returns the one-time session token. */
export function signIn(
  input: { username: string; password: string },
  options: AuthOptions = {},
) {
  return postJson<{
    token: string;
    user: PublicUser;
    session: SessionInfo;
  }>("/api/auth/login", { ...input, ...deviceInfo() }, options);
}

/** Revokes the current session and clears its cookie. */
export function signOut(options: AuthOptions = {}) {
  return postJson<{ ok: true }>("/api/auth/logout", undefined, options);
}

/** Creates an invite and returns its one-time token with the safe row. */
export function createInvite(
  input: { email: string; expiresInSeconds: number },
  options: AuthOptions = {},
) {
  return postJson<{ token: string; invite: Invite }>(
    "/api/auth/invites",
    input,
    options,
  );
}
