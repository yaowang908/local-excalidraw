import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowUp, PanelRightClose, Plus, Square, X } from "lucide-react";
import { CodexChat } from "./codex";

/** A collapsible native conversation beside the drawing, with explicit access. */
export function CodexPanel({ chat, open, activePath, openPaths, onClose }: {
  chat: CodexChat;
  open: boolean;
  activePath: string | null;
  openPaths: string[];
  onClose: () => void;
}) {
  const state = useSyncExternalStore(chat.subscribe, chat.getSnapshot);
  const [draft, setDraft] = useState("");
  const [executable, setExecutable] = useState("");
  const [width, setWidth] = useState(380);
  const [target, setTarget] = useState(activePath ?? "");
  const [adding, setAdding] = useState("");
  const [follow, setFollow] = useState(true);
  const transcript = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const resizing = useRef<{ x: number; width: number } | null>(null);
  const working = state.phase === "starting" || state.phase === "running";
  const available = openPaths.filter((path) => !state.allowed.includes(path));
  const selected = state.allowed.includes(target) ? target : state.allowed[0] ?? "";
  const run = (action: () => Promise<unknown>) => {
    void action().catch((error: unknown) => chat.reportError(error));
  };

  useEffect(() => {
    if (open && follow && transcript.current)
      transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [state.entries, open, follow]);
  useEffect(() => {
    if (activePath && state.allowed.includes(activePath)) setTarget(activePath);
  }, [activePath, state.allowed]);

  const send = async () => {
    const text = draft.trim();
    if (!text || !selected || working) return;
    if (state.phase !== "ready") await chat.connect(executable);
    setFollow(true);
    await chat.send(text, selected);
    // A blocked save must leave the unsent draft available for another attempt.
    setDraft((current) => current.trim() === text ? "" : current);
    composer.current?.focus();
  };

  return (
    <aside className="codex-panel" aria-label="Codex chat" hidden={!open} style={{ width }}>
      <div
        className="codex-resizer"
        role="separator"
        aria-label="Resize Codex panel"
        aria-orientation="vertical"
        aria-valuemin={300}
        aria-valuemax={620}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={(event) => {
          resizing.current = { x: event.clientX, width };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!resizing.current) return;
          setWidth(Math.max(300, Math.min(620, window.innerWidth - 300, resizing.current.width + resizing.current.x - event.clientX)));
        }}
        onPointerUp={() => { resizing.current = null; }}
        onPointerCancel={() => { resizing.current = null; }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          setWidth((current) => Math.max(300, Math.min(620, current + (event.key === "ArrowLeft" ? 20 : -20))));
        }}
      />
      <header className="codex-heading">
        <strong>Codex</strong>
        <span>{state.phase === "running" ? "Working" : state.phase === "starting" ? "Starting…" : state.phase === "ready" ? "Connected" : "Local session"}</span>
        <button className="icon-button" aria-label="Collapse Codex panel" title="Collapse Codex panel" onClick={onClose}>
          <PanelRightClose size={17} />
        </button>
      </header>
      <div className="codex-access">
        <div className="codex-access-heading">
          <span>Allowed drawings</span>
          <button className="text-button" disabled={working || (!state.threadId && !state.entries.length)} onClick={() => run(() => chat.newConversation())}>New chat</button>
        </div>
        {state.allowed.length > 0 ? (
          <ul>
            {state.allowed.map((path) => (
              <li key={path}>
                <span title={path}>{path}</span>
                <button className="icon-button" disabled={working} aria-label={`Revoke access to ${path}`} title="Revoke access" onClick={() => run(() => chat.setAllowed(state.allowed.filter((allowed) => allowed !== path)))}><X size={12} /></button>
              </li>
            ))}
          </ul>
        ) : <p>Open a drawing and add it here to begin.</p>}
        {available.length > 0 && (
          <div className="codex-add-drawing">
            <select aria-label="Drawing to allow" disabled={working} value={available.includes(adding) ? adding : available.includes(activePath ?? "") ? activePath ?? "" : available[0] ?? ""} onChange={(event) => setAdding(event.target.value)}>
              {available.map((path) => <option key={path} value={path}>{path}</option>)}
            </select>
            <button className="icon-button" aria-label="Allow drawing" title="Allow drawing" disabled={working} onClick={() => {
              const path = available.includes(adding) ? adding : available.includes(activePath ?? "") ? activePath : available[0];
              if (path) run(() => chat.setAllowed([...state.allowed, path]));
            }}><Plus size={16} /></button>
          </div>
        )}
      </div>
      <div className="codex-transcript" ref={transcript} onScroll={() => {
        const element = transcript.current;
        if (element) setFollow(element.scrollHeight - element.scrollTop - element.clientHeight < 50);
      }} aria-label="Conversation">
        {state.entries.length === 0 && (
          <div className="codex-empty">
            <p>Describe a change to your drawing.</p>
            <p>Codex can add shapes, update labels, and connect elements in the drawings you allow.</p>
            <p>Uses your installed Codex CLI and its sign-in.</p>
          </div>
        )}
        {state.entries.map((entry) => entry.role === "activity"
          ? <p className="codex-activity" key={entry.id}>{entry.text}</p>
          : <article className={`codex-message codex-message-${entry.role}`} key={entry.id}>
              <header><strong>{entry.role === "user" ? "You" : "Codex"}</strong>{entry.target && <span title={entry.target}>{entry.target}</span>}</header>
              <div>{entry.text}</div>
            </article>)}
        {state.phase === "running" && <p className="codex-activity" role="status">Codex is working…</p>}
      </div>
      {state.error && <div className="codex-error" role="alert">{state.error}</div>}
      <form className="codex-composer" onSubmit={(event) => { event.preventDefault(); run(send); }}>
        <label className="codex-target">
          <span>Drawing</span>
          <select aria-label="Target drawing" value={selected} disabled={working || state.allowed.length === 0} onChange={(event) => setTarget(event.target.value)}>
            {state.allowed.length === 0 && <option value="">No drawing allowed</option>}
            {state.allowed.map((path) => <option key={path} value={path}>{path}</option>)}
          </select>
        </label>
        <textarea ref={composer} aria-label="Message Codex" placeholder="Describe the change…" value={draft} maxLength={25000} rows={3}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              run(send);
            }
          }} />
        <div className="codex-composer-actions">
          <span>Enter to send · Shift Enter for a new line</span>
          {state.phase === "running"
            ? <button type="button" aria-label="Stop Codex" title="Stop Codex" onClick={() => run(() => chat.interrupt())}><Square size={13} /></button>
            : <button type="submit" aria-label="Send message" title="Send message" disabled={working || !draft.trim() || !selected}><ArrowUp size={17} /></button>}
        </div>
      </form>
      <footer className="codex-footer">
        <details>
          <summary>Session settings</summary>
          <label>Codex executable<input aria-label="Codex executable" placeholder="Auto-detect, or /absolute/path/to/codex" value={executable} disabled={working || state.phase === "ready"} onChange={(event) => setExecutable(event.target.value)} /></label>
          <p>Sign in from a terminal with <code>codex login</code>.</p>
        </details>
        {state.phase === "ready"
          ? <button className="text-button" onClick={() => run(() => chat.disconnect())}>End session</button>
          : <button className="text-button" disabled={working || state.allowed.length === 0} onClick={() => run(() => chat.connect(executable))}>{state.threadId ? "Resume session" : "Start session"}</button>}
      </footer>
    </aside>
  );
}
