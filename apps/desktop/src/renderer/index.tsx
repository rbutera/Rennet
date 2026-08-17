import { RennetApp } from "@rennet/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

const root = document.getElementById("root");
if (!root) throw new Error("Renderer root is missing");

// Expose the host platform to CSS so chrome can gate macOS-only insets (the
// titlebar traffic-light reservation) instead of leaking them onto Windows.
if (window.rennet.platform) {
  document.documentElement.dataset.platform = window.rennet.platform;
}

createRoot(root).render(
  <StrictMode>
    <RennetApp bridge={window.rennet} />
  </StrictMode>,
);
