import { initialLang } from "./i18n";
import type { Account, Catalog, LastLive, Prefs, SeriesDetails, VodDetails, WatchPoint } from "./types";

const PREFIX = "web-iptv-player";
const ACCOUNT = `${PREFIX}.account`;
const PREFS = `${PREFIX}.prefs`;
const PROGRESS = `${PREFIX}.progress`;
const LAST_LIVE = `${PREFIX}.lastLive`;
const DB_NAME = PREFIX;
const LEGACY_DB = "perde";

export function loadAccount(): Account | null {
  const raw = readStored<Account>(ACCOUNT);
  if (!raw?.base || !raw.username || !raw.password || !raw.id) return null;
  return raw;
}

export function saveAccount(account: Account): void {
  writeJson(ACCOUNT, account);
}

export function clearAccount(): void {
  localStorage.removeItem(ACCOUNT);
  localStorage.removeItem("perde.account");
}

export function loadPrefs(): Prefs {
  const raw = readStored<Partial<Prefs>>(PREFS) ?? {};
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
  const map = readStored<Record<string, WatchPoint>>(PROGRESS) ?? {};
  return Object.values(map)
    .filter((item) => item.key.startsWith(`${accountId}|`))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getProgress(accountId: string, kind: "movie" | "episode", id: string): WatchPoint | null {
  const map = readStored<Record<string, WatchPoint>>(PROGRESS) ?? {};
  return map[progressKey(accountId, kind, id)] ?? null;
}

export function saveProgress(point: WatchPoint): void {
  const map = readStored<Record<string, WatchPoint>>(PROGRESS) ?? {};
  map[point.key] = point;
  writeJson(PROGRESS, map);
}

export function clearProgress(accountId?: string): void {
  if (!accountId) {
    localStorage.removeItem(PROGRESS);
    localStorage.removeItem("perde.progress");
    return;
  }
  const map = readStored<Record<string, WatchPoint>>(PROGRESS) ?? {};
  for (const key of Object.keys(map)) {
    if (key.startsWith(`${accountId}|`)) delete map[key];
  }
  writeJson(PROGRESS, map);
}

export function loadLastLive(accountId: string): LastLive | null {
  const map = readStored<Record<string, LastLive>>(LAST_LIVE) ?? {};
  return map[accountId] ?? null;
}

export function saveLastLive(accountId: string, item: LastLive): void {
  const map = readStored<Record<string, LastLive>>(LAST_LIVE) ?? {};
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

function readStored<T>(key: string): T | null {
  const current = readJson<T>(key);
  if (current) return current;
  const legacy = readJson<T>(key.replace(`${PREFIX}.`, "perde."));
  if (legacy) writeJson(key, legacy);
  return legacy;
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // The TV may refuse a full store. Playback still works for this session.
  }
}

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
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
    const current = await idbRead<T>(DB_NAME, key);
    if (current != null) return current;
    const legacy = await idbRead<T>(LEGACY_DB, key);
    if (legacy != null) await idbSet(key, legacy);
    return legacy;
  } catch {
    return null;
  }
}

function idbRead<T>(name: string, key: string): Promise<T | null> {
  return openDb(name).then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction("kv", "readonly");
        const request = tx.objectStore("kv").get(key);
        request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
        request.onerror = () => reject(request.error);
      }),
  );
}

async function idbSet(key: string, value: unknown): Promise<void> {
  try {
    const db = await openDb(DB_NAME);
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
