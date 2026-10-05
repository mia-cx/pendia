import { reachServer, ServerUnreachable } from "./api.ts";

/** The icon key a section row renders; AdminNav maps each key to a Lucide component. */
export type AdminIcon =
  | "gauge"
  | "activity"
  | "library"
  | "users"
  | "shield-check"
  | "puzzle"
  | "settings";

/** One admin section: sidebar row, phone list row and search target. */
export type AdminSection = {
  id: string;
  href: string;
  label: string;
  icon: AdminIcon;
  keywords: readonly string[];
};

/** The admin sections grouped as the sidebar and phone list show them. */
export const adminSectionGroups: readonly (readonly AdminSection[])[] = [
  [
    {
      id: "overview",
      href: "/admin/overview",
      label: "Overview",
      icon: "gauge",
      keywords: ["health", "status", "server", "database", "scan", "playing"],
    },
    {
      id: "activity",
      href: "/admin/activity",
      label: "Activity",
      icon: "activity",
      keywords: [
        "sessions",
        "playing",
        "streams",
        "store",
        "jobs",
        "transcode",
      ],
    },
  ],
  [
    {
      id: "libraries",
      href: "/admin/libraries",
      label: "Libraries",
      icon: "library",
      keywords: ["media", "folders", "roots", "scan", "policies", "versions"],
    },
    {
      id: "users",
      href: "/admin/users",
      label: "Users",
      icon: "users",
      keywords: [
        "accounts",
        "invite",
        "sessions",
        "password",
        "access",
        "bitrate",
      ],
    },
    {
      id: "groups",
      href: "/admin/groups",
      label: "Groups",
      icon: "shield-check",
      keywords: ["permissions", "roles"],
    },
  ],
  [
    {
      id: "plugins",
      href: "/admin/plugins",
      label: "Plugins",
      icon: "puzzle",
      keywords: ["extensions", "registry", "install"],
    },
    {
      id: "general",
      href: "/admin/settings",
      label: "General",
      icon: "settings",
      keywords: [
        "proxies",
        "bitrate",
        "store window",
        "artwork",
        "provider keys",
        "tmdb",
        "oidc",
        "sign-in",
        "secret",
      ],
    },
  ],
];

/** Every admin section, flat, in display order. */
export const adminSections: readonly AdminSection[] = adminSectionGroups.flat();

/** Sections whose label or keywords contain the query, in display order. */
export function matchSections(query: string): readonly AdminSection[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return adminSections;
  return adminSections.filter(
    (section) =>
      section.label.toLowerCase().includes(needle) ||
      section.keywords.some((word) => word.toLowerCase().includes(needle)),
  );
}

/** The section a URL belongs to; `/admin` is overview, prefixes count. */
export function currentSection(url: URL): string | undefined {
  const path = url.pathname;
  if (path === "/admin" || path === "/admin/") return "overview";
  for (const section of adminSections) {
    if (path === section.href || path.startsWith(`${section.href}/`))
      return section.id;
  }
  return undefined;
}

/** Depth of an admin path: `/admin` is 0, a section is 1, a detail page is 2. */
function adminDepth(path: string): number | undefined {
  if (path === "/admin" || path === "/admin/") return 0;
  if (!path.startsWith("/admin/")) return undefined;
  return path.replace(/\/+$/, "").split("/").length - 2;
}

/** "push" when the admin path grows deeper, "pop" when it shrinks, else null. */
export function navDirection(from: string, to: string): "push" | "pop" | null {
  const before = adminDepth(new URL(from, "http://x").pathname);
  const after = adminDepth(new URL(to, "http://x").pathname);
  if (before === undefined || after === undefined) return null;
  if (after > before) return "push";
  if (after < before) return "pop";
  return null;
}

/** Reads /readyz: Pendia answers 200 when ready and a JSON 503 when its database is down; anything else means Pendia did not answer. */
export async function checkHealth(
  transport?: typeof fetch,
): Promise<"ready" | "no-database" | "unreachable"> {
  try {
    const response = await reachServer("/readyz", undefined, transport);
    if (response.ok) return "ready";
    if (response.status === 503) return "no-database";
    return "unreachable";
  } catch (error) {
    if (error instanceof ServerUnreachable) return "unreachable";
    throw error;
  }
}
