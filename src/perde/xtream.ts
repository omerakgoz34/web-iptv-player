import { directBlocked, parseDuration, streamUrls } from "./media";
import {
  loadCachedSeries,
  loadCachedVod,
  loadPrefs,
  getProgress,
  saveCachedSeries,
  saveCachedVod,
} from "./storage";
import type {
  Account,
  Catalog,
  Category,
  Fail,
  LiveItem,
  MovieItem,
  PlayRequest,
  Route,
  SeriesDetails,
  SeriesItem,
  VodDetails,
} from "./types";

export class IptvError extends Error {
  constructor(readonly code: Fail) {
    super(code);
  }
}

type Wrap = (url: string) => string;

let transport: "unknown" | "direct" | "relay" = "unknown";
let relayWrap: Wrap | null = null;

export function mediaRelay(): Wrap | null {
  return relayWrap;
}

export function resetTransport(): void {
  transport = "unknown";
  relayWrap = null;
}

export function parseLogin(input: { server: string; username: string; password: string }): Account {
  let server = input.server.trim();
  let username = input.username.trim();
  let password = input.password;
  if (!server) throw new IptvError("invalid");
  if (!/^https?:\/\//i.test(server)) server = `http://${server}`;
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    throw new IptvError("invalid");
  }
  const fromQueryUser = url.searchParams.get("username");
  const fromQueryPass = url.searchParams.get("password");
  if (!username && fromQueryUser) username = fromQueryUser;
  if (!password && fromQueryPass) password = fromQueryPass;
  if (!username || !password) throw new IptvError("invalid");
  const path = url.pathname.replace(/\/(player_api|panel_api|get|xmltv)\.php$/i, "").replace(/\/$/, "");
  const base = `${url.protocol}//${url.host}${path === "/" ? "" : path}`;
  return { id: `${username}@${url.host}${path === "/" ? "" : path}`, base, username, password };
}

export async function fetchCatalog(account: Account): Promise<Catalog> {
  const auth = await getJson<Record<string, unknown>>(account, {});
  assertAuth(auth);
  const [liveCategories, live, movieCategories, movies, seriesCategories, series] = await Promise.all([
    getJson<unknown>(account, { action: "get_live_categories" }),
    getJson<unknown>(account, { action: "get_live_streams" }),
    getJson<unknown>(account, { action: "get_vod_categories" }),
    getJson<unknown>(account, { action: "get_vod_streams" }),
    getJson<unknown>(account, { action: "get_series_categories" }),
    getJson<unknown>(account, { action: "get_series" }),
  ]);
  return {
    fetchedAt: Date.now(),
    liveCategories: categories(liveCategories),
    live: liveItems(live),
    movieCategories: categories(movieCategories),
    movies: movieItems(movies),
    seriesCategories: categories(seriesCategories),
    series: seriesItems(series),
  };
}

export async function fetchVodDetails(account: Account, id: string): Promise<VodDetails> {
  const key = `${account.id}:vod:${id}`;
  const memoryHit = memory.get(key) as VodDetails | undefined;
  if (memoryHit) return memoryHit;
  const cached = await loadCachedVod(account.id, id);
  if (cached) {
    memory.set(key, cached);
    return cached;
  }
  const raw = await getJson<Record<string, unknown>>(account, { action: "get_vod_info", vod_id: id });
  const info = asRecord(raw.info);
  const data = asRecord(raw.movie_data);
  const details: VodDetails = {
    name: text(info.name) || text(data.name),
    plot: text(info.plot) || text(info.description),
    poster: text(info.movie_image) || text(info.cover_big),
    logo: pickLogo(info) || pickLogo(raw),
    backdrop: backdrop(info.backdrop_path),
    genre: text(info.genre),
    year: (text(info.releasedate) || text(info.release_date)).slice(0, 4),
    rating: text(info.rating),
    duration: text(info.duration),
    director: text(info.director),
    cast: text(info.cast) || text(info.actors),
    ext: text(data.container_extension),
  };
  memory.set(key, details);
  await saveCachedVod(account.id, id, details);
  return details;
}

