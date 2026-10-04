import { readBoundedBytes } from "./bounded-body.ts";

/** Decoders that reject malformed provider JSON with `Invalid <label> response.`. */
export function jsonDecoders(label: string) {
  function invalid(): never {
    throw new Error(`Invalid ${label} response.`);
  }
  function asObject(value: unknown): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      invalid();
    return Object.fromEntries(Object.entries(value));
  }
  function requiredId(value: unknown): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0)
      invalid();
    return value;
  }
  function requiredString(value: unknown): string {
    if (typeof value !== "string" || value.trim().length === 0) invalid();
    return value;
  }
  function optionalString(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") invalid();
    return value;
  }
  /** Reads an optional `YYYY-MM-DD` date; an empty string means none. */
  function optionalDate(value: unknown): string | null {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string") invalid();
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (match === null) invalid();
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) invalid();
    return match[0];
  }
  return {
    invalid,
    asObject,
    requiredId,
    requiredString,
    optionalString,
    optionalDate,
  };
}

/** The year of a `YYYY-MM-DD` date, or null without one. */
export function dateYear(date: string | null): number | null {
  return date === null ? null : Number(date.slice(0, 4));
}

/** Folds case, accents and punctuation so folder titles compare with provider titles. */
export function normalizeTitle(title: string): string {
  return (
    title
      .normalize("NFKD")
      .toLowerCase()
      .replace(/\p{M}/gu, "")
      // Radarr's and Sonarr's clean titles write "&" as "and" and drop apostrophes.
      .replace(/&/g, " and ")
      .replace(/['’]/g, "")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()
  );
}

/** Scores a search result: 0.8 for a matching title, else 0.5, plus 0.1 without a query year or 0.2 when the years agree. */
export function titleConfidence(
  titleMatches: boolean,
  queryYear: number | undefined,
  resultYear: number | null,
): number {
  let confidence = titleMatches ? 0.8 : 0.5;
  if (queryYear === undefined) confidence += 0.1;
  else if (resultYear === queryYear) confidence += 0.2;
  return Math.min(confidence, 1);
}

/** The timeout and body limit every request of one provider shares. */
export type RequestLimits = {
  label: string;
  timeoutMs: number;
  maxResponseBytes: number;
};

/** Validates the timeout and body limit a provider factory receives. */
export function assertRequestLimits({
  label,
  timeoutMs,
  maxResponseBytes,
}: RequestLimits): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new Error(`Invalid ${label} request timeout.`);
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1)
    throw new Error(`Invalid ${label} response limit.`);
}

/** Options for one bounded provider JSON request. */
export type JsonRequestOptions = {
  init?: { method?: string; headers?: Record<string, string>; body?: string };
  /** A 404 resolves undefined, which no JSON body can produce. */
  allowMissing?: boolean;
};

const notFoundStatus = 404;

/** Sends one provider request and reads its JSON body under a timeout and a size limit. */
export async function requestJson(
  request: typeof fetch,
  url: URL,
  { label, timeoutMs, maxResponseBytes }: RequestLimits,
  options: JsonRequestOptions = {},
): Promise<unknown> {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await request(url, {
    ...options.init,
    headers: { accept: "application/json", ...options.init?.headers },
    signal,
  });
  if (options.allowMissing && response.status === notFoundStatus) {
    await response.body?.cancel();
    return undefined;
  }
  if (!response.ok)
    throw new Error(`${label} request failed with status ${response.status}.`);
  const tooLarge = () => new Error(`${label} response too large.`);
  const declared = response.headers.get("content-length")?.trim() ?? "";
  if (/^\d+$/.test(declared) && Number(declared) > maxResponseBytes) {
    await response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (response.body === null) throw new Error(`Invalid ${label} response.`);
  let bytes: Uint8Array;
  try {
    bytes = await readBoundedBytes(response.body, maxResponseBytes, tooLarge);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw error;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    if (signal.aborted) throw signal.reason;
    throw new Error(`Invalid ${label} response.`);
  }
}
