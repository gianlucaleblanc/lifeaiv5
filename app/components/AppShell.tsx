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
    <Link href="/" className="flex items-center gap-2 group select-none">
      {/* Drop your logo as public/logo.png to replace this */}
      <img
        src="/logo.png"
        alt="OpenHour"
        className="transition-all duration-200 group-hover:scale-105 group-hover:brightness-105"
        style={{ height: 32, width: "auto", display: "block" }}
        onError={(e) => {
          // Fallback: hide broken img and show text logo
          (e.currentTarget as HTMLImageElement).style.display = "none";
          const next = e.currentTarget.nextElementSibling as HTMLElement | null;
          if (next) next.style.display = "flex";
        }}
      />
      {/* Text fallback (hidden when logo.png loads) */}
      <div className="items-baseline gap-0" style={{ display: "none" }}>
        <span className="font-black text-black" style={{ fontSize: 20, letterSpacing: "-0.05em" }}>Open</span>
        <span className="font-black" style={{ fontSize: 20, letterSpacing: "-0.05em", color: "var(--lifeos-pink)" }}>Hour</span>
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
        className="flex items-center gap-1.5 transition-all duration-150"
        style={{
          height: 32, borderRadius: 8, padding: "0 12px",
          fontSize: "var(--font-xs)", fontWeight: 600, letterSpacing: "var(--tracking-snug)",
          color: "var(--text-secondary)", border: "1px solid var(--divider)", background: "transparent",
        }}
        title="Sign in to sync your data across devices"
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--surface-hover)"; (e.currentTarget as HTMLElement).style.color = "var(--text-primary)"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; (e.currentTarget as HTMLElement).style.color = "var(--text-secondary)"; }}
      >
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true">
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
        className="relative flex items-center justify-center transition-all duration-150"
        style={{ height: 32, width: 32, borderRadius: 8 }}
        title={displayName}
      >
        {avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={avatarUrl}
            alt={displayName}
            className="h-6 w-6 rounded-full object-cover"
            style={{ boxShadow: "0 0 0 2px rgba(var(--lifeos-pink-rgb),0.3)" }}
          />
        ) : (
          <div className="h-6 w-6 rounded-full flex items-center justify-center text-white font-bold"
            style={{ background: "var(--lifeos-pink)", fontSize: 10 }}>
            {displayName[0].toUpperCase()}
          </div>
        )}
        {/* Sync dot */}
        <div className="absolute" style={{ top: 1, right: 1, width: 8, height: 8, borderRadius: 999, background: "#34d399", border: "1.5px solid var(--surface-base)" }} />
      </button>

      {menuOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
          <div
            className="absolute right-0 z-50 overflow-hidden"
            style={{
              top: 40, width: 200, borderRadius: 14,
              background: "var(--surface-overlay)",
              border: "1px solid var(--divider)",
              boxShadow: "var(--shadow-lg)",
            }}
          >
            <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--divider)" }}>
              <div style={{ fontSize: "var(--font-sm)", fontWeight: 700, color: "var(--text-primary)" }} className="truncate">
                {(user.user_metadata?.full_name as string | undefined) ?? "Signed in"}
              </div>
              <div style={{ fontSize: "var(--font-xs)", color: "var(--text-faint)", marginTop: 1 }} className="truncate">{user.email}</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "8px 16px", fontSize: "var(--font-xs)", color: "#34d399", fontWeight: 600 }}>
              <div style={{ width: 6, height: 6, borderRadius: 999, background: "#34d399", flexShrink: 0 }} />
              Cloud sync active
            </div>
            <button
              onClick={() => { signOut(); setMenuOpen(false); }}
              className="w-full text-left transition-colors"
              style={{ padding: "10px 16px", fontSize: "var(--font-sm)", fontWeight: 600, color: "var(--text-secondary)", borderTop: "1px solid var(--divider)", background: "transparent" }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--surface-hover)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
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
      className="flex items-center justify-center transition-all duration-150 hover:scale-105 active:scale-95"
      style={{ height: 32, width: 32, borderRadius: 8, color: "var(--text-tertiary)", background: "transparent" }}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      title={dark ? "Light mode" : "Dark mode"}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--surface-hover)"; (e.currentTarget as HTMLElement).style.color = "var(--text-secondary)"; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)"; }}
    >
      {dark ? (
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="5" />
          <path d="M12 2v2M12 20v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M2 12h2M20 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
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
    <div
      className="flex items-center gap-1 select-none"
      style={{
        borderRadius: 999, padding: "4px 10px",
        background: "rgba(251,146,60,0.09)",
        border: "1px solid rgba(251,146,60,0.22)",
      }}
      title={`${streak}-day streak`}
    >
      {/* Flame SVG instead of emoji */}
      <svg viewBox="0 0 20 24" style={{ width: 10, height: 12, flexShrink: 0 }} fill="rgb(234,88,12)" aria-hidden="true">
        <path d="M10 0c.5 4.5-2.5 6-2.5 10C7.5 12.5 8.7 14 10 14s2.5-1.5 2.5-4C12.5 6 9.5 4.5 10 0z"/>
        <path d="M10 14c-1.4 0-2.5 1.1-2.5 2.5S8.6 19 10 19s2.5-1.1 2.5-2.5S11.4 14 10 14z"/>
      </svg>
      <span style={{ fontSize: "var(--font-xs)", fontWeight: 800, color: "rgb(234,88,12)", fontVariantNumeric: "tabular-nums" }}>
        {streak}
      </span>
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
      <header
        className="sticky top-0 z-40"
        style={{
          backgroundColor: `rgba(var(--background-rgb, 238,240,243), 0.92)`,
          backdropFilter: "blur(20px) saturate(1.8)",
          WebkitBackdropFilter: "blur(20px) saturate(1.8)",
          borderBottom: "1px solid rgba(0,0,0,0.10)",
          boxShadow: "0 1px 0 rgba(0,0,0,0.04)",
        }}
      >
        <div className={`mx-auto w-full ${MAX_W} px-5 sm:px-8 h-16 flex items-center justify-between gap-4`}>
          <LogoMark />
          <div className="flex items-center gap-2">
            <DarkModeToggle />
            <StreakPill />
            <AuthButton />
          </div>
        </div>
      </header>

      {/* ── Page content ── */}
      <main className={`mx-auto w-full ${MAX_W} px-5 sm:px-8 pb-32 pt-7`}>
        <motion.div
          key={pathname}
          initial={{ opacity: 0, y: 5 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
        >
          {children}
        </motion.div>
      </main>

      {/* ── Floating bottom nav ── */}
      <nav className="fixed bottom-0 left-0 right-0 z-30 pointer-events-none" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        <div
          className="nav-pill pointer-events-auto mx-4 mb-4 rounded-[28px] backdrop-blur-xl"
          style={{
            backgroundColor: "rgba(255,255,255,0.96)",
            border: "1px solid rgba(0,0,0,0.08)",
            boxShadow: "0 8px 36px rgba(0,0,0,0.16), 0 2px 8px rgba(0,0,0,0.08)",
          }}
        >
          <div className={`mx-auto flex ${MAX_W} items-center justify-around px-3 py-2`}>
            {NAV.map((item) => {
              const active = pathname === item.href;
              return (
                <Link key={item.href} href={item.href}
                  className="relative flex flex-col items-center justify-center gap-0.5 px-4 py-1.5 min-w-[60px]"
                  aria-current={active ? "page" : undefined}>
                  {/* Active indicator: pill background behind icon+label */}
                  {active && (
                    <motion.div
                      layoutId="nav-active-pill"
                      className="absolute inset-0 rounded-[16px]"
                      style={{ background: "rgba(var(--lifeos-pink-rgb), 0.10)" }}
                      transition={{ type: "spring", stiffness: 420, damping: 30 }}
                    />
                  )}
                  <motion.div whileTap={{ scale: 0.80 }} transition={{ type: "spring", stiffness: 500, damping: 22 }} className="relative z-10">
                    <Icon name={item.icon} active={active} />
                  </motion.div>
                  <span
                    className="relative z-10 transition-colors duration-200"
                    style={{
                      fontSize: "var(--font-2xs)",
                      fontWeight: 700,
                      letterSpacing: "0.04em",
                      color: active ? "var(--lifeos-pink)" : "var(--text-faint)",
                    }}
                  >
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
