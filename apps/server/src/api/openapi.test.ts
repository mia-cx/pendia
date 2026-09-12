import { describe, expect, test } from "bun:test";
import { openApiDocument } from "./openapi.ts";

type Parameter = { name: string; in: string };
type PathItem = {
  get?: {
    parameters?: (Parameter | { $ref: string })[];
    responses?: Record<
      string,
      { content?: { "application/json"?: { schema?: unknown } } }
    >;
  };
};

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
      expect.arrayContaining(["/me", "/items", "/items/{id}"]),
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
});
