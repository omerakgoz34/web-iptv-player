/** @jsxImportSource preact */
import type { ComponentChildren } from "preact";

function Svg(props: { children: ComponentChildren }) {
  return (
    <svg
      viewBox="0 0 24 24"
      class="h-5 w-5"
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

export function IconPlay() {
  return (
    <Svg>
      <path d="M8 5v14l11-7z" />
    </Svg>
  );
}

export function IconPause() {
  return (
    <Svg>
      <path d="M9 5v14M15 5v14" />
    </Svg>
  );
}
