import type { ReactNode } from "react";
import type { RepoState, RunState } from "@runnerbox/shared/types";

/** Colored state pill. `tone` drives color; `pulse` animates the dot. */
export function Chip({
  tone = "default",
  children,
}: {
  tone?: "default" | "ok" | "live" | "pending" | "error" | "info";
  children: ReactNode;
}) {
  return (
    <span className={`chip ${tone}`}>
      <span className="dot" />
      {children}
    </span>
  );
}

export function RunStateChip({ state }: { state: RunState }) {
  switch (state) {
    case "live":
      return <Chip tone="live">live</Chip>;
    case "dispatching":
    case "queued":
    case "booting":
      return <Chip tone="pending">{state}</Chip>;
    case "closing":
      return <Chip tone="info">closing</Chip>;
    case "failed":
      return <Chip tone="error">failed</Chip>;
    case "ended":
      return <Chip>ended</Chip>;
  }
}

export function RepoStateChip({ state }: { state: RepoState }) {
  switch (state) {
    case "ok":
      return <Chip tone="ok">connected</Chip>;
    case "pending_pr":
      return <Chip tone="pending">pending PR</Chip>;
    case "needs_repair":
      return <Chip tone="error">needs repair</Chip>;
    case "uninstalled":
      return <Chip tone="error">uninstalled</Chip>;
  }
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onCancel} role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>{title}</h3>
        <p>{body}</p>
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn danger" disabled={busy} onClick={onConfirm}>
            {busy ? <span className="spinner" /> : null}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="muted">
      <span className="spinner" /> {label}
    </span>
  );
}
