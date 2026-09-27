import { useEffect, useRef, useState } from "react";
import { errorMessage } from "./filesystem";

/** Reviewable form or confirmation for a specific filesystem operation. */
export interface PromptOptions {
  title: string;
  description: string;
  label?: string;
  initial?: string;
  submit: string;
  danger?: boolean;
  action: (value: string) => Promise<void>;
}

/** Native dialog semantics, keyboard dismissal, and errors that retain the entered path. */
export function Prompt({
  options,
  close,
}: {
  options: PromptOptions;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState(options.initial ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="prompt"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
      aria-labelledby="prompt-title"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          void options
            .action(value.trim())
            .then(close)
            .catch((reason) => setError(errorMessage(reason)))
            .finally(() => setBusy(false));
        }}
      >
        <h2 id="prompt-title">{options.title}</h2>
        <p>{options.description}</p>
        {options.label && (
          <label className="field">
            {options.label}
            <input
              autoFocus
              required
              value={value}
              disabled={busy}
              onChange={(event) => setValue(event.target.value)}
              spellCheck={false}
            />
          </label>
        )}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <div className="prompt-actions">
          <button type="button" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button
            className={options.danger ? "danger-button" : "primary-button"}
            disabled={busy}
          >
            {busy ? "Working…" : options.submit}
          </button>
        </div>
      </form>
    </dialog>
  );
}
