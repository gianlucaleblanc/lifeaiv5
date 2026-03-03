"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────
export type ToastKind = "success" | "error" | "info" | "warning";

export type Toast = {
  id: string;
  message: string;
  kind: ToastKind;
  duration?: number; // ms, default 3200
};

type ToastContextValue = {
  toast: (message: string, kind?: ToastKind, duration?: number) => void;
};

// ─────────────────────────────────────────────────────────────
// Context
// ─────────────────────────────────────────────────────────────
const ToastContext = createContext<ToastContextValue>({ toast: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

// ─────────────────────────────────────────────────────────────
// Single toast item
// ─────────────────────────────────────────────────────────────
const KIND_STYLES: Record<ToastKind, { bg: string; icon: string; bar: string }> = {
  success: { bg: "bg-[#1a1a1a]", icon: "✓", bar: "bg-emerald-400" },
  error:   { bg: "bg-[#1a1a1a]", icon: "✕", bar: "bg-red-400" },
  warning: { bg: "bg-[#1a1a1a]", icon: "⚠", bar: "bg-amber-400" },
  info:    { bg: "bg-[#1a1a1a]", icon: "✦", bar: "bg-[var(--lifeos-pink)]" },
};

function ToastItem({ t, onDismiss }: { t: Toast; onDismiss: (id: string) => void }) {
  const { bg, icon, bar } = KIND_STYLES[t.kind];
  const duration = t.duration ?? 3200;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    timerRef.current = setTimeout(() => onDismiss(t.id), duration);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [t.id, duration, onDismiss]);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 24, scale: 0.92 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9, y: 8 }}
      transition={{ type: "spring", stiffness: 420, damping: 30 }}
      className={`relative flex items-center gap-3 min-w-[260px] max-w-[380px] rounded-2xl px-4 py-3 shadow-[0_8px_32px_rgba(0,0,0,0.28)] overflow-hidden cursor-pointer ${bg}`}
      onClick={() => onDismiss(t.id)}
    >
      {/* Accent icon */}
      <div className="flex-shrink-0 h-7 w-7 rounded-xl flex items-center justify-center" style={{
        background: t.kind === "success" ? "rgba(52,211,153,0.15)" :
                    t.kind === "error"   ? "rgba(248,113,113,0.15)" :
                    t.kind === "warning" ? "rgba(251,191,36,0.15)"  :
                                          "rgba(217,108,125,0.2)",
      }}>
        <span className="text-xs font-extrabold" style={{
          color: t.kind === "success" ? "#34d399" :
                 t.kind === "error"   ? "#f87171" :
                 t.kind === "warning" ? "#fbbf24" :
                                       "var(--lifeos-pink)",
        }}>
          {icon}
        </span>
      </div>

      {/* Message */}
      <p className="flex-1 text-sm font-semibold text-white/90 leading-snug">{t.message}</p>

      {/* Dismiss X */}
      <button
        onClick={(e) => { e.stopPropagation(); onDismiss(t.id); }}
        className="flex-shrink-0 text-white/30 hover:text-white/70 transition-colors text-sm leading-none ml-1"
        aria-label="Dismiss"
      >×</button>

      {/* Progress bar */}
      <motion.div
        className={`absolute bottom-0 left-0 h-[2px] ${bar}`}
        initial={{ width: "100%" }}
        animate={{ width: "0%" }}
        transition={{ duration: duration / 1000, ease: "linear" }}
      />
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────
// Provider + Toaster
// ─────────────────────────────────────────────────────────────
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((message: string, kind: ToastKind = "info", duration?: number) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev.slice(-4), { id, message, kind, duration }]);
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}

      {/* Toaster — fixed bottom-center, above nav pill */}
      <div className="fixed bottom-24 left-0 right-0 z-[500] flex flex-col items-center gap-2 pointer-events-none px-4">
        <AnimatePresence mode="sync">
          {toasts.map((t) => (
            <div key={t.id} className="pointer-events-auto">
              <ToastItem t={t} onDismiss={dismiss} />
            </div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}
