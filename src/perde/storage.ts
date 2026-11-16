import { initialLang } from "./i18n";
import type { Account, Catalog, LastLive, Prefs, SeriesDetails, VodDetails, WatchPoint } from "./types";

const ACCOUNT = "perde.account";
const PREFS = "perde.prefs";
const PROGRESS = "perde.progress";
const LAST_LIVE = "perde.lastLive";

export function loadAccount(): Account | null {
  const raw = readJson<Account>(ACCOUNT);
  if (!raw?.base || !raw.username || !raw.password || !raw.id) return null;
  return raw;
}

export function saveAccount(account: Account): void {
  writeJson(ACCOUNT, account);
}

export function clearAccount(): void {
  localStorage.removeItem(ACCOUNT);
}

export function loadPrefs(): Prefs {
  const raw = readJson<Partial<Prefs>>(PREFS) ?? {};
  return {
    lang: raw.lang === "en" || raw.lang === "tr" ? raw.lang : initialLang(),
    theme: raw.theme === "light" ? "light" : "dark",
    relay: typeof raw.relay === "string" ? raw.relay : "",
    forceRelay: Boolean(raw.forceRelay),
  };
}

export function savePrefs(prefs: Prefs): void {
  writeJson(PREFS, prefs);
  document.documentElement.lang = prefs.lang;
  document.documentElement.dataset.theme = prefs.theme;
  document.documentElement.style.colorScheme = prefs.theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", prefs.theme === "light" ? "#f3efe6" : "#101418");
}

export function progressKey(accountId: string, kind: "movie" | "episode", id: string): string {
  return `${accountId}|${kind}|${id}`;
}

export function loadProgress(accountId: string): WatchPoint[] {
  const map = readJson<Record<string, WatchPoint>>(PROGRESS) ?? {};
  return Object.values(map)
    .filter((item) => item.key.startsWith(`${accountId}|`))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getProgress(accountId: string, kind: "movie" | "episode", id: string): WatchPoint | null {
  const map = readJson<Record<string, WatchPoint>>(PROGRESS) ?? {};
  return map[progressKey(accountId, kind, id)] ?? null;
}

export function saveProgress(point: WatchPoint): void {
  const map = readJson<Record<string, WatchPoint>>(PROGRESS) ?? {};
  map[point.key] = point;
  writeJson(PROGRESS, map);
}

export function clearProgress(accountId?: string): void {
  if (!accountId) {
    localStorage.removeItem(PROGRESS);
    return;
  }
  const map = readJson<Record<string, WatchPoint>>(PROGRESS) ?? {};
  for (const key of Object.keys(map)) {
    if (key.startsWith(`${accountId}|`)) delete map[key];
  }
  writeJson(PROGRESS, map);
}

export function loadLastLive(accountId: string): LastLive | null {
  const map = readJson<Record<string, LastLive>>(LAST_LIVE) ?? {};
  return map[accountId] ?? null;
}

export function saveLastLive(accountId: string, item: LastLive): void {
  const map = readJson<Record<string, LastLive>>(LAST_LIVE) ?? {};
  map[accountId] = item;
  writeJson(LAST_LIVE, map);
}

export async function loadCatalog(accountId: string): Promise<Catalog | null> {
  return idbGet<Catalog>(`catalog:${accountId}`);
}

export async function saveCatalog(accountId: string, catalog: Catalog): Promise<void> {
  await idbSet(`catalog:${accountId}`, catalog);
}

export async function loadCachedVod(accountId: string, id: string): Promise<VodDetails | null> {
  return idbGet<VodDetails>(`vod:${accountId}:${id}`);
}

export async function saveCachedVod(accountId: string, id: string, details: VodDetails): Promise<void> {
  await idbSet(`vod:${accountId}:${id}`, details);
}

export async function loadCachedSeries(accountId: string, id: string): Promise<SeriesDetails | null> {
  return idbGet<SeriesDetails>(`series:${accountId}:${id}`);
}

export async function saveCachedSeries(accountId: string, id: string, details: SeriesDetails): Promise<void> {
  await idbSet(`series:${accountId}:${id}`, details);
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // The TV may refuse a full store. Playback still works for this session.
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("perde", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbGet<T>(key: string): Promise<T | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("kv", "readonly");
      const request = tx.objectStore("kv").get(key);
      request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return null;
  }
}

async function idbSet(key: string, value: unknown): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Cache is optional.
  }
}
