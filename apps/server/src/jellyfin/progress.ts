import { listItemViews } from "../api/views.ts";
import { AuthError } from "../auth/errors.ts";
import {
  readClientPreference,
  writeClientPreference,
} from "../auth/profile.ts";
import { pingPlayback } from "../playback/activity.ts";
import {
  setFavourite,
  setLiked,
  setPlayed,
  updateItemState,
} from "../playback/marks.ts";
import {
  resolvePlaySession,
  startPlayback,
  stopPlayback,
  updatePlayback,
} from "../playback/progress.ts";
import { browseAsUser } from "./browse.ts";
import { json, noContent, type Route, type UserContext } from "./http.ts";
import { userData } from "./items.ts";
import {
  parseGuid,
  readBody,
  requiredGuid,
  ticksPerSecond,
} from "./request.ts";
import { readDto } from "./schema.ts";

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
  const session = await resolvePlaySession(db, caller, {
    itemId,
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
  const state: Record<string, boolean | number> = {};
  if (position !== undefined) state.positionSeconds = position;
  for (const [field, key] of [
    ["IsPaused", "paused"],
    ["IsMuted", "muted"],
    ["CanSeek", "canSeek"],
  ] as const) {
    const value = body.value(field);
    if (value === undefined) continue;
    if (typeof value !== "boolean") throw new AuthError("INVALID_INPUT");
    state[key] = value;
  }
  for (const [field, key] of [
    ["VolumeLevel", "volume"],
    ["AudioStreamIndex", "audioStreamIndex"],
    ["SubtitleStreamIndex", "subtitleStreamIndex"],
  ] as const) {
    const value = body.number(field);
    if (value !== undefined) state[key] = value;
  }
  return {
    scope: { sessionId: session.sessionId, itemId },
    state: session.state,
    position,
    finished: position !== undefined && position >= duration * finishedFraction,
    clientState: state,
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
      if (Object.keys(report.clientState).length > 0) {
        const previous = await readClientPreference(
          context.db,
          context.caller.user.id,
          context.caller.user.id,
          "playback-state",
          report.scope.sessionId,
        );
        await writeClientPreference(
          context.db,
          context.caller.user.id,
          context.caller.user.id,
          "playback-state",
          report.scope.sessionId,
          {
            ...(previous !== null &&
            typeof previous === "object" &&
            !Array.isArray(previous)
              ? previous
              : {}),
            ...report.clientState,
          },
        );
      }
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

/** Playback reports, heartbeat, and personal progress, opinions, played and favourite marks. */
export const progressRoutes: Route[] = (
  [
    // Playing without a position resumes where the play left off.
    reportRoute("/Sessions/Playing", ({ db, caller }, report) =>
      startPlayback(db, caller.user.id, report.scope, report.position),
    ),
    reportRoute(
      "/Sessions/Playing/Progress",
      async ({ db, caller }, report) => {
        if (report.position !== undefined)
          await updatePlayback(db, caller.user.id, report.scope, {
            positionSeconds: report.position,
          });
        else await pingPlayback(db, caller.user.id, report.scope.sessionId);
      },
    ),
    reportRoute("/Sessions/Playing/Stopped", ({ db, caller }, report) =>
      stopPlayback(db, caller.user.id, report.scope, {
        positionSeconds: report.position,
        completed: report.finished,
      }),
    ),
    {
      method: "POST",
      path: "/Sessions/Playing/Ping",
      handle: async ({ db, caller, query }) => {
        await pingPlayback(
          db,
          caller.user.id,
          requiredGuid(query.get("playSessionId")),
        );
        return noContent();
      },
    },
    {
      method: "GET",
      path: "/UserItems/{id}/UserData",
      handle: (context) => userDataOf(context, requiredGuid(context.params.id)),
    },
    {
      method: "POST",
      path: "/UserItems/{id}/UserData",
      handle: async (context) => {
        const value = await readDto(context.request, "UpdateUserItemDataDto");
        const itemId = requiredGuid(context.params.id);
        await updateItemState(context.db, context.caller.user.id, itemId, {
          positionSeconds:
            typeof value.PlaybackPositionTicks === "number"
              ? value.PlaybackPositionTicks / ticksPerSecond
              : undefined,
          completed:
            typeof value.Played === "boolean" ? value.Played : undefined,
          playCount:
            typeof value.PlayCount === "number" ? value.PlayCount : undefined,
          playedAt:
            typeof value.LastPlayedDate === "string"
              ? new Date(value.LastPlayedDate)
              : undefined,
          favourite:
            typeof value.IsFavorite === "boolean"
              ? value.IsFavorite
              : undefined,
          rating: typeof value.Rating === "number" ? value.Rating : undefined,
          liked: typeof value.Likes === "boolean" ? value.Likes : undefined,
        });
        return userDataOf(context, itemId);
      },
    },
    markRoute(
      "POST",
      "/UserItems/{id}/Rating",
      ({ db, caller, query }, itemId) =>
        setLiked(db, caller.user.id, itemId, query.flag("likes") ?? null),
    ),
    markRoute("DELETE", "/UserItems/{id}/Rating", ({ db, caller }, itemId) =>
      setLiked(db, caller.user.id, itemId, null),
    ),
    markRoute(
      "POST",
      "/UserPlayedItems/{id}",
      ({ db, caller, query }, itemId) =>
        setPlayed(
          db,
          caller.user.id,
          itemId,
          true,
          query.get("datePlayed") === undefined
            ? undefined
            : new Date(query.get("datePlayed") ?? ""),
        ),
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
  ] satisfies Route[]
).map((route) =>
  route.path.startsWith("/User") ? browseAsUser(route) : route,
);
