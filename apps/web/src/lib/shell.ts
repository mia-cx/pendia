/** A library as the sidebar lists it. */
export type ShellLibrary = {
  id: string;
  name: string;
  medium: "movies" | "shows";
};

/** One navigation destination. Children are a medium's libraries. */
export type NavEntry = {
  href: string;
  label: string;
  icon: "search" | "home" | "movies" | "shows" | "settings";
  children: readonly { href: string; label: string }[];
};

/** The shell's destinations for a caller: Search, Home, Movies, Shows, then Settings for admins. */
export function navigation(
  admin: boolean,
  libraries: readonly ShellLibrary[],
): readonly NavEntry[] {
  const children = (medium: "movies" | "shows", href: string) => {
    const owned = libraries.filter((l) => l.medium === medium);
    if (owned.length < 2) return [];
    return [...owned]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((l) => ({ href: `${href}?library=${l.id}`, label: l.name }));
  };
  const entries: NavEntry[] = [
    { href: "/search", label: "Search", icon: "search", children: [] },
    { href: "/", label: "Home", icon: "home", children: [] },
    {
      href: "/movies",
      label: "Movies",
      icon: "movies",
      children: children("movies", "/movies"),
    },
    {
      href: "/shows",
      label: "Shows",
      icon: "shows",
      children: children("shows", "/shows"),
    },
  ];
  if (admin)
    entries.push({
      href: "/admin",
      label: "Settings",
      icon: "settings",
      children: [],
    });
  return entries;
}

/** Up-to-two-letter initials for a display name or username ("Mia Chen" -> "MC", "mia" -> "M"). */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/** Whether an href is the current destination for a URL. */
export function isCurrent(url: URL, href: string): boolean {
  const [path, query] = href.split("?");
  if (path === "/") return url.pathname === "/";
  const wanted = new URLSearchParams(query ?? "").get("library");
  if (wanted !== null)
    return url.pathname === path && url.searchParams.get("library") === wanted;
  if (url.pathname !== path && !url.pathname.startsWith(`${path}/`))
    return false;
  return true;
}

/** Whether a nav entry is current; a visible library child that matches takes the highlight instead. */
export function isCurrentSection(
  url: URL,
  entry: NavEntry,
  childrenShown: boolean,
): boolean {
  if (!isCurrent(url, entry.href)) return false;
  return !(childrenShown && entry.children.some((c) => isCurrent(url, c.href)));
}
