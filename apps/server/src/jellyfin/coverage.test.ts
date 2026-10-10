import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
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
import { contributors, credits, items } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { createArtworkHandler } from "../metadata/artwork-http.ts";
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
import { jellyfinRoutes } from "./routes.ts";
import { contractValidator as ajv, jsonSchema } from "./schema.ts";
import { jellyfinLogin } from "./testing.ts";

type Fixture = { parameters?: Record<string, string>; body?: unknown };
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
      "Content-Type": "application/json",
      Authorization: header,
    },
    body:
      bodySchema === undefined ||
      operation.method === "GET" ||
      operation.method === "HEAD"
        ? undefined
        : JSON.stringify(fixture.body ?? defaultValue(bodySchema)),
  });
}

/** Valid seeded subjects let the generated contract check exercise real writes without revoking its own caller. */
async function fixtureOf(
  db: Database,
  adminId: string,
  operation: ApiOperation,
): Promise<Fixture> {
  const id = operation.operationId;
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
      withDatabase(async (db) => {
        const seeded = await seedBrowse(db);
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
        );
        const handle = createJellyfinHandler(db, routes);
        const send = (request: Request) => handle(request, "127.0.0.1");
        const admin = await jellyfinLogin(send, header, "admin", "admin-pass");
        const viewer = await jellyfinLogin(
          send,
          header.replace('DeviceId="coverage"', 'DeviceId="coverage-viewer"'),
        );
        const failures: string[] = [];
        for (const operation of operations) {
          if (gapOf(operation) !== undefined) continue;
          const fixture = await fixtureOf(db, seeded.admin.id, operation);
          fixture.parameters = {
            itemId: seeded.matrix.id,
            seriesId: seeded.show.id,
            genreName: "Science Fiction",
            year: "1999",
            name: "Keanu Reeves",
            searchTerm: "Matrix",
            ...fixture.parameters,
          };
          const response = await send(requestOf(operation, admin, fixture));
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
          const text = await response.text();
          if (operation.method === "HEAD" || response.status === 204) {
            expect(text, operation.operationId).toBe("");
          } else if (schema !== undefined) {
            const value: unknown =
              schema.format !== "binary" &&
              response.headers
                .get("Content-Type")
                ?.startsWith("application/json")
                ? JSON.parse(text)
                : text;
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
    60_000,
  );
});
