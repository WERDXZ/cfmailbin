import { render } from "preact";
import { App } from "./App.tsx";
import { LocaleProvider } from "./i18n.tsx";
import "./styles.css";

const root = document.getElementById("app");

if (!root) {
  throw new Error("Missing #app root");
}

render(
  <LocaleProvider>
    <App />
  </LocaleProvider>,
  root,
);
