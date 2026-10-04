import fixture from "./fixtures/openapi-10.11.11.json";

const schemas: Record<string, Record<string, string>> = fixture.schemas;
const enums: Record<string, string[]> = fixture.enums;

function valueErrors(type: string, value: unknown, at: string): string[] {
  if (type === "string" || type === "boolean")
    return typeof value === type ? [] : [`${at} is not a ${type}`];
  if (type === "integer")
    return Number.isInteger(value) ? [] : [`${at} is not an integer`];
  if (type.startsWith("enum:")) {
    const name = type.slice("enum:".length);
    return enums[name]?.some((known) => known === value)
      ? []
      : [`${at} is not a ${name}`];
  }
  if (type === "array" || type.startsWith("array:")) {
    if (!Array.isArray(value)) return [`${at} is not an array`];
    const entry = type.slice("array:".length);
    return type === "array"
      ? []
      : value.flatMap((item, index) =>
          objectErrors(entry, item, `${at}[${index}]`),
        );
  }
  return objectErrors(type, value, at);
}

function objectErrors(schema: string, value: unknown, at: string): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return [`${at} is not an object`];
  const fields = Object.entries(schemas[schema] ?? {});
  return fields.flatMap(([name, spec]) => {
    const nullable = spec.startsWith("?");
    const field = (value as Record<string, unknown>)[name];
    if (field === undefined || field === null)
      return nullable ? [] : [`${at}.${name} is missing`];
    return valueErrors(nullable ? spec.slice(1) : spec, field, `${at}.${name}`);
  });
}

/**
 * Lists where a response breaks a pinned Jellyfin 10.11.11 schema, or nothing
 * when it conforms. Required fields must be present and typed; nullable ones
 * are checked only when sent.
 */
export function contractErrors(
  schema: keyof typeof fixture.schemas,
  value: unknown,
): string[] {
  return objectErrors(schema, value, schema);
}
