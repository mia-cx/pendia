import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { and, eq } from "drizzle-orm";
import { createHlsHandler } from "../api/hls.ts";
import { seedBrowse } from "../api/view-fixtures.ts";
import { createLocalUser } from "../auth/accounts.ts";
import { createIntegrationKey } from "../auth/integration-keys.ts";
import {
  authorizeQuickConnect,
  initiateQuickConnect,
} from "../auth/quick-connect.ts";
import { issueSession } from "../auth/sessions.ts";
import type { Database } from "../db/client.ts";
import {
  contributors,
  credits,
  items,
  sessionRegistry,
} from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { insertItem } from "../db/tree.ts";
import { scanDirectory } from "../libraries/scan.ts";
import { createLibrary } from "../libraries/service.ts";
import {
  createVideoFixture,
  withVideoFixture,
} from "../mediums/video-common/fixtures.ts";
import { createArtworkHandler } from "../metadata/artwork-http.ts";
import { storeArtworkOriginal } from "../metadata/artwork-store.ts";
import { coveredOperations, gapOf, gaps } from "./coverage.ts";
import { createJellyfinHandler } from "./http.ts";
import {
  type ApiOperation,
  accessOf,
  defaultValue,
  openapi,
  operations,
  type Schema,
  specificationSource,
} from "./openapi.ts";
import { deviceProfiles } from "./profile-fixtures.ts";
import { jellyfinRoutes } from "./routes.ts";
import { contractValidator as ajv, jsonSchema } from "./schema.ts";
import { fixturePng, jellyfinLogin } from "./testing.ts";

type Fixture = {
  parameters?: Record<string, string>;
  body?: unknown;
  rawBody?: BodyInit;
  contentType?: string;
  token?: string;
};
const header =
  'MediaBrowser Client="Coverage", Device="Coverage", DeviceId="coverage"';

function requestOf(
  operation: ApiOperation,
  token: string,
  fixture: Fixture = {},
) {
  let path = operation.path;
  const query = new URLSearchParams();
  for (const parameter of operation.parameters ?? []) {
    if (
      !parameter.required &&
      fixture.parameters?.[parameter.name] === undefined
    )
      continue;
    const value =
      fixture.parameters?.[parameter.name] ??
      (String(defaultValue(parameter.schema)) || "sample");
    if (parameter.in === "path")
      path = path.replace(`{${parameter.name}}`, encodeURIComponent(value));
    if (parameter.in === "query") query.set(parameter.name, value);
  }
  const bodySchema = operation.requestBody?.content["application/json"]?.schema;
  return new Request(`http://thalia.test${path}?${query}`, {
    method: operation.method,
    headers: {
      "X-Emby-Token": token,
      "Content-Type": fixture.contentType ?? "application/json",
      Authorization: header,
    },
    body:
      fixture.rawBody ??
      (bodySchema === undefined ||
      operation.method === "GET" ||
      operation.method === "HEAD"
        ? undefined
        : JSON.stringify(fixture.body ?? defaultValue(bodySchema))),
  });
}

