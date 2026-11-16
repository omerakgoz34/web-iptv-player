/** @jsxImportSource preact */
import { useEffect, useRef, useState } from "preact/hooks";
import { useApp } from "./context";
import { go } from "./hash";
import { IconAudio, IconBack, IconBack10, IconFwd10, IconPause, IconPlay, IconSubs } from "./icons";
import { absolutizePlaylist, directBlocked, episodeCode, formatClock } from "./media";
import { saveLastLive, saveProgress, progressKey } from "./storage";
import type { PlayRequest } from "./types";
import { proxied } from "./xtream";

type Track = { id: number; label: string };

const WORKER = `export default {
  async fetch(request) {
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET,HEAD,OPTIONS"
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    const here = new URL(request.url);
    const target = here.searchParams.get("url");
    if (!target) return new Response("missing", { status: 400 });
    const parsed = new URL(target);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return new Response("blocked", { status: 400 });
    const headers = new Headers();
    const range = request.headers.get("range");
    if (range) headers.set("range", range);
    const media = /\\.(m3u8?|mp4|m4v|mkv|avi|ts|mov|webm)(\\?|$)/i.test(parsed.pathname);
    if (media) {
      headers.set("user-agent", "VLC/3.0.21 LibVLC/3.0.21");
      headers.set("referer", parsed.origin + "/");
    } else {
      const ua = request.headers.get("user-agent");
      if (ua) headers.set("user-agent", ua);
    }
    const upstream = await fetch(parsed, { headers, redirect: "follow" });
    const type = upstream.headers.get("content-type") || "";
    const relay = here.origin + here.pathname + "?url=";
    if (/\\.m3u8?(\\?|$)/i.test(parsed.pathname) || /mpegurl/i.test(type)) {
      const text = await upstream.text();
      if (!text.includes("#EXTM3U")) return new Response(text, { status: upstream.status >= 400 ? upstream.status : 502, headers: cors });
      const abs = (u) => { try { return new URL(u, upstream.url).toString(); } catch { return u; } };
      const body = text.split(/\\r?\\n/).map((line) => {
        const t = line.trim();
        if (!t) return line;
        if (t.startsWith("#")) return line.replace(/URI="([^"]+)"/g, (_, u) => 'URI="' + relay + encodeURIComponent(abs(u)) + '"');
        return relay + encodeURIComponent(abs(t));
      }).join("\\n");
      return new Response(body, { status: upstream.status, headers: { ...cors, "content-type": "application/vnd.apple.mpegurl" } });
    }
    const out = new Headers(upstream.headers);
    out.set("access-control-allow-origin", "*");
    return new Response(upstream.body, { status: upstream.status, headers: out });
  }
}`;

export { WORKER };

