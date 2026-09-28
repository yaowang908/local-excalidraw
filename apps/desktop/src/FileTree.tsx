import {
  ChevronDown,
  ChevronRight,
  FilePenLine,
  Folder,
  FolderOpen,
  Library,
  MoreHorizontal,
} from "lucide-react";
import type { FileEntry } from "./filesystem";

/** Expandable filesystem navigation with native-style entry actions. */
export function FileTree({
  entries,
  active,
  onOpen,
  onAction,
  expandedFolders,
  loadingFolders,
  folderErrors,
  onToggle,
  onRetry,
  level = 0,
}: {
  entries: FileEntry[];
  active: string | null;
  onOpen: (entry: FileEntry) => void;
  onAction: (entry: FileEntry, x: number, y: number) => void;
  expandedFolders: Set<string>;
  loadingFolders: Set<string>;
  folderErrors: Record<string, string>;
  onToggle: (entry: FileEntry) => void;
  onRetry: (entry: FileEntry) => void;
  level?: number;
}) {
  return (
    <ul
      className="file-tree"
      role={level === 0 ? "tree" : "group"}
      aria-label={level === 0 ? "Workspace files" : undefined}
    >
      {entries.map((entry) => {
        const expanded = expandedFolders.has(entry.path);
        const folder = entry.kind === "folder";
        const Icon = folder
          ? expanded
            ? FolderOpen
            : Folder
          : entry.kind === "library"
            ? Library
            : FilePenLine;
        return (
          <li
            key={entry.path}
            role="treeitem"
            aria-expanded={folder ? expanded : undefined}
            aria-selected={!folder && entry.path === active}
          >
            <div
              className={`tree-row ${entry.path === active ? "selected" : ""}`}
              style={{ paddingLeft: 10 + level * 16 }}
              onContextMenu={(event) => {
                event.preventDefault();
                onAction(entry, event.clientX, event.clientY);
              }}
            >
              <button
                className="tree-open"
                title={entry.path}
                onClick={() => {
                  if (folder) onToggle(entry);
                  else onOpen(entry);
                }}
              >
                {folder ? (
                  expanded ? (
                    <ChevronDown size={13} />
                  ) : (
                    <ChevronRight size={13} />
                  )
                ) : (
                  <span className="tree-indent" />
                )}
                <Icon size={16} strokeWidth={1.6} />
                <span>{entry.name.replace(/\.excalidraw$/, "")}</span>
              </button>
              <button
                className="entry-actions icon-button"
                aria-label={`Actions for ${entry.name}`}
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  onAction(entry, rect.right, rect.bottom);
                }}
              >
                <MoreHorizontal size={15} />
              </button>
            </div>
            {folder && expanded && (
              <>
                {loadingFolders.has(entry.path) && <div className="tree-state">Waiting for folder…</div>}
                {folderErrors[entry.path] && (
                  <div className="tree-state">
                    {folderErrors[entry.path]}
                    <button className="text-button" onClick={() => onRetry(entry)}>Retry</button>
                  </div>
                )}
                <FileTree
                  entries={entry.children}
                  active={active}
                  onOpen={onOpen}
                  onAction={onAction}
                  expandedFolders={expandedFolders}
                  loadingFolders={loadingFolders}
                  folderErrors={folderErrors}
                  onToggle={onToggle}
                  onRetry={onRetry}
                  level={level + 1}
                />
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}
