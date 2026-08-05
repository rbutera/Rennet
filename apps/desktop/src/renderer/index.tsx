import { RennetApp } from "@rennet/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

const root = document.getElementById("root");
if (!root) throw new Error("Renderer root is missing");

createRoot(root).render(
  <StrictMode>
    <RennetApp bridge={window.rennet} />
  </StrictMode>,
);
