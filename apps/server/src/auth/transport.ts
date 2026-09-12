import { isIP } from "node:net";

/** Normalizes an IPv4 or IPv6 literal; IPv4-mapped IPv6 folds to IPv4. */
export function normalizeAddress(value: string): string | undefined {
  const trimmed = value.trim();
  const kind = isIP(trimmed);
  if (kind === 4) return trimmed;
  if (kind !== 6) return undefined;
  let host: string;
  try {
    host = new URL(`http://[${trimmed}]/`).hostname;
  } catch {
    return undefined;
  }
  const canonical = host.replace(/^\[|\]$/g, "").toLowerCase();
  const mapped = canonical.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped?.[1] && mapped[2]) {
    const hi = Number.parseInt(mapped[1], 16);
    const lo = Number.parseInt(mapped[2], 16);
    return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
  }
  return canonical;
}

function parseForwardedFor(raw: string): string | undefined {
  const value = raw.trim().replace(/^"|"$/g, "");
  if (!value || /^unknown$/i.test(value) || value.startsWith("_"))
    return undefined;
  const bracketed = value.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed?.[1]) return normalizeAddress(bracketed[1]);
  const ipv4 = value.match(/^(\d+\.\d+\.\d+\.\d+)(?::\d+)?$/);
  if (ipv4?.[1]) return normalizeAddress(ipv4[1]);
  return undefined;
}

function parseForwardedElement(element: string) {
  let forAddress: string | undefined;
  let proto: "http" | "https" | undefined;
  for (const field of element.split(";")) {
    const pair = field.split("=", 2);
    const key = pair[0]?.trim().toLowerCase();
    const raw = pair[1]?.trim().replace(/^"|"$/g, "");
    if (key === "for" && raw !== undefined) forAddress = parseForwardedFor(raw);
    else if (key === "proto" && raw !== undefined) {
      const lowered = raw.toLowerCase();
      if (lowered === "http" || lowered === "https") proto = lowered;
    }
  }
  return { forAddress, proto };
}

function sanitizeProto(raw: string): boolean | undefined {
  const lowered = raw.trim().toLowerCase();
  if (lowered === "https") return true;
  if (lowered === "http") return false;
  return undefined;
}

/** Resolves client address and protocol; forwarding headers count only from configured trusted proxies, which must sanitize proto. */
export function requestIdentity(
  request: Request,
  peerAddress: string,
  trustedProxyAddresses: readonly string[],
): { address: string; secure: boolean } {
  const directSecure = new URL(request.url).protocol === "https:";
  const normalizedPeer = normalizeAddress(peerAddress);
  const peer = normalizedPeer ?? "0.0.0.0";
  const trusted = new Set(
    trustedProxyAddresses
      .map((a) => normalizeAddress(a))
      .filter((a): a is string => a !== undefined),
  );
  if (normalizedPeer === undefined || !trusted.has(peer))
    return { address: peer, secure: directSecure };

  let address = peer;
  let secure = directSecure;
  const forwarded = request.headers.get("forwarded");
  if (forwarded !== null) {
    const elements = forwarded.split(",");
    for (let i = elements.length - 1; i >= 0 && trusted.has(address); i--) {
      const { forAddress, proto } = parseForwardedElement(elements[i] ?? "");
      if (forAddress === undefined) break;
      address = forAddress;
      if (proto) secure = proto === "https";
    }
    return { address, secure };
  }

  const xff = request.headers.get("x-forwarded-for");
  const xfp = request.headers.get("x-forwarded-proto");
  if (xff !== null) {
    const parts = xff.split(",");
    let traversed = -1;
    for (let i = parts.length - 1; i >= 0 && trusted.has(address); i--) {
      const hop = normalizeAddress(parts[i] ?? "");
      if (hop === undefined) break;
      address = hop;
      traversed = i;
    }
    if (xfp !== null) {
      const protos = xfp.split(",");
      if (traversed >= 0 && protos.length === parts.length) {
        const proto = sanitizeProto(protos[traversed] ?? "");
        if (proto !== undefined) secure = proto;
      } else if (protos.length === 1) {
        const proto = sanitizeProto(protos[0] ?? "");
        if (proto !== undefined) secure = proto;
      }
    }
    return { address, secure };
  }
  if (xfp !== null) {
    const proto = sanitizeProto(xfp);
    if (proto !== undefined) secure = proto;
  }
  return { address, secure };
}
