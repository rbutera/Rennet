import { createRoot } from "react-dom/client";
import "../../../packages/theme/src/palette.css";
import "./app.css";
import { App } from "./app.jsx";

createRoot(document.getElementById("root")).render(<App />);
