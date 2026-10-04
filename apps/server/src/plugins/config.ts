import type { JsonObject, JsonValue } from "../db/schema/common.ts";

const types = [
  "object",
  "string",
  "number",
  "integer",
  "boolean",
  "array",
] as const;

/** The JSON Schema subset a plugin config uses, and the settings form renders. */
export type ConfigSchema = {
  type?: (typeof types)[number];
  title?: string;
  description?: string;
  properties?: Record<string, ConfigSchema>;
  required?: string[];
  enum?: JsonValue[];
  items?: ConfigSchema;
  default?: JsonValue;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJson(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  return isRecord(value) && Object.values(value).every(isJson);
}

/** Reports whether `value` is an object of JSON values, such as a submitted config. */
export function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && Object.values(value).every(isJson);
}

/** Reads a JSON Schema in the supported subset, throwing on anything else. */
export function readConfigSchema(
  value: unknown,
  path = "config",
): ConfigSchema {
  const fail = (reason: string): never => {
    throw new Error(`${path} ${reason}`);
  };
  if (!isRecord(value)) return fail("must be an object.");
  const schema: ConfigSchema = {};
  const { type, title, description, properties, required, items } = value;
  if (type !== undefined) {
    const known = types.find((candidate) => candidate === type);
    if (known === undefined) return fail("has an unsupported type.");
    schema.type = known;
  }
  if (title !== undefined) {
    if (typeof title !== "string") return fail("title must be a string.");
    schema.title = title;
  }
  if (description !== undefined) {
    if (typeof description !== "string")
      return fail("description must be a string.");
    schema.description = description;
  }
  if (properties !== undefined) {
    if (!isRecord(properties)) return fail("properties must be an object.");
    schema.properties = Object.fromEntries(
      Object.entries(properties).map(([key, property]) => [
        key,
        readConfigSchema(property, `${path}.properties.${key}`),
      ]),
    );
  }
  if (required !== undefined) {
    if (
      !Array.isArray(required) ||
      required.some((key) => typeof key !== "string")
    )
      return fail("required must list property names.");
    schema.required = required;
  }
  if (value.enum !== undefined) {
    if (!Array.isArray(value.enum) || !value.enum.every(isJson))
      return fail("enum must list JSON values.");
    schema.enum = value.enum;
  }
  if (items !== undefined)
    schema.items = readConfigSchema(items, `${path}.items`);
  if (value.default !== undefined) {
    if (!isJson(value.default)) return fail("default must be a JSON value.");
    schema.default = value.default;
  }
  return schema;
}

function matchesType(type: ConfigSchema["type"], value: JsonValue): boolean {
  switch (type) {
    case undefined:
      return true;
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "integer":
      return Number.isInteger(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
  }
}

/** Lists every way `value` breaks `schema`, as path-prefixed messages; empty means valid. */
export function configErrors(
  schema: ConfigSchema,
  value: JsonValue,
  path = "config",
): string[] {
  if (!matchesType(schema.type, value))
    return [`${path} must be ${schema.type}.`];
  if (
    schema.enum !== undefined &&
    !schema.enum.some((option) => Bun.deepEquals(option, value))
  )
    return [`${path} must be one of the listed values.`];
  const errors: string[] = [];
  if (Array.isArray(value) && schema.items !== undefined) {
    const items = schema.items;
    value.forEach((entry, index) => {
      errors.push(...configErrors(items, entry, `${path}[${index}]`));
    });
  }
  if (isRecord(value)) {
    for (const key of schema.required ?? [])
      if (value[key] === undefined) errors.push(`${path}.${key} is required.`);
    for (const [key, property] of Object.entries(schema.properties ?? {})) {
      const entry = value[key];
      if (entry !== undefined)
        errors.push(...configErrors(property, entry, `${path}.${key}`));
    }
  }
  return errors;
}

/** Fills the schema's top-level defaults under a stored config. */
export function withDefaults(
  schema: ConfigSchema | null,
  stored: JsonObject,
): JsonObject {
  const defaults: JsonObject = {};
  for (const [key, property] of Object.entries(schema?.properties ?? {}))
    if (property.default !== undefined) defaults[key] = property.default;
  return { ...defaults, ...stored };
}
