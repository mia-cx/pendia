import { posix } from "node:path";
import { Schema } from "effect";
import { AuthError } from "../auth/errors.ts";
import { requirePermission } from "../auth/permissions.ts";
import { authenticate } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import type {
  createChangeDebouncer,
  WatchedChange,
} from "../libraries/webhooks.ts";

const bearerPattern = /^Bearer (\S+)$/i;

/** A normalized library-relative path below the root. */
const RelativePath = Schema.String.pipe(
  Schema.filter(
    (path) =>
      !path.includes("\0") &&
      !posix.isAbsolute(path) &&
      posix.normalize(path) === path &&
      path !== "." &&
      path !== ".." &&
      !path.startsWith("../"),
  ),
);

const EventBatch = Schema.Struct({
  libraryId: Schema.UUID,
  changes: Schema.Array(
    Schema.Union(
      Schema.Struct({
        kind: Schema.Literal("add", "delete"),
        path: RelativePath,
      }),
      Schema.Struct({
        kind: Schema.Literal("move"),
        path: RelativePath,
        previousPath: RelativePath,
      }),
    ),
  ),
}) satisfies Schema.Schema<{
  libraryId: string;
  changes: readonly WatchedChange[];
}>;

const respond = (body: unknown, status: number) =>
  Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });

/** Accepts only an API key with manage-libraries, sent as a Bearer header. */
async function requireWatcherKey(db: Database, request: Request) {
  const token = request.headers.get("authorization")?.match(bearerPattern)?.[1];
  if (token === undefined) throw new AuthError("UNAUTHENTICATED");
  const auth = await authenticate(db, token);
  if (auth.credential.kind !== "api-key")
    throw new AuthError("UNAUTHENTICATED");
  await requirePermission(db, auth.user.id, "manage-libraries");
}

async function readBody<A, I>(request: Request, schema: Schema.Schema<A, I>) {
  try {
    return Schema.decodeUnknownSync(schema)(await request.json());
  } catch {
    throw new AuthError("INVALID_INPUT");
  }
}

/** Creates the HTTP handler for `/api/watcher/*`, the watcher role's api. */
export function createWatcherHandler(
  db: Database,
  debouncer: Pick<ReturnType<typeof createChangeDebouncer>, "submitWatched">,
) {
  return async (request: Request): Promise<Response | undefined> => {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith("/api/watcher/")) return undefined;
    try {
      if (request.method !== "POST") throw new AuthError("METHOD_NOT_ALLOWED");
      await requireWatcherKey(db, request);
      if (pathname === "/api/watcher/events") {
        const batch = await readBody(request, EventBatch);
        const accepted = await debouncer.submitWatched(
          batch.libraryId,
          batch.changes,
        );
        return respond({ accepted }, 202);
      }
      throw new AuthError("NOT_FOUND");
    } catch (error) {
      if (error instanceof AuthError)
        return respond(
          { error: { code: error.code, message: error.message } },
          error.status,
        );
      throw error;
    }
  };
}
