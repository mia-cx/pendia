import { listItemViews } from "../api/views.ts";
import { AuthError } from "../auth/errors.ts";
import { setFavourite, setPlayed } from "../playback/marks.ts";
import {
  resolvePlaySession,
  startPlayback,
  stopPlayback,
  updatePlayback,
} from "../playback/progress.ts";
import { json, noContent, type Route, type UserContext } from "./http.ts";
import { userData } from "./items.ts";
import {
  parseGuid,
  readBody,
  requiredGuid,
  ticksPerSecond,
} from "./request.ts";

// Jellyfin counts a play finished past 90 % of the runtime, its MaxResumePct default.
const finishedFraction = 0.9;

const optionalGuid = (text: string | undefined) =>
  text === undefined ? undefined : parseGuid(text);

/**
 * Reads a playback report and finds its session. Findroid sends no
 * PlaySessionId and Swiftfin repeats it as SessionId, so either names it,
 * and neither is required. The position is clamped into the runtime, since
 * players overshoot the end by a frame.
 */
async function readReport({ db, request, caller }: UserContext) {
  const body = await readBody(request);
  const itemId = requiredGuid(body.optionalString("ItemId"));
  const sourceId = optionalGuid(body.optionalString("MediaSourceId"));
  const session = await resolvePlaySession(db, caller.user.id, {
    itemId,
    credentialId: caller.credential.id,
    sessionId: optionalGuid(
      body.optionalString("PlaySessionId") ?? body.optionalString("SessionId"),
    ),
    // A Jellyfin item's first source shares the item's id.
    versionId: sourceId === itemId ? undefined : sourceId,
  });
  const ticks = body.number("PositionTicks");
  const duration = session.durationSeconds ?? Infinity;
  const position =
    ticks === undefined
      ? undefined
      : Math.min(Math.max(ticks / ticksPerSecond, 0), duration);
  return {
    scope: { sessionId: session.sessionId, itemId },
    state: session.state,
    position,
    finished: position !== undefined && position >= duration * finishedFraction,
  };
}

type Report = Awaited<ReturnType<typeof readReport>>;

/**
 * Serves one progress report. A report on a stopped play changes nothing, so
 * a retried stop counts once. A play still starting starts first when the
 * report says where it is, since some players skip `Sessions/Playing`.
 */
function reportRoute(
  path: string,
  apply: (context: UserContext, report: Report) => Promise<unknown>,
): Route {
  return {
    method: "POST",
    path,
    handle: async (context) => {
      const report = await readReport(context);
      if (report.state === "stopped") return noContent();
      if (report.state === "starting" && report.position !== undefined)
        await startPlayback(
          context.db,
          context.caller.user.id,
          report.scope,
          report.position,
        );
      await apply(context, report);
      return noContent();
    },
  };
}

async function userDataOf({ db, caller }: UserContext, itemId: string) {
  const [view] = (await listItemViews(db, caller.user.id, { ids: [itemId] }))
    .items;
  if (view === undefined) throw new AuthError("NOT_FOUND");
  return json(userData(view));
}

function markRoute(
  method: "POST" | "DELETE",
  path: string,
  mark: (context: UserContext, itemId: string) => Promise<unknown>,
): Route {
  return {
    method,
    path,
    handle: async (context) => {
      const itemId = requiredGuid(context.params.id);
      await mark(context, itemId);
      return userDataOf(context, itemId);
    },
  };
}

/** The three progress reports and the played and favourite marks. */
export const progressRoutes: Route[] = [
  // Playing without a position resumes where the play left off.
  reportRoute("/Sessions/Playing", ({ db, caller }, report) =>
    startPlayback(db, caller.user.id, report.scope, report.position),
  ),
  reportRoute("/Sessions/Playing/Progress", async ({ db, caller }, report) => {
    if (report.position !== undefined)
      await updatePlayback(db, caller.user.id, report.scope, {
        positionSeconds: report.position,
      });
  }),
  reportRoute("/Sessions/Playing/Stopped", ({ db, caller }, report) =>
    stopPlayback(db, caller.user.id, report.scope, {
      positionSeconds: report.position,
      completed: report.finished,
    }),
  ),
  markRoute("POST", "/UserPlayedItems/{id}", ({ db, caller }, itemId) =>
    setPlayed(db, caller.user.id, itemId, true),
  ),
  markRoute("DELETE", "/UserPlayedItems/{id}", ({ db, caller }, itemId) =>
    setPlayed(db, caller.user.id, itemId, false),
  ),
  markRoute("POST", "/UserFavoriteItems/{id}", ({ db, caller }, itemId) =>
    setFavourite(db, caller.user.id, itemId, true),
  ),
  markRoute("DELETE", "/UserFavoriteItems/{id}", ({ db, caller }, itemId) =>
    setFavourite(db, caller.user.id, itemId, false),
  ),
];