export async function fetchSeriesDetails(account: Account, id: string): Promise<SeriesDetails> {
  const key = `${account.id}:series:${id}`;
  const memoryHit = memory.get(key) as SeriesDetails | undefined;
  if (memoryHit) return memoryHit;
  const cached = await loadCachedSeries(account.id, id);
  if (cached) {
    memory.set(key, cached);
    return cached;
  }
  const raw = await getJson<Record<string, unknown>>(account, { action: "get_series_info", series_id: id });
  const info = asRecord(raw.info);
  const episodes = episodesFrom(raw.episodes);
  const details: SeriesDetails = {
    name: text(info.name),
    plot: text(info.plot) || text(info.description),
    poster: text(info.cover),
    logo: pickLogo(info) || pickLogo(raw),
    backdrop: backdrop(info.backdrop_path),
    genre: text(info.genre),
    year: (text(info.releaseDate) || text(info.release_date) || text(info.year)).slice(0, 4),
    rating: text(info.rating),
    cast: text(info.cast),
    director: text(info.director),
    episodes,
  };
  memory.set(key, details);
  await saveCachedSeries(account.id, id, details);
  return details;
}

export async function resolvePlay(account: Account, route: Extract<Route, { name: "watch" }>, catalog: Catalog): Promise<PlayRequest> {
  if (route.kind === "live") {
    const item = catalog.live.find((entry) => entry.id === route.id);
    if (!item) throw new IptvError("network");
    const urls = streamUrls(account, "live", item.id);
    return { kind: "live", id: item.id, title: item.name, poster: item.poster, hlsUrl: urls.hls };
  }
  if (route.kind === "movie") {
    const item = catalog.movies.find((entry) => entry.id === route.id);
    if (!item) throw new IptvError("network");
    const urls = streamUrls(account, "movie", item.id, item.ext);
    const direct = /^https?:\/\//i.test(item.direct) ? item.direct : undefined;
    const saved = getProgress(account.id, "movie", item.id);
    const startAt = usableStart(route.startAt, saved?.position);
    return {
      kind: "movie",
      id: item.id,
      title: item.name,
      poster: item.poster,
      logo: item.logo,
      hlsUrl: urls.hls,
      fileUrl: direct || urls.file,
      startAt,
    };
  }
  const seriesId = route.seriesId || "";
  const show = catalog.series.find((entry) => entry.id === seriesId);
  const details = await fetchSeriesDetails(account, seriesId);
  const episode = details.episodes.find((entry) => entry.id === route.id);
  if (!episode) throw new IptvError("network");
  const urls = streamUrls(account, "episode", episode.id, episode.ext);
  const saved = getProgress(account.id, "episode", episode.id);
  const startAt = usableStart(route.startAt, saved?.position);
  const index = details.episodes.findIndex((entry) => entry.id === episode.id);
  const next = index >= 0 ? details.episodes[index + 1] : undefined;
  return {
    kind: "episode",
    id: episode.id,
    title: episode.title,
    subtitle: show?.name || details.name,
    poster: episode.poster || show?.poster || details.poster,
    logo: show?.logo || details.logo,
    hlsUrl: urls.hls,
    fileUrl: urls.file,
    startAt,
    seriesId,
    season: episode.season,
    episode: episode.episode,
    nextPath: next ? `/watch/episode/${encodeURIComponent(seriesId)}/${encodeURIComponent(next.id)}` : undefined,
  };
}

const memory = new Map<string, VodDetails | SeriesDetails>();

async function getJson<T>(account: Account, params: Record<string, string>): Promise<T> {
  const url = apiUrl(account, params);
  const response = await fetchUpstream(url);
  const textBody = await response.text();
  if (!response.ok) throw new IptvError(response.status === 401 || response.status === 403 ? "auth" : "network");
  if (textBody.trim().startsWith("<")) throw new IptvError("blocked");
  try {
    return JSON.parse(textBody) as T;
  } catch {
    throw new IptvError("network");
  }
}

