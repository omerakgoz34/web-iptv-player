/** @jsxImportSource preact */
import { useEffect, useState } from "preact/hooks";
import { useApp } from "./context";
import { browsePath, go } from "./hash";
import { formatCount, formatWhen } from "./i18n";
import { episodeCode, formatClock } from "./media";
import { WORKER } from "./player";
import { getProgress, loadLastLive, loadProgress } from "./storage";
import type { Kind, MovieItem, SeriesItem } from "./types";
import { BackButton, Cover, Field, LangTheme, Shell, TitleLockup, Wordmark } from "./ui";
import { fetchSeriesDetails, fetchVodDetails, showAsset } from "./xtream";

const PAGE = 40;
const browseMemory = new Map<string, { q: string; page: number }>();

export function Login() {
  const app = useApp();
  const [server, setServer] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const secure = location.protocol === "https:";

  const submit = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    const code = await app.connect(server, username, password);
    setBusy(false);
    if (code) setError(code === "auth" ? app.t("errorAuth") : code === "blocked" ? app.t("errorBlocked") : code === "invalid" ? app.t("errorInvalid") : app.t("errorNetwork"));
  };

  return (
    <main data-screen class="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-6 p-4">
      <div class="flex items-center justify-between gap-3">
        <Wordmark />
        <div class="flex items-center gap-2">
          <LangTheme />
        </div>
      </div>
      <form class="flex flex-col gap-4" onSubmit={submit}>
        <Field id="server" label={app.t("server")} type="url" value={server} placeholder={app.t("serverPlaceholder")} onInput={setServer} autoFocus />
        <Field id="username" label={app.t("username")} type="text" value={username} onInput={setUsername} />
        <Field id="password" label={app.t("password")} type="password" value={password} onInput={setPassword} />
        {secure ? (
          <Field
            id="relay"
            label={app.t("relay")}
            type="url"
            value={app.prefs.relay}
            placeholder="https://name.workers.dev/?url="
            onInput={(value) => app.updatePrefs({ relay: value })}
          />
        ) : null}
        {error ? <p role="alert" class="text-accent">{error}</p> : null}
        {secure && error ? <p class="text-sm text-muted">{app.t("relayHelp")}</p> : null}
        <button type="submit" data-nav class="min-h-12 rounded-md bg-accent font-semibold text-on-accent" disabled={busy}>
          {busy ? app.t("connecting") : app.t("connect")}
        </button>
      </form>
      <p class="text-sm text-muted">{app.t("savedOnDevice")}</p>
      <button type="button" data-nav class="min-h-12 self-start rounded-md border border-line bg-surface px-4" onClick={() => go("/settings")}>
        {app.t("settings")}
      </button>
    </main>
  );
}

export function Status(props: { error?: boolean }) {
  const app = useApp();
  const message = props.error
    ? app.bootError === "auth"
      ? app.t("errorAuth")
      : app.bootError === "blocked"
        ? app.t("errorBlocked")
        : app.t("errorNetwork")
    : app.t("loadingList");
  return (
    <main data-screen class="mx-auto flex min-h-screen w-full max-w-lg flex-col justify-center gap-4 p-4">
      <Wordmark />
      <p role={props.error ? "alert" : "status"}>{message}</p>
      {props.error ? (
        <div class="flex flex-wrap gap-2">
          <button type="button" data-nav data-autofocus class="min-h-12 rounded-md bg-accent px-4 font-semibold text-on-accent" onClick={() => app.refresh()}>
            {app.t("retry")}
          </button>
          <button type="button" data-nav class="min-h-12 rounded-md border border-line px-4" onClick={() => app.signOut()}>
            {app.t("signOut")}
          </button>
        </div>
      ) : null}
    </main>
  );
}

