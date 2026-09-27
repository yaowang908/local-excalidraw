import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PanelsTopLeft } from "lucide-react";
import { writeFile } from "node:fs/promises";

// Lucide's ISC-licensed icon supplies the app's workspace symbol.
const icon = renderToStaticMarkup(
  createElement(PanelsTopLeft, {
    width: 512,
    height: 512,
    color: "#315f80",
    strokeWidth: 1.25,
    fill: "#f5f5f6",
  }),
);
await writeFile(new URL("../app-icon.svg", import.meta.url), icon);
