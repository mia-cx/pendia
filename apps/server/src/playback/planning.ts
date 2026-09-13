import { and, asc, eq, sql } from "drizzle-orm";
import { Schema } from "effect";
import { AuthError } from "../auth/errors.ts";
import { requirePermission } from "../auth/permissions.ts";
import { issuePlaybackToken } from "../auth/playback-tokens.ts";
import type { authenticate } from "../auth/sessions.ts";
import { readAuthSettings } from "../auth/settings.ts";
import { requestIdentity } from "../auth/transport.ts";
import type { Database } from "../db/client.ts";
import {
  files,
  items,
  sessionRegistry,
  settings,
  streams,
  userSettings,
  versions,
} from "../db/schema/index.ts";
import {
  type AudioStream,
  decidePlayback,
  type PlaybackSource,
  type SubtitleStream,
} from "./decisions.ts";
import type { ClientProfile, Hdr, PlaybackCaps } from "./policy.ts";

/** The decoded input every playback planning call receives. */
export type PlanInput = {
  itemId: string;
  versionId: string;
  profile: ClientProfile;
  bitrateCapBps?: number;
};

/** The request details planning needs to judge network locality and URL style. */
export type PlanningTransport = {
  request: Request;
  peerAddress: string;
};

type Caller = Awaited<ReturnType<typeof authenticate>>;
type StreamRow = typeof streams.$inferSelect;
type FileRow = typeof files.$inferSelect;
type VersionRow = typeof versions.$inferSelect;

const hdrFlavours: readonly string[] = [
  "sdr",
  "hdr10",
  "hdr10+",
  "hlg",
  "dolby-vision",
];

function isHdr(value: string | null): value is Hdr {
  return value !== null && hdrFlavours.includes(value);
}

function videoBitrate(
  video: StreamRow,
  file: FileRow,
  version: VersionRow,
): number {
  if (video.bitrate !== null) {
    const bitrate = Number(video.bitrate);
    if (Number.isSafeInteger(bitrate) && bitrate > 0) return bitrate;
  }
  const duration = file.durationSeconds ?? version.durationSeconds;
  if (duration !== null && Number.isFinite(duration) && duration > 0) {
    const average = (Number(file.bytes) * 8) / duration;
    if (Number.isFinite(average) && average > 0) return average;
  }
  throw new AuthError("INVALID_INPUT");
}

function toAudioStream(row: StreamRow): AudioStream {
  if (row.channels === null || row.channels <= 0)
    throw new AuthError("INVALID_INPUT");
  return {
    codec:
      row.codec === "dts" &&
      (row.profile === "dtshdma" || row.profile === "dtshdhra")
        ? "dts-hd"
        : row.codec,
    channels: row.channels,
  };
}

const subtitleFormats: Record<string, string> = {
  subrip: "srt",
  hdmv_pgs_subtitle: "pgs",
  dvd_subtitle: "vobsub",
};
const bitmapSubtitles = new Set(["pgs", "vobsub", "dvb_subtitle", "xsub"]);

function toSubtitleStream(row: StreamRow): SubtitleStream {
  const format = subtitleFormats[row.codec] ?? row.codec;
  return { format, kind: bitmapSubtitles.has(format) ? "bitmap" : "text" };
}

/** Loads the Item, Version, File and normalized playback source for planning. */
export async function loadPlaybackSource(
  db: Database,
  userId: string,
  itemId: string,
  versionId: string,
) {
  const [item] = await db
    .select()
    .from(items)
    .where(eq(items.id, itemId))
    .limit(1);
  if (!item) throw new AuthError("NOT_FOUND");
  await requirePermission(db, userId, "view", item.libraryId);
  await requirePermission(db, userId, "play");
  const [version] = await db
    .select()
    .from(versions)
    .where(and(eq(versions.id, versionId), eq(versions.itemId, item.id)))
    .limit(1);
  if (!version) throw new AuthError("NOT_FOUND");
  if (version.origin !== "imported" || version.format !== "video")
    throw new AuthError("INVALID_INPUT");

  const fileRows = await db
    .select()
    .from(files)
    .where(eq(files.versionId, version.id))
    .orderBy(asc(files.order));
  const [file, extraFile] = fileRows;
  if (file === undefined || extraFile !== undefined || file.container === null)
    throw new AuthError("INVALID_INPUT");

  const streamRows = await db
    .select()
    .from(streams)
    .where(eq(streams.fileId, file.id))
    .orderBy(asc(streams.index));
  const [video, extraVideo] = streamRows.filter(
    (row) => row.kind === "video" && row.disposition.attached_pic !== true,
  );
  if (
    video === undefined ||
    extraVideo !== undefined ||
    video.width === null ||
    video.height === null ||
    video.width <= 0 ||
    video.height <= 0 ||
    !isHdr(video.hdr)
  )
    throw new AuthError("INVALID_INPUT");

  const source: PlaybackSource = {
    container: file.container,
    video: {
      codec: video.codec,
      profile: video.profile,
      level: video.level,
      width: video.width,
      height: video.height,
      bitrate: videoBitrate(video, file, version),
      hdr: video.hdr,
      dvProfile: video.dvProfile,
    },
    audio: streamRows.filter((row) => row.kind === "audio").map(toAudioStream),
    subtitles: streamRows
      .filter((row) => row.kind === "subtitle")
      .map(toSubtitleStream),
  };
  return { item, version, file, source };
}

