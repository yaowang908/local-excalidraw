import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  ChevronDown,
  FilePlus2,
  FolderOpen,
  FolderPlus,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Save,
  X,
} from "lucide-react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { emptyScene } from "@local-excalidraw/model";
import { Canvas } from "./Canvas";
import { Documents } from "./documents";
import {
  errorMessage,
  NativeFs,
  type FileEntry,
  type Preferences,
} from "./filesystem";
import { FileTree } from "./FileTree";
import { Prompt, type PromptOptions } from "./Prompt";

type Session = { fs: NativeFs; documents: Documents };
const basename = (path: string): string => path.split("/").pop() ?? path;
const parent = (path: string): string =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
const join = (folder: string, name: string): string =>
  folder ? `${folder}/${name}` : name;

/** Desktop workspace shell with file-backed tabs and explicit conflict resolution. */
export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<PromptOptions | null>(null);
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(true);
  const [sidebar, setSidebar] = useState(true);
  const [menu, setMenu] = useState<{
    entry: FileEntry;
    x: number;
    y: number;
  } | null>(null);
  const [workspaceMenu, setWorkspaceMenu] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">(
    matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );
  const currentSession = useRef<Session | null>(null);
  const activePath = useRef(active);
  activePath.current = active;
  const apis = useRef(new Map<string, ExcalidrawImperativeAPI>());
  const savingPreferences = useRef(Promise.resolve());
  const treeRequest = useRef(0);
  const emptyDocuments = useRef<ReturnType<Documents["getSnapshot"]>>([]);
  const documents = useSyncExternalStore(
    session?.documents.subscribe ?? (() => () => {}),
    session?.documents.getSnapshot ?? (() => emptyDocuments.current),
  );
  const document = documents.find((doc) => doc.path === active);

  const run = useCallback((action: () => Promise<unknown>) => {
    void action().catch((reason) => setError(errorMessage(reason)));
  }, []);
  const refresh = useCallback(async (target: Session) => {
    const request = ++treeRequest.current;
    const tree = await target.fs.tree();
    if (currentSession.current === target && treeRequest.current === request)
      setEntries(tree);
  }, []);

  const openWorkspace = useCallback(
    async (
      path: string,
      tabs: string[] = [],
      selected: string | null = null,
    ) => {
      setBusy(true);
      try {
        const previous = currentSession.current;
        if (previous) await previous.documents.flush();
        const root = await invoke<string>("open_workspace", { path });
        const fs = new NativeFs(root);
        const next = { fs, documents: new Documents(fs, setError) };
        previous?.documents.dispose();
        currentSession.current = next;
        apis.current.clear();
        setSession(next);
        setActive(null);
        setEntries([]);
        setError(null);
        await refresh(next);
        for (const tab of tabs) {
          try {
            await next.documents.open(tab);
          } catch (reason) {
            setError(`Could not reopen ${tab}: ${errorMessage(reason)}`);
          }
        }
        setActive(
          next.documents.get(selected ?? "")?.path ??
            next.documents.getSnapshot()[0]?.path ??
            null,
        );
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const chooseWorkspace = useCallback(async () => {
    setBusy(true);
    try {
      const path = await open({
        directory: true,
        multiple: false,
        title: "Open Excalidraw workspace",
      });
      if (path) await openWorkspace(path);
    } finally {
      setBusy(false);
      setWorkspaceMenu(false);
    }
  }, [openWorkspace]);

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const update = () => setTheme(media.matches ? "dark" : "light");
    media.addEventListener("change", update);
    if (!isTauri()) {
      setStarting(false);
      return () => media.removeEventListener("change", update);
    }
    void invoke<Preferences>("load_preferences")
      .then(async (preferences) => {
        if (preferences.workspacePath)
          await openWorkspace(
            preferences.workspacePath,
            preferences.openTabs,
            preferences.activeTab,
          );
      })
      .catch((reason) => setError(errorMessage(reason)))
      .finally(() => setStarting(false));
    return () => media.removeEventListener("change", update);
  }, [openWorkspace]);

  useEffect(() => {
    documentElementTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (!session || starting) return;
    const preferences: Preferences = {
      workspacePath: session.fs.root,
      openTabs: documents.map((doc) => doc.path),
      activeTab: active,
    };
    const timer = setTimeout(() => {
      savingPreferences.current = savingPreferences.current
        .then(() => invoke<void>("save_preferences", { preferences }))
        .catch((reason) => setError(errorMessage(reason)));
    }, 250);
    return () => clearTimeout(timer);
  }, [session, active, documents.map((doc) => doc.path).join("\0"), starting]);

  useEffect(() => {
    if (!session) return;
    let stopped = false;
    let unlisten: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const synchronize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (stopped) return;
        run(async () => {
          await Promise.all([
            refresh(session),
            ...session.documents
              .getSnapshot()
              .map((doc) => session.documents.reconcile(doc.path)),
          ]);
        });
      }, 120);
    };
    void session.fs
      .watch((watchError) => {
        if (watchError) setError(watchError);
        synchronize();
      })
      .then((stop) => {
        if (stopped) stop();
        else {
          unlisten = stop;
          synchronize();
        }
      })
      .catch((reason) => setError(errorMessage(reason)));
    window.addEventListener("focus", synchronize);
    return () => {
      stopped = true;
      clearTimeout(timer);
      unlisten?.();
      window.removeEventListener("focus", synchronize);
    };
  }, [session, refresh, run]);

  useEffect(() => {
    if (!isTauri()) return;
    let closing = false;
    let stopped = false;
    const cleanups: (() => void)[] = [];
    const close = () => {
      if (closing) return;
      closing = true;
      setBusy(true);
      run(async () => {
        try {
          await currentSession.current?.documents.flush();
          await savingPreferences.current;
          const current = currentSession.current;
          if (current)
            await invoke("save_preferences", {
              preferences: {
                workspacePath: current.fs.root,
                openTabs: current.documents
                  .getSnapshot()
                  .map((doc) => doc.path),
                activeTab: activePath.current,
              },
            });
          await invoke("exit_app");
        } finally {
          closing = false;
          setBusy(false);
        }
      });
    };
    void Promise.all([
      getCurrentWindow().onCloseRequested((event) => {
        event.preventDefault();
        close();
      }),
      listen("app-close-requested", close),
    ])
      .then((list) => {
        if (stopped) list.forEach((stop) => stop());
        else cleanups.push(...list);
      })
      .catch((reason) => setError(errorMessage(reason)));
    return () => {
      stopped = true;
      cleanups.forEach((stop) => stop());
    };
  }, [run]);

  const openFile = async (entry: FileEntry) => {
    if (!session) return;
    if (entry.kind === "library") {
      const api = active ? apis.current.get(active) : undefined;
      if (!api) throw new Error("Open a drawing before importing a library.");
      const disk = await session.fs.read(entry.path);
      await api.updateLibrary({
        libraryItems: new Blob([disk.content], { type: "application/json" }),
        merge: true,
        openLibraryMenu: true,
      });
      return;
    }
    await session.documents.open(entry.path);
    setActive(entry.path);
  };

  const newEntry = (kind: "drawing" | "folder", folder = "") => {
    if (!session) {
      run(chooseWorkspace);
      return;
    }
    setPrompt({
      title: kind === "drawing" ? "New drawing" : "New folder",
      description: folder
        ? `Create in ${folder}/`
        : "Create in the workspace folder.",
      label: "Name",
      initial: kind === "drawing" ? "Untitled.excalidraw" : "",
      submit: "Create",
      action: async (name) => {
        if (!name || name.includes("/"))
          throw new Error("Enter a name without slashes.");
        const path = join(
          folder,
          kind === "drawing" && !name.endsWith(".excalidraw")
            ? `${name}.excalidraw`
            : name,
        );
        if (kind === "folder") await session.fs.createFolder(path);
        else {
          await session.fs.save(
            path,
            JSON.stringify(emptyScene(), null, 2),
            null,
          );
          await session.documents.open(path);
          setActive(path);
        }
        await refresh(session);
      },
    });
  };

  const moveEntry = (entry: FileEntry, rename: boolean) => {
    if (!session) return;
    setMenu(null);
    setPrompt({
      title: rename ? `Rename ${entry.name}` : `Move ${entry.name}`,
      description: rename
        ? "Open tabs will follow the new name."
        : "Enter the new path relative to this workspace. The destination folder must exist.",
      label: rename ? "Name" : "Destination path",
      initial: rename ? entry.name : entry.path,
      submit: rename ? "Rename" : "Move",
      action: async (value) => {
        if (rename && value.includes("/"))
          throw new Error("Use Move to change folders.");
        const destination = rename ? join(parent(entry.path), value) : value;
        if (entry.path === destination) return;
        await session.documents.flush();
        await session.fs.move(entry.path, destination);
        session.documents.moved(entry.path, destination);
        if (active === entry.path || active?.startsWith(`${entry.path}/`))
          setActive(destination + active.slice(entry.path.length));
        await refresh(session);
      },
    });
  };

  const trashEntry = (entry: FileEntry) => {
    if (!session) return;
    setMenu(null);
    setPrompt({
      title: `Move ${entry.name} to Trash?`,
      description:
        entry.kind === "folder"
          ? "The folder and all its contents will be moved to the macOS Trash."
          : "You can restore this drawing from the macOS Trash.",
      submit: "Move to Trash",
      danger: true,
      action: async () => {
        await session.documents.flush();
        await session.fs.trash(entry.path);
        session.documents.trashed(entry.path);
        if (active === entry.path || active?.startsWith(`${entry.path}/`))
          setActive(session.documents.getSnapshot()[0]?.path ?? null);
        await refresh(session);
      },
    });
  };

  const closeTab = async (path: string) => {
    if (!session) return;
    setBusy(true);
    try {
      await session.documents.close(path);
      apis.current.delete(path);
      if (active === path)
        setActive(session.documents.getSnapshot().at(-1)?.path ?? null);
    } finally {
      setBusy(false);
    }
  };

  const saveCopy = () => {
    if (!session || !document) return;
    const path = document.path;
    setPrompt({
      title: "Save your version as",
      description:
        "The external file will stay on disk. Your canvas will be saved as a separate drawing.",
      label: "Path in workspace",
      initial: path.replace(/\.excalidraw$/, "-local.excalidraw"),
      submit: "Save copy",
      action: async (destination) => {
        if (!destination.endsWith(".excalidraw")) destination += ".excalidraw";
        await session.documents.saveCopy(path, destination);
        setActive(destination);
        await refresh(session);
      },
    });
  };

  const chooseFile = async () => {
    const selected = await open({
      directory: false,
      multiple: false,
      filters: [{ name: "Excalidraw", extensions: ["excalidraw"] }],
    });
    if (!selected) return;
    let target = currentSession.current;
    if (!target || !selected.startsWith(`${target.fs.root}/`)) {
      await openWorkspace(parent(selected));
      target = currentSession.current;
    }
    if (target) {
      const path = selected.slice(target.fs.root.length + 1);
      await target.documents.open(path);
      setActive(path);
    }
    setWorkspaceMenu(false);
  };

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || prompt) return;
      const key = event.key.toLowerCase();
      if (!["o", "n", "s", "w", "b"].includes(key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (busy) return;
      if (key === "o") run(event.shiftKey ? chooseFile : chooseWorkspace);
      if (key === "n") newEntry(event.shiftKey ? "folder" : "drawing");
      if (key === "s" && session && active)
        run(() => session.documents.save(active));
      if (key === "w" && active) run(() => closeTab(active));
      if (key === "b") setSidebar((value) => !value);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  });

  const status = !document
    ? ""
    : document.conflict
      ? "Conflict needs attention"
      : document.saving
        ? "Saving…"
        : document.error
          ? "Save failed"
          : document.dirty
            ? "Unsaved changes"
            : document.external
              ? "Updated externally"
              : "All changes saved";
  return (
    <div className="app-shell" data-theme={theme}>
      <header className="workspace-toolbar">
        <button
          className="icon-button"
          aria-label={sidebar ? "Hide sidebar" : "Show sidebar"}
          onClick={() => setSidebar((value) => !value)}
        >
          {sidebar ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
        </button>
        <div className="workspace-switcher">
          <button
            className="workspace-button"
            disabled={busy || starting}
            onClick={() =>
              session
                ? setWorkspaceMenu((value) => !value)
                : run(chooseWorkspace)
            }
          >
            <FolderOpen size={17} />
            <span>
              {session ? basename(session.fs.root) : "Open workspace"}
            </span>
            <ChevronDown size={13} />
          </button>
          {workspaceMenu && (
            <>
              <button
                className="menu-backdrop"
                aria-label="Close workspace menu"
                onClick={() => setWorkspaceMenu(false)}
              />
              <div className="context-menu workspace-menu">
                <button onClick={() => run(chooseWorkspace)}>
                  Open workspace…<kbd>⌘O</kbd>
                </button>
                <button onClick={() => run(chooseFile)}>
                  Open drawing…<kbd>⇧⌘O</kbd>
                </button>
                <button
                  onClick={() => {
                    if (session) run(() => session.fs.reveal(null));
                    setWorkspaceMenu(false);
                  }}
                >
                  Reveal in Finder
                </button>
              </div>
            </>
          )}
        </div>
        <span className="toolbar-separator" />
        <span className="app-title">Local Excalidraw</span>
        <div className="toolbar-end">
          <button
            className="toolbar-action"
            disabled={!session || busy}
            onClick={() => newEntry("drawing")}
          >
            <FilePlus2 size={16} />
            <span>New drawing</span>
            <kbd>⌘N</kbd>
          </button>
        </div>
      </header>
      {error && (
        <div className="error-strip" role="alert">
          <AlertCircle size={16} />
          <span>{error}</span>
          <button
            className="icon-button"
            aria-label="Dismiss error"
            onClick={() => setError(null)}
          >
            <X size={15} />
          </button>
        </div>
      )}
      <div
        className="workspace-body"
        aria-busy={busy}
        ref={(element) => {
          if (element) element.inert = busy;
        }}
      >
        {sidebar && (
          <aside className="sidebar" aria-label="File browser">
            <div className="sidebar-heading">
              <span>Files</span>
              <div>
                <button
                  className="icon-button"
                  title="New folder (⇧⌘N)"
                  aria-label="New folder"
                  disabled={!session}
                  onClick={() => newEntry("folder")}
                >
                  <FolderPlus size={16} />
                </button>
                <button
                  className="icon-button"
                  title="Refresh workspace"
                  aria-label="Refresh workspace"
                  disabled={!session}
                  onClick={() => {
                    if (session)
                      run(async () => {
                        await refresh(session);
                        await Promise.all(
                          documents.map((doc) =>
                            session.documents.reconcile(doc.path),
                          ),
                        );
                      });
                  }}
                >
                  <RefreshCw size={14} />
                </button>
              </div>
            </div>
            <div className="tree-scroll">
              {entries.length > 0 ? (
                <FileTree
                  entries={entries}
                  active={active}
                  onOpen={(entry) => run(() => openFile(entry))}
                  onAction={(entry, x, y) => setMenu({ entry, x, y })}
                />
              ) : (
                <div className="sidebar-empty">
                  {session ? (
                    <>
                      <p>No drawings yet.</p>
                      <button
                        className="text-button"
                        onClick={() => newEntry("drawing")}
                      >
                        Create a drawing
                      </button>
                    </>
                  ) : (
                    <p>Open a folder to see your drawings.</p>
                  )}
                </div>
              )}
            </div>
            {session && (
              <div className="workspace-location" title={session.fs.root}>
                <FolderOpen size={13} />
                <span>{session.fs.root}</span>
              </div>
            )}
          </aside>
        )}
        <main className="editor-area">
          {documents.length > 0 && (
            <div className="tab-bar" role="tablist" aria-label="Open drawings">
              {documents.map((doc) => (
                <div
                  className={`tab ${active === doc.path ? "active" : ""}`}
                  key={doc.path}
                >
                  <button
                    role="tab"
                    aria-selected={active === doc.path}
                    title={doc.path}
                    onClick={() => setActive(doc.path)}
                  >
                    <span>
                      {basename(doc.path).replace(/\.excalidraw$/, "")}
                    </span>
                    {doc.conflict ? (
                      <AlertCircle size={13} aria-label="Conflict" />
                    ) : doc.dirty ? (
                      <span
                        className="dirty-dot"
                        aria-label="Unsaved changes"
                      />
                    ) : null}
                  </button>
                  <button
                    className="tab-close icon-button"
                    aria-label={`Close ${basename(doc.path)}`}
                    onClick={() => run(() => closeTab(doc.path))}
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {document?.conflict && (
            <section className="conflict-bar" aria-label="File conflict">
              <div>
                <strong>External change in {basename(document.path)}</strong>
                <p>{document.conflict.message}</p>
              </div>
              <div className="conflict-actions">
                <button
                  disabled={!document.conflict.disk || document.saving}
                  onClick={() => {
                    if (session)
                      run(() => session.documents.reload(document.path));
                  }}
                >
                  Reload external
                </button>
                <button
                  disabled={document.saving}
                  onClick={() => {
                    if (session)
                      run(() => session.documents.keep(document.path));
                  }}
                >
                  Keep my version
                </button>
                <button disabled={document.saving} onClick={saveCopy}>
                  Save mine as…
                </button>
              </div>
            </section>
          )}
          <div className="canvas-stack">
            {session &&
              documents.map((doc) => (
                <Canvas
                  key={`${doc.path}:${doc.revision}`}
                  document={doc}
                  documents={session.documents}
                  active={active === doc.path}
                  theme={theme}
                  register={(path, api) => apis.current.set(path, api)}
                />
              ))}
            {!document && (
              <section className="empty-workspace">
                <div className="empty-content">
                  <FolderOpen size={34} strokeWidth={1.3} />
                  <h1>
                    {starting
                      ? "Opening workspace…"
                      : session
                        ? "A place for your drawings"
                        : "Your drawings, in your folders"}
                  </h1>
                  <p>
                    {session
                      ? "Open a drawing from the sidebar, or start a new one."
                      : "Choose a folder on your Mac. Drawings stay as ordinary .excalidraw files, ready for any compatible editor."}
                  </p>
                  <button
                    className="primary-button"
                    disabled={starting || busy || !isTauri()}
                    onClick={() =>
                      session ? newEntry("drawing") : run(chooseWorkspace)
                    }
                  >
                    {session ? (
                      <FilePlus2 size={16} />
                    ) : (
                      <FolderOpen size={16} />
                    )}
                    {session ? "New drawing" : "Open workspace"}
                    <kbd>{session ? "⌘N" : "⌘O"}</kbd>
                  </button>
                  {!isTauri() && (
                    <p className="browser-note">
                      This is the browser preview. Run{" "}
                      <code>npm run desktop</code> to open local folders.
                    </p>
                  )}
                  <div className="empty-hint">
                    <span>Local files</span>
                    <span>Automatic saving</span>
                    <span>External change protection</span>
                  </div>
                </div>
              </section>
            )}
          </div>
          <footer className="status-bar">
            <span className="document-path" title={active ?? undefined}>
              {active ?? "No drawing open"}
            </span>
            <div aria-live="polite">
              {document && (
                <>
                  <span
                    className={
                      document.conflict || document.error
                        ? "status-attention"
                        : ""
                    }
                  >
                    {document.conflict || document.error ? (
                      <AlertCircle size={13} />
                    ) : !document.dirty && !document.saving ? (
                      <Check size={13} />
                    ) : (
                      <Save size={13} />
                    )}
                    {status}
                  </span>
                  {document.error && (
                    <button
                      className="text-button"
                      onClick={() => {
                        if (session && active)
                          run(() => session.documents.save(active));
                      }}
                    >
                      Retry
                    </button>
                  )}
                </>
              )}
              <span className="autosave-label">Autosave · 750 ms</span>
            </div>
          </footer>
        </main>
      </div>
      {menu && (
        <>
          <button
            className="menu-backdrop"
            aria-label="Close file menu"
            onClick={() => setMenu(null)}
          />
          <div
            className="context-menu"
            role="menu"
            style={{
              left: Math.min(menu.x, window.innerWidth - 235),
              top: Math.min(menu.y, window.innerHeight - 280),
            }}
          >
            {menu.entry.kind === "folder" && (
              <>
                <button
                  role="menuitem"
                  onClick={() => {
                    newEntry("drawing", menu.entry.path);
                    setMenu(null);
                  }}
                >
                  <FilePlus2 size={15} />
                  New drawing
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    newEntry("folder", menu.entry.path);
                    setMenu(null);
                  }}
                >
                  <FolderPlus size={15} />
                  New folder
                </button>
                <hr />
              </>
            )}
            <button role="menuitem" onClick={() => moveEntry(menu.entry, true)}>
              Rename…
            </button>
            <button
              role="menuitem"
              onClick={() => moveEntry(menu.entry, false)}
            >
              Move…
            </button>
            <button
              role="menuitem"
              onClick={() => {
                if (session) run(() => session.fs.reveal(menu.entry.path));
                setMenu(null);
              }}
            >
              Reveal in Finder
              <ArrowUpRight size={14} />
            </button>
            <hr />
            <button
              role="menuitem"
              className="danger-text"
              onClick={() => trashEntry(menu.entry)}
            >
              Move to Trash
            </button>
          </div>
        </>
      )}
      {prompt && <Prompt options={prompt} close={() => setPrompt(null)} />}
    </div>
  );
}

function documentElementTheme(theme: "light" | "dark"): void {
  document.documentElement.style.colorScheme = theme;
}
