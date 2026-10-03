import { createRoot } from "react-dom/client";
import "@excalidraw/excalidraw/index.css";
import "./styles.css";
import { App } from "./App";
import { Viewer } from "./Viewer";

window.EXCALIDRAW_ASSET_PATH = `${window.location.origin}${window.location.pathname.startsWith("/view/") ? window.location.pathname : "/"}excalidraw-assets/`;
const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
createRoot(root).render(window.location.pathname.startsWith("/view/") ? <Viewer /> : <App />);
