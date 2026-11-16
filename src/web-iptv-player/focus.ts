import { back } from "./hash";

const BACK_KEYS = new Set(["Escape", "BrowserBack", "GoBack", "XF86Back"]);

export function installKeys(): () => void {
  const onKey = (event: KeyboardEvent) => {
    if (isBack(event)) {
      const target = event.target;
      if (target instanceof HTMLInputElement && event.key === "Backspace") return;
      event.preventDefault();
      back();
      return;
    }
    const dir = direction(event.key);
    if (!dir) return;
    const target = event.target;
    if (target instanceof HTMLInputElement) {
      const type = target.type;
      if ((type === "text" || type === "password" || type === "url" || type === "search" || type === "range") && (dir === "left" || dir === "right")) {
        return;
      }
    }
    if (target instanceof HTMLTextAreaElement && (dir === "left" || dir === "right")) return;
    const player = document.querySelector("[data-player]");
    const selector = player ? "[data-player] [data-nav]" : "[data-nav]";
    event.preventDefault();
    move(dir, selector);
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}

export function focusScreen(): void {
  requestAnimationFrame(() => {
    const screen = document.querySelector("[data-screen]");
    const target =
      screen?.querySelector<HTMLElement>("[data-autofocus]") ||
      screen?.querySelector<HTMLElement>("[data-nav]");
    target?.focus();
  });
}

function isBack(event: KeyboardEvent): boolean {
  return BACK_KEYS.has(event.key) || event.keyCode === 461 || event.keyCode === 10009;
}

function direction(key: string): "up" | "down" | "left" | "right" | null {
  if (key === "ArrowUp") return "up";
  if (key === "ArrowDown") return "down";
  if (key === "ArrowLeft") return "left";
  if (key === "ArrowRight") return "right";
  return null;
}

function move(dir: "up" | "down" | "left" | "right", selector: string): void {
  const nodes = [...document.querySelectorAll<HTMLElement>(selector)].filter(isEnabled);
  if (!nodes.length) return;
  const current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (!current || !nodes.includes(current)) {
    nodes[0].focus();
    nodes[0].scrollIntoView({ block: "nearest", inline: "nearest" });
    return;
  }
  const origin = center(current);
  let best: HTMLElement | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const node of nodes) {
    if (node === current) continue;
    const point = center(node);
    const dx = point.x - origin.x;
    const dy = point.y - origin.y;
    if (dir === "right" && dx < 8) continue;
    if (dir === "left" && dx > -8) continue;
    if (dir === "down" && dy < 8) continue;
    if (dir === "up" && dy > -8) continue;
    const primary = dir === "left" || dir === "right" ? Math.abs(dx) : Math.abs(dy);
    const secondary = dir === "left" || dir === "right" ? Math.abs(dy) : Math.abs(dx);
    const score = primary + secondary * 2.4;
    if (score < bestScore) {
      best = node;
      bestScore = score;
    }
  }
  if (!best) return;
  best.focus();
  best.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function isEnabled(element: HTMLElement): boolean {
  if (element.getAttribute("aria-disabled") === "true") return false;
  if (element instanceof HTMLButtonElement && element.disabled) return false;
  if (element instanceof HTMLInputElement && element.disabled) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function center(element: HTMLElement): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}
