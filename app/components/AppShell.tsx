"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

// ─────────────────────────────────────────────────────────────
// Icons
// ─────────────────────────────────────────────────────────────
function Icon({ name, active }: { name: "spark" | "list" | "calendar" | "user"; active: boolean }) {
  const cls = cx("h-6 w-6 transition-colors duration-200", active ? "text-[var(--lifeos-pink)]" : "text-black/40");
  switch (name) {
    case "spark": return (
      <svg viewBox="0 0 24 24" className={cls} fill="none" aria-hidden="true">
        <path d="M12 2l2.09 6.26L21 10l-6.91 1.74L12 18l-2.09-5.74L3 10l6.91-1.74z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" fill={active ? "currentColor" : "none"} fillOpacity={active ? 0.15 : 0} />
        <circle cx="19" cy="4" r="1.2" fill="currentColor" opacity={active ? 1 : 0.5} />
        <circle cx="5" cy="19" r="0.9" fill="currentColor" opacity={active ? 0.7 : 0.3} />
      </svg>
    );
    case "list": return (
      <svg viewBox="0 0 24 24" className={cls} fill="none" aria-hidden="true">
        <rect x="3" y="4" width="18" height="16" rx="4" stroke="currentColor" strokeWidth="1.7" fill={active ? "currentColor" : "none"} fillOpacity={active ? 0.1 : 0} />
        <path d="M7 9h10" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        <path d="M7 12.5h7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        <path d="M7 16h5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    );
    case "calendar": return (
      <svg viewBox="0 0 24 24" className={cls} fill="none" aria-hidden="true">
        <rect x="3" y="5" width="18" height="16" rx="4" stroke="currentColor" strokeWidth="1.7" fill={active ? "currentColor" : "none"} fillOpacity={active ? 0.1 : 0} />
        <path d="M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        <path d="M3 10h18" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <rect x="7" y="13" width="3" height="3" rx="1" fill="currentColor" fillOpacity={active ? 1 : 0.4} />
      </svg>
    );
    case "user": return (
      <svg viewBox="0 0 24 24" className={cls} fill="none" aria-hidden="true">
        <circle cx="12" cy="8.5" r="3.5" stroke="currentColor" strokeWidth="1.7" fill={active ? "currentColor" : "none"} fillOpacity={active ? 0.15 : 0} />
        <path d="M5 20c0-3.31 3.13-6 7-6s7 2.69 7 6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Logo
// ─────────────────────────────────────────────────────────────
function LogoMark() {
  return (
    <Link href="/" className="flex items-center gap-2.5 group select-none">
      <div className="h-10 w-10 rounded-[14px] bg-[var(--lifeos-pink)] grid place-items-center shadow-[0_2px_10px_rgba(255,107,107,0.35)] transition-all duration-200 group-hover:shadow-[0_4px_18px_rgba(255,107,107,0.5)] group-hover:scale-105">
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden="true">
          <path d="M12 2l2.09 6.26L21 10l-6.91 1.74L12 18l-2.09-5.74L3 10l6.91-1.74z" fill="white" stroke="white" strokeWidth="1.5" strokeLinejoin="round" />
          <circle cx="19.5" cy="4" r="1.2" fill="white" opacity="0.7" />
        </svg>
      </div>
      <div className="flex items-baseline gap-0">
        <span className="text-[22px] font-extrabold text-black" style={{ letterSpacing: "-0.04em" }}>life</span>
        <span className="text-[22px] font-extrabold text-[var(--lifeos-pink)]" style={{ letterSpacing: "-0.04em" }}>os</span>
      </div>
    </Link>
  );
}

// ─────────────────────────────────────────────────────────────
// Dark mode toggle button
// ─────────────────────────────────────────────────────────────
function DarkModeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("lifeos_preferences_v1");
      if (raw) {
        const prefs = JSON.parse(raw);
        setDark(!!prefs?.darkMode);
      }
    } catch { /* ignore */ }
  }, []);

  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      const raw = window.localStorage.getItem("lifeos_preferences_v1");
      const prefs = raw ? JSON.parse(raw) : {};
      window.localStorage.setItem("lifeos_preferences_v1", JSON.stringify({ ...prefs, darkMode: next }));
    } catch { /* ignore */ }
  }

  return (
    <button
      onClick={toggle}
      className="flex items-center justify-center h-9 w-9 rounded-xl text-black/40 hover:text-black/70 hover:bg-black/[0.05] hover:scale-105 active:scale-95 transition-all duration-150"
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      title={dark ? "Light mode" : "Dark mode"}
    >
      {dark ? (
        // Sun icon
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="5" />
          <path d="M12 2v2M12 20v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M2 12h2M20 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
        </svg>
      ) : (
        // Moon icon
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────
// Streak pill — reads real data from localStorage
// ─────────────────────────────────────────────────────────────
function StreakPill() {
  const [streak, setStreak] = useState<number>(0);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      // Compute streak: consecutive days with at least 1 calendar block, counting back from today
      const calRaw = window.localStorage.getItem("lifeos_calendar_v1");
      const calendar: Array<{ date: string }> = (() => {
        try { const p = JSON.parse(calRaw ?? "[]"); return Array.isArray(p) ? p : []; } catch { return []; }
      })();
      const dateSet = new Set(calendar.map((b) => b.date));
      let count = 0;
      const today = new Date();
      for (let i = 0; i < 365; i++) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        const iso = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
        if (dateSet.has(iso)) count++;
        else if (i > 0) break; // gap found — stop counting
      }
      setStreak(count);
    } catch { /* ignore */ }
    setLoaded(true);
  }, []);

  if (!loaded || streak < 1) return null;

  return (
    <div className="flex items-center gap-1.5 rounded-full bg-black/[0.045] px-3 py-1.5 select-none" title={`${streak}-day streak`}>
      <span className="text-base leading-none">🔥</span>
      <span className="text-sm font-bold text-black/55">{streak}</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Nav config
// ─────────────────────────────────────────────────────────────
type NavItem = { href: string; label: string; icon: "spark" | "list" | "calendar" | "user" };

const NAV: NavItem[] = [
  { href: "/", label: "Today", icon: "spark" },
  { href: "/plan", label: "Focus", icon: "list" },
  { href: "/calendar", label: "Calendar", icon: "calendar" },
  { href: "/profile", label: "Profile", icon: "user" },
];

// ─────────────────────────────────────────────────────────────
// AppShell
// ─────────────────────────────────────────────────────────────
export default function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const MAX_W = "max-w-[1700px]";

  // Apply dark mode from saved preferences on first mount
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("lifeos_preferences_v1");
      if (raw) {
        const prefs = JSON.parse(raw);
        if (prefs?.darkMode === true) document.documentElement.classList.add("dark");
        else document.documentElement.classList.remove("dark");
      }
      // Apply saved accent color
      const accent = window.localStorage.getItem("lifeos_accent_color_v1");
      if (accent) document.documentElement.style.setProperty("--lifeos-pink", accent);
    } catch { /* ignore */ }
  }, []);

  return (
    <div className="min-h-screen" style={{ backgroundColor: "var(--background)" }}>
      {/* ── Sticky top header ── */}
      <header className="sticky top-0 z-40 backdrop-blur-md border-b border-black/[0.05]" style={{ backgroundColor: "var(--background)" }}>
        <div className={`mx-auto w-full ${MAX_W} px-4 sm:px-6 h-16 flex items-center justify-between gap-3`}>
          <LogoMark />
          <div className="flex items-center gap-1.5">
            <DarkModeToggle />
            <StreakPill />
          </div>
        </div>
      </header>

      {/* ── Page content ── */}
      <main className={`mx-auto w-full ${MAX_W} px-4 sm:px-6 pb-28 pt-6`}>
        <motion.div
          key={pathname}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
        >
          {children}
        </motion.div>
      </main>

      {/* ── Floating bottom nav ── */}
      <nav className="fixed bottom-0 left-0 right-0 z-30 pointer-events-none">
        <div
          className="nav-pill pointer-events-auto mx-4 mb-4 rounded-[28px] backdrop-blur-xl shadow-[0_8px_32px_rgba(0,0,0,0.12),0_2px_8px_rgba(0,0,0,0.06)] border border-black/[0.06]"
          style={{ backgroundColor: "var(--background)" }}
        >
          <div className={`mx-auto flex ${MAX_W} items-center justify-around px-2 py-2`}>
            {NAV.map((item) => {
              const active = pathname === item.href;
              return (
                <Link key={item.href} href={item.href}
                  className="relative flex flex-col items-center justify-center gap-1 px-5 py-2 min-w-[64px]"
                  aria-current={active ? "page" : undefined}>
                  {active && (
                    <motion.div layoutId="nav-active-pill"
                      className="absolute inset-0 rounded-[20px] bg-[var(--lifeos-pink)]/10"
                      transition={{ type: "spring", stiffness: 400, damping: 30 }} />
                  )}
                  <motion.div whileTap={{ scale: 0.82 }} transition={{ type: "spring", stiffness: 500, damping: 22 }} className="relative z-10">
                    <Icon name={item.icon} active={active} />
                  </motion.div>
                  <span className={cx("relative z-10 text-[10px] font-bold tracking-wide transition-colors duration-200", active ? "text-[var(--lifeos-pink)]" : "text-black/35")}>
                    {item.label}
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      </nav>
    </div>
  );
}
