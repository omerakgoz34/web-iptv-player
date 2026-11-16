/** @jsxImportSource preact */
import { render } from "preact";
import { App } from "./web-iptv-player/app";
import { installKeys } from "./web-iptv-player/focus";
import "./styles.css";

const root = document.getElementById("app");
if (root) render(<App />, root);

installKeys();
