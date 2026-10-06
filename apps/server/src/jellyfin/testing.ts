import { createLocalUser, setupAdmin } from "../auth/accounts.ts";
import type { Database } from "../db/client.ts";
import { migrateDatabase } from "../db/migrate.ts";
import { runQueuedKeyframeIndexes } from "../db/testing.ts";
import { scanDirectory } from "../libraries/scan.ts";
import { createLibrary } from "../libraries/service.ts";
import fixture from "./fixtures/openapi-10.11.11.json";

/**
 * Migrates, creates an admin and a `viewer` (password `viewer-pass`), adds a
 * movie library over `root` and scans each `<title> (2026)` folder in it.
 */
export async function seedMovies(
  db: Database,
  root: string,
  titles: readonly string[],
) {
  await migrateDatabase(db);
  const admin = await setupAdmin(db, {
    username: "admin",
    password: "admin-pass",
  });
  const viewer = await createLocalUser(db, admin.id, {
    username: "viewer",
    password: "viewer-pass",
  });
  const library = await createLibrary(db, admin.id, {
    name: "Movies",
    medium: "movies",
    roots: [root],
  });
  const movies = new Map<string, { itemId: string; versionId: string }>();
  for (const title of titles) {
    const scanned = await scanDirectory(db, library.id, `${title} (2026)`);
    await runQueuedKeyframeIndexes(db);
    const versionId = scanned.versionIds[0];
    if (scanned.itemId === null || versionId === undefined)
      throw new Error(`Expected one Item and Version in ${title}.`);
    movies.set(title, { itemId: scanned.itemId, versionId });
  }
  return { admin, viewer, library, movies };
}

/** Logs in through the Jellyfin layer and returns the access token. */
export async function jellyfinLogin(
  send: (request: Request) => Promise<Response | undefined>,
  header: string,
  username = "viewer",
  password = "viewer-pass",
) {
  const response = await send(
    new Request("http://thalia.test/Users/AuthenticateByName", {
      method: "POST",
      headers: { authorization: header, "content-type": "application/json" },
      body: JSON.stringify({ Username: username, Pw: password }),
    }),
  );
  if (response?.status !== 200)
    throw new Error(`Login failed with ${response?.status}.`);
  return ((await response.json()) as { AccessToken: string }).AccessToken;
}

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
