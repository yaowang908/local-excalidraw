import { Component, useMemo, type ReactNode } from "react";
import { Excalidraw, MainMenu, serializeAsJSON } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { mergeEditorScene, parseScene } from "@local-excalidraw/model";
import type { Documents, OpenDocument } from "./documents";

/** One mounted editor per tab preserves selections, viewport, and undo history. */
export function Canvas({
  document,
  documents,
  active,
  theme,
  register,
}: {
  document: OpenDocument;
  documents: Documents;
  active: boolean;
  theme: "light" | "dark";
  register: (path: string, api: ExcalidrawImperativeAPI) => void;
}) {
  // The parent remounts only when disk reconciliation replaces this scene.
  const scene = useMemo(() => parseScene(document.content), []);
  return (
    <div
      className="canvas-pane"
      hidden={!active}
      aria-label={`Drawing ${document.path}`}
    >
      <SceneBoundary path={document.path}>
        <Excalidraw
          initialData={{ ...scene, scrollToContent: true }}
          excalidrawAPI={(api) => register(document.path, api)}
          onChange={(elements, appState, files) =>
            documents.change(
              document.path,
              mergeEditorScene(
                scene,
                serializeAsJSON(elements, appState, files, "local"),
              ),
              document.revision,
            )
          }
          theme={theme}
          name={document.path.replace(/\.excalidraw$/, "")}
          handleKeyboardGlobally={false}
          autoFocus={active}
          aiEnabled={false}
          validateEmbeddable={false}
          UIOptions={{
            canvasActions: {
              loadScene: false,
              saveToActiveFile: false,
              toggleTheme: false,
            },
          }}
        >
          <MainMenu>
            <MainMenu.DefaultItems.Export />
            <MainMenu.DefaultItems.SaveAsImage />
            <MainMenu.DefaultItems.ClearCanvas />
            <MainMenu.Separator />
            <MainMenu.DefaultItems.ChangeCanvasBackground />
          </MainMenu>
        </Excalidraw>
      </SceneBoundary>
    </div>
  );
}

class SceneBoundary extends Component<
  { path: string; children: ReactNode },
  { error: string | null }
> {
  state: { error: string | null } = { error: null };
  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  render(): ReactNode {
    if (this.state.error)
      return (
        <div className="canvas-error" role="alert">
          <h2>Could not render this drawing</h2>
          <p>{this.props.path}</p>
          <p>{this.state.error}</p>
          <p>
            Close this tab or repair the file and reopen it. Other drawings are
            still available.
          </p>
        </div>
      );
    return this.props.children;
  }
}
