import type { Account } from "./types";

export function absolutizePlaylist(text: string, base: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/g, (_match, uri: string) => `URI="${abs(uri, base)}"`);
      }
      return abs(trimmed, base);
    })
    .join("\n");
}

function abs(uri: string, base: string): string {
  try {
    return new URL(uri, base).toString();
  } catch {
    return uri;
  }
}

export function streamUrls(
  account: Account,
  kind: "live" | "movie" | "episode",
  id: string,
  ext?: string,
): { hls: string; file?: string } {
  const user = encodeURIComponent(account.username);
  const pass = encodeURIComponent(account.password);
  const item = encodeURIComponent(id);
  if (kind === "live") {
    return { hls: `${account.base}/live/${user}/${pass}/${item}.m3u8` };
  }
  const folder = kind === "movie" ? "movie" : "series";
  const clean = (ext || "mp4").replace(/^\./, "") || "mp4";
  const file = `${account.base}/${folder}/${user}/${pass}/${item}.${clean}`;
  const hls = `${account.base}/${folder}/${user}/${pass}/${item}.m3u8`;
  return clean === "m3u8" ? { hls } : { hls, file };
}

export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remain = total % 60;
  const sec = String(remain).padStart(2, "0");
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${sec}`;
  return `${minutes}:${sec}`;
}

export function episodeCode(season: number, episode: number): string {
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

export function parseDuration(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return 0;
  const parts = value.split(":").map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

export function directBlocked(url: string): boolean {
  if (typeof location === "undefined") return false;
  return location.protocol === "https:" && url.startsWith("http://");
}
