import type { Event, EventBroker } from "../api/events.ts";
import { listItemViews } from "../api/views.ts";
import { AuthError } from "../auth/errors.ts";
import { authenticate } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import { userData } from "./items.ts";
import { readClient, readQuery, toGuid } from "./request.ts";

type Caller = Awaited<ReturnType<typeof authenticate>>;

/** What each open Jellyfin socket carries: its caller, the token to recheck, and its stop signal. */
export type SocketData = {
  caller: Caller;
  token: string;
  stop: AbortController;
};

/** The one path the Jellyfin websocket answers on, in any case. */
export const socketPath = "/socket";

// Clients send KeepAlive at half this many seconds, well inside Bun's two minute idle timeout.
const keepAliveSeconds = 60;

const message = (type: string, data?: unknown) =>
  JSON.stringify({
    MessageType: type,
    MessageId: toGuid(crypto.randomUUID()),
    ...(data === undefined ? {} : { Data: data }),
  });

/** Maps a Thalia event to the Jellyfin message it means for this caller; undefined when none. */
async function toMessage(db: Database, caller: Caller, event: Event) {
  switch (event.kind) {
    case "library.changed": {
      const library = toGuid(event.libraryId);
      return message("LibraryChanged", {
        FoldersAddedTo: [],
        FoldersRemovedFrom: [],
        ItemsAdded: [],
        ItemsRemoved: [],
        ItemsUpdated: [library],
        CollectionFolders: [library],
        IsEmpty: false,
      });
    }
    case "user-data.changed": {
      const { items } = await listItemViews(db, caller.user.id, {
        ids: event.itemIds,
      });
      return message("UserDataChanged", {
        UserId: toGuid(caller.user.id),
        UserDataList: items.map(userData),
      });
    }
    default:
      return undefined;
  }
}

/**
 * Creates the Jellyfin websocket. Clients authenticate with the MediaBrowser
 * header, as the Kotlin SDK does, or with `api_key` in the query, as the
 * Swift SDK and the web client do. The socket answers KeepAlive and pushes
 * LibraryChanged and UserDataChanged from the event broker; every other
 * inbound message is ignored, since remote control is deferred.
 */
export function createJellyfinSocket(db: Database, events: EventBroker) {
  async function pump(socket: Bun.ServerWebSocket<SocketData>) {
    const { token, stop } = socket.data;
    const stream = events.subscribe({
      caller: socket.data.caller,
      revalidate: async () => {
        socket.data.caller = await authenticate(db, token);
        return socket.data.caller;
      },
      signal: stop.signal,
    });
    for await (const event of stream) {
      const text = await toMessage(db, socket.data.caller, event);
      if (text !== undefined) socket.send(text);
    }
  }

  return {
    /** Upgrades an authenticated request; answers 401 JSON otherwise. Undefined means upgraded. */
    async upgrade(request: Request, server: Bun.Server<SocketData>) {
      const query = readQuery(new URL(request.url).searchParams);
      const token =
        readClient(request).token ??
        query.get("api_key") ??
        query.get("apiKey");
      try {
        if (token === undefined) throw new AuthError("UNAUTHENTICATED");
        const caller = await authenticate(db, token);
        const data = { caller, token, stop: new AbortController() };
        if (server.upgrade(request, { data })) return undefined;
        return Response.json(
          {
            error: { code: "INVALID_INPUT", message: "Expected a websocket." },
          },
          { status: 400 },
        );
      } catch (error) {
        if (!(error instanceof AuthError)) throw error;
        return Response.json(
          { error: { code: error.code, message: error.message } },
          { status: error.status },
        );
      }
    },
    websocket: {
      open(socket) {
        socket.send(message("ForceKeepAlive", keepAliveSeconds));
        // A revoked token ends the stream; the socket goes with it.
        pump(socket).catch((error: unknown) => {
          if (error instanceof AuthError)
            return socket.close(1008, "Unauthorized");
          console.error(
            JSON.stringify({
              level: "error",
              message: "jellyfin.socket.failed",
              error: error instanceof Error ? error.message : String(error),
            }),
          );
          socket.close(1011, "Internal error");
        });
      },
      message(socket, raw) {
        let type: unknown;
        try {
          type = JSON.parse(String(raw)).MessageType;
        } catch {
          return;
        }
        if (type === "KeepAlive") socket.send(message("KeepAlive"));
      },
      close(socket) {
        socket.data.stop.abort();
      },
    } satisfies Bun.WebSocketHandler<SocketData>,
  };
}
