/** @jsxImportSource preact */
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { useApp } from "./context";
import { back, go } from "./hash";
import { IconBack, IconMoon, IconRefresh, IconSun } from "./icons";
import type { Kind } from "./types";
import { APP_NAME, VERSION } from "./version";
import { showAsset } from "./xtream";

export function Cover(props: { src?: string; title: string; progress?: number }) {
  const [broken, setBroken] = useState(false);
  const src = showAsset(props.src) && !broken ? showAsset(props.src) : "";
  return (
    <div class="relative aspect-[2/3] overflow-hidden rounded-md bg-surface-2">
      {src ? (
        <img
          src={src}
          alt={props.title}
          class="h-full w-full object-cover"
          referrerPolicy="no-referrer"
          onError={() => setBroken(true)}
        />
      ) : (
        <div class="flex h-full items-end p-3">
          <span class="text-sm font-semibold leading-snug text-fg">{props.title}</span>
        </div>
      )}
      {props.progress && props.progress > 0 ? (
        <div class="absolute inset-x-0 bottom-0 h-1 bg-line">
          <div class="h-full bg-accent" style={{ width: `${Math.min(100, Math.max(0, props.progress))}%` }} />
        </div>
      ) : null}
    </div>
  );
}

export function TitleLockup(props: { src?: string; title: string }) {
  const [broken, setBroken] = useState(false);
  if (showAsset(props.src) && !broken) {
    return (
      <img
        src={showAsset(props.src)}
        alt={props.title}
        class="block max-h-22 max-w-[min(100%,28rem)] object-contain object-left"
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
      />
    );
  }
  return <h1 class="text-balance text-3xl font-semibold leading-tight text-fg md:text-4xl">{props.title}</h1>;
}

export function Wordmark() {
  return (
    <span class="flex items-center gap-2 text-lg font-semibold tracking-wide">
      <span class="inline-block h-3 w-3 shrink-0 bg-accent" />
      <span class="flex flex-col items-start leading-tight">
        <span>{APP_NAME}</span>
        <span class="text-xs font-normal text-muted">{VERSION}</span>
      </span>
    </span>
  );
}

export function Shell(props: { children: ComponentChildren; active?: "home" | Kind | "settings" }) {
  const app = useApp();
  return (
    <div data-screen class="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-5 p-4 md:p-8">
      <header class="flex flex-wrap items-center gap-2 border-b border-line pb-4">
        <button type="button" data-nav class="mr-auto flex min-h-12 items-center pr-2 text-left" onClick={() => go("/")}>
          <Wordmark />
        </button>
        <LangTheme />
        {props.active === "home" ? (
          <button type="button" data-nav class="flex min-h-12 items-center gap-2 rounded-md bg-accent px-4 font-semibold text-on-accent" onClick={() => app.refresh()} disabled={app.boot === "loading"}>
            <IconRefresh />
            {app.boot === "loading" ? app.t("refreshing") : app.t("refresh")}
          </button>
        ) : null}
        <button type="button" data-nav class="min-h-12 rounded-md border border-line bg-surface px-4" onClick={() => go("/settings")}>
          {app.t("settings")}
        </button>
      </header>
      {props.children}
    </div>
  );
}

export function LangTheme() {
  const app = useApp();
  const langClass = (active: boolean) =>
    `min-h-12 min-w-12 rounded-md px-3 ${active ? "bg-accent font-semibold text-on-accent" : "border border-line bg-surface text-fg"}`;
  return (
    <>
      <button type="button" data-nav class={langClass(app.lang === "tr")} aria-pressed={app.lang === "tr"} onClick={() => app.updatePrefs({ lang: "tr" })}>
        TR
      </button>
      <button type="button" data-nav class={langClass(app.lang === "en")} aria-pressed={app.lang === "en"} onClick={() => app.updatePrefs({ lang: "en" })}>
        EN
      </button>
      <button
        type="button"
        data-nav
        class="flex min-h-12 min-w-12 items-center justify-center rounded-md border border-line bg-surface px-3"
        aria-label={app.t("theme")}
        onClick={() => app.updatePrefs({ theme: app.prefs.theme === "dark" ? "light" : "dark" })}
      >
        {app.prefs.theme === "dark" ? <IconSun /> : <IconMoon />}
      </button>
    </>
  );
}

export function BackButton() {
  const app = useApp();
  return (
    <button type="button" data-nav class="flex min-h-12 items-center gap-2 rounded-md border border-line bg-surface px-3" onClick={() => back()}>
      <IconBack />
      {app.t("back")}
    </button>
  );
}

export function Field(props: {
  id: string;
  label: string;
  type: "text" | "password" | "url";
  value: string;
  placeholder?: string;
  onInput: (value: string) => void;
  autoFocus?: boolean;
}) {
  return (
    <label class="flex flex-col gap-2" for={props.id}>
      <span class="text-sm text-muted">{props.label}</span>
      <input
        id={props.id}
        data-nav
        data-autofocus={props.autoFocus ? true : undefined}
        class="min-h-12 rounded-md border border-line bg-surface px-3 text-fg"
        type={props.type as "text"}
        value={props.value}
        placeholder={props.placeholder}
        autocomplete={props.type === "password" ? "current-password" : "on"}
        autocapitalize="off"
        autocorrect="off"
        spellcheck={false}
        onInput={(event) => props.onInput((event.currentTarget as HTMLInputElement).value)}
      />
    </label>
  );
}