export function Home() {
  const app = useApp();
  const catalog = app.catalog;
  if (!catalog || !app.account) return null;
  const points = loadProgress(app.account.id).filter((item) => item.position > 10 && (item.duration <= 0 || item.position / item.duration < 0.95));
  const lastEpisode = points.find((item) => item.kind === "episode");
  const resume = [...points.filter((item) => item.kind === "movie"), ...(lastEpisode ? [lastEpisode] : [])].sort((a, b) => b.updatedAt - a.updatedAt);
  const last = loadLastLive(app.account.id);
  return (
    <Shell active="home">
      <p class="text-sm text-muted">
        {app.t("updated")} {formatWhen(app.lang, catalog.fetchedAt)}
      </p>
      {app.boot === "error" ? <p role="alert" class="text-accent">{app.bootError === "blocked" ? app.t("errorBlocked") : app.t("errorNetwork")}</p> : null}
      {resume.length ? (
        <section class="flex flex-col gap-3">
          <h2 class="text-xl font-semibold">{app.t("continueWatching")}</h2>
          <div class="flex gap-3 overflow-x-auto pb-2">
            {resume.map((item) => (
              <button
                key={item.key}
                type="button"
                data-nav
                class="w-28 shrink-0 text-left sm:w-36"
                onClick={() =>
                  go(
                    item.kind === "movie"
                      ? `/watch/movie/${encodeURIComponent(item.id)}?t=${Math.floor(item.position)}`
                      : `/watch/episode/${encodeURIComponent(item.seriesId || "")}/${encodeURIComponent(item.id)}?t=${Math.floor(item.position)}`,
                  )
                }
              >
                <Cover src={item.poster} title={item.title} progress={item.duration > 0 ? (item.position / item.duration) * 100 : 0} />
                <span class="mt-2 block truncate text-sm">{item.seriesTitle || item.title}</span>
                <span class="block truncate text-sm text-muted">
                  {item.kind === "episode" && item.season && item.episode ? `${episodeCode(item.season, item.episode)} · ` : ""}
                  {formatClock(item.position)}
                </span>
              </button>
            ))}
          </div>
        </section>
      ) : null}
      {last ? (
        <button type="button" data-nav class="flex min-h-14 items-center gap-3 self-start rounded-md border border-line bg-surface px-4" onClick={() => go(`/watch/live/${encodeURIComponent(last.id)}`)}>
          {last.poster ? <img src={showAsset(last.poster)} alt="" class="h-8 w-8 object-contain" referrerPolicy="no-referrer" /> : null}
          <span class="text-sm text-muted">{app.t("lastChannel")}</span>
          <span class="font-semibold">{last.name}</span>
        </button>
      ) : null}
      <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Tile kind="live" title={app.t("live")} count={catalog.live.length} unit={app.t("channels")} path="/live" auto />
        <Tile kind="movie" title={app.t("movies")} count={catalog.movies.length} unit={app.t("titles")} path="/movies" />
        <Tile kind="series" title={app.t("series")} count={catalog.series.length} unit={app.t("titles")} path="/series" />
      </div>
    </Shell>
  );
}

function ChannelLogo(props: { src?: string; name: string }) {
  const [broken, setBroken] = useState(false);
  const src = showAsset(props.src);
  if (!src || broken) {
    return <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-surface-2 text-sm">{props.name.slice(0, 1)}</span>;
  }
  return <img src={src} alt="" class="h-10 w-10 shrink-0 object-contain" referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
}

function Tile(props: { kind: Kind; title: string; count: number; unit: string; path: string; auto?: boolean }) {
  const app = useApp();
  return (
    <button
      type="button"
      data-nav
      data-autofocus={props.auto ? true : undefined}
      class="flex min-h-32 flex-col items-start justify-between rounded-md border border-line bg-surface p-5 text-left"
      onClick={() => go(props.path)}
    >
      <span class="text-2xl font-semibold">{props.title}</span>
      <span class="tabular-nums text-muted">
        {formatCount(app.lang, props.count)} {props.unit}
      </span>
    </button>
  );
}

