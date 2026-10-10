import { describe, expect, test } from "bun:test";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { createHlsHandler } from "../api/hls.ts";
import { seedBrowse } from "../api/view-fixtures.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { createArtworkHandler } from "../metadata/artwork-http.ts";
import { gapOf, gaps } from "./coverage.ts";
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
import { jellyfinLogin } from "./testing.ts";

// OpenAPI 3.0's nullable applies to refs/allOf too. JSON Schema expresses that union with anyOf.
function jsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonSchema);
  if (value === null || typeof value !== "object") return value;
  const fields = value as Record<string, unknown>;
  const schema = Object.fromEntries(
    Object.entries(fields)
      .filter(([name]) => name !== "nullable")
      .map(([name, field]) => [
        name,
        name === "$ref" && typeof field === "string"
          ? `jellyfin${field}`
          : jsonSchema(field),
      ]),
  );
  return fields.nullable === true
    ? { anyOf: [schema, { type: "null" }] }
    : schema;
}

const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: true });
addFormats(ajv);
for (const format of [
  "int32",
  "int64",
  "float",
  "double",
  "binary",
  "byte",
  "text",
])
  ajv.addFormat(format, true);
ajv.addSchema({
  $id: "jellyfin",
  components: { schemas: jsonSchema(openapi.components.schemas) },
});

function requestOf(operation: ApiOperation, token: string) {
  let path = operation.path;
  const query = new URLSearchParams();
  for (const parameter of operation.parameters ?? []) {
    if (!parameter.required) continue;
    const value = String(defaultValue(parameter.schema)) || "sample";
    if (parameter.in === "path")
      path = path.replace(`{${parameter.name}}`, encodeURIComponent(value));
    if (parameter.in === "query") query.set(parameter.name, value);
  }
  const bodySchema = operation.requestBody?.content["application/json"]?.schema;
  return new Request(`http://thalia.test${path}?${query}`, {
    method: operation.method,
    headers: { "X-Emby-Token": token, "Content-Type": "application/json" },
    body:
      bodySchema === undefined ||
      operation.method === "GET" ||
      operation.method === "HEAD"
        ? undefined
        : JSON.stringify(defaultValue(bodySchema)),
  });
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
});

describe.skipIf(!databaseUrl)("official Jellyfin operation coverage", () => {
  test(
    "validates statuses, bodies, and admin access against a seeded library",
    () =>
      withDatabase(async (db) => {
        await seedBrowse(db);
        const routes = jellyfinRoutes(
          createArtworkHandler(db),
          createHlsHandler(db),
        );
        const handle = createJellyfinHandler(db, routes);
        const send = (request: Request) => handle(request, "127.0.0.1");
        const header =
          'MediaBrowser Client="Coverage", Device="Coverage", DeviceId="coverage"';
        const admin = await jellyfinLogin(send, header, "admin", "admin-pass");
        const viewer = await jellyfinLogin(send, header);
        const failures: string[] = [];
        for (const operation of operations) {
          if (gapOf(operation) !== undefined) continue;
          const response = await send(requestOf(operation, admin));
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
            const value: unknown = response.headers
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
            const denied = await send(requestOf(operation, viewer));
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
