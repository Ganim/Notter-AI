import { Buffer } from "buffer";
// gray-matter (M4 import/export codec) reaches for Node's Buffer; the Tauri
// webview has none. Install it on the global before any module that touches
// gray-matter loads.
if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = Buffer;
}

import React from "react";
import ReactDOM from "react-dom/client";
import './i18n';
import App from "./App";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