export function Browse(props: { kind: Kind; category: string }) {
  const app = useApp();
  const catalog = app.catalog;
  const key = `${props.kind}:${props.category}`;
  const remembered = browseMemory.get(key);
  const [q, setQ] = useState(remembered?.q || "");
  const [page, setPage] = useState(remembered?.page || 0);
  useEffect(() => {
    const saved = browseMemory.get(key);
    setQ(saved?.q || "");
    setPage(saved?.page || 0);
  }, [key]);
  useEffect(() => {
    browseMemory.set(key, { q, page });
  }, [key, q, page]);
  if (!catalog) return null;
  const categories = props.kind === "live" ? catalog.liveCategories : props.kind === "movie" ? catalog.movieCategories : catalog.seriesCategories;
  const source = props.kind === "live" ? catalog.live : props.kind === "movie" ? catalog.movies : catalog.series;
  const filtered = (() => {
    const query = q.trim().toLocaleLowerCase("tr");
    const rows = source.filter((item) => (props.category === "all" ? true : item.categoryId === props.category) && (!query || item.name.toLocaleLowerCase("tr").includes(query)));
    if (props.kind === "live") return rows;
    return [...rows].sort((a, b) => a.name.localeCompare(b.name, "tr"));
  })();
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const safePage = Math.min(page, pages - 1);
  const slice = filtered.slice(safePage * PAGE, safePage * PAGE + PAGE);
  const title = props.kind === "live" ? app.t("live") : props.kind === "movie" ? app.t("movies") : app.t("series");

  return (
    <Shell active={props.kind}>
      <div class="flex flex-wrap items-center gap-3">
        <BackButton />
        <h1 class="text-2xl font-semibold">{title}</h1>
        <label class="ml-auto flex min-w-48 flex-1 items-center gap-2">
          <span class="sr-only">{app.t("search")}</span>
          <input
            data-nav
            class="min-h-12 w-full rounded-md border border-line bg-surface px-3"
            placeholder={app.t("searchPlaceholder")}
            value={q}
            onInput={(event) => {
              setQ((event.currentTarget as HTMLInputElement).value);
              setPage(0);
            }}
          />
        </label>
      </div>
      <div class="flex gap-2 overflow-x-auto pb-1">
        <Chip label={app.t("all")} active={props.category === "all"} onClick={() => go(browsePath(props.kind, "all"))} />
        {categories.map((category) => (
          <Chip key={category.id} label={category.name} active={props.category === category.id} onClick={() => go(browsePath(props.kind, category.id))} />
        ))}
      </div>
      {slice.length === 0 ? <p class="text-muted">{app.t("empty")}</p> : null}
      {props.kind === "live" ? (
        <div class="flex flex-col gap-2">
          {slice.map((item, index) => (
            <button
              key={item.id}
              type="button"
              data-nav
              data-page-item={index === 0 ? true : undefined}
              class="flex min-h-14 items-center gap-3 rounded-md bg-surface px-3 text-left"
              onClick={() => go(`/watch/live/${encodeURIComponent(item.id)}`)}
            >
              <ChannelLogo src={item.poster} name={item.name} />
              {"number" in item && item.number ? <span class="w-10 tabular-nums text-muted">{item.number}</span> : null}
              <span class="truncate">{item.name}</span>
            </button>
          ))}
        </div>
      ) : (
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {slice.map((item, index) => (
            <button
              key={item.id}
              type="button"
              data-nav
              data-page-item={index === 0 ? true : undefined}
              class="text-left"
              onClick={() => go(props.kind === "movie" ? `/movie/${encodeURIComponent(item.id)}` : `/show/${encodeURIComponent(item.id)}`)}
            >
              <Cover src={item.poster} title={item.name} />
              <span class="mt-2 block text-sm leading-snug">{item.name}</span>
            </button>
          ))}
        </div>
      )}
      {pages > 1 ? (
        <div class="flex items-center gap-3">
          <button type="button" data-nav class="min-h-12 rounded-md border border-line px-4" disabled={safePage === 0} onClick={() => turn(setPage, safePage - 1)}>
            {app.t("prev")}
          </button>
          <span class="tabular-nums text-muted">
            {app.t("page")} {safePage + 1} / {pages}
          </span>
          <button type="button" data-nav class="min-h-12 rounded-md border border-line px-4" disabled={safePage >= pages - 1} onClick={() => turn(setPage, safePage + 1)}>
            {app.t("next")}
          </button>
        </div>
      ) : null}
    </Shell>
  );
}

function Chip(props: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" data-nav class={`min-h-12 shrink-0 rounded-full px-4 ${props.active ? "bg-accent font-semibold text-on-accent" : "border border-line bg-surface"}`} onClick={props.onClick}>
      {props.label}
    </button>
  );
}

function turn(setPage: (value: number) => void, next: number) {
  setPage(next);
  requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-page-item]")?.focus());
}

export function MoviePage(props: { id: string }) {
  const app = useApp();
  const item = app.catalog?.movies.find((movie) => movie.id === props.id);
  const [extra, setExtra] = useState<Awaited<ReturnType<typeof fetchVodDetails>> | null>(null);
  useEffect(() => {
    if (!app.account) return;
    let cancel = false;
    setExtra(null);
    fetchVodDetails(app.account, props.id).then((details) => {
      if (!cancel) setExtra(details);
    }).catch(() => undefined);
    return () => {
      cancel = true;
    };
  }, [app.account, props.id]);
  if (!item || !app.account) return <Shell><p>{app.t("missing")}</p></Shell>;
  return <TitlePage item={item} extra={extra} accountId={app.account.id} kind="movie" />;
}

