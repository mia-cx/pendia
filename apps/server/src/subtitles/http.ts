import { AuthError } from "../auth/errors.ts";
import { readSessionToken } from "../auth/http.ts";
import { requirePermission } from "../auth/permissions.ts";
import { authenticate } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import {
  readTrackName,
  type StoredSubtitle,
  subtitleFolders,
} from "./store.ts";

const routePattern =
  /^\/api\/subtitles\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([^/]+)$/i;

const contentTypes: Record<StoredSubtitle["format"], string> = {
  srt: "application/x-subrip; charset=utf-8",
  ass: "text/x-ssa; charset=utf-8",
  vtt: "text/vtt; charset=utf-8",
};

/** The URL the play plan gives for one stored track. */
export function subtitleUrl(itemId: string, track: StoredSubtitle): string {
  return `/api/subtitles/${itemId}/${track.language}.${track.format}`;
}

function failure(status: number, message: string): Response {
  return Response.json(
    { error: message },
    { status, headers: { "cache-control": "no-store" } },
  );
}

/** Serves stored subtitle tracks at `/api/subtitles/<itemId>/<language>.<format>` to callers who may view the Item. */
export function createSubtitleHandler(db: Database) {
  return async (request: Request): Promise<Response | undefined> => {
    const match = routePattern.exec(new URL(request.url).pathname);
    if (match === null) return undefined;
    const [, itemId = "", name = ""] = match;
    if (request.method !== "GET") return failure(405, "Use GET.");
    try {
      const caller = await authenticate(db, readSessionToken(request));
      const track = readTrackName(name);
      if (track === null) return failure(404, "No such subtitle track.");
      // A track may sit in any asset root; the home root holds the newest.
      const folders = await subtitleFolders(db, itemId);
      const [first] = folders;
      if (first === undefined) return failure(404, "No such subtitle track.");
      await requirePermission(db, caller.user.id, "view", first.libraryId);
      for (const folder of folders) {
        const file = Bun.file(folder.file(track));
        if (await file.exists())
          return new Response(file, {
            headers: {
              "content-type": contentTypes[track.format],
              "cache-control": "private, no-cache",
              "x-content-type-options": "nosniff",
            },
          });
      }
      return failure(404, "No such subtitle track.");
    } catch (error) {
      if (error instanceof AuthError)
        return failure(error.status, error.message);
      throw error;
    }
  };
}
