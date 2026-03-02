"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { motion } from "framer-motion";

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

// ─────────────────────────────────────────────────────────────
// Icons — clean, rounded, friendly (Duolingo-style weight)
// ─────────────────────────────────────────────────────────────
function Icon({ name, active }: { name: "spark" | "list" | "calendar" | "user"; active: boolean }) {
  const cls = cx(
    "h-6 w-6 transition-colors duration-200",
    active ? "text-[var(--lifeos-pink)]" : "text-black/40"
  );

  switch (name) {
    case "spark":
      return (
        <svg viewBox="0 0 24 24" className={cls} fill="none" aria-hidden="true">
          <path
            d="M12 2l2.09 6.26L21 10l-6.91 1.74L12 18l-2.09-5.74L3 10l6.91-1.74z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
            fill={active ? "currentColor" : "none"}
            fillOpacity={active ? 0.15 : 0}
          />
          <circle cx="19" cy="4" r="1.2" fill="currentColor" opacity={active ? 1 : 0.5} />
          <circle cx="5" cy="19" r="0.9" fill="currentColor" opacity={active ? 0.7 : 0.3} />
        </svg>
      );
    case "list":
      return (
        <svg viewBox="0 0 24 24" className={cls} fill="none" aria-hidden="true">
          <rect
            x="3" y="4" width="18" height="16" rx="4"
            stroke="currentColor" strokeWidth="1.7"
            fill={active ? "currentColor" : "none"}
            fillOpacity={active ? 0.1 : 0}
          />
          <path d="M7 9h10" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          <path d="M7 12.5h7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          <path d="M7 16h5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
      );
    case "calendar":
      return (
        <svg viewBox="0 0 24 24" className={cls} fill="none" aria-hidden="true">
          <rect
            x="3" y="5" width="18" height="16" rx="4"
            stroke="currentColor" strokeWidth="1.7"
            fill={active ? "currentColor" : "none"}
            fillOpacity={active ? 0.1 : 0}
          />
          <path d="M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          <path d="M3 10h18" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <rect
            x="7" y="13" width="3" height="3" rx="1"
            fill="currentColor"
            fillOpacity={active ? 1 : 0.4}
          />
        </svg>
      );
    case "user":
      return (
        <svg viewBox="0 0 24 24" className={cls} fill="none" aria-hidden="true">
          <circle
            cx="12" cy="8.5" r="3.5"
            stroke="currentColor" strokeWidth="1.7"
            fill={active ? "currentColor" : "none"}
            fillOpacity={active ? 0.15 : 0}
          />
          <path
            d="M5 20c0-3.31 3.13-6 7-6s7 2.69 7 6"
            stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"
          />
        </svg>
      );
  }
}

// ─────────────────────────────────────────────────────────────
// Logo — icon pill + split wordmark
// ─────────────────────────────────────────────────────────────
function LogoMark() {
  return (
    <Link href="/" className="flex items-center gap-2.5 group select-none">
      {/* Spark icon pill */}
      <div
        className="h-10 w-10 rounded-[14px] bg-[var(--lifeos-pink)] grid place-items-center
          shadow-[0_2px_10px_rgba(255,107,107,0.35)]
          transition-all duration-200
          group-hover:shadow-[0_4px_18px_rgba(255,107,107,0.5)]
          group-hover:scale-105"
      >
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden="true">
          <path
            d="M12 2l2.09 6.26L21 10l-6.91 1.74L12 18l-2.09-5.74L3 10l6.91-1.74z"
            fill="white"
            stroke="white"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <circle cx="19.5" cy="4" r="1.2" fill="white" opacity="0.7" />
        </svg>
      </div>

      {/* Wordmark */}
      <div className="flex items-baseline gap-0">
        <span
          className="text-[22px] font-extrabold text-black"
          style={{ letterSpacing: "-0.04em" }}
        >
          life
        </span>
        <span
          className="text-[22px] font-extrabold text-[var(--lifeos-pink)]"
          style={{ letterSpacing: "-0.04em" }}
        >
          os
        </span>
      </div>
    </Link>
  );
}

// ─────────────────────────────────────────────────────────────
// Streak pill (decorative Duolingo nod)
// ─────────────────────────────────────────────────────────────
function StreakPill() {
  return (
    <div className="flex items-center gap-1.5 rounded-full bg-black/[0.045] px-3 py-1.5 select-none">
      <span className="text-base leading-none">🔥</span>
      <span className="text-sm font-bold text-black/55">1</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Nav config
// ─────────────────────────────────────────────────────────────
type NavItem = { href: string; label: string; icon: "spark" | "list" | "calendar" | "user" };

const NAV: NavItem[] = [
  { href: "/", label: "Today", icon: "spark" },
  { href: "/plan", label: "Plan", icon: "list" },
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
        if (prefs?.darkMode === true) {
          document.documentElement.classList.add("dark");
        } else {
          document.documentElement.classList.remove("dark");
        }
      }
    } catch {
      // ignore
    }
  }, []);

  return (
    <div className="min-h-screen" style={{ backgroundColor: "var(--background)" }}>

      {/* ── Sticky top header ── */}
      <header className="sticky top-0 z-40 backdrop-blur-md border-b border-black/[0.05]" style={{ backgroundColor: "var(--background)" }}>
        <div className={`mx-auto w-full ${MAX_W} px-6 h-16 flex items-center justify-between`}>
          <LogoMark />
          <StreakPill />
        </div>
      </header>

      {/* ── Page content ── */}
      <main className={`mx-auto w-full ${MAX_W} px-6 pb-28 pt-6`}>
        {children}
      </main>

      {/* ── Floating bottom nav ── */}
      <nav className="fixed bottom-0 left-0 right-0 z-30 pointer-events-none">
        <div
          className="nav-pill pointer-events-auto mx-4 mb-4 rounded-[28px]
            backdrop-blur-xl
            shadow-[0_8px_32px_rgba(0,0,0,0.12),0_2px_8px_rgba(0,0,0,0.06)]
            border border-black/[0.06]"
          style={{ backgroundColor: "var(--background)" }}
        >
          <div className={`mx-auto flex ${MAX_W} items-center justify-around px-2 py-2`}>
            {NAV.map((item) => {
              const active = pathname === item.href;

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className="relative flex flex-col items-center justify-center gap-1 px-5 py-2 min-w-[64px]"
                  aria-current={active ? "page" : undefined}
                >
                  {/* Animated active pill background */}
                  {active && (
                    <motion.div
                      layoutId="nav-active-pill"
                      className="absolute inset-0 rounded-[20px] bg-[var(--lifeos-pink)]/10"
                      transition={{ type: "spring", stiffness: 400, damping: 30 }}
                    />
                  )}

                  {/* Icon with tap spring */}
                  <motion.div
                    whileTap={{ scale: 0.82 }}
                    transition={{ type: "spring", stiffness: 500, damping: 22 }}
                    className="relative z-10"
                  >
                    <Icon name={item.icon} active={active} />
                  </motion.div>

                  {/* Label */}
                  <span
                    className={cx(
                      "relative z-10 text-[10px] font-bold tracking-wide transition-colors duration-200",
                      active ? "text-[var(--lifeos-pink)]" : "text-black/35"
                    )}
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
