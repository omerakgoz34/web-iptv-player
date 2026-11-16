/** @jsxImportSource preact */
import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type { MessageKey } from "./i18n";
import type { Account, Catalog, Fail, Lang, Prefs } from "./types";

export type Model = {
  lang: Lang;
  t: (key: MessageKey) => string;
  prefs: Prefs;
  updatePrefs: (patch: Partial<Prefs>) => void;
  account: Account | null;
  catalog: Catalog | null;
  boot: "ready" | "loading" | "error";
  bootError: Fail | "";
  refresh: () => void;
  connect: (server: string, username: string, password: string) => Promise<Fail | "">;
  signOut: () => void;
  clearWatching: () => void;
  progressTick: number;
};

export const AppContext = createContext<Model | null>(null);

export function useApp(): Model {
  const model = useContext(AppContext);
  if (!model) throw new Error("missing app");
  return model;
}
