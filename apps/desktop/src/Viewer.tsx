import { useEffect, useState } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import { parseScene, type Scene } from "@local-excalidraw/model";
import "./viewer.css";

type Entry = { name: string; path: string; kind: "folder" | "drawing" };

const base = window.location.pathname;

async function get(path: string): Promise<Response> {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(await response.text());
  return response;
}

function Folder({
  path,
  depth,
  refresh,
  selected,
  onSelect,
}: {
  path: string;
  depth: number;
  refresh: number;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    setLoading(true);
    void get(`${base}api/list?${new URLSearchParams({ path })}`)
      .then((response) => response.json() as Promise<Entry[]>)
      .then((items) => {
        if (active) {
          setEntries(items);
          setError(null);
        }
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [path, refresh]);
  if (loading) return <p className="viewer-tree-state">Waiting for folder…</p>;
  if (error) return <p className="viewer-tree-state" role="alert">{error}</p>;
  if (!entries.length) return <p className="viewer-tree-state">No drawings here.</p>;
  return (
    <ul className="viewer-tree">
      {entries.map((entry) => (
        <li key={entry.path}>
          <button
            className={`viewer-entry${selected === entry.path ? " selected" : ""}`}
            style={{ paddingLeft: 14 + depth * 16 }}
            onClick={() => {
              if (entry.kind === "drawing") onSelect(entry.path);
              else setExpanded((previous) => {
                const next = new Set(previous);
                if (next.has(entry.path)) next.delete(entry.path);
                else next.add(entry.path);
                return next;
              });
            }}
          >
            <span aria-hidden="true">{entry.kind === "folder" ? expanded.has(entry.path) ? "▾" : "▸" : "·"}</span>
            <span>{entry.name.replace(/\.excalidraw$/, "")}</span>
          </button>
          {entry.kind === "folder" && expanded.has(entry.path) && (
            <Folder path={entry.path} depth={depth + 1} refresh={refresh} selected={selected} onSelect={onSelect} />
          )}
        </li>
      ))}
    </ul>
  );
}

/** Browser-only, read-only view of the desktop app's selected workspace. */
export function Viewer() {
  const [selected, setSelected] = useState<string | null>(null);
  const [scene, setScene] = useState<Scene | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  useEffect(() => {
    if (!selected) return;
    let active = true;
    setScene(null);
    setError(null);
    void get(`${base}api/file?${new URLSearchParams({ path: selected })}`)
      .then((response) => response.text())
      .then((content) => parseScene(content))
      .then((drawing) => {
        if (active) {
          setScene(drawing);
        }
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false;
    };
  }, [selected, refresh]);
  return (
    <div className="viewer-shell" data-theme={theme}>
      <aside className="viewer-sidebar">
        <header className="viewer-sidebar-heading">
          <strong>Drawings</strong>
          <button onClick={() => setRefresh((value) => value + 1)}>Refresh</button>
        </header>
        <div className="viewer-folders">
          <Folder path="" depth={0} refresh={refresh} selected={selected} onSelect={setSelected} />
        </div>
        <p className="viewer-note">Read-only · Selected desktop workspace</p>
      </aside>
      <main className="viewer-main">
        {selected && scene ? (
          <Excalidraw
            key={`${selected}:${refresh}`}
            initialData={{ ...scene, appState: { ...scene.appState, theme }, scrollToContent: true }}
            viewModeEnabled
            theme={theme}
            name={selected.replace(/\.excalidraw$/, "")}
            UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false } }}
            onChange={(_, appState) => setTheme(appState.theme)}
          />
        ) : (
          <div className="viewer-empty" role={error ? "alert" : undefined}>
            <h1>{error ? "Drawing unavailable" : selected ? "Opening drawing…" : "Choose a drawing"}</h1>
            <p>{error ?? (selected ? "The desktop app may be waiting for this file." : "Select a file from the list to view it here.")}</p>
          </div>
        )}
      </main>
    </div>
  );
}
