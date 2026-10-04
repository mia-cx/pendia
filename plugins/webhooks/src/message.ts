const placeholder = /\{\{\s*([\w.]+)\s*\}\}/g;

function lookup(context: object, path: string): unknown {
  let current: unknown = context;
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    // Own keys only, so `{{data.constructor}}` finds nothing.
    if (!Object.hasOwn(current, key)) return undefined;
    current = Reflect.get(current, key);
  }
  return current;
}

function format(value: unknown): string {
  if (value === undefined) return "";
  // A string goes in escaped for a JSON string, so `"{{item.title}}"` stays valid JSON.
  if (typeof value === "string") return JSON.stringify(value).slice(1, -1);
  return JSON.stringify(value);
}

/**
 * Renders a body template. `{{path}}` inserts a dotted path from `context`:
 * a string escaped for use inside a JSON string, any other value as JSON, and
 * nothing for a path that does not exist.
 */
export function renderBody(template: string, context: object): string {
  return template.replace(placeholder, (_, path: string) =>
    format(lookup(context, path)),
  );
}

/** Reads `Name: value` strings into header pairs; entries without a valid name come back in `invalid`. */
export function readHeaders(entries: readonly string[]) {
  const headers: [string, string][] = [];
  const invalid: string[] = [];
  for (const line of entries) {
    const colon = line.indexOf(":");
    const name = line.slice(0, colon).trim();
    if (colon < 1 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
      invalid.push(line);
      continue;
    }
    headers.push([name, line.slice(colon + 1).trim()]);
  }
  return { headers, invalid };
}
