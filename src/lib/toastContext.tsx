"use client";

import { createContext, useContext, useState, useCallback, ReactNode } from "react";
import { CheckCircle, AlertCircle, X } from "lucide-react";

type ToastType = "success" | "error";

interface Toast {
  id: number;
  message: string;
  type: ToastType;
}

interface ToastContextValue {
  showToast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const showToast = useCallback((message: string, type: ToastType = "success") => {
    const id = Date.now();
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3500);
  }, []);

  function dismiss(id: number) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[9999] flex flex-col items-center gap-2 pointer-events-none px-4">
        {toasts.map((toast) => (
          <div key={toast.id}
            className={`pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-2xl shadow-2xl border text-sm font-medium animate-slide-up min-w-[260px] max-w-sm ${
              toast.type === "success"
                ? "bg-[var(--bg-card)] border-[var(--border)] text-[var(--text-1)]"
                : "bg-[var(--bg-card)] border-red-500/20 text-[var(--text-1)]"
            }`}>
            <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${
              toast.type === "success" ? "bg-emerald-500/10" : "bg-red-500/10"
            }`}>
              {toast.type === "success"
                ? <CheckCircle size={15} className="text-emerald-400" />
                : <AlertCircle size={15} className="text-red-400" />}
            </div>
            <span className="flex-1 leading-snug text-[var(--text-1)]">{toast.message}</span>
            <button onClick={() => dismiss(toast.id)}
              className="w-5 h-5 rounded-full flex items-center justify-center text-[var(--text-3)] hover:text-[var(--text-2)] hover:bg-[var(--bg-elevated)] transition-colors flex-shrink-0">
              <X size={11} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
