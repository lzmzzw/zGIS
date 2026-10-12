import React from "react";
import { createRoot } from "react-dom/client";
import WebApp from "./WebApp";
import "ol/ol.css";
import "../styles.css";
import "./web.css";

document.documentElement.dataset.theme = "light";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WebApp />
  </React.StrictMode>,
);
