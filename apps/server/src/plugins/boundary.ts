/** A value that crossed the plugin boundary without being plain data. */
export class BoundaryError extends Error {
  constructor(path: string, found: string) {
    super(`${path} is ${found}, which cannot cross the plugin boundary.`);
    this.name = "BoundaryError";
  }
}

function describe(value: unknown): string {
  if (typeof value === "function") return "a function";
  if (typeof value === "symbol") return "a symbol";
  if (typeof value === "bigint") return "a bigint";
  if (typeof value === "number") return String(value);
  const name = Object.getPrototypeOf(value)?.constructor?.name;
  return typeof name === "string" ? `a ${name}` : "an object";
}

/**
 * Throws a BoundaryError unless `value` is plain data: JSON values and byte
 * arrays, with undefined allowed only as an absent object property. This is
 * the rule that lets plugins move to a subprocess without a rewrite.
 */
export function assertPlainData(
  value: unknown,
  path = "value",
  ancestors = new Set<object>(),
): void {
  if (value === null) return;
  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (Number.isFinite(value)) return;
      throw new BoundaryError(path, describe(value));
    case "object":
      break;
    default:
      throw new BoundaryError(path, describe(value));
  }
  if (value instanceof Uint8Array) return;
  if (ancestors.has(value)) throw new BoundaryError(path, "a cycle");
  const prototype = Object.getPrototypeOf(value);
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      if (entry === undefined)
        throw new BoundaryError(`${path}[${index}]`, "undefined");
      assertPlainData(entry, `${path}[${index}]`, ancestors);
    }
  } else if (prototype === Object.prototype || prototype === null) {
    for (const [key, entry] of Object.entries(value))
      if (entry !== undefined)
        assertPlainData(entry, `${path}.${key}`, ancestors);
  } else {
    throw new BoundaryError(path, describe(value));
  }
  ancestors.delete(value);
}
