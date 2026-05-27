// Lightweight toast notification system for Pita Ji workspace.
// No external dependencies — pure React state + CSS animations.

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { CheckCircle2, AlertTriangle, Info, X } from "lucide-react";

export type ToastKind = "success" | "error" | "info";

interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
  exiting?: boolean;
}

interface ToastCtx {
  toast: (kind: ToastKind, message: string) => void;
}

const Ctx = createContext<ToastCtx>({ toast: () => {} });

export function useToast() {
  return useContext(Ctx);
}

let nextId = 0;

export function PitajiToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, exiting: true } : t)));
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 220);
  }, []);

  const toast = useCallback(
    (kind: ToastKind, message: string) => {
      const id = `pj-toast-${++nextId}`;
      setToasts((prev) => [...prev.slice(-4), { id, kind, message }]);
      // Auto-dismiss after 4s
      setTimeout(() => dismiss(id), 4000);
    },
    [dismiss],
  );

  return (
    <Ctx.Provider value={{ toast }}>
      {children}
      {toasts.length > 0 && (
        <div className="pj-toast-stack" aria-live="polite" aria-relevant="additions">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`pj-toast pj-toast--${t.kind}${t.exiting ? " pj-toast--exiting" : ""}`}
              role={t.kind === "error" ? "alert" : "status"}
            >
              <span className="pj-toast-icon">
                {t.kind === "success" ? (
                  <CheckCircle2 size={16} strokeWidth={2.5} />
                ) : t.kind === "error" ? (
                  <AlertTriangle size={16} strokeWidth={2.5} />
                ) : (
                  <Info size={16} strokeWidth={2.5} />
                )}
              </span>
              <span className="pj-toast-text">{t.message}</span>
              <button type="button" className="pj-toast-close" onClick={() => dismiss(t.id)}>
                <X size={14} strokeWidth={2} />
              </button>
            </div>
          ))}
        </div>
      )}
    </Ctx.Provider>
  );
}
