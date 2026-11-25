import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../styles/fonts";
import "../index.css";
import "../i18n";
import QuickNote from "./QuickNote";

const root = document.getElementById("root");
if (!root) {
  throw new Error("#root element missing in quicknote.html");
}

createRoot(root).render(
  <StrictMode>
    <QuickNote />
  </StrictMode>,
);
