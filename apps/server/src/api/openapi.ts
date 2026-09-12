import {
  type ConditionalSchemaConverter,
  type JSONSchema,
  OpenAPIGenerator,
  type SchemaConvertOptions,
} from "@orpc/openapi";
import { JSONSchema as EffectJSONSchema, Schema } from "effect";
import { pendiaRouter } from "./router.ts";

/** The API version reported in the generated OpenAPI document. */
export const apiVersion = "0.1.0";

type ConverterSchema = Parameters<ConditionalSchemaConverter["convert"]>[0];

const defsPrefix = "#/$defs/";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function inlineRefs(
  value: unknown,
  definitions: Record<string, unknown>,
  path: readonly string[],
): unknown {
  if (Array.isArray(value))
    return value.map((entry) => inlineRefs(entry, definitions, path));
  if (!isRecord(value)) return value;
  const ref = value.$ref;
  if (typeof ref === "string" && ref.startsWith(defsPrefix)) {
    const name = ref.slice(defsPrefix.length);
    const target = definitions[name];
    if (target === undefined || path.includes(name)) return {};
    return inlineRefs(target, definitions, [...path, name]);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      inlineRefs(entry, definitions, path),
    ]),
  );
}

/** Converts an Effect schema to JSON Schema with every $defs reference inlined. */
export class EffectSchemaConverter implements ConditionalSchemaConverter {
  condition(schema: ConverterSchema): boolean {
    return Schema.isSchema(schema);
  }

  convert(
    schema: ConverterSchema,
    _options: SchemaConvertOptions,
  ): [required: boolean, jsonSchema: JSONSchema] {
    if (!Schema.isSchema(schema)) return [true, {}];
    const definitions: Record<string, EffectJSONSchema.JsonSchema7> = {};
    const json = EffectJSONSchema.fromAST(schema.ast, {
      definitions,
      target: "openApi3.1",
      topLevelReferenceStrategy: "skip",
    });
    // Effect's JsonSchema7 and oRPC's JSONSchema are the same shape under different names.
    return [true, inlineRefs(json, definitions, []) as JSONSchema];
  }
}

let documentPromise: ReturnType<OpenAPIGenerator["generate"]> | undefined;

/** The generated OpenAPI document, computed once and shared by every request. */
export function openApiDocument() {
  documentPromise ??= new OpenAPIGenerator({
    schemaConverters: [new EffectSchemaConverter()],
  }).generate(pendiaRouter, {
    info: { title: "Pendia", version: apiVersion },
    servers: [{ url: "/api" }],
  });
  return documentPromise;
}
