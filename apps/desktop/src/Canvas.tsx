import { Component, useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { Excalidraw, MainMenu, serializeAsJSON } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { mergeEditorScene, parseScene } from "@local-excalidraw/model";
import type { Documents, OpenDocument } from "./documents";
import { youtubePlayerPath } from "./embeds";
import { errorMessage } from "./filesystem";

/** One mounted editor per tab preserves selections, viewport, and undo history. */
export function Canvas({
  document,
  documents,
  active,
  theme,
  register,
  onError,
}: {
  document: OpenDocument;
  documents: Documents;
  active: boolean;
  theme: "light" | "dark";
  register: (path: string, api: ExcalidrawImperativeAPI) => void;
  onError: (message: string) => void;
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
          onLinkOpen={(element, event) => {
            if (!isTauri() || !element.link) return;
            event.preventDefault();
            void invoke("open_external_link", { link: element.link }).catch((error: unknown) =>
              onError(`Could not open link: ${errorMessage(error)}`),
            );
          }}
          validateEmbeddable={(link) => youtubePlayerPath(link) !== null}
          renderEmbeddable={(element) => {
            const path = youtubePlayerPath(element.link);
            return path ? <YouTubePlayer path={path} /> : null;
          }}
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

function YouTubePlayer({ path }: { path: string }) {
  const [base, setBase] = useState<string | null>(() =>
    isTauri() ? null : "https://www.youtube.com/embed",
  );
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let mounted = true;
    void invoke<string>("youtube_embed_base")
      .then((url) => {
        if (mounted) setBase(url);
      })
      .catch((error: unknown) => {
        if (mounted) setError(errorMessage(error));
      });
    return () => {
      mounted = false;
    };
  }, []);
  if (error) return <div role="alert">Could not load YouTube player: {error}</div>;
  if (!base) return <div>Loading video…</div>;
  return (
    <iframe
      className="excalidraw__embeddable"
      src={`${base}/${path}`}
      title="YouTube video player"
      referrerPolicy="strict-origin-when-cross-origin"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
      allowFullScreen
      sandbox="allow-same-origin allow-scripts allow-popups allow-presentation"
    />
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