export function ShowPage(props: { id: string }) {
  const app = useApp();
  const item = app.catalog?.series.find((show) => show.id === props.id);
  const [details, setDetails] = useState<Awaited<ReturnType<typeof fetchSeriesDetails>> | null>(null);
  const [failed, setFailed] = useState(false);
  const saved = app.account ? loadProgress(app.account.id).find((point) => point.seriesId === props.id) : undefined;
  const [season, setSeason] = useState(saved?.season || 0);
  useEffect(() => {
    if (!app.account) return;
    let cancel = false;
    setFailed(false);
    setDetails(null);
    fetchSeriesDetails(app.account, props.id)
      .then((value) => {
        if (cancel) return;
        setDetails(value);
        setSeason((current) => current || value.episodes[0]?.season || 1);
      })
      .catch(() => {
        if (!cancel) setFailed(true);
      });
    return () => {
      cancel = true;
    };
  }, [app.account, props.id]);
  if (!item) return <Shell><p>{app.t("missing")}</p></Shell>;
  const seasons = [...new Set((details?.episodes || []).map((episode) => episode.season))];
  const visible = (details?.episodes || []).filter((episode) => episode.season === (season || seasons[0]));
  return (
    <Shell active="series">
      <BackButton />
      <div class="flex flex-col gap-5 md:flex-row">
        <div class="w-40 shrink-0 md:w-56">
          <Cover src={details?.poster || item.poster} title={item.name} />
        </div>
        <div class="flex min-w-0 flex-col gap-3">
          <TitleLockup src={details?.logo || item.logo} title={item.name} />
          <p class="text-sm text-muted">{[details?.year || item.year, details?.genre || item.genre, details?.rating || item.rating].filter(Boolean).join(" · ")}</p>
          <p class="max-w-3xl text-pretty">{details?.plot || item.plot}</p>
          {details?.cast ? <p class="text-sm text-muted">{app.t("cast")}: {details.cast}</p> : null}
        </div>
      </div>
      {failed ? <p class="text-accent">{app.t("errorNetwork")}</p> : null}
      {!details && !failed ? <p>{app.t("loadingList")}</p> : null}
      {seasons.length ? (
        <div class="flex gap-2 overflow-x-auto">
          {seasons.map((value) => (
            <Chip key={value} label={`${app.t("season")} ${value}`} active={(season || seasons[0]) === value} onClick={() => setSeason(value)} />
          ))}
        </div>
      ) : null}
      <div class="flex flex-col gap-2">
        {visible.map((episode) => {
          const point = app.account ? getProgress(app.account.id, "episode", episode.id) : null;
          const ratio = point && point.duration > 0 ? (point.position / point.duration) * 100 : 0;
          return (
            <button
              key={episode.id}
              type="button"
              data-nav
              class="flex min-h-16 items-center gap-3 rounded-md bg-surface px-3 text-left"
              onClick={() => go(`/watch/episode/${encodeURIComponent(props.id)}/${encodeURIComponent(episode.id)}${point && point.position > 15 ? `?t=${Math.floor(point.position)}` : ""}`)}
            >
              <span class="w-20 shrink-0 tabular-nums text-muted">{episodeCode(episode.season, episode.episode)}</span>
              <span class="min-w-0 flex-1">
                <span class="block truncate">{episode.title}</span>
                {point ? <span class="mt-1 block h-1 overflow-hidden rounded-full bg-line"><span class="block h-full bg-accent" style={{ width: `${Math.min(100, ratio)}%` }} /></span> : null}
              </span>
              {episode.duration ? <span class="tabular-nums text-sm text-muted">{formatClock(episode.duration)}</span> : null}
            </button>
          );
        })}
      </div>
    </Shell>
  );
}

