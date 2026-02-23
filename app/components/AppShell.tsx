"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function Icon({ name, className }: { name: "spark" | "list" | "calendar" | "user"; className?: string }) {
  const common = cx("h-7 w-7", className ?? "text-black");

  // Simple, original line icons (inspired by common UI patterns, no brand assets)
  switch (name) {
    case "spark":
      // megaphone-ish ("coach")
      return (
        <svg viewBox="0 0 24 24" className={common} fill="none" aria-hidden="true">
          <path
            d="M3.5 11.5v-2.2c0-.5.4-.9.9-.9h2.6l9.3-3.6c.6-.2 1.2.2 1.2.9v12.6c0 .7-.6 1.1-1.2.9L7 15.7H4.4c-.5 0-.9-.4-.9-.9v-2.3"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
          <path
            d="M7.2 15.6l1.2 4.2c.2.6-.2 1.2-.8 1.3l-.9.2c-.5.1-1-.2-1.2-.7L4 15.6"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <path
            d="M20 9.2c.9 1 1.4 2 1.4 2.8s-.5 1.8-1.4 2.8"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      );
    case "list":
      return (
        <svg viewBox="0 0 24 24" className={common} fill="none" aria-hidden="true">
          <path d="M6 7h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M6 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M6 17h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M3.5 7h.01" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
          <path d="M3.5 12h.01" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
          <path d="M3.5 17h.01" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
        </svg>
      );
    case "calendar":
      return (
        <svg viewBox="0 0 24 24" className={common} fill="none" aria-hidden="true">
          <path d="M7 3v3M17 3v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <path
            d="M5 7.5h14a2 2 0 012 2V19a2.5 2.5 0 01-2.5 2.5H5.5A2.5 2.5 0 013 19V9.5a2 2 0 012-2z"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <path d="M3.5 10.5h17" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <path d="M7.5 13h3v3h-3z" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      );
    case "user":
      return (
        <svg viewBox="0 0 24 24" className={common} fill="none" aria-hidden="true">
          <path d="M12 12a4.3 4.3 0 100-8.6A4.3 4.3 0 0012 12z" stroke="currentColor" strokeWidth="1.6" />
          <path d="M4.5 21a7.5 7.5 0 0115 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );
  }
}

function LogoMark() {
  return (
    <div className="h-16 w-16 rounded-2xl bg-[var(--lifeos-pink)] grid place-items-center shadow-sm">
      <div className="text-white text-2xl font-extrabold tracking-tight" style={{ letterSpacing: "-0.02em" }}>
        lifeos
      </div>
    </div>
  );
}

type NavItem = { href: string; label: string; icon: "spark" | "list" | "calendar" | "user" };

const NAV: NavItem[] = [
  { href: "/", label: "Prompt", icon: "spark" },
  { href: "/plan", label: "Plan", icon: "list" },
  { href: "/calendar", label: "Calendar", icon: "calendar" },
  { href: "/profile", label: "Profile", icon: "user" },
];

export default function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  // LifeOS pages are intentionally roomy (especially Calendar). 6xl can feel cramped
  // on wide displays, so we use a larger centered max width while keeping the layout simple.
  const MAX_W = "max-w-[1700px]";

  return (
    <div className="min-h-screen bg-white">
      {/* Top logo area (simple, like your mockups) */}
      <header className="px-6 pt-6">
        <div className={`mx-auto w-full ${MAX_W}`}>
          <LogoMark />
        </div>
      </header>

      {/* Content */}
      <main className={`mx-auto w-full ${MAX_W} px-6 pb-28 pt-10`}>
        {children}
      </main>

      {/* Bottom nav (white bar + pink strip, active pink circle) */}
      <nav className="fixed bottom-0 left-0 right-0 z-30">
        <div className="h-4 bg-[var(--lifeos-pink)]" />
        <div className="bg-white">
          <div className={`mx-auto flex ${MAX_W} items-center justify-between px-10 py-4`}>
            {NAV.map((item) => {
              const active = pathname === item.href;
              const isProfile = item.icon === "user";

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className="flex flex-col items-center justify-center gap-2"
                  aria-current={active ? "page" : undefined}
                >
                  <div
                    className={cx(
                      "grid h-14 w-14 place-items-center rounded-full transition",
                      active ? "bg-[var(--lifeos-pink)]" : "bg-transparent",
                      isProfile && active ? "ring-4 ring-[var(--lifeos-pink)]" : ""
                    )}
                  >
                    <Icon name={item.icon} className={active ? "text-white" : "text-black"} />
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      </nav>
    </div>
  );
}
