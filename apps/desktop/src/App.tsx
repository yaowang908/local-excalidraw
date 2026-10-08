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
import {
  folderChooserPrompt,
  modifierKey,
  revealLabel,
  shiftModifierKey,
  trashDescription,
} from "./platform";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { emptyScene } from "@local-excalidraw/model";
import { Canvas } from "./Canvas";
import { Documents } from "./documents";
import {
  errorMessage,
  hasCode,
  NativeFs,
  type FileEntry,
  type Preferences,
} from "./filesystem";
import { FileTree } from "./FileTree";
import { Prompt, type PromptOptions } from "./Prompt";

type Session = { fs: NativeFs; documents: Documents };
type WorkspaceRoute = { kind: "current" | "focused" | "new"; root: string };
const basename = (path: string): string => path.split("/").pop() ?? path;
const parent = (path: string): string =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
const join = (folder: string, name: string): string =>
  folder ? `${folder}/${name}` : name;
const mergeListing = (previous: FileEntry[], listed: FileEntry[]): FileEntry[] => {
  const old = new Map(previous.map((entry) => [entry.path, entry]));
  return listed.map((entry) => ({
    ...entry,
    children: entry.kind === "folder" ? old.get(entry.path)?.children ?? [] : [],
  }));
};
const replaceFolder = (entries: FileEntry[], path: string, listed: FileEntry[]): FileEntry[] =>
  entries.map((entry) => entry.path === path
    ? { ...entry, children: mergeListing(entry.children, listed) }
    : { ...entry, children: replaceFolder(entry.children, path, listed) });

