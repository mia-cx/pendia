import { createHash } from "node:crypto";
import { openapi } from "./openapi.ts";

const personTypes = new Map(
  (openapi.components.schemas.PersonKind?.enum ?? []).flatMap((value) =>
    typeof value === "string" ? [[value.toLowerCase(), value] as const] : [],
  ),
);

/** Maps core credit role names to the contract's person types; unknown roles remain displayable as Role text. */
export function personType(role: string) {
  return personTypes.get(role.toLowerCase().replaceAll(/[^a-z]/g, ""));
}

/** Stable identifiers for name-only core facets, scoped by their Jellyfin resource kind. */
export function facetId(type: string, name: string) {
  const bytes = createHash("sha256")
    .update(`thalia:jellyfin:${type}:${name}`)
    .digest();
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return bytes.subarray(0, 16).toString("hex");
}
