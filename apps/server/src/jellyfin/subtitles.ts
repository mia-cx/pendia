import { AuthError } from "../auth/errors.ts";
import type { SubtitleProviderOptions } from "../subtitles/providers.ts";
import {
  deleteSubtitle,
  downloadSubtitleCandidate,
  installSubtitleCandidate,
  maxSubtitleBytes,
  readItemSubtitle,
  searchSubtitleCandidates,
  subtitleSource,
  uploadSubtitle,
} from "../subtitles/service.ts";
import { subtitleFormats } from "../subtitles/store.ts";
import { webvttEvents } from "../transcoder/subtitles.ts";
import { json, noContent, type RequestContext, type Route } from "./http.ts";
import { mediaUserId } from "./playback.ts";
import { readQuery, requiredGuid, ticksPerSecond } from "./request.ts";
import { readDto } from "./schema.ts";

const contentTypes = { vtt: "text/vtt", srt: "text/plain", ass: "text/x-ssa" };
const perfectMatchScore = 0.9;

function textResponse(text: string, format: keyof typeof contentTypes) {
  return new Response(text, {
    headers: {
      "Content-Type": `${contentTypes[format]}; charset=utf-8`,
      "Cache-Control": "no-store",
    },
  });
}

function streamParameters({ params, query }: RequestContext) {
  const itemId = requiredGuid(query.get("itemId") ?? params.itemId);
  const sourceId = requiredGuid(query.get("mediaSourceId") ?? params.sourceId);
  const index = readQuery(
    new URLSearchParams({ index: query.get("index") ?? params.index ?? "" }),
  ).count("index");
  if (index === undefined) throw new AuthError("INVALID_INPUT");
  return { itemId, sourceId, index };
}

