import { reachServer } from "./api.ts";
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
  const response = await reachServer(
    `${options.origin ?? ""}${path}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    options.fetch,
  );
  if (!response.ok) await raiseAuthError(response);
  return (await response.json()) as T;
}

// crypto.randomUUID needs a secure context; getRandomValues works on plain HTTP.
function newDeviceId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function storedDeviceId(): string | null {
  try {
    return localStorage.getItem("pendia.deviceId");
  } catch {
    return null;
  }
}

function rememberDeviceId(deviceId: string): void {
  try {
    localStorage.setItem("pendia.deviceId", deviceId);
  } catch {
    // A browser that denies storage gets an id for this page only.
  }
}

/** The device identity this browser keeps across reloads. */
export function deviceInfo() {
  let deviceId = storedDeviceId();
  if (deviceId === null) {
    deviceId = newDeviceId();
    rememberDeviceId(deviceId);
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

/** The screen-ready sentence explaining the username rules. */
export const usernameRule =
  "A username uses letters, digits, dots, underscores and hyphens, and starts with a letter or digit.";

/** An invite token's state, as the status route reads it. */
export type InviteStatus = "live" | "expired" | "accepted" | "unknown";

/** Reads whether an invite token can still create an account, without spending it. */
export function readInviteStatus(token: string, options: AuthOptions = {}) {
  return postJson<{ status: InviteStatus }>(
    "/api/auth/invites/status",
    { token },
    options,
  );
}

/** Spends an invite on a new local account; the route also sets the session cookie. */
export function acceptInvite(
  input: {
    token: string;
    username: string;
    password: string;
    displayName?: string;
  },
  options: AuthOptions = {},
) {
  return postJson<{
    token: string;
    user: PublicUser;
    session: SessionInfo;
  }>("/api/auth/invites/accept", { ...input, ...deviceInfo() }, options);
}

/** The OIDC login route for this browser, carrying an invite token for a new account. */
export function oidcLoginUrl(invite?: string) {
  const params = new URLSearchParams(deviceInfo());
  if (invite !== undefined) params.set("invite", invite);
  return `/api/auth/oidc/login?${params}`;
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
