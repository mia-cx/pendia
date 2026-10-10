import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { AuthError } from "../auth/errors.ts";
import { readJsonObject } from "../auth/http.ts";
import type { JsonObject } from "../db/schema/common.ts";
import { openapi } from "./openapi.ts";
import { parseGuid } from "./request.ts";

/** Converts OpenAPI 3.0 nullable refs and compositions into JSON Schema unions. */
export function jsonSchema(value: unknown): unknown {
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

/** Validates the pinned schemas using Jellyfin's own UUID serialization convention. */
export const contractValidator = new Ajv({ strict: false, allErrors: true });
addFormats(contractValidator);
// Jellyfin's v12.2 JsonGuidConverter writes N-format UUIDs and accepts dashed UUIDs too.
// https://github.com/jellyfin/jellyfin/blob/v12.2/src/Jellyfin.Extensions/Json/Converters/JsonGuidConverter.cs
contractValidator.addFormat("uuid", (value) => parseGuid(value) !== undefined);
for (const format of [
  "int32",
  "int64",
  "float",
  "double",
  "binary",
  "byte",
  "text",
])
  contractValidator.addFormat(format, true);
contractValidator.addSchema({
  $id: "jellyfin",
  components: { schemas: jsonSchema(openapi.components.schemas) },
});
const validators = new Map<string, ValidateFunction<JsonObject>>();

/** Reads an object DTO with case-insensitive top-level names, ignoring unknown fields as ASP.NET does. */
export async function readDto(
  request: Request,
  name: string,
): Promise<JsonObject> {
  const schema = openapi.components.schemas[name];
  if (schema?.properties === undefined)
    throw new Error(`Unknown object DTO ${name}.`);
  const fields = new Map(
    Object.keys(schema.properties).map((key) => [key.toLowerCase(), key]),
  );
  const input = await readJsonObject(request, 262_144);
  const value = Object.fromEntries(
    Object.entries(input).flatMap(([key, value]) => {
      const canonical = fields.get(key.toLowerCase());
      return canonical === undefined ? [] : [[canonical, value]];
    }),
  );
  const validate =
    validators.get(name) ??
    contractValidator.compile<JsonObject>({
      $ref: `jellyfin#/components/schemas/${name}`,
    });
  validators.set(name, validate);
  if (!validate(value)) throw new AuthError("INVALID_INPUT");
  return value;
}