/** Desktop workspace shell with file-backed tabs and explicit conflict resolution. */
export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [folderLoading, setFolderLoading] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [loadingFolders, setLoadingFolders] = useState<Set<string>>(new Set());
  const [folderErrors, setFolderErrors] = useState<Record<string, string>>({});
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  const [openingError, setOpeningError] = useState<{ path: string; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [viewerBusy, setViewerBusy] = useState(false);
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
  const theme = "dark";
  const currentSession = useRef<Session | null>(null);
  const activePath = useRef(active);
  activePath.current = active;
  const apis = useRef(new Map<string, ExcalidrawImperativeAPI>());
  const savingPreferences = useRef(Promise.resolve());
  const closingWindow = useRef(false);
  const treeRequest = useRef(0);
  const treePending = useRef<{ target: Session; promise: Promise<void> } | null>(null);
  const folderPending = useRef(new Map<string, { target: Session; promise: Promise<void> }>());
  const expandedRef = useRef(expandedFolders);
  expandedRef.current = expandedFolders;
  const emptyDocuments = useRef<ReturnType<Documents["getSnapshot"]>>([]);
  const documents = useSyncExternalStore(
    session?.documents.subscribe ?? (() => () => {}),
    session?.documents.getSnapshot ?? (() => emptyDocuments.current),
  );
  const document = documents.find((doc) => doc.path === active);

  const run = useCallback((action: () => Promise<unknown>) => {
    void action().catch((reason) => setError(errorMessage(reason)));
  }, []);
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    void invoke<string | null>("viewer_url")
      .then((url) => {
        if (active) setViewerUrl(url);
      })
      .catch((reason: unknown) => {
        if (active) setViewerError(errorMessage(reason));
      });
    return () => {
      active = false;
    };
  }, []);
  const toggleViewer = useCallback(async () => {
    setViewerBusy(true);
    setViewerError(null);
    try {
      if (viewerUrl) {
        await invoke("stop_viewer");
        setViewerUrl(null);
      } else {
        setViewerUrl(await invoke<string>("start_viewer"));
      }
    } catch (reason) {
      setViewerError(errorMessage(reason));
    } finally {
      setViewerBusy(false);
    }
  }, [viewerUrl]);
  const refresh = useCallback((target: Session): Promise<void> => {
    if (treePending.current?.target === target) return treePending.current.promise;
    const request = ++treeRequest.current;
    const operation = (async () => {
      if (currentSession.current === target) setFolderLoading(true);
      try {
        const tree = await target.fs.tree();
        if (currentSession.current === target && treeRequest.current === request) {
          setEntries((previous) => mergeListing(previous, tree));
          setFolderError(null);
        }
      } catch (reason) {
        if (currentSession.current === target && treeRequest.current === request)
          setFolderError(errorMessage(reason));
        throw reason;
      } finally {
        if (currentSession.current === target && treeRequest.current === request)
          setFolderLoading(false);
      }
    })();
    treePending.current = { target, promise: operation };
    const clear = () => {
      if (treePending.current?.promise === operation) treePending.current = null;
    };
    void operation.then(clear, clear);
    return operation;
  }, []);
  const loadFolder = useCallback((target: Session, path: string): Promise<void> => {
    const existing = folderPending.current.get(path);
    if (existing?.target === target) return existing.promise;
    const operation = (async () => {
      if (currentSession.current === target)
        setLoadingFolders((previous) => new Set(previous).add(path));
      try {
        const listed = await target.fs.tree(path);
        if (currentSession.current === target) {
          setEntries((previous) => replaceFolder(previous, path, listed));
          setFolderErrors((previous) => {
            const next = { ...previous };
            delete next[path];
            return next;
          });
        }
      } catch (reason) {
        if (currentSession.current === target)
          setFolderErrors((previous) => ({ ...previous, [path]: errorMessage(reason) }));
        throw reason;
      } finally {
        if (currentSession.current === target)
          setLoadingFolders((previous) => {
            const next = new Set(previous);
            next.delete(path);
            return next;
          });
      }
    })();
    folderPending.current.set(path, { target, promise: operation });
    const clear = () => {
      if (folderPending.current.get(path)?.promise === operation)
        folderPending.current.delete(path);
    };
    void operation.then(clear, clear);
    return operation;
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
        setViewerUrl(null);
        setViewerError(null);
        const fs = new NativeFs(root);
        const next = { fs, documents: new Documents(fs, setError) };
        previous?.documents.dispose();
        currentSession.current = next;
        apis.current.clear();
        setSession(next);
        setActive(null);
        setEntries([]);
        setExpandedFolders(new Set());
        setLoadingFolders(new Set());
        setFolderErrors({});
        setError(null);
        const restoredPath = selected && tabs.includes(selected) ? selected : tabs[0] ?? null;
        setActive(restoredPath);
        setOpeningPath(restoredPath);
        setOpeningError(null);
        void refresh(next).catch((reason) => setError(errorMessage(reason)));
        for (const tab of tabs) {
          void next.documents.open(tab)
            .catch((reason) => {
              if (currentSession.current === next) {
                const message = errorMessage(reason);
                if (tab === restoredPath) setOpeningError({ path: tab, message });
                setError(`Could not reopen ${tab}: ${message}`);
              }
            })
            .finally(() => {
              if (tab === restoredPath)
                setOpeningPath((path) => path === tab ? null : path);
            });
        }
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
      if (path) {
        const route = await invoke<WorkspaceRoute>("route_workspace", { path, selectedFile: null });
        if (route.kind === "current" && currentSession.current?.fs.root !== route.root)
          await openWorkspace(route.root);
      }
    } finally {
      setBusy(false);
      setWorkspaceMenu(false);
    }
  }, [openWorkspace]);

  useEffect(() => {
    if (!isTauri()) {
      setStarting(false);
      return;
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
  }, [openWorkspace]);

  useEffect(() => {
    documentElementTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (!session || !isTauri()) return;
    let stopped = false;
    let unlisten: (() => void) | undefined;
    void listen<string>("open-drawing", (event) => {
      if (currentSession.current !== session) return;
      const path = event.payload;
      setActive(path);
      setOpeningPath(path);
      setOpeningError(null);
      void session.documents.open(path)
        .catch((reason) => {
          setOpeningError({ path, message: errorMessage(reason) });
          setError(`Could not open ${path}: ${errorMessage(reason)}`);
        })
        .finally(() => setOpeningPath((opening) => opening === path ? null : opening));
    }).then((stop) => {
      if (stopped) stop();
      else unlisten = stop;
    }).catch((reason) => setError(errorMessage(reason)));
    return () => {
      stopped = true;
      unlisten?.();
    };
  }, [session]);

  useEffect(() => {
    if (!session || starting) return;
    const preferences: Preferences = {
      workspacePath: session.fs.root,
      openTabs: documents.map((doc) => doc.path),
      activeTab: active,
    };
    const timer = setTimeout(() => {
      if (closingWindow.current) return;
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
    const reconcileOpen = async () => {
      for (const doc of session.documents.getSnapshot())
        void session.documents.reconcile(doc.path).catch((reason) => setError(errorMessage(reason)));
    };
    const synchronize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (stopped) return;
        run(async () => {
          for (const path of expandedRef.current)
            void loadFolder(session, path).catch((reason) => setError(errorMessage(reason)));
          await Promise.all([
            refresh(session),
            reconcileOpen(),
          ]);
        });
      }, 1000);
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
    const filePoll = setInterval(() => run(reconcileOpen), 10_000);
    const folderPoll = setInterval(() => {
      run(() => refresh(session));
      for (const path of expandedRef.current)
        run(() => loadFolder(session, path));
    }, 30_000);
    return () => {
      stopped = true;
      clearTimeout(timer);
      unlisten?.();
      clearInterval(filePoll);
      clearInterval(folderPoll);
      window.removeEventListener("focus", synchronize);
    };
  }, [session, refresh, loadFolder, run]);

  useEffect(() => {
    if (!isTauri()) return;
    let closing = false;
    let stopped = false;
    const cleanups: (() => void)[] = [];
    const close = (preserveSession: boolean) => {
      if (closing) return;
      closing = true;
      closingWindow.current = true;
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
          await invoke("close_window", { preserveSession });
        } finally {
          closing = false;
          closingWindow.current = false;
          setBusy(false);
        }
      });
    };
    void Promise.all([
      getCurrentWindow().onCloseRequested((event) => {
        event.preventDefault();
        close(false);
      }),
      listen("app-close-requested", () => close(true)),
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
    setActive(entry.path);
    setOpeningPath(entry.path);
    setOpeningError(null);
    try {
      await session.documents.open(entry.path);
    } catch (reason) {
      setOpeningError({ path: entry.path, message: errorMessage(reason) });
      throw reason;
    } finally {
      setOpeningPath((path) => path === entry.path ? null : path);
    }
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
        let warning: string | null = null;
        try {
          await session.fs.move(entry.path, destination);
        } catch (reason) {
          if (!hasCode(reason, "recovery_move")) throw reason;
          warning = errorMessage(reason);
        }
        session.documents.moved(entry.path, destination);
        setExpandedFolders((previous) => new Set([...previous].filter((path) => path !== entry.path && !path.startsWith(`${entry.path}/`))));
        if (active === entry.path || active?.startsWith(`${entry.path}/`))
          setActive(destination + active.slice(entry.path.length));
        await refresh(session);
        if (warning) setError(warning);
      },
    });
  };

  const trashEntry = (entry: FileEntry) => {
    if (!session) return;
    setMenu(null);
    setPrompt({
      title: `Move ${entry.name} to Trash?`,
      description: trashDescription(entry.kind === "folder"),
      submit: "Move to Trash",
      danger: true,
      action: async () => {
        await session.documents.flush();
        let warning: string | null = null;
        try {
          await session.fs.trash(entry.path);
        } catch (reason) {
          if (!hasCode(reason, "recovery_trash")) throw reason;
          warning = errorMessage(reason);
        }
        session.documents.trashed(entry.path);
        setExpandedFolders((previous) => new Set([...previous].filter((path) => path !== entry.path && !path.startsWith(`${entry.path}/`))));
        if (active === entry.path || active?.startsWith(`${entry.path}/`))
          setActive(session.documents.getSnapshot()[0]?.path ?? null);
        await refresh(session);
        if (warning) setError(warning);
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
      const file = basename(selected);
      const route = await invoke<WorkspaceRoute>("route_workspace", {
        path: parent(selected),
        selectedFile: file,
      });
      if (route.kind === "current") {
        await openWorkspace(route.root, [file], file);
      }
      setWorkspaceMenu(false);
      return;
    }
    if (target) {
      const path = selected.slice(target.fs.root.length + 1);
      setActive(path);
      setOpeningPath(path);
      setOpeningError(null);
      try {
        await target.documents.open(path);
      } catch (reason) {
        setOpeningError({ path, message: errorMessage(reason) });
        throw reason;
      } finally {
        setOpeningPath((opening) => opening === path ? null : opening);
      }
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
    : document.error
      ? "Save or recovery failed"
      : document.conflict
      ? "Version choice needed"
      : document.waiting
        ? "Waiting for folder…"
      : document.saving
        ? "Saving…"
        : document.dirty
            ? "Unsaved changes"
            : document.external
              ? "Updated from folder"
              : "Saved locally";
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
                  Open workspace in window…<kbd>{modifierKey()}O</kbd>
                </button>
                <button onClick={() => run(chooseFile)}>
                  Open drawing…<kbd>{shiftModifierKey()}O</kbd>
                </button>
                <button
                  onClick={() => {
                    if (session) run(() => session.fs.reveal(null));
                    setWorkspaceMenu(false);
                  }}
                >
                  {revealLabel()}
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
            <kbd>{modifierKey()}N</kbd>
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
                  title={`New folder (${shiftModifierKey()}N)`}
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
                        for (const path of expandedRef.current)
                          void loadFolder(session, path).catch((reason) => setError(errorMessage(reason)));
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
                  expandedFolders={expandedFolders}
                  loadingFolders={loadingFolders}
                  folderErrors={folderErrors}
                  onToggle={(entry) => {
                    const opening = !expandedFolders.has(entry.path);
                    setExpandedFolders((previous) => {
                      const next = new Set(previous);
                      if (opening) next.add(entry.path);
                      else next.delete(entry.path);
                      return next;
                    });
                    if (opening && session) run(() => loadFolder(session, entry.path));
                  }}
                  onRetry={(entry) => {
                    if (session) run(() => loadFolder(session, entry.path));
                  }}
                />
              ) : (
                <div className="sidebar-empty">
                  {session ? (
                    <>
                      <p>{folderLoading ? "Waiting for folder contents…" : folderError ? `Folder unavailable: ${folderError}` : "No drawings yet."}</p>
                      {folderError ? (
                        <button className="text-button" onClick={() => run(() => refresh(session))}>Retry folder</button>
                      ) : !folderLoading ? (
                        <button className="text-button" onClick={() => newEntry("drawing")}>Create a drawing</button>
                      ) : null}
                    </>
                  ) : (
                    <p>Open a folder to see your drawings.</p>
                  )}
                </div>
              )}
            </div>
            <div className="viewer-location">
              <div className="viewer-controls">
                <span>Read-only viewer</span>
                <button
                  className="text-button"
                  disabled={!session || busy || viewerBusy}
                  onClick={() => { void toggleViewer(); }}
                >
                  {viewerBusy ? "Working…" : viewerUrl ? "Stop" : "Start"}
                </button>
              </div>
              {viewerUrl ? (
                <>
                  <code>{viewerUrl}</code>
                  <button
                    className="text-button"
                    onClick={() => run(async () => {
                      await navigator.clipboard.writeText(viewerUrl);
                    })}
                  >
                    Copy URL
                  </button>
                </>
              ) : (
                <p>{session ? "Off. Start to share this folder." : "Open a folder to share it."}</p>
              )}
              {viewerError && <p role="alert">{viewerError}</p>}
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
                <strong>Choose a version of {basename(document.path)}</strong>
                <p>{document.conflict.message}</p>
                {document.conflict.copyPath && <p>Local copy: {document.conflict.copyPath}</p>}
                {document.error && <p className="form-error">{document.error}</p>}
              </div>
              <div className="conflict-actions">
                <button
                  disabled={!document.conflict.disk || document.saving}
                  onClick={() => {
                    if (session)
                      run(() => session.documents.reload(document.path));
                  }}
                >
                  Use incoming
                </button>
                <button
                  disabled={!document.conflict.disk || document.saving}
                  onClick={() => {
                    if (session)
                      run(() => session.documents.keep(document.path));
                  }}
                >
                  Make mine primary
                </button>
                <button
                  disabled={!document.conflict.disk || document.saving}
                  onClick={() => {
                    if (session) run(async () => {
                      const destination = await session.documents.openIncoming(document.path);
                      setActive(destination);
                      await refresh(session);
                    });
                  }}
                >
                  Open incoming
                </button>
                <button
                  disabled={!document.conflict.disk || document.saving}
                  onClick={() => {
                    if (session) run(async () => {
                      const destination = await session.documents.keepBoth(document.path);
                      setActive(destination);
                      await refresh(session);
                    });
                  }}
                >
                  Keep both
                </button>
                <button
                  disabled={document.saving}
                  onClick={() => {
                    if (session) run(() => session.documents.reconcile(document.path));
                  }}
                >
                  Retry read
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
                  onError={setError}
                />
              ))}
            {!document && (
              <section className="empty-workspace">
                <div className="empty-content">
                  <FolderOpen size={34} strokeWidth={1.3} />
                  <h1>
                    {active !== null && openingPath === active
                      ? "Waiting for drawing…"
                      : openingError?.path === active
                      ? "Drawing unavailable"
                      : starting
                      ? "Opening workspace…"
                      : session
                        ? "A place for your drawings"
                        : "Your drawings, in your folders"}
                  </h1>
                  <p>
                    {active !== null && openingPath === active
                      ? "The cloud service may be downloading this file. You can keep using the rest of the app."
                      : openingError?.path === active
                      ? openingError.message
                      : session
                      ? "Open a drawing from the sidebar, or start a new one."
                      : folderChooserPrompt()}
                  </p>
                  {openingError?.path === active && session && active ? (
                    <button className="primary-button" onClick={() => run(() => openFile({ name: basename(active), path: active, kind: "drawing", children: [] }))}>Retry opening</button>
                  ) : <button
                    className="primary-button"
                    disabled={starting || busy || !isTauri() || (active !== null && openingPath === active)}
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
                    <kbd>{session ? `${modifierKey()}N` : `${modifierKey()}O`}</kbd>
                  </button>}
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
              {revealLabel()}
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