/** Subtitle management and delivery use core providers, asset roots, and conversion. */
export function subtitleRoutes(options: SubtitleProviderOptions = {}): Route[] {
  const stream = async (context: RequestContext) => {
    const { itemId, sourceId, index } = streamParameters(context);
    const { query, params } = context;
    const requested = (
      query.get("format") ??
      params.format ??
      "vtt"
    ).toLowerCase();
    const format =
      requested === "js" || requested === "json"
        ? "json"
        : subtitleFormats.find((known) => known === requested);
    if (format === undefined) throw new AuthError("INVALID_INPUT");
    const start =
      readQuery(
        new URLSearchParams({
          start: query.get("startPositionTicks") ?? params.start ?? "0",
        }),
      ).count("start") ?? 0;
    const end = query.count("endPositionTicks");
    if (end !== undefined && end < start) throw new AuthError("INVALID_INPUT");
    const userId = await mediaUserId(context, itemId);
    const text = await readItemSubtitle(
      context.db,
      userId,
      itemId,
      sourceId,
      index,
      format === "json" ? "vtt" : format,
      {
        startSeconds: start / ticksPerSecond,
        endSeconds: end === undefined ? undefined : end / ticksPerSecond,
        copyTimestamps: query.flag("copyTimestamps") ?? false,
        addTimeMap: query.flag("addVttTimeMap") ?? false,
      },
      context.request.signal,
    );
    if (format === "json")
      return json({
        TrackEvents: webvttEvents(text).map((event, index) => ({
          Id: event.id || String(index),
          Text: event.text,
          StartPositionTicks: Math.round(event.startSeconds * ticksPerSecond),
          EndPositionTicks: Math.round(event.endSeconds * ticksPerSecond),
        })),
      });
    return textResponse(text, format);
  };
  return [
    {
      method: "GET",
      path: "/Videos/{itemId}/{sourceId}/Subtitles/{index}/Stream.{format}",
      anonymous: true,
      handle: stream,
    },
    {
      method: "GET",
      path: "/Videos/{itemId}/{sourceId}/Subtitles/{index}/{start}/Stream.{format}",
      anonymous: true,
      handle: stream,
    },
    {
      method: "GET",
      path: "/Videos/{itemId}/{sourceId}/Subtitles/{index}/subtitles.m3u8",
      anonymous: true,
      handle: async (context) => {
        const { itemId, sourceId, index } = streamParameters(context);
        const userId = await mediaUserId(context, itemId);
        const source = await subtitleSource(
          context.db,
          userId,
          itemId,
          sourceId,
          index,
        );
        const length = context.query.count("segmentLength") ?? 6;
        if (length < 1 || length > 3600) throw new AuthError("INVALID_INPUT");
        const duration = source.durationSeconds ?? 0;
        const lines = [
          "#EXTM3U",
          "#EXT-X-VERSION:3",
          `#EXT-X-TARGETDURATION:${length}`,
          "#EXT-X-MEDIA-SEQUENCE:0",
          "#EXT-X-PLAYLIST-TYPE:VOD",
        ];
        for (let start = 0; start < duration; start += length) {
          const end = Math.min(start + length, duration);
          const query = new URLSearchParams(context.url.searchParams);
          // Players need a credential when subsequent segment requests lack headers.
          if (context.client.token !== undefined) {
            for (const key of [...query.keys()])
              if (["apikey", "api_key"].includes(key.toLowerCase()))
                query.delete(key);
            query.set("api_key", context.client.token);
          }
          // Window parameters belong to each segment, not the playlist request.
          for (const key of [...query.keys()])
            if (
              [
                "startpositionticks",
                "endpositionticks",
                "copytimestamps",
                "addvtttimemap",
                "format",
              ].includes(key.toLowerCase())
            )
              query.delete(key);
          query.set(
            "endPositionTicks",
            String(Math.round(end * ticksPerSecond)),
          );
          query.set("copyTimestamps", "true");
          query.set("addVttTimeMap", "true");
          lines.push(
            `#EXTINF:${(end - start).toFixed(3)},`,
            `${Math.round(start * ticksPerSecond)}/Stream.vtt?${query}`,
          );
        }
        lines.push("#EXT-X-ENDLIST");
        return new Response(`${lines.join("\n")}\n`, {
          headers: {
            "Content-Type": "application/x-mpegURL",
            "Cache-Control": "no-store",
          },
        });
      },
    },
    {
      method: "POST",
      path: "/Videos/{itemId}/Subtitles",
      handle: async ({ db, caller, params, request }) => {
        const dto = await readDto(
          request,
          "UploadSubtitleDto",
          Math.ceil((maxSubtitleBytes * 4) / 3) + 4096,
        );
        const format = subtitleFormats.find(
          (format) => format === String(dto.Format).toLowerCase(),
        );
        const data = String(dto.Data);
        if (
          format === undefined ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
            data,
          )
        )
          throw new AuthError("INVALID_INPUT");
        await uploadSubtitle(
          db,
          caller.user.id,
          requiredGuid(params.itemId),
          {
            language: String(dto.Language),
            format,
            forced: dto.IsForced === true,
            hearingImpaired: dto.IsHearingImpaired === true,
          },
          Buffer.from(data, "base64"),
        );
        return noContent();
      },
    },
    {
      method: "DELETE",
      path: "/Videos/{itemId}/Subtitles/{index}",
      handle: async ({ db, caller, params }) => {
        const index = readQuery(
          new URLSearchParams({ index: params.index ?? "" }),
        ).count("index");
        if (index === undefined) throw new AuthError("INVALID_INPUT");
        await deleteSubtitle(
          db,
          caller.user.id,
          requiredGuid(params.itemId),
          index,
        );
        return noContent();
      },
    },
    {
      method: "GET",
      path: "/Items/{itemId}/RemoteSearch/Subtitles/{language}",
      handle: async ({ db, caller, params, query }) =>
        json(
          (
            await searchSubtitleCandidates(
              db,
              caller.user.id,
              requiredGuid(params.itemId),
              params.language ?? "",
              options,
            )
          )
            .filter(
              (match) =>
                !query.flag("isPerfectMatch") ||
                match.score >= perfectMatchScore,
            )
            .map((match) => ({
              Id: match.id,
              ProviderName: match.provider,
              ThreeLetterISOLanguageName: params.language,
              Name: `${match.provider} ${match.language}`,
              Forced: match.forced,
            })),
        ),
    },
    {
      method: "POST",
      path: "/Items/{itemId}/RemoteSearch/Subtitles/{subtitleId}",
      handle: async ({ db, caller, params }) => {
        await installSubtitleCandidate(
          db,
          caller.user.id,
          requiredGuid(params.itemId),
          params.subtitleId ?? "",
          options,
        );
        return noContent();
      },
    },
    {
      method: "GET",
      path: "/Providers/Subtitles/Subtitles/{subtitleId}",
      handle: async ({ db, caller, params }) => {
        const downloaded = await downloadSubtitleCandidate(
          db,
          caller.user.id,
          params.subtitleId ?? "",
          options,
        );
        return textResponse(downloaded.text, downloaded.format);
      },
    },
  ];
}