function apiUrl(account: Account, params: Record<string, string>): string {
  const url = new URL(`${account.base}/player_api.php`);
  url.searchParams.set("username", account.username);
  url.searchParams.set("password", account.password);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

async function fetchUpstream(url: string): Promise<Response> {
  const prefs = loadPrefs();
  const attempts: Array<"direct" | "user" | "local"> = [];
  const pageBlocksDirect = directBlocked(url);
  if (!prefs.forceRelay && !pageBlocksDirect && transport !== "relay") attempts.push("direct");
  if (prefs.relay.trim()) attempts.push("user");
  attempts.push("local");
  if (transport === "relay") {
    attempts.splice(0, attempts.length);
    if (prefs.relay.trim()) attempts.push("user");
    attempts.push("local");
  }
  let sawBlock = pageBlocksDirect;
  for (const kind of attempts) {
    const target = kind === "direct" ? url : kind === "user" ? applyRelay(prefs.relay.trim(), url) : localRelay(url);
    try {
      const response = await fetch(target, { signal: AbortSignal.timeout(25000) });
      if (kind !== "direct") {
        const type = response.headers.get("content-type") || "";
        if (response.status === 404 || type.includes("text/html")) {
          sawBlock = true;
          continue;
        }
        relayWrap = kind === "user" ? (value) => applyRelay(prefs.relay.trim(), value) : localRelay;
        transport = "relay";
      } else {
        relayWrap = null;
        transport = "direct";
      }
      return response;
    } catch {
      sawBlock = true;
    }
  }
  throw new IptvError(sawBlock ? "blocked" : "network");
}

function localRelay(url: string): string {
  const relay = new URL("api/relay", document.baseURI);
  relay.searchParams.set("url", url);
  return relay.toString();
}

function applyRelay(relay: string, url: string): string {
  if (relay.includes("{url}")) return relay.replaceAll("{url}", encodeURIComponent(url));
  return `${relay}${encodeURIComponent(url)}`;
}

function usableStart(requested: number | undefined, saved: number | undefined): number {
  if (requested !== undefined && Number.isFinite(requested)) return Math.max(0, requested);
  if (saved && saved > 15) return saved;
  return 0;
}

function assertAuth(raw: Record<string, unknown>): void {
  const info = asRecord(raw.user_info);
  const auth = Number(info.auth);
  const status = text(info.status);
  if (auth !== 1 || /expired|banned|disabled/i.test(status)) throw new IptvError("auth");
}

function categories(raw: unknown): Category[] {
  if (!Array.isArray(raw)) return [];
  const list: Category[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    const id = text(record.category_id) || text(record.id);
    if (!id) continue;
    list.push({ id, name: text(record.category_name) || text(record.name) || id });
  }
  return list;
}

function liveItems(raw: unknown): LiveItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const record = asRecord(item);
    return {
      id: text(record.stream_id),
      name: text(record.name) || "—",
      poster: text(record.stream_icon),
      categoryId: text(record.category_id),
      number: Number(record.num) || 0,
    };
  }).filter((item) => item.id);
}

function movieItems(raw: unknown): MovieItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const record = asRecord(item);
    return {
      id: text(record.stream_id),
      name: text(record.name) || "—",
      poster: text(record.stream_icon) || text(record.cover),
      logo: pickLogo(record),
      categoryId: text(record.category_id),
      ext: text(record.container_extension) || "mp4",
      rating: text(record.rating),
      plot: text(record.plot),
      direct: text(record.direct_source),
      added: text(record.added),
    };
  }).filter((item) => item.id);
}

function seriesItems(raw: unknown): SeriesItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const record = asRecord(item);
    return {
      id: text(record.series_id),
      name: text(record.name) || "—",
      poster: text(record.cover) || text(record.stream_icon),
      logo: pickLogo(record),
      categoryId: text(record.category_id),
      plot: text(record.plot),
      rating: text(record.rating),
      genre: text(record.genre),
      year: (text(record.releaseDate) || text(record.year)).slice(0, 4),
      backdrop: backdrop(record.backdrop_path),
    };
  }).filter((item) => item.id);
}

function episodesFrom(raw: unknown): SeriesDetails["episodes"] {
  const groups = asRecord(raw);
  const episodes: SeriesDetails["episodes"] = [];
  for (const [seasonKey, value] of Object.entries(groups)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      const record = asRecord(item);
      const info = asRecord(record.info);
      const season = Number(record.season ?? seasonKey) || Number(seasonKey) || 0;
      const episode = Number(record.episode_num) || 0;
      const id = text(record.id);
      if (!id) continue;
      episodes.push({
        id,
        season,
        episode,
        title: text(record.title) || `${episode}`,
        plot: text(info.plot) || text(record.plot),
        poster: text(info.movie_image),
        ext: text(record.container_extension) || "mp4",
        duration: Number(info.duration_secs) || parseDuration(info.duration),
      });
    }
  }
  episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);
  return episodes;
}

const LOGO_KEYS = ["title_logo", "logo", "stream_logo", "movie_logo", "series_logo", "logo_url"];

function pickLogo(record: Record<string, unknown>): string {
  for (const key of LOGO_KEYS) {
    const value = text(record[key]);
    if (/^https?:\/\//i.test(value)) return value;
  }
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && /logo/i.test(key) && /^https?:\/\//i.test(value)) return value;
  }
  return "";
}

function backdrop(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return "";
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}
