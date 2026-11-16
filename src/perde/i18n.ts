import type { Lang } from "./types";

const tr = {
  tagline: "Televizyon için sade bir yayın uygulaması.",
  server: "Sunucu adresi",
  username: "Kullanıcı adı",
  password: "Şifre",
  connect: "Bağlan",
  connecting: "Bağlanıyor…",
  live: "Canlı",
  movies: "Filmler",
  series: "Diziler",
  refresh: "Yenile",
  refreshing: "Yenileniyor…",
  settings: "Ayarlar",
  theme: "Tema",
  dark: "Koyu",
  light: "Açık",
  continueWatching: "Kaldığın yer",
  search: "Ara",
  all: "Tümü",
  empty: "Bu listede bir şey yok.",
  back: "Geri",
  play: "Oynat",
  resume: "Devam et",
  fromStart: "Baştan",
  audio: "Ses",
  subtitles: "Altyazı",
  off: "Kapalı",
  back10: "10 saniye geri",
  fwd10: "10 saniye ileri",
  pause: "Duraklat",
  channels: "kanal",
  titles: "başlık",
  updated: "Güncellendi",
  signOut: "Çıkış",
  signOutSure: "Bu cihazdan silinsin mi?",
  relay: "Aktarım adresi",
  relayHelp:
    "Panel http ise ya da tarayıcıyı engelliyorsa https bir aktarım adresi yaz. O adres kullanıcı adı ve şifreni görür.",
  forceRelay: "Doğrudan bağlantıyı atla",
  clearProgress: "İzleme geçmişini sil",
  clearSure: "Geçmiş silinsin mi?",
  savedOnDevice: "Giriş bilgileri yalnız bu cihazda durur.",
  errorAuth: "Giriş kabul edilmedi. Adres, kullanıcı adı ve şifreyi kontrol et.",
  errorBlocked:
    "Tarayıcı panele ulaşamadı. https sayfadan http panele doğrudan gidilmez. Yayıncı izin vermiyorsa buraya bir aktarım adresi gerekir.",
  errorNetwork: "Sunucuya ulaşılamadı.",
  errorInvalid: "Adres, kullanıcı adı veya şifre eksik.",
  loadingList: "Liste alınıyor…",
  playerError: "Bu yayın bu cihazda açılamadı.",
  missing: "Bu kayıt listede yok. Yenilemeyi dene.",
  page: "Sayfa",
  prev: "Önceki",
  next: "Sonraki",
  nextEpisode: "Sonraki bölüm",
  ended: "Bölüm bitti",
  director: "Yönetmen",
  cast: "Oyuncular",
  season: "Sezon",
  lastChannel: "Son kanal",
  retry: "Tekrar dene",
  noTracks: "Parça yok",
  searchPlaceholder: "İsim ara",
  serverPlaceholder: "http://sunucu:port",
  account: "Hesap",
  worker: "Örnek aktarım kodu",
  workerHelp: "Bilgisayardan bir Cloudflare Worker’a yapıştır, çıkan https adresini televizyonda buraya yaz.",
  copy: "Kodu seç",
  liveBadge: "CANLI",
  episodes: "Bölümler",
};

const en: { [K in keyof typeof tr]: string } = {
  tagline: "A quiet player for the television.",
  server: "Server address",
  username: "Username",
  password: "Password",
  connect: "Connect",
  connecting: "Connecting…",
  live: "Live",
  movies: "Movies",
  series: "Series",
  refresh: "Refresh",
  refreshing: "Refreshing…",
  settings: "Settings",
  theme: "Theme",
  dark: "Dark",
  light: "Light",
  continueWatching: "Continue",
  search: "Search",
  all: "All",
  empty: "Nothing in this list.",
  back: "Back",
  play: "Play",
  resume: "Resume",
  fromStart: "From start",
  audio: "Audio",
  subtitles: "Subtitles",
  off: "Off",
  back10: "Back 10 seconds",
  fwd10: "Forward 10 seconds",
  pause: "Pause",
  channels: "channels",
  titles: "titles",
  updated: "Updated",
  signOut: "Sign out",
  signOutSure: "Remove it from this device?",
  relay: "Relay address",
  relayHelp:
    "If the panel is http, or the browser blocks it, paste an https relay. That address can see your username and password.",
  forceRelay: "Skip the direct connection",
  clearProgress: "Clear watch history",
  clearSure: "Clear history?",
  savedOnDevice: "Login details stay on this device only.",
  errorAuth: "Login was refused. Check the address, username, and password.",
  errorBlocked:
    "The browser could not reach the panel. An https page cannot open an http panel directly. Add a relay address if the provider blocks browsers.",
  errorNetwork: "The server could not be reached.",
  errorInvalid: "Address, username, or password is missing.",
  loadingList: "Loading the list…",
  playerError: "This stream could not be opened on this device.",
  missing: "This item is not in the list. Try refresh.",
  page: "Page",
  prev: "Previous",
  next: "Next",
  nextEpisode: "Next episode",
  ended: "Episode finished",
  director: "Director",
  cast: "Cast",
  season: "Season",
  lastChannel: "Last channel",
  retry: "Try again",
  noTracks: "No tracks",
  searchPlaceholder: "Search by name",
  serverPlaceholder: "http://server:port",
  account: "Account",
  worker: "Sample relay code",
  workerHelp: "Paste this into a Cloudflare Worker on a computer, then type the https address here on the TV.",
  copy: "Select code",
  liveBadge: "LIVE",
  episodes: "Episodes",
};

const table = { tr, en };

export type MessageKey = keyof typeof tr;

export function translate(lang: Lang, key: MessageKey): string {
  return table[lang][key];
}

export function formatCount(lang: Lang, value: number): string {
  return new Intl.NumberFormat(lang === "tr" ? "tr-TR" : "en-US").format(value);
}

export function formatWhen(lang: Lang, stamp: number): string {
  return new Intl.DateTimeFormat(lang === "tr" ? "tr-TR" : "en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(stamp));
}

export function initialLang(): Lang {
  if (typeof navigator === "undefined") return "en";
  return navigator.language.toLowerCase().startsWith("tr") ? "tr" : "en";
}