/** Valid seeded subjects let the generated contract check exercise real writes without revoking its own caller. */
async function fixtureOf(
  db: Database,
  adminId: string,
  operation: ApiOperation,
  root: string,
  mediaId: string,
): Promise<Fixture> {
  const id = operation.operationId;
  if (
    [
      "GetDownload",
      "GetFile",
      "GetPlaybackInfo",
      "GetPostedPlaybackInfo",
      "GetVideoStream",
      "HeadVideoStream",
      "GetVideoStreamByContainer",
      "HeadVideoStreamByContainer",
    ].includes(id)
  )
    return {
      parameters: { itemId: mediaId, container: "mkv" },
      body: { DeviceProfile: deviceProfiles.infuse },
    };
  if (
    [
      "ReportPlaybackStart",
      "ReportPlaybackProgress",
      "ReportPlaybackStopped",
    ].includes(id)
  )
    return {
      body: {
        ItemId: mediaId,
        PositionTicks: 0,
        CanSeek: true,
        IsPaused: false,
        IsMuted: false,
      },
    };
  if (id === "PingPlaybackSession") {
    const [play] = await db
      .select({ id: sessionRegistry.id })
      .from(sessionRegistry)
      .where(
        and(
          eq(sessionRegistry.userId, adminId),
          eq(sessionRegistry.itemId, mediaId),
        ),
      );
    if (play === undefined)
      throw new Error("Missing coverage playback session");
    return { parameters: { playSessionId: play.id } };
  }
  if (id === "ReportSessionEnded") {
    const session = await issueSession(
      db,
      adminId,
      { clientName: "Coverage logout", deviceId: id, deviceName: id },
      null,
    );
    return { token: session.token };
  }
  if (id === "DisplayContent") {
    const session = await issueSession(
      db,
      adminId,
      { clientName: "Coverage viewing", deviceId: id, deviceName: id },
      null,
    );
    return {
      parameters: {
        sessionId: session.session.id,
        itemId: mediaId,
        itemType: "Movie",
        itemName: "Coverage",
      },
    };
  }
  if (
    operation.tags.includes("Image") &&
    operation.path.startsWith("/Items/")
  ) {
    const folder = `${root}/${id}`;
    await mkdir(folder);
    const library = await createLibrary(db, adminId, {
      name: id,
      medium: "movies",
      roots: [folder],
    });
    const item = await insertItem(db, {
      libraryId: library.id,
      kind: "movie",
      title: "Image subject",
      canonicalFolder: ".",
      extension: {},
    });
    const image = await storeArtworkOriginal(
      db,
      item.id,
      { type: "poster", url: "https://image.example/fixture.png" },
      (async (_input: RequestInfo | URL) =>
        new Response(fixturePng)) as typeof fetch,
    );
    return {
      parameters: {
        itemId: item.id,
        imageType: "Primary",
        imageIndex: "0",
        tag: image.id.replaceAll("-", ""),
        format: "Png",
        maxWidth: "4",
        maxHeight: "4",
        percentPlayed: "0",
        unplayedCount: "0",
        newIndex: "0",
      },
      rawBody:
        operation.method === "POST" && id !== "UpdateItemImageIndex"
          ? fixturePng.toString("base64")
          : undefined,
      contentType: "image/png",
    };
  }
  if (id === "ApplySearchCriteria")
    return {
      body: { ProviderIds: { Tmdb: "999" }, SearchProviderName: "tmdb" },
    };
  if (id === "DownloadRemoteImage") {
    const folder = `${root}/download`;
    await mkdir(folder);
    const library = await createLibrary(db, adminId, {
      name: "Artwork download",
      medium: "movies",
      roots: [folder],
    });
    const item = await insertItem(db, {
      libraryId: library.id,
      kind: "movie",
      title: "Artwork subject",
      canonicalFolder: ".",
      extension: {},
    });
    return {
      parameters: {
        itemId: item.id,
        type: "Primary",
        imageUrl: "https://image.example/fixture.png",
      },
    };
  }
  if (id === "AddVirtualFolder")
    return {
      parameters: {
        name: "Coverage added",
        collectionType: "movies",
        paths: `${tmpdir()}/coverage-added`,
      },
      body: { LibraryOptions: {} },
    };
  if (
    [
      "RemoveVirtualFolder",
      "RenameVirtualFolder",
      "UpdateLibraryOptions",
      "AddMediaPath",
      "RemoveMediaPath",
      "UpdateMediaPath",
    ].includes(id)
  ) {
    const root = `${tmpdir()}/coverage-${id}-${Bun.randomUUIDv7()}`;
    const library = await createLibrary(db, adminId, {
      name: id,
      medium: "movies",
      roots:
        id === "RemoveMediaPath"
          ? [`${root}/first`, `${root}/second`]
          : [`${root}/first`],
    });
    return {
      parameters: {
        name: library.name,
        newName: "Coverage renamed",
        path: `${root}/second`,
      },
      body:
        id === "UpdateLibraryOptions"
          ? {
              Id: library.id,
              LibraryOptions: { PathInfos: [{ Path: `${root}/first` }] },
            }
          : {
              Name: library.name,
              Path: `${root}/second`,
              PathInfo: {
                Path:
                  id === "UpdateMediaPath" ? `${root}/first` : `${root}/second`,
              },
            },
    };
  }
  if (["DeleteItems", "DeleteItem", "UpdateItem"].includes(id)) {
    const library = await createLibrary(db, adminId, {
      name: `${id} fixture`,
      medium: "movies",
      roots: [`${tmpdir()}/coverage-items-${id}`],
    });
    const item = await insertItem(db, {
      libraryId: library.id,
      kind: "movie",
      title: "Coverage subject",
      canonicalFolder: ".",
      extension: {},
    });
    return {
      parameters: { itemId: item.id, ids: item.id },
      body: {
        Name: "Coverage edited",
        Overview: "Edited through Jellyfin",
        ProviderIds: { Tmdb: "123" },
      },
    };
  }
  if (id === "CreateKey") return { parameters: { app: "Coverage" } };
  if (id === "RevokeKey") {
    const key = await createIntegrationKey(db, adminId, "Coverage revoke");
    return { parameters: { key: key.token } };
  }
  if (id === "AuthenticateUserByName")
    return { body: { Username: "admin", Pw: "admin-pass" } };
  if (
    [
      "AuthorizeQuickConnect",
      "GetQuickConnectState",
      "AuthenticateWithQuickConnect",
    ].includes(id)
  ) {
    const pending = await initiateQuickConnect(
      db,
      {
        clientName: "Coverage",
        clientVersion: "1",
        deviceName: "Coverage",
        deviceId: id,
      },
      "127.0.0.1",
    );
    if (id === "AuthenticateWithQuickConnect")
      await authorizeQuickConnect(db, adminId, pending.request.code);
    return {
      parameters: { code: pending.request.code, secret: pending.secret },
      body: { Secret: pending.secret },
    };
  }
  if (id === "CreateUserByName")
    return { body: { Name: "coverage-created", Password: "coverage-pass" } };
  if (
    [
      "GetDeviceInfo",
      "GetDeviceOptions",
      "UpdateDeviceOptions",
      "DeleteDevice",
    ].includes(id)
  ) {
    await issueSession(
      db,
      adminId,
      {
        clientName: "Coverage",
        deviceName: "Coverage subject",
        deviceId: id,
      },
      null,
    );
    return { parameters: { id }, body: { CustomName: "Coverage renamed" } };
  }
  if (
    [
      "GetUserById",
      "DeleteUser",
      "UpdateUser",
      "UpdateUserPassword",
      "UpdateUserPolicy",
      "UpdateUserConfiguration",
    ].includes(id)
  ) {
    const user = await createLocalUser(db, adminId, {
      username: `coverage-${id.toLowerCase()}`,
      password: "coverage-pass",
    });
    const body =
      id === "UpdateUser"
        ? { Name: "coverage-renamed" }
        : id === "UpdateUserPassword"
          ? { NewPw: "coverage-new-pass" }
          : id === "UpdateUserPolicy"
            ? {
                IsDisabled: false,
                EnableMediaPlayback: true,
                AuthenticationProviderId:
                  "Jellyfin.Server.Implementations.Users.DefaultAuthenticationProvider",
                PasswordResetProviderId:
                  "Jellyfin.Server.Implementations.Users.DefaultPasswordResetProvider",
              }
            : undefined;
    return { parameters: { userId: user.id }, body };
  }
  return {};
}

