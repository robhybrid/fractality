import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if (import.meta.hot) {
  import.meta.hot.on("vite:beforeUpdate", (payload) => {
    const changed = payload.updates?.some((update) => /\/src\/engine\//.test(update.path || ""));
    if (changed) location.reload();
  });
}