export function Player(props: { request: PlayRequest }) {
  const app = useApp();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(props.request.startAt || 0);
  const [duration, setDuration] = useState(0);
  const [audio, setAudio] = useState<Track[]>([]);
  const [subs, setSubs] = useState<Track[]>([]);
  const [audioId, setAudioId] = useState(0);
  const [subId, setSubId] = useState(-1);
  const [menu, setMenu] = useState<"" | "audio" | "sub">("");
  const [failed, setFailed] = useState(false);
  const [failKind, setFailKind] = useState<"device" | "format">("device");
  const [ended, setEnded] = useState(false);
  const [busy, setBusy] = useState(true);
  const [chrome, setChrome] = useState(true);
  const chromeShown = useRef(true);
  const chromeTimer = useRef(0);
  const holdChrome = useRef(false);
  const hlsRef = useRef<{ destroy: () => void; audioTrack: number; subtitleTrack: number } | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.setAttribute("referrerpolicy", "no-referrer");
    let cancelled = false;
    const request = props.request;
    const native = prefersNativeHls(video);
    const attempts = attemptsFor(request, native);
    let step = 0;
    let expecting = false;
    let switching = false;
    let token = 0;
    let timer = 0;
    let sawFormat = false;
    video.preload = "auto";
    setFailed(false);
    setFailKind("device");
    setEnded(false);
    setMenu("");
    setBusy(true);

    const remember = () => {
      if (request.kind === "live" || !app.account) return;
      const dur = Number.isFinite(video.duration) ? video.duration : 0;
      if (video.currentTime < 8 && dur === 0) return;
      saveProgress({
        key: progressKey(app.account.id, request.kind === "movie" ? "movie" : "episode", request.id),
        kind: request.kind === "movie" ? "movie" : "episode",
        id: request.id,
        seriesId: request.seriesId,
        season: request.season,
        episode: request.episode,
        title: request.title,
        seriesTitle: request.subtitle,
        poster: request.poster,
        logo: request.logo,
        position: video.currentTime || 0,
        duration: dur,
        updatedAt: Date.now(),
      });
    };

    const collectNative = () => {
      const textTracks = [...video.textTracks].filter((track) => track.kind === "subtitles" || track.kind === "captions");
      if (!hlsRef.current && textTracks.length) {
        setSubs(textTracks.map((track, index) => ({ id: index, label: track.label || track.language || String(index + 1) })));
      }
      const tracks = nativeAudioTracks(video);
      if (!hlsRef.current && tracks && tracks.length) {
        const list: Track[] = [];
        let enabled = 0;
        for (let index = 0; index < tracks.length; index += 1) {
          const track = tracks[index];
          list.push({ id: index, label: track.label || track.language || String(index + 1) });
          if (track.enabled) enabled = index;
        }
        setAudio(list);
        setAudioId(enabled);
      }
    };

    const stopWatch = () => window.clearTimeout(timer);
    const stuck = () => {
      if (video.error) return true;
      if (video.currentTime > 0.3) return false;
      if (video.paused && video.readyState >= 2) return false;
      return true;
    };
    const watch = () => {
      stopWatch();
      timer = window.setTimeout(() => {
        if (cancelled || !expecting) return;
        if (stuck()) advance();
      }, 12000);
    };

    const begin = (url: string, raw: string, mine: number) => {
      expecting = false;
      hlsRef.current?.destroy();
      hlsRef.current = null;
      const arm = () => {
        if (mine !== token || cancelled) return;
        video.src = url;
        expecting = true;
        if (request.startAt && request.startAt > 0) {
          const seekTo = () => {
            if (mine !== token) return;
            video.currentTime = request.startAt || 0;
          };
          video.addEventListener("loadedmetadata", seekTo, { once: true });
        }
        void video.play().catch(() => {
          if (!cancelled && mine === token) setPlaying(false);
        });
        watch();
      };
      if (!isHls(raw) || native) {
        arm();
        return;
      }
      void import("hls.js").then((mod) => {
        if (cancelled || mine !== token) return;
        const Hls = mod.default;
        if (!Hls.isSupported()) {
          arm();
          return;
        }
        const proxiedAlready = url !== raw;
        const loader = proxiedAlready ? undefined : relayLoader(Hls.DefaultConfig.loader, proxied);
        const vod = request.kind !== "live";
        const options: Record<string, unknown> = {
          enableWorker: false,
          capLevelToPlayerSize: true,
          startFragPrefetch: true,
          maxBufferLength: vod ? 30 : 10,
          maxMaxBufferLength: vod ? 60 : 20,
          backBufferLength: vod ? 30 : 10,
        };
        if (loader && attemptUsesRelay(url, raw)) options.loader = loader;
        const hls = new Hls(options as never);
        hlsRef.current = hls;
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (mine !== token) return;
          setAudio(readTracks(hls.audioTracks));
          setSubs(readTracks(hls.subtitleTracks));
          setAudioId(hls.audioTrack);
          setSubId(hls.subtitleTrack);
        });
        hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => setAudio(readTracks(hls.audioTracks)));
        hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => setSubs(readTracks(hls.subtitleTracks)));
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data?.fatal || cancelled || mine !== token) return;
          advance();
        });
        hls.loadSource(url);
        hls.attachMedia(video);
        expecting = true;
        void video.play().catch(() => {
          if (!cancelled && mine === token) setPlaying(false);
        });
        watch();
      });
    };

    const giveUp = () => setFailKind(sawFormat ? "format" : "device");

    const spin = async (mine: number) => {
      while (!cancelled && mine === token && step < attempts.length) {
        const attempt = attempts[step];
        if (!attempt.relay) {
          begin(attempt.raw, attempt.raw, mine);
          return;
        }
        const via = await relayServes(attempt.raw, native && request.kind !== "live");
        if (cancelled || mine !== token) return;
        if (via === "format") {
          sawFormat = true;
          const raw = attempt.raw;
          while (step < attempts.length && attempts[step].raw === raw) step += 1;
          continue;
        }
        if (via) {
          begin(via, attempt.raw, mine);
          return;
        }
        step += 1;
      }
      if (!cancelled && mine === token) {
        giveUp();
        setFailed(true);
      }
    };

    const advance = () => {
      if (cancelled || switching) return;
      switching = true;
      stopWatch();
      expecting = false;
      token += 1;
      const mine = token;
      hlsRef.current?.destroy();
      hlsRef.current = null;
      step += 1;
      switching = false;
      void spin(mine);
    };

    const onMediaError = () => {
      if (!expecting || cancelled) return;
      advance();
    };

    if (request.kind === "live" && app.account) {
      saveLastLive(app.account.id, { id: request.id, name: request.title, poster: request.poster || "", updatedAt: Date.now() });
    }
    void spin(token);
    const onTime = () => {
      if (video.currentTime > 0.3) stopWatch();
      setPosition(video.currentTime || 0);
      setDuration(Number.isFinite(video.duration) ? video.duration : 0);
      if (video.currentTime > 0 && Math.floor(video.currentTime) % 5 === 0) remember();
    };
    const onPlay = () => {
      setPlaying(true);
      watch();
    };
    const onPause = () => {
      setPlaying(false);
      if (!video.seeking) setBusy(false);
      remember();
    };
    const onEnd = () => {
      setEnded(true);
      setPlaying(false);
      setBusy(false);
      remember();
    };
    const onWait = () => setBusy(true);
    const onReady = () => {
      if (!video.seeking && video.readyState >= 3) setBusy(false);
    };
    video.addEventListener("error", onMediaError);
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onEnd);
    video.addEventListener("waiting", onWait);
    video.addEventListener("seeking", onWait);
    video.addEventListener("loadstart", onWait);
    video.addEventListener("playing", onReady);
    video.addEventListener("canplay", onReady);
    video.textTracks.addEventListener("addtrack", collectNative);
    return () => {
      cancelled = true;
      stopWatch();
      remember();
      video.removeEventListener("error", onMediaError);
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onEnd);
      video.removeEventListener("waiting", onWait);
      video.removeEventListener("seeking", onWait);
      video.removeEventListener("loadstart", onWait);
      video.removeEventListener("playing", onReady);
      video.removeEventListener("canplay", onReady);
      video.textTracks.removeEventListener("addtrack", collectNative);
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
  }, [props.request, app.account]);

  const seek = (delta: number) => {
    const video = videoRef.current;
    if (!video) return;
    const start = video.seekable.length ? video.seekable.start(0) : 0;
    const end = video.seekable.length ? video.seekable.end(video.seekable.length - 1) : video.duration;
    const cap = Number.isFinite(end) ? end : video.currentTime + Math.max(0, delta);
    video.currentTime = Math.min(cap, Math.max(start, video.currentTime + delta));
  };

  const toggle = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play();
    else video.pause();
  };

  holdChrome.current = menu !== "" || failed || ended;
  const nudge = () => {
    window.clearTimeout(chromeTimer.current);
    if (!chromeShown.current) {
      chromeShown.current = true;
      setChrome(true);
    }
    if (holdChrome.current) return;
    chromeTimer.current = window.setTimeout(() => {
      chromeShown.current = false;
      setChrome(false);
    }, 3000);
  };

  useEffect(() => {
    const onKey = () => nudge();
    window.addEventListener("keydown", onKey);
    nudge();
    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(chromeTimer.current);
    };
  }, [menu, failed, ended]);

  const onSurface = () => {
    if (!chrome) {
      nudge();
      return;
    }
    toggle();
    nudge();
  };

  const chooseAudio = (id: number) => {
    const hls = hlsRef.current;
    const video = videoRef.current;
    if (hls) hls.audioTrack = id;
    const tracks = nativeAudioTracks(video);
    if (tracks) {
      for (let index = 0; index < tracks.length; index += 1) tracks[index].enabled = index === id;
    }
    setAudioId(id);
    setMenu("");
  };

  const chooseSub = (id: number) => {
    const hls = hlsRef.current;
    const video = videoRef.current;
    if (hls) hls.subtitleTrack = id;
    if (video) {
      const tracks = [...video.textTracks].filter((track) => track.kind === "subtitles" || track.kind === "captions");
      tracks.forEach((track, index) => {
        track.mode = id === -1 ? "disabled" : index === id ? "showing" : "disabled";
      });
    }
    setSubId(id);
    setMenu("");
  };

  const finite = Number.isFinite(duration) && duration > 0 && props.request.kind !== "live";
  const code = props.request.season && props.request.episode ? episodeCode(props.request.season, props.request.episode) : "";

  const control = "flex h-10 w-10 shrink-0 items-center justify-center rounded-md [&_svg]:h-5 [&_svg]:w-5";

  return (
    <div
      data-player
      data-screen
      class="fixed inset-0 z-30 box-border flex bg-black pt-[env(safe-area-inset-top,0px)] pr-[env(safe-area-inset-right,0px)] pb-[env(safe-area-inset-bottom,0px)] pl-[env(safe-area-inset-left,0px)]"
      onPointerDown={nudge}
      onPointerMove={nudge}
    >
      <div class="relative min-h-0 w-full flex-1">
      <video ref={videoRef} class="h-full w-full bg-black object-contain [&::cue]:bg-transparent [&::cue]:text-[1.15rem] [&::cue]:text-white" playsInline preload="auto" onClick={onSurface} />
      {busy && !failed && !ended ? (
        <div class="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span class="h-11 w-11 animate-spin rounded-full border-2 border-white/25 border-t-white" />
        </div>
      ) : null}
      {failed ? <p class="pointer-events-none absolute inset-x-6 top-1/3 text-center text-white">{failKind === "format" ? app.t("formatError") : app.t("playerError")}</p> : null}
      {ended && props.request.nextPath ? (
        <button type="button" data-nav class="absolute left-1/2 top-1/3 min-h-10 -translate-x-1/2 rounded-md bg-accent px-4 text-sm font-semibold text-on-accent" onClick={() => go(props.request.nextPath || "/")}>
          {app.t("nextEpisode")}
        </button>
      ) : null}
      {ended && !props.request.nextPath && props.request.kind !== "live" ? <p class="pointer-events-none absolute inset-x-6 top-1/3 text-center text-white/80">{app.t("ended")}</p> : null}
      <div class={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent px-3 pb-3 pt-14 transition-opacity duration-300 ${chrome ? "opacity-100" : "pointer-events-none opacity-0"}`}>
        <div class="mb-2 flex min-w-0 items-center gap-2 text-white">
          <button type="button" data-nav class={`${control} border border-white/25 bg-black/40`} aria-label={app.t("back")} onClick={() => history.back()}>
            <IconBack />
          </button>
          <div class="min-w-0 flex-1">
            <div class="truncate text-sm font-semibold">{props.request.subtitle || props.request.title}</div>
            <div class="truncate text-xs text-white/70">
              {props.request.kind === "live" ? app.t("liveBadge") : [code, props.request.subtitle ? props.request.title : ""].filter(Boolean).join(" · ")}
            </div>
          </div>
        </div>
        {finite ? (
          <div class="mb-2 flex items-center gap-2 text-xs tabular-nums text-white/80">
            <span class="w-12 shrink-0 text-right">{formatClock(position)}</span>
            <input
              data-nav
              type="range"
              min={0}
              max={Math.max(1, duration)}
              step={1}
              value={Math.min(duration, position)}
              aria-label={app.t("play")}
              class="h-10 min-w-0 flex-1 accent-accent"
              onInput={(event) => {
                const video = videoRef.current;
                if (!video) return;
                video.currentTime = Number((event.currentTarget as HTMLInputElement).value);
              }}
            />
            <span class="w-12 shrink-0">{formatClock(duration)}</span>
          </div>
        ) : null}
        <div class="grid grid-cols-[1fr_auto_1fr] items-center gap-1.5">
          <span />
          <div class="flex flex-nowrap items-center justify-center gap-1.5">
            <button type="button" data-nav data-autofocus class={`${control} border border-white/25 bg-black/40 text-white`} aria-label={app.t("back10")} onClick={() => seek(-10)}>
              <IconBack10 />
            </button>
            <button type="button" data-nav class={`${control} bg-accent text-on-accent`} aria-label={playing ? app.t("pause") : app.t("play")} onClick={toggle}>
              {playing ? <IconPause /> : <IconPlay />}
            </button>
            <button type="button" data-nav class={`${control} border border-white/25 bg-black/40 text-white`} aria-label={app.t("fwd10")} onClick={() => seek(10)}>
              <IconFwd10 />
            </button>
          </div>
          <div class="flex flex-nowrap items-center justify-end gap-1.5">
            <button type="button" data-nav class={`${control} ${menu === "audio" ? "bg-accent text-on-accent" : "border border-white/25 bg-black/40 text-white"}`} aria-label={app.t("audio")} aria-pressed={menu === "audio"} onClick={() => setMenu(menu === "audio" ? "" : "audio")}>
              <IconAudio />
            </button>
            <button type="button" data-nav class={`${control} ${menu === "sub" ? "bg-accent text-on-accent" : "border border-white/25 bg-black/40 text-white"}`} aria-label={app.t("subtitles")} aria-pressed={menu === "sub"} onClick={() => setMenu(menu === "sub" ? "" : "sub")}>
              <IconSubs />
            </button>
          </div>
        </div>
        {menu ? (
          <div class="mt-2 flex flex-nowrap justify-end gap-1.5 overflow-x-auto">
            {menu === "sub" ? (
              <button type="button" data-nav class={`h-9 shrink-0 rounded-md px-3 text-sm ${subId === -1 ? "bg-accent text-on-accent" : "border border-white/25 bg-black/40 text-white"}`} onClick={() => chooseSub(-1)}>
                {app.t("off")}
              </button>
            ) : null}
            {(menu === "audio" ? audio : subs).map((track) => {
              const active = menu === "audio" ? track.id === audioId : track.id === subId;
              return (
                <button
                  type="button"
                  data-nav
                  key={track.id}
                  class={`h-9 shrink-0 rounded-md px-3 text-sm ${active ? "bg-accent text-on-accent" : "border border-white/25 bg-black/40 text-white"}`}
                  onClick={() => (menu === "audio" ? chooseAudio(track.id) : chooseSub(track.id))}
                >
                  {labelTrack(track.label, app.lang, track.id)}
                </button>
              );
            })}
            {(menu === "audio" ? audio : subs).length === 0 ? <p class="shrink-0 text-sm text-white/70">{app.t("noTracks")}</p> : null}
          </div>
        ) : null}
      </div>
      </div>
    </div>
  );
}

function attemptsFor(request: PlayRequest, ios: boolean): Array<{ raw: string; relay: boolean }> {
  const urls: string[] = [];
  const file = request.fileUrl || "";
  const path = file.split("?")[0]?.toLowerCase() || "";
  const badFile = /\.(mkv|avi|wmv|flv|mpg|mpeg|divx)$/.test(path);
  if (request.kind !== "live") {
    if (request.hlsUrl) urls.push(request.hlsUrl);
    if (file && file !== request.hlsUrl && !(ios && badFile)) urls.push(file);
  } else if (request.hlsUrl) {
    urls.push(request.hlsUrl);
    const ts = request.hlsUrl.replace(/\.m3u8(?=$|\?)/i, ".ts");
    if (ts !== request.hlsUrl) urls.push(ts);
  }
  const attempts: Array<{ raw: string; relay: boolean }> = [];
  for (const raw of urls) {
    const relays = ios && request.kind !== "live" ? [true, false] : [false, true];
    for (const relay of relays) {
      if (!relay && directBlocked(raw)) continue;
      attempts.push({ raw, relay });
    }
  }
  return attempts;
}

function attemptUsesRelay(url: string, raw: string): boolean {
  return url !== raw;
}

function playlistLines(text: string): string[] {
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) {
      const match = /URI="([^"]+)"/i.exec(trimmed);
      if (match) lines.push(match[1]);
      continue;
    }
    lines.push(trimmed);
  }
  return lines;
}

function iosPlaylistOk(text: string): boolean {
  if (!text.includes("#EXTM3U")) return false;
  const lines = playlistLines(text);
  if (lines.length === 0) return true;
  const bad = /\.(mkv|avi|wmv|flv|mpg|mpeg|divx)(?:$|\?)/i;
  const good = /\.(m3u8?|ts|mp4|m4s|m4v|mov|aac|webm)(?:$|\?)/i;
  if (lines.some((line) => good.test(line))) return true;
  if (lines.every((line) => bad.test(line))) return false;
  return true;
}

function isHls(url: string): boolean {
  return /\.m3u8?(?:$|\?|#)/i.test(url);
}

async function relayServes(raw: string, rejectBad: boolean): Promise<string | "format" | null> {
  const url = proxied(raw);
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), 8000);
  try {
    const response = await fetch(url, { signal: ctrl.signal, headers: { Range: "bytes=0-4095" } });
    if (response.status === 404 || response.status >= 500) return null;
    const type = (response.headers.get("content-type") || "").toLowerCase();
    if (type.includes("text/html")) return null;
    const reader = response.body?.getReader();
    if (!reader) return url;
    const { value } = await reader.read();
    await reader.cancel().catch(() => undefined);
    const head = new TextDecoder().decode(value || new Uint8Array()).replace(/^\uFEFF/, "").trim();
    if (head.startsWith("<")) return null;
    if (rejectBad && head.includes("#EXTM3U") && !iosPlaylistOk(head)) return "format";
    return url;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

function prefersNativeHls(video: HTMLVideoElement): boolean {
  const ua = navigator.userAgent;
  const ios = /iP(hone|ad|od)/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (!ios) return false;
  return video.canPlayType("application/vnd.apple.mpegurl") !== "";
}

type NativeAudio = {
  length: number;
  [index: number]: { label: string; language: string; enabled: boolean };
};

function nativeAudioTracks(video: HTMLVideoElement | null): NativeAudio | null {
  if (!video) return null;
  const tracks = (video as HTMLVideoElement & { audioTracks?: NativeAudio }).audioTracks;
  return tracks || null;
}

function readTracks(tracks: Array<{ id?: number; name?: string; lang?: string }> | undefined): Track[] {
  if (!tracks) return [];
  return tracks.map((track, index) => ({
    id: typeof track.id === "number" ? track.id : index,
    label: track.lang || track.name || String(index + 1),
  }));
}

function labelTrack(label: string, lang: "tr" | "en", index: number): string {
  const code = label.slice(0, 2).toLowerCase();
  if (/^[a-z]{2}$/.test(code)) {
    try {
      const pretty = new Intl.DisplayNames([lang], { type: "language" }).of(code);
      if (pretty) return pretty;
    } catch {
      // Keep the raw label.
    }
  }
  return label || String(index + 1);
}

function relayLoader(Base: new (...args: any[]) => any, wrap: (url: string) => string) {
  return class extends Base {
    load(context: { url: string }, config: unknown, callbacks: RelayCallbacks) {
      const original = context.url;
      const onSuccess = callbacks.onSuccess;
      const wrapped: RelayCallbacks = {
        ...callbacks,
        onSuccess: (response, stats, ctx, details) => {
          if (typeof response.data === "string" && response.data.includes("#EXTM3U")) {
            response.data = absolutizePlaylist(response.data, original);
          }
          onSuccess(response, stats, ctx, details);
        },
      };
      if (!isRelay(original)) context.url = wrap(original);
      super.load(context, config, wrapped);
    }
  };
}

type RelayCallbacks = {
  onSuccess: (response: { data: unknown }, stats: unknown, ctx: unknown, details: unknown) => void;
  onError: (...args: unknown[]) => void;
  onTimeout: (...args: unknown[]) => void;
};

function isRelay(url: string): boolean {
  return url.includes("/api/relay?") || url.includes("%3A%2F%2F") && url.includes("url=");
}