function responseSchema(
  operation: ApiOperation,
  status: number,
  contentType: string | null,
): Schema | undefined {
  const content = operation.responses[String(status)]?.content;
  if (content === undefined) return undefined;
  const media = Object.keys(content).find((type) => {
    if (contentType === null) return false;
    const expected = type.split(";")[0] ?? type;
    return expected.endsWith("/*")
      ? contentType.startsWith(expected.slice(0, -1))
      : contentType.startsWith(expected);
  });
  expect(media, `${operation.operationId} response content type`).toBeDefined();
  return media === undefined ? undefined : content[media]?.schema;
}

test("registers every operation from the pinned official OpenAPI document", () => {
  const routes = jellyfinRoutes(
    async () => new Response(),
    async () => new Response(),
  );
  expect(openapi.info.version).toBe(specificationSource.version);
  expect(
    new Set(operations.map((operation) => operation.operationId)).size,
  ).toBe(operations.length);
  for (const operation of operations)
    expect(
      routes.some(
        (route) =>
          route.method === operation.method && route.path === operation.path,
      ),
      operation.operationId,
    ).toBe(true);
  for (const tag of Object.keys(gaps))
    expect(
      operations.some((operation) => operation.tags.includes(tag)),
      `Stale gap ${tag}`,
    ).toBe(true);
  for (const id of coveredOperations)
    expect(
      operations.some((operation) => operation.operationId === id),
      `Stale coverage ${id}`,
    ).toBe(true);
});

