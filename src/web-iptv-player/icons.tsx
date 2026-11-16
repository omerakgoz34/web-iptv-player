/** @jsxImportSource preact */
import type { ComponentChildren } from "preact";

function Svg(props: { children: ComponentChildren; large?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      class={props.large ? "h-7 w-7" : "h-5 w-5"}
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {props.children}
    </svg>
  );
}

export function IconBack() {
  return (
    <Svg>
      <path d="M15 18 9 12l6-6" />
    </Svg>
  );
}

export function IconRefresh() {
  return (
    <Svg>
      <path d="M21 12a9 9 0 1 1-2.6-6.3" />
      <path d="M21 3v6h-6" />
    </Svg>
  );
}

export function IconSun() {
  return (
    <Svg>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </Svg>
  );
}

export function IconMoon() {
  return (
    <Svg>
      <path d="M21 14.5A8.5 8.5 0 1 1 9.5 3 7 7 0 0 0 21 14.5z" />
    </Svg>
  );
}

export function IconPlay(props: { large?: boolean }) {
  return (
    <Svg large={props.large}>
      <path d="M8 5v14l11-7z" />
    </Svg>
  );
}

export function IconPause(props: { large?: boolean }) {
  return (
    <Svg large={props.large}>
      <path d="M9 5v14M15 5v14" />
    </Svg>
  );
}

export function IconBack10() {
  return (
    <svg viewBox="0 0 24 24" class="h-8 w-8" aria-hidden="true">
      <path d="M16.6 6.1A7.5 7.5 0 1 0 18.8 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
      <path d="M16.5 3.2v4.1h-4.1" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M9.15 10.5v4.7" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" />
      <ellipse cx="13.55" cy="12.85" rx="1.85" ry="2.4" fill="none" stroke="currentColor" stroke-width="1.55" />
    </svg>
  );
}

export function IconFwd10() {
  return (
    <svg viewBox="0 0 24 24" class="h-8 w-8" aria-hidden="true">
      <path d="M7.4 6.1A7.5 7.5 0 1 1 5.2 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
      <path d="M7.5 3.2v4.1h4.1" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M9.15 10.5v4.7" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" />
      <ellipse cx="13.55" cy="12.85" rx="1.85" ry="2.4" fill="none" stroke="currentColor" stroke-width="1.55" />
    </svg>
  );
}

export function IconAudio(props: { large?: boolean }) {
  return (
    <Svg large={props.large}>
      <path d="M4 10v4h3l4 3V7L7 10H4z" />
      <path d="M16 9.5a3.5 3.5 0 0 1 0 5" />
      <path d="M18.5 7a7 7 0 0 1 0 10" />
    </Svg>
  );
}

export function IconSubs(props: { large?: boolean }) {
  return (
    <Svg large={props.large}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M7 15h3M12 15h5" />
    </Svg>
  );
}
