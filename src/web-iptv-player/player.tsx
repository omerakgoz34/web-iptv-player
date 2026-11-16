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
    const ua = request.headers.get("user-agent");
    if (ua) headers.set("user-agent", ua);
    const upstream = await fetch(parsed, { headers, redirect: "follow" });
    const type = upstream.headers.get("content-type") || "";
    const relay = here.origin + here.pathname + "?url=";
    if (/\\.m3u8?(\\?|$)/i.test(parsed.pathname) || /mpegurl/i.test(type)) {
      const text = await upstream.text();
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
  const [ended, setEnded] = useState(false);
  const hlsRef = useRef<{ destroy: () => void; audioTrack: number; subtitleTrack: number } | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.setAttribute("referrerpolicy", "no-referrer");
    let cancelled = false;
    const request = props.request;
    let triedRelay = directBlocked(request.hlsUrl);
    let usedFile = false;
    let expecting = false;
    const native = prefersNativeHls(video);
    setFailed(false);
    setEnded(false);
    setMenu("");

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

    const playable = (url: string, forceRelay: boolean) => (forceRelay || directBlocked(url) ? proxied(url) : url);

    const start = async (forceRelay: boolean) => {
      expecting = false;
      hlsRef.current?.destroy();
      hlsRef.current = null;
      video.removeAttribute("src");
      video.load();
      const source = playable(request.hlsUrl, forceRelay);
      const file = request.fileUrl ? playable(request.fileUrl, forceRelay) : "";
      const wantHls = !request.fileUrl || request.hlsUrl.endsWith(".m3u8");
      const arm = (url: string) => {
        video.src = url;
        expecting = true;
      };
      if (wantHls && !native) {
        const mod = await import("hls.js");
        if (cancelled) return;
        const Hls = mod.default;
        if (Hls.isSupported()) {
          const loader = forceRelay || directBlocked(request.hlsUrl) ? relayLoader(Hls.DefaultConfig.loader, proxied) : undefined;
          const options: Record<string, unknown> = {
            enableWorker: false,
            capLevelToPlayerSize: true,
            maxBufferLength: 20,
            maxMaxBufferLength: 40,
            backBufferLength: 20,
          };
          if (loader) options.loader = loader;
          const hls = new Hls(options as never);
          hlsRef.current = hls;
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            setAudio(readTracks(hls.audioTracks));
            setSubs(readTracks(hls.subtitleTracks));
            setAudioId(hls.audioTrack);
            setSubId(hls.subtitleTrack);
          });
          hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => setAudio(readTracks(hls.audioTracks)));
          hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => setSubs(readTracks(hls.subtitleTracks)));
          hls.on(Hls.Events.ERROR, (_event, data) => {
            if (!data?.fatal || cancelled) return;
            if (!triedRelay) {
              triedRelay = true;
              void start(true);
              return;
            }
            if (file && !usedFile) {
              usedFile = true;
              hls.destroy();
              hlsRef.current = null;
              arm(file);
              void video.play().catch(() => undefined);
              return;
            }
            setFailed(true);
          });
          hls.loadSource(source);
          hls.attachMedia(video);
          expecting = true;
        } else {
          arm(source);
        }
      } else if (wantHls) {
        arm(source);
      } else if (file) {
        usedFile = true;
        arm(file);
      }
      if (request.startAt && request.startAt > 0) {
        const seek = () => {
          video.currentTime = request.startAt || 0;
          video.removeEventListener("loadedmetadata", seek);
        };
        video.addEventListener("loadedmetadata", seek);
      }
      try {
        await video.play();
      } catch {
        if (!cancelled) setPlaying(false);
      }
    };

    const onMediaError = () => {
      if (!expecting || cancelled || hlsRef.current) return;
      expecting = false;
      if (!triedRelay) {
        triedRelay = true;
        void start(true);
        return;
      }
      if (request.fileUrl && !usedFile) {
        usedFile = true;
        video.src = playable(request.fileUrl, true);
        expecting = true;
        void video.play().catch(() => undefined);
        return;
      }
      setFailed(true);
    };

    if (request.kind === "live" && app.account) {
      saveLastLive(app.account.id, { id: request.id, name: request.title, poster: request.poster || "", updatedAt: Date.now() });
    }
    void start(triedRelay);
    const onTime = () => {
      setPosition(video.currentTime || 0);
      setDuration(Number.isFinite(video.duration) ? video.duration : 0);
      if (video.currentTime > 0 && Math.floor(video.currentTime) % 5 === 0) remember();
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => {
      setPlaying(false);
      remember();
    };
    const onEnd = () => {
      setEnded(true);
      setPlaying(false);
      remember();
    };
    video.addEventListener("error", onMediaError);
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onEnd);
    video.textTracks.addEventListener("addtrack", collectNative);
    return () => {
      cancelled = true;
      remember();
      video.removeEventListener("error", onMediaError);
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onEnd);
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

  return (
    <div data-player data-screen class="fixed inset-0 z-30 flex flex-col bg-bg">
      <video ref={videoRef} class="min-h-0 w-full flex-1 bg-bg [&::cue]:bg-transparent [&::cue]:text-[1.15rem] [&::cue]:text-fg" playsInline onClick={toggle} />
      <div class="flex flex-col gap-3 border-t border-line bg-surface p-4">
        <div class="flex flex-wrap items-center gap-3">
          <button type="button" data-nav class="flex min-h-12 min-w-12 items-center justify-center rounded-md border border-line" aria-label={app.t("back")} onClick={() => history.back()}>
            <IconBack />
          </button>
          <div class="min-w-0 flex-1">
            <div class="truncate font-semibold">{props.request.subtitle || props.request.title}</div>
            <div class="truncate text-sm text-muted">
              {props.request.kind === "live" ? app.t("liveBadge") : [code, props.request.subtitle ? props.request.title : ""].filter(Boolean).join(" · ")}
            </div>
          </div>
          <div class="tabular-nums text-sm text-muted">{finite ? `${formatClock(position)} / ${formatClock(duration)}` : formatClock(position)}</div>
        </div>
        {finite ? (
          <input
            data-nav
            type="range"
            min={0}
            max={Math.floor(duration)}
            step={10}
            value={Math.min(Math.floor(duration), Math.floor(position))}
            aria-label={app.t("play")}
            class="h-11 w-full accent-accent"
            onInput={(event) => {
              const video = videoRef.current;
              if (!video) return;
              video.currentTime = Number((event.currentTarget as HTMLInputElement).value);
            }}
          />
        ) : null}
        <div class="flex flex-wrap gap-2">
          <button type="button" data-nav data-autofocus class="flex min-h-14 min-w-14 items-center justify-center rounded-md border border-line" aria-label={app.t("back10")} onClick={() => seek(-10)}>
            <IconBack10 />
          </button>
          <button type="button" data-nav class="flex min-h-14 min-w-14 items-center justify-center rounded-md bg-accent text-on-accent" aria-label={playing ? app.t("pause") : app.t("play")} onClick={toggle}>
            {playing ? <IconPause large /> : <IconPlay large />}
          </button>
          <button type="button" data-nav class="flex min-h-14 min-w-14 items-center justify-center rounded-md border border-line" aria-label={app.t("fwd10")} onClick={() => seek(10)}>
            <IconFwd10 />
          </button>
          <button type="button" data-nav class={`flex min-h-14 min-w-14 items-center justify-center rounded-md ${menu === "audio" ? "bg-accent text-on-accent" : "border border-line"}`} aria-label={app.t("audio")} aria-pressed={menu === "audio"} onClick={() => setMenu(menu === "audio" ? "" : "audio")}>
            <IconAudio large />
          </button>
          <button type="button" data-nav class={`flex min-h-14 min-w-14 items-center justify-center rounded-md ${menu === "sub" ? "bg-accent text-on-accent" : "border border-line"}`} aria-label={app.t("subtitles")} aria-pressed={menu === "sub"} onClick={() => setMenu(menu === "sub" ? "" : "sub")}>
            <IconSubs large />
          </button>
        </div>
        {menu ? (
          <div class="flex flex-wrap gap-2">
            {menu === "sub" ? (
              <button type="button" data-nav class={`min-h-12 rounded-md px-4 ${subId === -1 ? "bg-accent text-on-accent" : "border border-line"}`} onClick={() => chooseSub(-1)}>
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
                  class={`min-h-12 rounded-md px-4 ${active ? "bg-accent text-on-accent" : "border border-line"}`}
                  onClick={() => (menu === "audio" ? chooseAudio(track.id) : chooseSub(track.id))}
                >
                  {labelTrack(track.label, app.lang, track.id)}
                </button>
              );
            })}
            {(menu === "audio" ? audio : subs).length === 0 ? <p class="text-sm text-muted">{app.t("noTracks")}</p> : null}
          </div>
        ) : null}
        {failed ? <p class="text-accent">{app.t("playerError")}</p> : null}
        {ended && props.request.nextPath ? (
          <button type="button" data-nav class="min-h-12 self-start rounded-md bg-accent px-4 font-semibold text-on-accent" onClick={() => go(props.request.nextPath || "/")}>
            {app.t("nextEpisode")}
          </button>
        ) : null}
        {ended && !props.request.nextPath && props.request.kind !== "live" ? <p class="text-muted">{app.t("ended")}</p> : null}
      </div>
    </div>
  );
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
