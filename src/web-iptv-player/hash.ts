import type { Kind, Route } from "./types";

export function parseHash(hash: string): Route {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const [pathPart, queryPart] = raw.split("?");
  const parts = pathPart.split("/").filter(Boolean);
  const query = new URLSearchParams(queryPart || "");
  const startAt = query.has("t") ? Number(query.get("t")) : undefined;
  if (parts.length === 0) return { name: "home" };
  if (parts[0] === "login") return { name: "login" };
  if (parts[0] === "settings") return { name: "settings" };
  if (parts[0] === "live" || parts[0] === "movies" || parts[0] === "series") {
    const kind: Kind = parts[0] === "live" ? "live" : parts[0] === "movies" ? "movie" : "series";
    const category = parts[1] === "c" && parts[2] ? safeDecode(parts[2]) : "all";
    return { name: "browse", kind, category };
  }
  if (parts[0] === "movie" && parts[1]) return { name: "movie", id: safeDecode(parts[1]) };
  if (parts[0] === "show" && parts[1]) return { name: "show", id: safeDecode(parts[1]) };
  if (parts[0] === "watch" && parts[1] === "live" && parts[2]) {
    return { name: "watch", kind: "live", id: safeDecode(parts[2]) };
  }
  if (parts[0] === "watch" && parts[1] === "movie" && parts[2]) {
    return { name: "watch", kind: "movie", id: safeDecode(parts[2]), startAt };
  }
  if (parts[0] === "watch" && parts[1] === "episode" && parts[2] && parts[3]) {
    return {
      name: "watch",
      kind: "episode",
      seriesId: safeDecode(parts[2]),
      id: safeDecode(parts[3]),
      startAt,
    };
  }
  return { name: "home" };
}

export function browsePath(kind: Kind, category: string): string {
  const root = kind === "live" ? "/live" : kind === "movie" ? "/movies" : "/series";
  if (!category || category === "all") return root;
  return `${root}/c/${encodeURIComponent(category)}`;
}

export function go(path: string): void {
  const next = path.startsWith("#") ? path : `#${path.startsWith("/") ? path : `/${path}`}`;
  if (location.hash === next) return;
  location.hash = next;
}

export function back(): void {
  const hash = location.hash;
  if (!hash || hash === "#" || hash === "#/") return;
  history.back();
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