async function globalBitrateCap(db: Database): Promise<number | null> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, "playback"))
    .limit(1);
  if (row === undefined) return null;
  const raw: unknown = row.value;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Invalid playback settings.");
  const cap = (raw as Record<string, unknown>).bitrateCapBps;
  if (cap === null || cap === undefined) return null;
  if (typeof cap !== "number" || !Number.isSafeInteger(cap) || cap <= 0)
    throw new Error("Invalid playback settings.");
  return cap;
}

async function userBitrateCap(
  db: Database,
  userId: string,
): Promise<number | null> {
  const [row] = await db
    .select({ cap: userSettings.bitrateCapBps })
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);
  if (row === undefined || row.cap === null) return null;
  const cap = Number(row.cap);
  if (!Number.isSafeInteger(cap) || cap <= 0)
    throw new Error("Invalid playback settings.");
  return cap;
}

function isLanAddress(address: string): boolean {
  const v4 = address.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (v4) {
    const first = Number(v4[1]);
    const second = Number(v4[2]);
    return (
      first === 127 ||
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    );
  }
  if (address === "::1") return true;
  const firstHextet = Number.parseInt(address.split(":", 1)[0] ?? "", 16);
  if (!Number.isInteger(firstHextet)) return false;
  return (firstHextet & 0xfe00) === 0xfc00 || (firstHextet & 0xffc0) === 0xfe80;
}

function playbackUrl(
  method: "direct-play" | "remux",
  request: Request,
  caller: Caller,
  sessionId: string,
  itemId: string,
  issued: { token: string; expiresAt: string },
) {
  const path =
    method === "remux"
      ? `/api/playback/${sessionId}/${itemId}/hls/master.m3u8`
      : `/api/playback/${sessionId}/${itemId}/direct`;
  // Cookie callers can keep the token out of direct URLs; every HLS URL must
  // carry it because segments are requested without other credentials.
  if (
    method === "direct-play" &&
    request.headers.get("authorization") === null &&
    caller.credential.kind === "session"
  )
    return { url: path, expiresAt: null };
  return {
    url: `${path}?token=${encodeURIComponent(issued.token)}`,
    expiresAt: issued.expiresAt,
  };
}

/** Runs the playback decision and, for direct play and remux, opens a session with a token URL. */
export async function planPlayback(
  db: Database,
  caller: Caller,
  input: PlanInput,
  transport: PlanningTransport,
) {
  const { item, version, source } = await loadPlaybackSource(
    db,
    caller.user.id,
    input.itemId,
    input.versionId,
  );
  const config = await readAuthSettings(db);
  const identity = requestIdentity(
    transport.request,
    transport.peerAddress,
    config.trustedProxyAddresses,
  );
  const caps: PlaybackCaps = {
    globalDefault: await globalBitrateCap(db),
    userOverride: await userBitrateCap(db, caller.user.id),
    sessionRequest: input.bitrateCapBps ?? null,
    isLan: isLanAddress(identity.address),
  };
  let decision: ReturnType<typeof decidePlayback>;
  try {
    decision = decidePlayback(source, input.profile, caps);
  } catch {
    throw new AuthError("INVALID_INPUT");
  }
  const base = {
    method: decision.method,
    itemId: item.id,
    versionId: version.id,
    sessionId: null as string | null,
    url: null as string | null,
    expiresAt: null as string | null,
  };
  if (decision.method === "transcode") return base;
  // A Version without an aligned timeline cannot be segmented for remux.
  if (
    decision.method === "remux" &&
    (version.segmentTimelineId === null || !version.timelineAligned)
  )
    throw new AuthError("CONFLICT");
  const method = decision.method;
  return db.transaction(async (tx) => {
    const [session] = await tx
      .insert(sessionRegistry)
      .values({
        userId: caller.user.id,
        itemId: item.id,
        versionId: version.id,
        playMethod: method,
        state: "starting",
      })
      .returning();
    if (!session) throw new Error("Session insert returned no row.");
    const issued = await issuePlaybackToken(tx, caller, {
      sessionId: session.id,
      itemId: item.id,
    });
    return {
      ...base,
      sessionId: session.id,
      ...playbackUrl(
        method,
        transport.request,
        caller,
        session.id,
        item.id,
        issued,
      ),
    };
  });
}

/** Re-issues a playback token for the caller's live direct-play or remux session. */
export async function refreshPlayback(
  db: Database,
  caller: Caller,
  scope: { sessionId: string; itemId: string },
  transport: PlanningTransport,
) {
  if (
    !Schema.is(Schema.UUID)(scope.sessionId) ||
    !Schema.is(Schema.UUID)(scope.itemId)
  )
    throw new AuthError("UNAUTHENTICATED");
  const [session] = await db
    .select({
      userId: sessionRegistry.userId,
      versionId: sessionRegistry.versionId,
      playMethod: sessionRegistry.playMethod,
      state: sessionRegistry.state,
    })
    .from(sessionRegistry)
    .where(
      and(
        eq(sessionRegistry.id, scope.sessionId),
        eq(sessionRegistry.itemId, scope.itemId),
      ),
    )
    .limit(1);
  if (
    !session ||
    session.userId !== caller.user.id ||
    session.state === "stopped" ||
    session.playMethod === "transcode"
  )
    throw new AuthError("UNAUTHENTICATED");
  const issued = await issuePlaybackToken(db, caller, scope);
  await db
    .update(sessionRegistry)
    .set({ lastSeenAt: sql`clock_timestamp()` })
    .where(eq(sessionRegistry.id, scope.sessionId));
  const method = session.playMethod;
  return {
    method,
    itemId: scope.itemId,
    versionId: session.versionId,
    sessionId: scope.sessionId,
    ...playbackUrl(
      method,
      transport.request,
      caller,
      scope.sessionId,
      scope.itemId,
      issued,
    ),
  };
}