describe.skipIf(!databaseUrl)("official Jellyfin operation coverage", () => {
  test(
    "validates statuses, bodies, and admin access against a seeded library",
    () =>
      withDatabase(async (db) =>
        withVideoFixture(async (root) => {
          const seeded = await seedBrowse(db);
          const mediaRoot = `${root}/media`;
          await mkdir(`${mediaRoot}/Coverage (2026)`, { recursive: true });
          await createVideoFixture(
            `${mediaRoot}/Coverage (2026)/Coverage.mkv`,
            { width: 64, height: 64 },
          );
          const mediaLibrary = await createLibrary(db, seeded.admin.id, {
            name: "Coverage media",
            medium: "movies",
            roots: [mediaRoot],
          });
          const media = await scanDirectory(
            db,
            mediaLibrary.id,
            "Coverage (2026)",
          );
          if (media.itemId === null) throw new Error("Missing coverage media");
          await db
            .update(items)
            .set({ genres: ["Science Fiction"], tags: ["Classic"] })
            .where(eq(items.id, seeded.matrix.id));
          const [person] = await db
            .insert(contributors)
            .values({ name: "Keanu Reeves" })
            .returning();
          if (person === undefined) throw new Error("Missing contributor");
          await db.insert(credits).values({
            itemId: seeded.matrix.id,
            contributorId: person.id,
            role: "actor",
            order: 0,
            character: "Neo",
          });
          const routes = jellyfinRoutes(
            createArtworkHandler(db),
            createHlsHandler(db),
            {
              request: (async (_input: RequestInfo | URL) =>
                new Response(fixturePng)) as typeof fetch,
            },
          );
          const handle = createJellyfinHandler(db, routes);
          const send = (request: Request) => handle(request, "127.0.0.1");
          const admin = await jellyfinLogin(
            send,
            header,
            "admin",
            "admin-pass",
          );
          const viewer = await jellyfinLogin(
            send,
            header.replace('DeviceId="coverage"', 'DeviceId="coverage-viewer"'),
          );
          const failures: string[] = [];
          for (const operation of operations) {
            if (gapOf(operation) !== undefined) continue;
            const fixture = await fixtureOf(
              db,
              seeded.admin.id,
              operation,
              root,
              media.itemId,
            );
            fixture.parameters = {
              itemId: seeded.matrix.id,
              seriesId: seeded.show.id,
              genreName: "Science Fiction",
              year: "1999",
              name: "Keanu Reeves",
              searchTerm: "Matrix",
              ...fixture.parameters,
            };
            const response = await send(
              requestOf(operation, fixture.token ?? admin, fixture),
            );
            expect(response, operation.operationId).toBeDefined();
            if (response === undefined) continue;
            const declared = operation.responses[String(response.status)];
            expect(
              declared,
              `${operation.operationId} status ${response.status}`,
            ).toBeDefined();
            expect(response.status, operation.operationId).toBeLessThan(300);
            const schema = responseSchema(
              operation,
              response.status,
              response.headers.get("Content-Type"),
            );
            const imageResponse =
              operation.method !== "HEAD" &&
              response.headers.get("Content-Type")?.startsWith("image/");
            let text: string;
            if (imageResponse) {
              const bytes = Buffer.from(await response.arrayBuffer());
              const image = await new Bun.Image(bytes).metadata();
              expect(image.width, operation.operationId).toBeGreaterThan(0);
              expect(image.height, operation.operationId).toBeGreaterThan(0);
              text = bytes.toString();
            } else text = await response.text();
            if (operation.method === "HEAD" || response.status === 204) {
              expect(text, operation.operationId).toBe("");
            } else if (schema !== undefined) {
              const value: unknown =
                schema.format !== "binary" &&
                response.headers
                  .get("Content-Type")
                  ?.startsWith("application/json")
                  ? JSON.parse(text)
                  : String(text);
              const validate = ajv.compile(jsonSchema(schema) as object);
              if (!validate(value))
                failures.push(
                  `${operation.operationId}: ${ajv.errorsText(validate.errors)}`,
                );
            }
            if (accessOf(operation).admin) {
              const denied = await send(requestOf(operation, viewer, fixture));
              expect(
                denied?.status,
                `${operation.operationId} requires admin`,
              ).toBe(403);
            }
          }
          expect(failures).toEqual([]);
        }),
      ),
    60_000,
  );
});
