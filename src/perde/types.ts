export type Lang = "tr" | "en";
export type Theme = "dark" | "light";
export type Kind = "live" | "movie" | "series";

export type Account = {
  id: string;
  base: string;
  username: string;
  password: string;
};

export type Prefs = {
  lang: Lang;
  theme: Theme;
  relay: string;
  forceRelay: boolean;
};

export type Category = {
  id: string;
  name: string;
};

export type LiveItem = {
  id: string;
  name: string;
  poster: string;
  categoryId: string;
  number: number;
};

export type MovieItem = {
  id: string;
  name: string;
  poster: string;
  logo: string;
  categoryId: string;
  ext: string;
  rating: string;
  plot: string;
  direct: string;
  added: string;
};

export type SeriesItem = {
  id: string;
  name: string;
  poster: string;
  logo: string;
  categoryId: string;
  plot: string;
  rating: string;
  genre: string;
  year: string;
  backdrop: string;
};

export type Catalog = {
  fetchedAt: number;
  liveCategories: Category[];
  live: LiveItem[];
  movieCategories: Category[];
  movies: MovieItem[];
  seriesCategories: Category[];
  series: SeriesItem[];
};

export type VodDetails = {
  name: string;
  plot: string;
  poster: string;
  logo: string;
  backdrop: string;
  genre: string;
  year: string;
  rating: string;
  duration: string;
  director: string;
  cast: string;
  ext: string;
};

export type Episode = {
  id: string;
  season: number;
  episode: number;
  title: string;
  plot: string;
  poster: string;
  ext: string;
  duration: number;
};

export type SeriesDetails = {
  name: string;
  plot: string;
  poster: string;
  logo: string;
  backdrop: string;
  genre: string;
  year: string;
  rating: string;
  cast: string;
  director: string;
  episodes: Episode[];
};

export type WatchPoint = {
  key: string;
  kind: "movie" | "episode";
  id: string;
  seriesId?: string;
  season?: number;
  episode?: number;
  title: string;
  seriesTitle?: string;
  poster?: string;
  logo?: string;
  position: number;
  duration: number;
  updatedAt: number;
};

export type LastLive = {
  id: string;
  name: string;
  poster: string;
  updatedAt: number;
};

export type Route =
  | { name: "home" }
  | { name: "login" }
  | { name: "settings" }
  | { name: "browse"; kind: Kind; category: string }
  | { name: "movie"; id: string }
  | { name: "show"; id: string }
  | {
      name: "watch";
      kind: "live" | "movie" | "episode";
      id: string;
      seriesId?: string;
      startAt?: number;
    };

export type PlayRequest = {
  kind: "live" | "movie" | "episode";
  id: string;
  title: string;
  subtitle?: string;
  poster?: string;
  logo?: string;
  hlsUrl: string;
  fileUrl?: string;
  startAt?: number;
  seriesId?: string;
  season?: number;
  episode?: number;
  nextPath?: string;
};

export type Fail = "auth" | "blocked" | "network" | "invalid";
