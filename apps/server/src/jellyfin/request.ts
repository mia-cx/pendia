import { AuthError } from "../auth/errors.ts";
import { readJsonObject } from "../auth/http.ts";

/** What a Jellyfin client says about itself in its MediaBrowser header. */
export type ClientInfo = {
  client?: string;
  device?: string;
  deviceId?: string;
  version?: string;
  token?: string;
};

const schemes = new Set(["mediabrowser", "emby"]);
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const guidPattern = /^[0-9a-f]{32}$/i;

function decode(value: string): string {
  try {
    // Jellyfin decodes with WebUtility.UrlDecode, which reads + as a space.
    return decodeURIComponent(value.replaceAll("+", " "));
  } catch {
    return value;
  }
}

/** Parses `MediaBrowser Key="Value", ...` with quoted or bare values in any order. */
export function parseAuthorization(header: string): ClientInfo | undefined {
  const trimmed = header.trim();
  const space = trimmed.indexOf(" ");
  if (space < 0 || !schemes.has(trimmed.slice(0, space).toLowerCase()))
    return undefined;
  const fields = new Map<string, string>();
  for (const part of trimmed.slice(space + 1).split(",")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    let value = part.slice(separator + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"'))
      value = value.slice(1, -1);
    value = decode(value).trim();
    if (value.length > 0)
      fields.set(part.slice(0, separator).trim().toLowerCase(), value);
  }
  return {
    client: fields.get("client"),
    device: fields.get("device"),
    deviceId: fields.get("deviceid"),
    version: fields.get("version"),
    token: fields.get("token"),
  };
}

/** Reads the client header from `Authorization`, falling back to Infuse's `X-Emby-Authorization`. */
export function readClient(request: Request): ClientInfo {
  for (const name of ["authorization", "x-emby-authorization"]) {
    const header = request.headers.get(name);
    const parsed = header === null ? undefined : parseAuthorization(header);
    if (parsed !== undefined) return parsed;
  }
  return {};
}

/** Formats a Pendia UUID as a Jellyfin GUID: the same UUID without dashes. */
export function toGuid(id: string): string {
  return id.replaceAll("-", "");
}

/** Reads a Jellyfin GUID, with or without dashes, as a Pendia UUID. */
export function parseGuid(text: string): string | undefined {
  if (uuidPattern.test(text)) return text.toLowerCase();
  if (!guidPattern.test(text)) return undefined;
  const hex = text.toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Query parameters looked up by name case-insensitively, as ASP.NET does. */
export type Query = ReturnType<typeof readQuery>;

/** Wraps URL search parameters for case-insensitive, Jellyfin-typed lookups. */
export function readQuery(params: URLSearchParams) {
  const values = new Map<string, string[]>();
  for (const [name, value] of params) {
    const key = name.toLowerCase();
    values.set(key, [...(values.get(key) ?? []), value]);
  }
  const get = (name: string) =>
    values.get(name.toLowerCase())?.find((value) => value !== "");
  return {
    get,
    /** Reads a list sent repeated or comma-separated. */
    list: (name: string) =>
      (values.get(name.toLowerCase()) ?? [])
        .flatMap((value) => value.split(","))
        .map((value) => value.trim())
        .filter((value) => value !== ""),
    flag: (name: string) => {
      const value = get(name)?.toLowerCase();
      if (value === undefined) return undefined;
      if (value === "true") return true;
      if (value === "false") return false;
      throw new AuthError("INVALID_INPUT");
    },
    count: (name: string) => {
      const value = get(name);
      if (value === undefined) return undefined;
      const number = Number(value);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(number))
        throw new AuthError("INVALID_INPUT");
      return number;
    },
  };
}

/** Reads a JSON object body whose keys match case-insensitively, as ASP.NET binds them. */
export async function readBody(request: Request) {
  const body = await readJsonObject(request);
  const fields = new Map(
    Object.entries(body).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    string: (name: string) => {
      const value = fields.get(name.toLowerCase());
      if (typeof value !== "string") throw new AuthError("INVALID_INPUT");
      return value;
    },
  };
}
