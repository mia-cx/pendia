import type { Route } from "./http.ts";
import document from "./openapi/jellyfin-12.2.0.json";
import source from "./openapi/source.json";

/** The subset of OpenAPI used by registration, neutral responses, and coverage. */
export type Schema = {
  $ref?: string;
  type?: string;
  format?: string;
  nullable?: boolean;
  default?: unknown;
  enum?: unknown[];
  properties?: Record<string, Schema>;
  additionalProperties?: boolean | Schema;
  items?: Schema;
  allOf?: Schema[];
  oneOf?: Schema[];
  required?: string[];
};

type Content = Record<string, { schema?: Schema }>;
type Operation = {
  operationId: string;
  tags: string[];
  security?: Record<string, string[]>[];
  parameters?: {
    name: string;
    in: string;
    required?: boolean;
    schema: Schema;
  }[];
  requestBody?: { required?: boolean; content: Content };
  responses: Record<string, { content?: Content }>;
};

/** The pinned official contract. Updating it changes registration and the coverage test together. */
export const openapi: {
  info: { version: string };
  paths: Record<string, Partial<Record<Route["method"], Operation>>>;
  components: { schemas: Record<string, Schema> };
} = {
  info: document.info,
  components: document.components,
  paths: Object.fromEntries(
    Object.entries(document.paths).map(([path, methods]) => [
      path,
      Object.fromEntries(
        Object.entries(methods).map(([method, operation]) => [
          method.toUpperCase(),
          operation,
        ]),
      ),
    ]),
  ),
};

/** Every operation in the official document, including HEAD and embedded path parameters. */
export const operations = Object.entries(openapi.paths).flatMap(
  ([path, methods]) =>
    Object.entries(methods).map(([method, operation]) => ({
      ...operation,
      method: method as Route["method"],
      path,
    })),
);
export type ApiOperation = (typeof operations)[number];
export const specificationSource = source;

/** Resolves a schema in the pinned document without making Jellyfin DTOs part of the core. */
export function resolveSchema(schema: Schema): Schema {
  if (schema.$ref === undefined) return schema;
  const name = schema.$ref.split("/").at(-1) ?? "";
  const found = openapi.components.schemas[name];
  if (found === undefined) throw new Error(`Unknown Jellyfin schema ${name}.`);
  return found;
}

const emptyGuid = "00000000-0000-0000-0000-000000000000";

/** Builds an empty/default value of a Jellyfin schema for concepts Thalia does not have. */
export function defaultValue(
  input: Schema,
  ancestors: readonly Schema[] = [],
): unknown {
  const schema = resolveSchema(input);
  if (ancestors.includes(schema)) return schema.nullable ? null : {};
  const next = [...ancestors, schema];
  if (schema.default !== undefined) return schema.default;
  if (schema.enum !== undefined) return schema.enum[0];
  if (schema.allOf !== undefined) {
    const values = schema.allOf.map((part) => defaultValue(part, next));
    return values.length === 1 ? values[0] : Object.assign({}, ...values);
  }
  if (schema.oneOf !== undefined)
    return defaultValue(schema.oneOf[0] ?? {}, next);
  switch (schema.type) {
    case "array":
      return [];
    case "object":
      return Object.fromEntries(
        Object.entries(schema.properties ?? {}).map(([name, field]) => [
          name,
          defaultValue(field, next),
        ]),
      );
    case "boolean":
      return false;
    case "integer":
    case "number":
      return 0;
    case "string":
      if (schema.format === "uuid") return emptyGuid;
      if (schema.format === "date-time") return "1970-01-01T00:00:00.000Z";
      return "";
    default:
      return {};
  }
}

/** The successful response used by neutral operations; accepted writes prefer the documented 204. */
export function successResponse(operation: ApiOperation) {
  const status =
    operation.responses["204"] === undefined
      ? Object.keys(operation.responses).find((code) => /^2\d\d$/.test(code))
      : "204";
  if (status === undefined)
    throw new Error(`${operation.operationId} has no success response.`);
  const response = operation.responses[status];
  const content = response?.content;
  const mediaType = content === undefined ? undefined : Object.keys(content)[0];
  return {
    status: Number(status),
    mediaType,
    schema: mediaType === undefined ? undefined : content?.[mediaType]?.schema,
  };
}

/** Jellyfin publishes authorization policy names as security scopes in its OpenAPI document. */
export function accessOf(operation: ApiOperation) {
  const policies =
    operation.security?.flatMap((security) => Object.values(security).flat()) ??
    [];
  return {
    anonymous: policies.length === 0,
    admin: policies.some((policy) => /RequiresElevation|Elevated/.test(policy)),
  };
}
