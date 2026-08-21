import { useEffect, type ReactElement, type ReactNode } from "react";
import { X } from "lucide-react";

export function ModalDialog({
  open,
  title,
  description,
  busy = false,
  children,
  actions,
  onClose,
}: {
  open: boolean;
  title: string;
  description?: string;
  busy?: boolean;
  children: ReactNode;
  actions?: ReactNode;
  onClose(): void;
}): ReactElement | null {
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [busy, onClose, open]);

  if (!open) return null;
  return (
    <div className="app-modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <section className="app-modal" role="dialog" aria-modal="true" aria-labelledby="app-modal-title">
        <header className="app-modal-header">
          <div><h2 id="app-modal-title">{title}</h2>{description && <p>{description}</p>}</div>
          <button className="icon-button" title="关闭" disabled={busy} onClick={onClose}><X size={18} /></button>
        </header>
        <div className="app-modal-body">{children}</div>
        {actions && <footer className="app-modal-actions">{actions}</footer>}
      </section>
    </div>
  );
}
