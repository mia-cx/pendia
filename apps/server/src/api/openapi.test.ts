import { describe, expect, test } from "bun:test";
import { openApiDocument } from "./openapi.ts";

type Parameter = { name: string; in: string };
type Operation = {
  parameters?: (Parameter | { $ref: string })[];
  security?: unknown[];
  responses?: Record<
    string,
    { content?: { "application/json"?: { schema?: unknown } } }
  >;
};
type PathItem = { get?: Operation; post?: Operation; put?: Operation };

function parameterNames(item: PathItem | undefined): Set<string> {
  return new Set(
    (item?.get?.parameters ?? [])
      .map((parameter) => ("name" in parameter ? parameter.name : undefined))
      .filter((name): name is string => name !== undefined),
  );
}

function collectRefs(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) collectRefs(entry, found);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      if (key === "$ref" && typeof entry === "string") found.push(entry);
      collectRefs(entry, found);
    }
  }
  return found;
}

describe("openapi document", () => {
  test("reports the OpenAPI version, title and API paths", async () => {
    const doc = await openApiDocument();
    expect(doc.openapi).toStartWith("3.1");
    expect(doc.info?.title).toBe("Pendia");
    expect(Object.keys(doc.paths ?? {})).toEqual(
      expect.arrayContaining([
        "/me",
        "/items",
        "/items/{id}",
        "/playback/plan",
        "/playback/{sessionId}/{itemId}/refresh",
        "/playback/{sessionId}/{itemId}/start",
        "/playback/{sessionId}/{itemId}/progress",
        "/playback/{sessionId}/{itemId}/stop",
        "/items/{itemId}/progress",
        "/items/{itemId}/versions/{versionId}/resume",
        "/items/{itemId}/marks",
        "/items/{itemId}/favourite",
        "/items/{itemId}/rating",
        "/shelves/continue-watching",
        "/setup/status",
        "/users",
        "/users/{id}",
        "/users/{id}/sessions",
        "/sessions/{id}/revoke",
        "/users/{id}/groups",
        "/users/{id}/overrides/{permission}",
        "/users/{id}/settings",
        "/users/{id}/libraries/{libraryId}",
        "/groups",
        "/groups/{id}/permissions",
        "/settings",
        "/settings/providers/{name}",
        "/libraries/{id}/scan-status",
      ]),
    );
  });

  test("declares the list query parameters and the get path parameter", async () => {
    const doc = await openApiDocument();
    const paths = doc.paths as Record<string, PathItem> | undefined;
    const listParams = parameterNames(paths?.["/items"]);
    expect(listParams.has("limit")).toBe(true);
    expect(listParams.has("cursor")).toBe(true);
    const idParameter = (paths?.["/items/{id}"]?.get?.parameters ?? []).find(
      (parameter) => "name" in parameter && parameter.name === "id",
    ) as Parameter | undefined;
    expect(idParameter?.in).toBe("path");
  });

  test("the list response carries the connection and the card properties", async () => {
    const doc = await openApiDocument();
    const paths = doc.paths as Record<string, PathItem> | undefined;
    const schema = paths?.["/items"]?.get?.responses?.["200"]?.content?.[
      "application/json"
    ]?.schema as {
      properties?: {
        items?: { items?: { properties?: Record<string, unknown> } };
      };
    };
    expect(schema.properties && Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(["items", "cursor"]),
    );
    const card = schema.properties?.items?.items?.properties ?? {};
    expect(Object.keys(card)).toEqual(
      expect.arrayContaining([
        "id",
        "kind",
        "libraryId",
        "title",
        "year",
        "addedAt",
      ]),
    );
  });

  test("publishes the playback, marks and shelf operations with schemas", async () => {
    const doc = await openApiDocument();
    const paths = doc.paths as Record<string, PathItem> | undefined;
    const expected: [string, "get" | "post" | "put"][] = [
      ["/playback/plan", "post"],
      ["/playback/{sessionId}/{itemId}/refresh", "post"],
      ["/playback/{sessionId}/{itemId}/start", "post"],
      ["/playback/{sessionId}/{itemId}/progress", "post"],
      ["/playback/{sessionId}/{itemId}/stop", "post"],
      ["/items/{itemId}/progress", "get"],
      ["/items/{itemId}/versions/{versionId}/resume", "get"],
      ["/items/{itemId}/marks", "get"],
      ["/items/{itemId}/favourite", "put"],
      ["/items/{itemId}/rating", "put"],
      ["/shelves/continue-watching", "get"],
    ];
    for (const [path, method] of expected) {
      const operation = paths?.[path]?.[method];
      expect(operation, `${method.toUpperCase()} ${path}`).toBeDefined();
      expect(Object.keys(operation?.responses ?? {})).toEqual(
        expect.arrayContaining(["200"]),
      );
    }
    const shelfParams = parameterNames(paths?.["/shelves/continue-watching"]);
    expect(shelfParams.has("limit")).toBe(true);
    expect(shelfParams.has("cursor")).toBe(true);
    const marksSchema = paths?.["/items/{itemId}/marks"]?.get?.responses?.[
      "200"
    ]?.content?.["application/json"]?.schema as
      | { properties?: Record<string, unknown> }
      | undefined;
    expect(
      marksSchema?.properties && Object.keys(marksSchema.properties),
    ).toEqual(expect.arrayContaining(["favourite", "rating"]));
    const shelfSchema = paths?.["/shelves/continue-watching"]?.get?.responses?.[
      "200"
    ]?.content?.["application/json"]?.schema as
      | {
          properties?: {
            items?: { items?: { properties?: Record<string, unknown> } };
          };
        }
      | undefined;
    const shelfEntry = shelfSchema?.properties?.items?.items?.properties ?? {};
    expect(Object.keys(shelfEntry)).toEqual(
      expect.arrayContaining(["item", "progress", "durationSeconds"]),
    );
  });

  test("no reference in the document dangles into $defs", async () => {
    const doc = await openApiDocument();
    for (const ref of collectRefs(doc))
      expect(ref.startsWith("#/$defs/")).toBe(false);
  });

  test("the declared error statuses appear on the items operation", async () => {
    const doc = await openApiDocument();
    const paths = doc.paths as Record<string, PathItem> | undefined;
    expect(Object.keys(paths?.["/items"]?.get?.responses ?? {})).toEqual(
      expect.arrayContaining(["200", "400", "401", "403", "404"]),
    );
  });

  test("declares both credential schemes as root alternatives", async () => {
    const doc = await openApiDocument();
    const components = doc.components as
      | { securitySchemes?: Record<string, unknown> }
      | undefined;
    expect(components?.securitySchemes?.bearerAuth).toEqual({
      type: "http",
      scheme: "bearer",
    });
    expect(components?.securitySchemes?.cookieAuth).toEqual({
      type: "apiKey",
      in: "cookie",
      name: "pendia_session",
    });
    expect(doc.security).toEqual([{ bearerAuth: [] }, { cookieAuth: [] }]);
  });

  test("setup status opts out of the root security requirement", async () => {
    const doc = await openApiDocument();
    const paths = doc.paths as Record<string, PathItem> | undefined;
    expect(paths?.["/setup/status"]?.get?.security).toEqual([]);
    expect(paths?.["/users"]?.get?.security ?? doc.security).toEqual([
      { bearerAuth: [] },
      { cookieAuth: [] },
    ]);
  });
});
