/** @jsxImportSource preact */
import { render } from "preact";
import { App } from "./perde/app";
import { installKeys } from "./perde/focus";
import "./styles.css";

const root = document.getElementById("app");
if (root) render(<App />, root);

installKeys();
