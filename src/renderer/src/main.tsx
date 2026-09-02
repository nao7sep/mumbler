import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./app/App";
import { denyUnhandledExternalDrop } from "./app/external-drop-boundary";
import "./styles.css";
import { RendererErrorBoundary } from "./app/RendererErrorBoundary";

window.addEventListener("dragover", denyUnhandledExternalDrop);
window.addEventListener("drop", denyUnhandledExternalDrop);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RendererErrorBoundary><App /></RendererErrorBoundary>
  </React.StrictMode>,
);
