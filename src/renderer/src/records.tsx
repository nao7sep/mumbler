import React from "react";
import ReactDOM from "react-dom/client";

import { denyUnhandledExternalDrop } from "./app/external-drop-boundary";
import { RendererErrorBoundary } from "./app/RendererErrorBoundary";
import { RecordsApp } from "./records/RecordsWindow";
import "./styles.css";

window.addEventListener("dragover", denyUnhandledExternalDrop);
window.addEventListener("drop", denyUnhandledExternalDrop);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RendererErrorBoundary><RecordsApp /></RendererErrorBoundary>
  </React.StrictMode>,
);
