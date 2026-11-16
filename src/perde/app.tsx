/** @jsxImportSource preact */
import { useEffect, useMemo, useState } from "preact/hooks";
import { AppContext, type Model } from "./context";
import { focusScreen } from "./focus";
import { parseHash, go } from "./hash";
import { translate } from "./i18n";
import { Player } from "./player";
import { Browse, Home, Login, MoviePage, Settings, ShowPage, Status } from "./screens";
import {
  clearAccount,
  clearProgress,
  loadAccount,
  loadCatalog,
  loadPrefs,
  saveAccount,
  saveCatalog,
  savePrefs,
} from "./storage";
import type { Account, Catalog, Fail, Prefs } from "./types";
import { fetchCatalog, IptvError, parseLogin, preferHttps, resetTransport, resolvePlay } from "./xtream";
import type { PlayRequest } from "./types";

export function App() {
  const [hash, setHash] = useState(() => location.hash || "#/");
  const [account, setAccount] = useState<Account | null>(() => loadAccount());
  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs());
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [boot, setBoot] = useState<Model["boot"]>(account ? "loading" : "ready");
  const [bootError, setBootError] = useState<Fail | "">("");
  const [progressTick, setProgressTick] = useState(0);
  const [play, setPlay] = useState<PlayRequest | null>(null);
  const [playError, setPlayError] = useState("");

  useEffect(() => {
    const onHash = () => setHash(location.hash || "#/");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    savePrefs(prefs);
  }, [prefs]);

  useEffect(() => {
    if (!account) return;
    let cancel = false;
    setBoot("loading");
    loadCatalog(account.id)
      .then(async (cached) => {
        if (cancel) return;
        if (cached) {
          setCatalog(cached);
          setBoot("ready");
          return;
        }
        const next = await fetchCatalog(account);
        if (cancel) return;
        await saveCatalog(account.id, next);
        setCatalog(next);
        setBoot("ready");
        setBootError("");
      })
      .catch((error: unknown) => {
        if (cancel) return;
        setBoot("error");
        setBootError(error instanceof IptvError ? error.code : "network");
      });
    return () => {
      cancel = true;
    };
  }, [account?.id]);

  const route = parseHash(hash);
  useEffect(() => {
    if (!account && route.name !== "login" && route.name !== "settings") go("/login");
  }, [account, hash, route.name]);

  useEffect(() => {
    if (route.name !== "watch" || !account || !catalog) {
      setPlay(null);
      return;
    }
    let cancel = false;
    setPlay(null);
    setPlayError("");
    resolvePlay(account, route, catalog)
      .then((value) => {
        if (!cancel) setPlay(value);
      })
      .catch(() => {
        if (!cancel) setPlayError("missing");
      });
    return () => {
      cancel = true;
    };
  }, [hash, account, catalog]);

  useEffect(() => {
    if (route.name === "watch" && play) return;
    focusScreen();
  }, [hash, boot, play, route.name]);

  const model = useMemo<Model>(() => {
    return {
      lang: prefs.lang,
      t: (key) => translate(prefs.lang, key),
      prefs,
      updatePrefs: (patch) => {
        const next = { ...prefs, ...patch };
        savePrefs(next);
        setPrefs(next);
      },
      account,
      catalog,
      boot,
      bootError,
      progressTick,
      refresh: () => {
        if (!account) return;
        setBoot("loading");
        fetchCatalog(account)
          .then(async (next) => {
            await saveCatalog(account.id, next);
            setCatalog(next);
            setBoot("ready");
            setBootError("");
          })
          .catch((error: unknown) => {
            setBoot(catalog ? "ready" : "error");
            setBootError(error instanceof IptvError ? error.code : "network");
          });
      },
      connect: async (server, username, password) => {
        try {
          const parsed = parseLogin({ server, username, password });
          const nextAccount = await preferHttps(parsed);
          resetTransport();
          const next = await fetchCatalog(nextAccount);
          saveAccount(nextAccount);
          await saveCatalog(nextAccount.id, next);
          setAccount(nextAccount);
          setCatalog(next);
          setBoot("ready");
          setBootError("");
          go("/");
          return "";
        } catch (error) {
          resetTransport();
          return error instanceof IptvError ? error.code : "network";
        }
      },
      signOut: () => {
        clearAccount();
        resetTransport();
        setAccount(null);
        setCatalog(null);
        setBoot("ready");
        go("/login");
      },
      clearWatching: () => {
        if (account) clearProgress(account.id);
        setProgressTick((value) => value + 1);
      },
    };
  }, [prefs, account, catalog, boot, bootError, progressTick]);

  let body;
  if (!account && route.name !== "settings") body = <Login />;
  else if (account && !catalog && boot === "loading") body = <Status />;
  else if (account && !catalog && boot === "error") body = <Status error />;
  else if (route.name === "settings") body = <Settings />;
  else if (route.name === "browse") body = <Browse kind={route.kind} category={route.category} />;
  else if (route.name === "movie") body = <MoviePage id={route.id} />;
  else if (route.name === "show") body = <ShowPage id={route.id} />;
  else if (route.name === "watch") {
    body = play ? (
      <Player request={play} />
    ) : (
      <Status error={Boolean(playError)} />
    );
  } else body = <Home />;

  return <AppContext.Provider value={model}>{body}</AppContext.Provider>;
}
