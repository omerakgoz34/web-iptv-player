/** @jsxImportSource preact */
import { useEffect, useRef, useState } from "preact/hooks";
import { useApp } from "./context";
import { go } from "./hash";
import { IconAudio, IconBack, IconBack10, IconFull, IconFwd10, IconPause, IconPlay, IconSubs } from "./icons";
import { absolutizePlaylist, directBlocked, episodeCode, formatClock } from "./media";
import { saveLastLive, saveProgress, progressKey, loadPrefs } from "./storage";
import type { PlayRequest } from "./types";
import { proxied } from "./xtream";

type Track = { id: number; label: string };

const WORKER = `import { connect } from "cloudflare:sockets";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET,HEAD,OPTIONS",
  "access-control-expose-headers": "*",
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    const here = new URL(request.url);
    const target = here.searchParams.get("url");
    if (!target) return new Response("missing", { status: 400, headers: cors });
    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      return new Response("bad", { status: 400, headers: cors });
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return new Response("blocked", { status: 400, headers: cors });
    const relay = here.origin + here.pathname + "?url=";
    const headers = new Headers();
    const range = request.headers.get("range");
    if (range && !/\\.m3u8?(\\?|$)/i.test(parsed.pathname)) headers.set("range", range);
    headers.set("user-agent", request.headers.get("user-agent") || "Mozilla/5.0");
    headers.set("accept", "*/*");
    try {
      const loaded = await load(parsed.toString(), headers);
      const type = loaded.response.headers.get("content-type") || "";
      const playlist = /\\.m3u8?(\\?|$)/i.test(new URL(loaded.url).pathname) || /mpegurl|vnd\\.apple/i.test(type);
      if (playlist && request.method !== "HEAD") {
        const text = await loaded.response.text();
        if (!text.includes("#EXTM3U")) {
          return new Response(text, { status: loaded.response.status >= 400 ? loaded.response.status : 502, headers: { ...cors, "content-type": type || "text/plain" } });
        }
        const body = rewrite(text, loaded.url, relay);
        return new Response(body, { status: 200, headers: { ...cors, "content-type": "application/vnd.apple.mpegurl", "cache-control": "no-store" } });
      }
      const out = new Headers();
      for (const name of ["content-type", "content-range", "accept-ranges"]) {
        const value = loaded.response.headers.get(name);
        if (value) out.set(name, value);
      }
      const path = new URL(loaded.url).pathname;
      if (/\\.mp4(\\?|$)/i.test(path) && !(out.get("content-type") || "").startsWith("video/")) out.set("content-type", "video/mp4");
      if (/\\.ts(\\?|$)/i.test(path) && !out.get("content-type")) out.set("content-type", "video/mp2t");
      out.set("cache-control", "no-store");
      out.set("access-control-allow-origin", "*");
      out.set("access-control-expose-headers", "*");
      return new Response(loaded.response.body, { status: loaded.response.status, headers: out });
    } catch (error) {
      return new Response(String(error && error.message ? error.message : error), { status: 502, headers: cors });
    }
  },
};

async function load(url, headers) {
  let current = url;
  for (let hop = 0; hop < 5; hop += 1) {
    current = reachable(current);
    const target = new URL(current);
    const response = isIp(target.hostname) ? await fetchIp(target, headers) : await fetch(target, { headers, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return { response, url: current };
      current = new URL(location, current).toString();
      continue;
    }
    return { response, url: current };
  }
  return { response: new Response("redirect", { status: 502 }), url: current };
}

function reachable(url) {
  const target = new URL(url);
  if (!isIp(target.hostname)) return url;
  const port = target.port || (target.protocol === "https:" ? "443" : "80");
  if (port !== "80" && port !== "443") return url;
  target.hostname = \`\${target.hostname}.sslip.io\`;
  return target.toString();
}

function isIp(host) {
  return /^\\d{1,3}(?:\\.\\d{1,3}){3}$/.test(host) || host.includes(":");
}

async function fetchIp(target, headers) {
  const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
  if (target.protocol === "https:") throw new Error("https ip");
  const socket = connect({ hostname: \`\${target.hostname}.sslip.io\`, port }, { allowHalfOpen: true });
  const path = \`\${target.pathname || "/"}\${target.search}\`;
  const lines = [
    \`GET \${path} HTTP/1.1\`,
    \`Host: \${target.host}\`,
    \`User-Agent: \${headers.get("user-agent") || "Mozilla/5.0"}\`,
    "Accept: */*",
    "Connection: close",
  ];
  const range = headers.get("range");
  if (range) lines.push(\`Range: \${range}\`);
  lines.push("", "");
  const writer = socket.writable.getWriter();
  await writer.write(new TextEncoder().encode(lines.join("\\r\\n")));
  await writer.close();
  return readSocket(socket.readable);
}

async function readSocket(readable) {
  const reader = readable.getReader();
  let buffer = new Uint8Array(0);
  let split = -1;
  while (split < 0) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer = append(buffer, value);
    split = find(buffer, "\\r\\n\\r\\n");
  }
  if (split < 0) throw new Error("stream server closed the connection");
  const headerText = new TextDecoder().decode(buffer.slice(0, split));
  const rest = buffer.slice(split + 4);
  const lines = headerText.split("\\r\\n");
  const status = Number((lines[0] || "").split(" ")[1]) || 502;
  const headers = new Headers();
  for (const line of lines.slice(1)) {
    const index = line.indexOf(":");
    if (index > 0) headers.set(line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim());
  }
  const length = Number(headers.get("content-length"));
  const chunked = (headers.get("transfer-encoding") || "").includes("chunked");
  headers.delete("transfer-encoding");
  headers.delete("connection");
  const body = new ReadableStream({
    async start(controller) {
      let pending = rest;
      const push = (bytes) => {
        if (bytes.length) controller.enqueue(bytes);
      };
      if (!chunked) {
        let left = Number.isFinite(length) ? length : Infinity;
        if (pending.length) {
          const take = pending.slice(0, left);
          push(take);
          left -= take.length;
          pending = pending.slice(take.length);
        }
        while (left > 0) {
          const { value, done } = await reader.read();
          if (done) break;
          const take = value.slice(0, left);
          push(take);
          left -= take.length;
        }
        controller.close();
        return;
      }
      let cache = pending;
      const more = async () => {
        const { value, done } = await reader.read();
        if (done) return false;
        cache = append(cache, value);
        return true;
      };
      while (true) {
        let nl = find(cache, "\\r\\n");
        while (nl < 0) {
          if (!(await more())) {
            controller.close();
            return;
          }
          nl = find(cache, "\\r\\n");
        }
        const size = Number.parseInt(new TextDecoder().decode(cache.slice(0, nl)).trim(), 16);
        cache = cache.slice(nl + 2);
        if (!Number.isFinite(size) || size === 0) {
          controller.close();
          return;
        }
        while (cache.length < size + 2) {
          if (!(await more())) break;
        }
        push(cache.slice(0, size));
        cache = cache.slice(size + 2);
      }
    },
  });
  return new Response(body, { status, headers });
}

function rewrite(text, base, relay) {
  const abs = (value) => {
    try {
      return new URL(value, base).toString();
    } catch {
      return value;
    }
  };
  return text
    .split(/\\r?\\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith("#")) return line.replace(/URI="([^"]+)"/g, (_, uri) => \`URI="\${relay}\${encodeURIComponent(abs(uri))}"\`);
      return relay + encodeURIComponent(abs(trimmed));
    })
    .join("\\n");
}

function append(left, right) {
  const next = new Uint8Array(left.length + right.length);
  next.set(left, 0);
  next.set(right, left.length);
  return next;
}

function find(buffer, text) {
  const needle = new TextEncoder().encode(text);
  for (let i = 0; i <= buffer.length - needle.length; i += 1) {
    let match = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (buffer[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}
`

export { WORKER };

export function Player(props: { request: PlayRequest }) {
  const app = useApp();
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);
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

  useEffect(() => {
    const sync = () => setFull(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  const toggleFull = () => {
    const video = videoRef.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    const stage = stageRef.current;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    if (stage?.requestFullscreen) {
      void stage.requestFullscreen().catch(() => video?.webkitEnterFullscreen?.());
      return;
    }
    video?.webkitEnterFullscreen?.();
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
      ref={stageRef}
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
            <button type="button" data-nav class={`${control} border border-white/25 bg-black/40 text-white`} aria-label={app.t("fullscreen")} aria-pressed={full} onClick={toggleFull}>
              <IconFull on={full} />
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
    const preferRelay = Boolean(loadPrefs().relay.trim()) || loadPrefs().forceRelay;
    const relays = preferRelay || (ios && request.kind !== "live") ? [true, false] : [false, true];
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
