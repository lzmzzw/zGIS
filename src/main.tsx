import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "ol/ol.css";
import "./styles.css";
import { isMacOS } from "./platform";
document.documentElement.dataset.platform = isMacOS ? "macos" : "other";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