function TitlePage(props: {
  item: MovieItem | SeriesItem;
  extra: Awaited<ReturnType<typeof fetchVodDetails>> | null;
  accountId: string;
  kind: "movie";
}) {
  const app = useApp();
  const point = getProgress(props.accountId, "movie", props.item.id);
  const canResume = Boolean(point && point.position > 15 && (point.duration <= 0 || point.position / point.duration < 0.95));
  const poster = props.extra?.poster || props.item.poster;
  const logo = props.extra?.logo || props.item.logo;
  const plot = props.extra?.plot || props.item.plot;
  return (
    <Shell active="movie">
      <BackButton />
      <div class="flex flex-col gap-5 md:flex-row">
        <div class="w-40 shrink-0 md:w-56">
          <Cover src={poster} title={props.item.name} progress={point && point.duration > 0 ? (point.position / point.duration) * 100 : 0} />
        </div>
        <div class="flex min-w-0 flex-col gap-3">
          <TitleLockup src={logo} title={props.extra?.name || props.item.name} />
          <p class="text-sm text-muted">{[props.extra?.year, props.extra?.genre, props.extra?.duration || props.extra?.rating || ("rating" in props.item ? props.item.rating : "")].filter(Boolean).join(" · ")}</p>
          <div class="flex flex-wrap gap-2">
            {canResume && point ? (
              <button type="button" data-nav data-autofocus class="min-h-12 rounded-md bg-accent px-4 font-semibold text-on-accent" onClick={() => go(`/watch/movie/${encodeURIComponent(props.item.id)}?t=${Math.floor(point.position)}`)}>
                {app.t("resume")} · {formatClock(point.position)}
              </button>
            ) : null}
            <button type="button" data-nav data-autofocus={canResume ? undefined : true} class={`min-h-12 rounded-md px-4 font-semibold ${canResume ? "border border-line" : "bg-accent text-on-accent"}`} onClick={() => go(`/watch/movie/${encodeURIComponent(props.item.id)}?t=0`)}>
              {canResume ? app.t("fromStart") : app.t("play")}
            </button>
          </div>
          {plot ? <p class="max-w-3xl text-pretty">{plot}</p> : null}
          {props.extra?.director ? <p class="text-sm text-muted">{app.t("director")}: {props.extra.director}</p> : null}
          {props.extra?.cast ? <p class="text-sm text-muted">{app.t("cast")}: {props.extra.cast}</p> : null}
        </div>
      </div>
    </Shell>
  );
}

export function Settings() {
  const app = useApp();
  const [sureOut, setSureOut] = useState(false);
  const [sureClear, setSureClear] = useState(false);
  return (
    <Shell active="settings">
      <BackButton />
      <h1 class="text-2xl font-semibold">{app.t("settings")}</h1>
      {app.account ? (
        <section class="flex flex-col gap-2 rounded-md border border-line bg-surface p-4">
          <h2 class="font-semibold">{app.t("account")}</h2>
          <p class="break-all">{app.account.base}</p>
          <p class="text-muted">{app.account.username}</p>
          <p class="text-sm text-muted">{app.t("savedOnDevice")}</p>
          <button
            type="button"
            data-nav
            class="min-h-12 self-start rounded-md border border-line px-4"
            onClick={() => {
              if (!sureOut) {
                setSureOut(true);
                return;
              }
              app.signOut();
            }}
          >
            {sureOut ? app.t("signOutSure") : app.t("signOut")}
          </button>
        </section>
      ) : null}
      <section class="flex max-w-2xl flex-col gap-3">
        <label class="flex flex-col gap-2">
          <span>{app.t("relay")}</span>
          <input
            data-nav
            class="min-h-12 rounded-md border border-line bg-surface px-3"
            value={app.prefs.relay}
            spellcheck={false}
            autocapitalize="off"
            onInput={(event) => app.updatePrefs({ relay: (event.currentTarget as HTMLInputElement).value })}
          />
        </label>
        <p class="text-sm text-muted">{app.t("relayHelp")}</p>
        <button type="button" data-nav aria-pressed={app.prefs.forceRelay} class={`min-h-12 self-start rounded-md px-4 ${app.prefs.forceRelay ? "bg-accent font-semibold text-on-accent" : "border border-line"}`} onClick={() => app.updatePrefs({ forceRelay: !app.prefs.forceRelay })}>
          {app.t("forceRelay")}
        </button>
        <button
          type="button"
          data-nav
          class="min-h-12 self-start rounded-md border border-line px-4"
          onClick={() => {
            if (!sureClear) {
              setSureClear(true);
              return;
            }
            app.clearWatching();
            setSureClear(false);
          }}
        >
          {sureClear ? app.t("clearSure") : app.t("clearProgress")}
        </button>
      </section>
      <section class="flex max-w-2xl flex-col gap-2">
        <h2 class="font-semibold">{app.t("worker")}</h2>
        <p class="text-sm text-muted">{app.t("workerHelp")}</p>
        <textarea data-nav readOnly rows={8} class="w-full rounded-md border border-line bg-surface p-3 font-mono text-sm" value={WORKER} />
      </section>
    </Shell>
  );
}
