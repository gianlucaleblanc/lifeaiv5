"use client";

import { useEffect, useMemo, useState } from "react";
import { loadPreferences, loadProfile, savePreferences, type UserPreferences, type UserProfile } from "../lib/storage";

function weekdayShort(yyyyMmDd: string) {
  const [y, m, d] = yyyyMmDd.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, { weekday: "short" });
}

// Toggle switch component
function Toggle({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${
        enabled ? "bg-[var(--lifeos-pink)]" : "bg-black/[0.12]"
      }`}
      role="switch"
      aria-checked={enabled}
    >
      <span
        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ${
          enabled ? "translate-x-5" : "translate-x-0"
        }`}
      />
    </button>
  );
}

export default function ProfilePage() {
  const [profile, setProfile] = useState<UserProfile>({ daysTracked: 0, avgCompletion: 0, last7: [] });
  const [prefs, setPrefs] = useState<UserPreferences | null>(null);

  useEffect(() => {
    setProfile(loadProfile());
    setPrefs(loadPreferences());
  }, []);

  const avgPct = Math.round((profile.avgCompletion ?? 0) * 100);
  const trend = useMemo(() => (profile.last7 ?? []).slice().reverse(), [profile.last7]);

  const consistencyLabel =
    avgPct >= 70 ? "On fire 🔥" :
    avgPct >= 45 ? "Building momentum 📈" :
    "Getting started 🌱";

  const suggestion =
    avgPct >= 70
      ? "You're consistent — add one small stretch goal only if you finish early."
      : avgPct >= 45
        ? "Tighten the first task so it's easier to start."
        : "Pick one small task for tomorrow and make it 5 minutes.";

  const coachFeedback =
    avgPct >= 70
      ? "You finish most of your days — keep it simple and repeatable."
      : avgPct >= 45
        ? "You're building momentum — make starting the first task easier."
        : "You're often not finishing — shrink the plan down to 1–2 core tasks.";

  function togglePref(key: "darkMode" | "suggestionsEnabled") {
    if (!prefs) return;
    const updated = { ...prefs, [key]: !prefs[key] };
    setPrefs(updated);
    savePreferences(updated);
    // Apply dark mode immediately
    if (key === "darkMode") {
      document.documentElement.classList.toggle("dark", updated.darkMode);
    }
  }

  return (
    <div
      className="relative min-h-[calc(100vh-80px)] flex flex-col"
      style={{
        background: "radial-gradient(ellipse 60% 40% at 50% 0%, rgba(255,107,107,0.06) 0%, transparent 65%)",
      }}
    >
      {/* ── Profile header ── */}
      <div className="flex items-center gap-5 mb-8">
        <div className="relative flex-shrink-0">
          <div className="h-20 w-20 rounded-3xl bg-gradient-to-br from-[var(--lifeos-pink)] to-[#ff8e8e] shadow-[0_4px_16px_rgba(255,107,107,0.35)] grid place-items-center">
            <span className="text-3xl select-none">😊</span>
          </div>
          <div className="absolute -bottom-0.5 -right-0.5 h-4 w-4 rounded-full bg-emerald-400 border-2 border-white shadow-sm" />
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-extrabold text-black" style={{ letterSpacing: "-0.03em" }}>
            Your Profile
          </h1>
          <div className="mt-1 flex items-center gap-2 flex-wrap">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--lifeos-pink)]/10 px-3 py-1 text-xs font-bold text-[var(--lifeos-pink)]">
              ✦ {consistencyLabel}
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-black/[0.05] px-3 py-1 text-xs font-semibold text-black/50">
              {profile.daysTracked} day{profile.daysTracked !== 1 ? "s" : ""} tracked
            </span>
          </div>
        </div>
      </div>

      {/* ── Stat cards row ── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
        {/* Completion */}
        <div className="col-span-2 sm:col-span-1 rounded-2xl bg-white border border-black/[0.06] p-5 flex flex-col gap-1">
          <div className="text-[11px] font-bold uppercase tracking-widest text-black/30">Avg completion</div>
          <div className="text-4xl font-extrabold text-black" style={{ letterSpacing: "-0.04em" }}>
            {avgPct > 0 ? `${avgPct}%` : "—"}
          </div>
          <div className="text-xs text-black/40 font-medium">over recent plans</div>
          {avgPct > 0 && (
            <>
              <div className="mt-3 h-2 rounded-full bg-black/[0.06] overflow-hidden">
                <div
                  className="h-full rounded-full bg-[var(--lifeos-pink)] transition-all duration-700"
                  style={{ width: `${avgPct}%` }}
                />
              </div>
              <div className="mt-1 text-[10px] text-black/30">{coachFeedback}</div>
            </>
          )}
          {avgPct === 0 && (
            <div className="mt-1 text-[10px] text-black/30">Generate your first plan to start tracking.</div>
          )}
        </div>

        {/* Days tracked */}
        <div className="rounded-2xl bg-white border border-black/[0.06] p-5 flex flex-col gap-1">
          <div className="text-[11px] font-bold uppercase tracking-widest text-black/30">Days tracked</div>
          <div className="text-4xl font-extrabold text-black" style={{ letterSpacing: "-0.04em" }}>
            {profile.daysTracked > 0 ? profile.daysTracked : "—"}
          </div>
          <div className="text-xs text-black/40 font-medium">since you started</div>
        </div>

        {/* Streak */}
        <div className="rounded-2xl bg-white border border-black/[0.06] p-5 flex flex-col gap-1">
          <div className="text-[11px] font-bold uppercase tracking-widest text-black/30">Streak</div>
          <div className="text-4xl font-extrabold text-black" style={{ letterSpacing: "-0.04em" }}>
            🔥 {profile.daysTracked > 0 ? profile.daysTracked : 1}
          </div>
          <div className="text-xs text-black/40 font-medium">days in a row</div>
        </div>
      </div>

      {/* ── Last 7 days bar chart ── */}
      <div className="rounded-2xl bg-white border border-black/[0.06] p-5 mb-4">
        <div className="flex items-center justify-between mb-4">
          <div className="text-xs font-bold text-black/70">Last 7 days</div>
          <div className="text-[10px] text-black/30">completion %</div>
        </div>

        {trend.length ? (
          <div className="flex items-end justify-between gap-2 h-20">
            {trend.map((d) => {
              const pct = Math.round(d.completion * 100);
              const heightPct = Math.max(6, pct);
              const barColor =
                pct >= 70 ? "bg-[var(--lifeos-pink)]" :
                pct >= 40 ? "bg-[var(--lifeos-pink)]/60" :
                            "bg-black/[0.08]";
              return (
                <div key={d.date} className="flex flex-col items-center gap-1.5 flex-1 group">
                  <div className="opacity-0 group-hover:opacity-100 transition-opacity text-[10px] font-bold text-black/50 pointer-events-none">
                    {pct}%
                  </div>
                  <div className="w-full flex items-end" style={{ height: 60 }}>
                    <div
                      className={`w-full rounded-lg transition-all duration-500 ${barColor}`}
                      style={{ height: `${heightPct}%` }}
                      title={`${d.date} · ${pct}%`}
                    />
                  </div>
                  <div className="text-[10px] font-semibold text-black/30">{weekdayShort(d.date)}</div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="h-20 flex items-center justify-center">
            <p className="text-xs text-black/30">No data yet — generate your first plan.</p>
          </div>
        )}
      </div>

      {/* ── AI suggestion card ── */}
      <div className="rounded-2xl border border-[var(--lifeos-pink)]/20 bg-[var(--lifeos-pink)]/5 p-5 mb-4">
        <div className="flex items-start gap-3">
          <div className="h-8 w-8 rounded-xl bg-[var(--lifeos-pink)] flex-shrink-0 grid place-items-center shadow-[0_2px_8px_rgba(255,107,107,0.3)]">
            <span className="text-white text-sm">✦</span>
          </div>
          <div>
            <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--lifeos-pink)]/60 mb-1">Coach tip</div>
            <p className="text-sm font-semibold text-black/80">{suggestion}</p>
          </div>
        </div>
      </div>

      {/* ── Settings section ── */}
      <div className="rounded-2xl bg-white border border-black/[0.06] p-5">
        <div className="text-[11px] font-bold uppercase tracking-widest text-black/30 mb-4">Settings</div>
        <div className="space-y-1">

          {/* Dark mode toggle */}
          <div className="flex items-center gap-4 rounded-xl px-4 py-3 hover:bg-black/[0.03] transition-colors">
            <span className="text-xl flex-shrink-0">🌙</span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-black/80">Dark mode</div>
              <div className="text-xs text-black/40">Switch to a darker interface</div>
            </div>
            {prefs !== null && (
              <Toggle enabled={prefs.darkMode} onToggle={() => togglePref("darkMode")} />
            )}
          </div>

          {/* AI suggestions toggle */}
          <div className="flex items-center gap-4 rounded-xl px-4 py-3 hover:bg-black/[0.03] transition-colors">
            <span className="text-xl flex-shrink-0">✨</span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-black/80">AI suggestions</div>
              <div className="text-xs text-black/40">Show prep & recovery ideas after scheduling</div>
            </div>
            {prefs !== null && (
              <Toggle enabled={prefs.suggestionsEnabled} onToggle={() => togglePref("suggestionsEnabled")} />
            )}
          </div>

          {/* Notifications (placeholder) */}
          <div className="flex items-center gap-4 rounded-xl px-4 py-3 hover:bg-black/[0.03] transition-colors cursor-pointer">
            <span className="text-xl flex-shrink-0">🔔</span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-black/80">Notifications</div>
              <div className="text-xs text-black/40">Get reminders for upcoming events</div>
            </div>
            <span className="text-xs text-black/25 font-medium">Coming soon</span>
          </div>

          {/* Calendar sync (placeholder) */}
          <div className="flex items-center gap-4 rounded-xl px-4 py-3 hover:bg-black/[0.03] transition-colors cursor-pointer">
            <span className="text-xl flex-shrink-0">📅</span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-black/80">Calendar sync</div>
              <div className="text-xs text-black/40">Connect Google Calendar</div>
            </div>
            <span className="text-xs text-black/25 font-medium">Coming soon</span>
          </div>

          {/* Data & privacy */}
          <div className="flex items-center gap-4 rounded-xl px-4 py-3 hover:bg-black/[0.03] transition-colors cursor-pointer">
            <span className="text-xl flex-shrink-0">🔒</span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-black/80">Data & privacy</div>
              <div className="text-xs text-black/40">All data stored locally on your device</div>
            </div>
            <span className="text-black/20 flex-shrink-0">›</span>
          </div>

        </div>
      </div>
    </div>
  );
}
