import type { ErrorMap } from "@orpc/server";
import { os } from "@orpc/server";
import { readSessionToken } from "../auth/http.ts";
import { authenticate } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { fromHost, runApi } from "./errors.ts";
import type { EventBroker } from "./events.ts";

/** The request-scoped context every API procedure receives. */
export type ApiContext = {
  db: Database;
  request: Request;
  peerAddress: string;
  events: EventBroker;
};

/** The error map every procedure shares so oRPC documents and types it. */
export const apiErrors = {
  UNAUTHORIZED: {},
  FORBIDDEN: {},
  NOT_FOUND: {},
  BAD_REQUEST: {},
} satisfies ErrorMap;

/** The builder every procedure starts from. */
export const base = os.$context<ApiContext>().errors(apiErrors);

/** Authenticates a request against the auth slice as an effect. */
export function authenticateRequest(db: Database, request: Request) {
  return fromHost(async () => authenticate(db, readSessionToken(request)));
}

/** The builder for procedures that need an authenticated caller. */
export const authenticated = base.use(async ({ context, next }) => {
  const caller = await runApi(authenticateRequest(context.db, context.request));
  return next({ context: { caller } });
});
