"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { useAuth } from "./AuthProvider";

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
          <circle cx="12" cy="12" r="8" stroke="white" strokeWidth="1.8" />
          <path d="M12 8v4l2.5 2.5" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <div className="flex items-baseline gap-0">
        <span className="text-[22px] font-extrabold text-black" style={{ letterSpacing: "-0.04em" }}>Open</span>
        <span className="text-[22px] font-extrabold text-[var(--lifeos-pink)]" style={{ letterSpacing: "-0.04em" }}>Hour</span>
      </div>
    </Link>
  );
}

// ─────────────────────────────────────────────────────────────
// Auth button — Google sign-in / avatar when signed in
// ─────────────────────────────────────────────────────────────
function AuthButton() {
  const { user, loading, signInWithGoogle, signOut } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);

  if (loading) return null; // Avoid flash of wrong auth state

  if (!user) {
    return (
      <button
        onClick={signInWithGoogle}
        className="flex items-center gap-1.5 h-9 rounded-xl px-3 text-black/50 hover:text-black/80 hover:bg-black/[0.05] transition-all duration-150 text-xs font-semibold"
        title="Sign in to sync your data across devices"
      >
        {/* Google G icon */}
        <svg viewBox="0 0 24 24" className="h-4 w-4 flex-shrink-0" aria-hidden="true">
          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
          <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
          <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
        </svg>
        <span className="hidden sm:inline">Sign in</span>
      </button>
    );
  }

  // Signed-in: avatar with dropdown
  const avatarUrl = user.user_metadata?.avatar_url as string | undefined;
  const displayName =
    ((user.user_metadata?.full_name as string | undefined)?.split(" ")[0]) ??
    "Account";

  return (
    <div className="relative">
      <button
        onClick={() => setMenuOpen((v) => !v)}
        className="relative flex items-center h-9 w-9 rounded-xl hover:bg-black/[0.05] transition-all duration-150 justify-center"
        title={displayName}
      >
        {avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={avatarUrl}
            alt={displayName}
            className="h-7 w-7 rounded-full object-cover ring-2 ring-[var(--lifeos-pink)]/30"
          />
        ) : (
          <div className="h-7 w-7 rounded-full bg-[var(--lifeos-pink)] flex items-center justify-center text-white text-xs font-bold">
            {displayName[0].toUpperCase()}
          </div>
        )}
        {/* Green cloud-sync indicator dot */}
        <div className="absolute top-0.5 right-0.5 h-2.5 w-2.5 rounded-full bg-emerald-400 border-2 border-white" />
      </button>

      {menuOpen && (
        <>
          {/* Backdrop */}
          <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
          {/* Dropdown */}
          <div
            className="absolute right-0 top-11 z-50 w-52 rounded-2xl border border-black/[0.08] shadow-xl overflow-hidden"
            style={{ backgroundColor: "var(--background)" }}
          >
            <div className="px-4 py-3 border-b border-black/[0.06]">
              <div className="text-xs font-bold text-black/80 truncate">
                {(user.user_metadata?.full_name as string | undefined) ?? "Signed in"}
              </div>
              <div className="text-[11px] text-black/40 truncate">{user.email}</div>
            </div>
            <div className="flex items-center gap-2 px-4 py-2.5 text-[11px] text-emerald-600 font-semibold">
              <div className="h-1.5 w-1.5 rounded-full bg-emerald-400 flex-shrink-0" />
              Cloud sync active
            </div>
            <button
              onClick={() => {
                signOut();
                setMenuOpen(false);
              }}
              className="w-full flex items-center gap-3 px-4 py-3 text-sm font-semibold text-black/60 hover:bg-black/[0.04] transition-colors text-left border-t border-black/[0.06]"
            >
              Sign out
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Dark mode toggle button
// ─────────────────────────────────────────────────────────────
function DarkModeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("openhour_preferences_v1");
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
      const raw = window.localStorage.getItem("openhour_preferences_v1");
      const prefs = raw ? JSON.parse(raw) : {};
      window.localStorage.setItem("openhour_preferences_v1", JSON.stringify({ ...prefs, darkMode: next }));
      // Re-check accent contrast whenever dark mode changes
      const accent = window.localStorage.getItem("openhour_accent_color_v1");
      if (accent) applyAccentDarkAttribute(accent);
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
      const calRaw = window.localStorage.getItem("openhour_calendar_v1");
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
// Helpers for notification timers
// ─────────────────────────────────────────────────────────────
function minsTo12hShell(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const suffix = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, "0")}${suffix}`;
}

function isoDateLocalShell(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// ─────────────────────────────────────────────────────────────
// Accent color dark-mode helper
// Sets data-accent-dark on <html> when the chosen accent color is
// too dark to be legible on a dark background (luminance < 0.15)
// ─────────────────────────────────────────────────────────────
function relativeLuminance(hex: string): number {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const toLinear = (c: number) => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

export function applyAccentDarkAttribute(accent: string) {
  try {
    const lum = relativeLuminance(accent);
    if (lum < 0.15) {
      document.documentElement.setAttribute("data-accent-dark", "1");
    } else {
      document.documentElement.removeAttribute("data-accent-dark");
    }
  } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────────────
// AppShell
// ─────────────────────────────────────────────────────────────
export default function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const MAX_W = "max-w-[1700px]";

  // Apply dark mode from saved preferences on first mount
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("openhour_preferences_v1");
      if (raw) {
        const prefs = JSON.parse(raw);
        if (prefs?.darkMode === true) document.documentElement.classList.add("dark");
        else document.documentElement.classList.remove("dark");
      }
      // Apply saved accent color
      const accent = window.localStorage.getItem("openhour_accent_color_v1");
      if (accent) {
        document.documentElement.style.setProperty("--lifeos-pink", accent);
        applyAccentDarkAttribute(accent);
      }
    } catch { /* ignore */ }
  }, []);

  // Schedule browser notification timers for today's events (15-min reminders)
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("openhour_preferences_v1");
      const prefs = raw ? JSON.parse(raw) : {};
      if (!prefs?.notificationsEnabled) return;
      if (typeof Notification === "undefined") return;
      if (Notification.permission !== "granted") return;

      const calRaw = window.localStorage.getItem("openhour_calendar_v1");
      const calendar: Array<{ id: string; date: string; title: string; startMin: number; endMin: number }> =
        (() => { try { const p = JSON.parse(calRaw ?? "[]"); return Array.isArray(p) ? p : []; } catch { return []; } })();

      const today = isoDateLocalShell(new Date());
      const todayBlocks = calendar.filter((b) => b.date === today);
      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes();

      const timers: ReturnType<typeof setTimeout>[] = [];
      todayBlocks.forEach((block) => {
        const msUntil = (block.startMin - 15 - nowMin) * 60_000;
        if (msUntil < 0) return; // already passed
        timers.push(setTimeout(() => {
          try {
            new Notification(`Starting soon: ${block.title}`, {
              body: `In 15 minutes at ${minsTo12hShell(block.startMin)}`,
              icon: "/icon-192.png",
              tag: `lifeos-reminder-${block.id}`,
            });
          } catch { /* Notification may fail silently */ }
        }, msUntil));
      });

      return () => timers.forEach(clearTimeout);
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
            <AuthButton />
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
