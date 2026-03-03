"use client";

import { useEffect, useMemo, useState } from "react";
import { loadPreferences, loadProfile, savePreferences, loadOnboardingProfile, type UserPreferences, type UserProfile } from "../lib/storage";
import { useToast } from "../components/Toast";

function weekdayShort(yyyyMmDd: string) {
  const [y, m, d] = yyyyMmDd.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short" });
}

function Toggle({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none hover:scale-105 active:scale-95 ${enabled ? "bg-[var(--lifeos-pink)]" : "bg-black/[0.12]"}`}
      role="switch"
      aria-checked={enabled}
    >
      <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ${enabled ? "translate-x-5" : "translate-x-0"}`} />
    </button>
  );
}

// ── Accent color palette ─────────────────────────────────────
const ACCENT_COLORS = [
  { color: "#d96c7d", label: "Rose" },
  { color: "#6C8EE8", label: "Blue" },
  { color: "#5BA85E", label: "Green" },
  { color: "#E8A83C", label: "Amber" },
  { color: "#9B6CE8", label: "Purple" },
  { color: "#E87050", label: "Coral" },
  { color: "#1a1a1a", label: "Noir" },
];

// ── Achievement badges ───────────────────────────────────────
type Badge = { emoji: string; title: string; desc: string; earned: boolean };

function computeBadges(profile: UserProfile): Badge[] {
  const avgPct = Math.round((profile.avgCompletion ?? 0) * 100);
  const days = profile.daysTracked ?? 0;
  const calRaw = typeof window !== "undefined" ? window.localStorage.getItem("lifeos_calendar_v1") : null;
  const calCount = (() => {
    try { const p = JSON.parse(calRaw ?? "[]"); return Array.isArray(p) ? p.length : 0; } catch { return 0; }
  })();
  return [
    { emoji: "🎓", title: "First Import", desc: "Import your first syllabus", earned: calCount > 0 },
    { emoji: "📅", title: "First Plan", desc: "Generate your first plan", earned: days >= 1 },
    { emoji: "🔥", title: "3-Day Streak", desc: "Use LifeOS 3 days in a row", earned: days >= 3 },
    { emoji: "⭐", title: "Perfect Day", desc: "Hit 100% completion", earned: (profile.last7 ?? []).some((d) => d.completion >= 1) },
    { emoji: "🚀", title: "7-Day Streak", desc: "Use LifeOS 7 days in a row", earned: days >= 7 },
    { emoji: "📚", title: "Scholar", desc: "Add 20+ calendar blocks", earned: calCount >= 20 },
    { emoji: "💪", title: "Consistent", desc: "Average 70%+ completion", earned: avgPct >= 70 },
    { emoji: "🌟", title: "30-Day Pro", desc: "30 consecutive days tracked", earned: days >= 30 },
  ];
}

export default function ProfilePage() {
  const { toast } = useToast();
  const [profile, setProfile] = useState<UserProfile>({ daysTracked: 0, avgCompletion: 0, last7: [] });
  const [prefs, setPrefs] = useState<UserPreferences | null>(null);
  const [accentColor, setAccentColor] = useState("#d96c7d");
  const [streak, setStreak] = useState(0);
  const [userName, setUserName] = useState<string | null>(null);
  const [showSoonExpanded, setShowSoonExpanded] = useState(false);
  const [showPrivacyModal, setShowPrivacyModal] = useState(false);

  useEffect(() => {
    setProfile(loadProfile());
    setPrefs(loadPreferences());
    // Load user's name from onboarding
    const onboarding = loadOnboardingProfile();
    if (onboarding?.name && onboarding.name !== "Friend") {
      setUserName(onboarding.name.split(" ")[0]);
    }
    // Load accent color
    const saved = window.localStorage.getItem("lifeos_accent_color_v1");
    if (saved) setAccentColor(saved);
    // Compute streak
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
      else if (i > 0) break;
    }
    setStreak(count);
  }, []);

  const avgPct = Math.round((profile.avgCompletion ?? 0) * 100);
  const trend = useMemo(() => (profile.last7 ?? []).slice().reverse(), [profile.last7]);

  const consistencyLabel =
    avgPct >= 70 ? "On fire 🔥" :
    avgPct >= 45 ? "Building momentum 📈" :
    "Getting started 🌱";

  const suggestion =
    avgPct >= 70 ? "You're consistent — add one small stretch goal only if you finish early." :
    avgPct >= 45 ? "Tighten the first task so it's easier to start." :
    "Pick one small task for tomorrow and make it 5 minutes.";

  const coachFeedback =
    avgPct >= 70 ? "You finish most of your days — keep it simple and repeatable." :
    avgPct >= 45 ? "You're building momentum — make starting the first task easier." :
    "You're often not finishing — shrink the plan down to 1–2 core tasks.";

  function togglePref(key: "darkMode" | "suggestionsEnabled") {
    if (!prefs) return;
    const updated = { ...prefs, [key]: !prefs[key] };
    setPrefs(updated);
    savePreferences(updated);
    if (key === "darkMode") document.documentElement.classList.toggle("dark", updated.darkMode);
    toast(key === "darkMode" ? (updated.darkMode ? "Dark mode on" : "Light mode on") : (updated.suggestionsEnabled ? "AI suggestions on" : "AI suggestions off"), "info");
  }

  function changeAccent(color: string) {
    setAccentColor(color);
    document.documentElement.style.setProperty("--lifeos-pink", color);
    window.localStorage.setItem("lifeos_accent_color_v1", color);
    toast("Accent color updated", "success");
  }

  const badges = useMemo(() => computeBadges(profile), [profile]);
  const earnedCount = badges.filter((b) => b.earned).length;

  return (
    <div
      className="relative min-h-[calc(100vh-80px)] flex flex-col"
      style={{ background: "radial-gradient(ellipse 60% 40% at 50% 0%, rgba(255,107,107,0.06) 0%, transparent 65%)" }}
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
            {userName ? `Hey, ${userName}` : "Your Profile"}
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
        <div className="col-span-2 sm:col-span-1 rounded-2xl bg-white border border-black/[0.06] p-5 flex flex-col gap-1">
          <div className="text-[11px] font-bold uppercase tracking-widest text-black/30">Avg completion</div>
          <div className="text-4xl font-extrabold text-black" style={{ letterSpacing: "-0.04em" }}>
            {avgPct > 0 ? `${avgPct}%` : "—"}
          </div>
          <div className="text-xs text-black/40 font-medium">over recent plans</div>
          {avgPct > 0 && (
            <>
              <div className="mt-3 h-2 rounded-full bg-black/[0.06] overflow-hidden">
                <div className="h-full rounded-full bg-[var(--lifeos-pink)] transition-all duration-700" style={{ width: `${avgPct}%` }} />
              </div>
              <div className="mt-1 text-[10px] text-black/30 leading-snug">{coachFeedback}</div>
            </>
          )}
          {avgPct === 0 && <div className="mt-1 text-[10px] text-black/30">Generate your first plan to start tracking.</div>}
        </div>

        <div className="rounded-2xl bg-white border border-black/[0.06] p-5 flex flex-col gap-1">
          <div className="text-[11px] font-bold uppercase tracking-widest text-black/30">Days tracked</div>
          <div className="text-4xl font-extrabold text-black" style={{ letterSpacing: "-0.04em" }}>
            {profile.daysTracked > 0 ? profile.daysTracked : "—"}
          </div>
          <div className="text-xs text-black/40 font-medium">since you started</div>
        </div>

        <div className="rounded-2xl bg-white border border-black/[0.06] p-5 flex flex-col gap-1">
          <div className="text-[11px] font-bold uppercase tracking-widest text-black/30">Streak</div>
          <div className="text-4xl font-extrabold text-black" style={{ letterSpacing: "-0.04em" }}>
            {streak > 0 ? `🔥 ${streak}` : "—"}
          </div>
          <div className="text-xs text-black/40 font-medium">{streak > 0 ? "days in a row" : "Start today!"}</div>
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
              const barColor = pct >= 70 ? "bg-[var(--lifeos-pink)]" : pct >= 40 ? "bg-[var(--lifeos-pink)]/60" : "bg-black/[0.08]";
              return (
                <div key={d.date} className="flex flex-col items-center gap-1.5 flex-1 group">
                  <div className="opacity-0 group-hover:opacity-100 transition-opacity text-[10px] font-bold text-black/50 pointer-events-none">{pct}%</div>
                  <div className="w-full flex items-end" style={{ height: 60 }}>
                    <div className={`w-full rounded-lg transition-all duration-500 hover:opacity-80 ${barColor}`} style={{ height: `${heightPct}%` }} title={`${d.date} · ${pct}%`} />
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

      {/* ── Achievements ── */}
      <div className="rounded-2xl bg-white border border-black/[0.06] p-5 mb-4">
        <div className="flex items-center justify-between mb-4">
          <div className="text-[11px] font-bold uppercase tracking-widest text-black/30">Achievements</div>
          <div className="text-xs font-semibold text-black/40">{earnedCount}/{badges.length} earned</div>
        </div>
        <div className="grid grid-cols-4 sm:grid-cols-8 gap-3">
          {badges.map((badge) => (
            <div key={badge.title} className="group flex flex-col items-center gap-1.5 relative" title={`${badge.title}: ${badge.desc}`}>
              <div className={`h-12 w-12 rounded-2xl flex items-center justify-center text-2xl transition-all ${badge.earned ? "bg-[var(--lifeos-pink)]/10 shadow-[0_2px_8px_rgba(255,107,107,0.15)]" : "bg-black/[0.04] grayscale opacity-40"}`}>
                {badge.emoji}
              </div>
              <div className={`text-[9px] font-bold text-center leading-tight ${badge.earned ? "text-black/60" : "text-black/25"}`}>{badge.title}</div>
              {badge.earned && (
                <div className="absolute -top-1 -right-1 h-3.5 w-3.5 rounded-full bg-emerald-400 border-2 border-white flex items-center justify-center">
                  <span className="text-white" style={{ fontSize: 7, lineHeight: 1 }}>✓</span>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ── AI coach card ── */}
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

          {/* Accent color */}
          <div className="flex items-center gap-4 rounded-xl px-4 py-3">
            <span className="text-xl flex-shrink-0">🎨</span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-black/80">Accent color</div>
              <div className="text-xs text-black/40">Personalise your LifeOS theme</div>
            </div>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              {ACCENT_COLORS.map(({ color, label }) => (
                <button
                  key={color}
                  onClick={() => changeAccent(color)}
                  className="h-5 w-5 rounded-full transition-all hover:scale-125 active:scale-95 flex-shrink-0"
                  style={{
                    backgroundColor: color,
                    outline: accentColor === color ? `2px solid ${color}` : "2px solid transparent",
                    outlineOffset: "2px",
                  }}
                  title={label}
                  aria-label={`Set accent to ${label}`}
                />
              ))}
            </div>
          </div>

          {/* Dark mode toggle */}
          <div className="flex items-center gap-4 rounded-xl px-4 py-3 hover:bg-black/[0.03] transition-colors">
            <span className="text-xl flex-shrink-0">🌙</span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-black/80">Dark mode</div>
              <div className="text-xs text-black/40">Switch to a darker interface</div>
            </div>
            {prefs !== null && <Toggle enabled={prefs.darkMode} onToggle={() => togglePref("darkMode")} />}
          </div>

          {/* AI suggestions toggle */}
          <div className="flex items-center gap-4 rounded-xl px-4 py-3 hover:bg-black/[0.03] transition-colors">
            <span className="text-xl flex-shrink-0">✨</span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-black/80">AI suggestions</div>
              <div className="text-xs text-black/40">Show prep & recovery ideas after scheduling</div>
            </div>
            {prefs !== null && <Toggle enabled={prefs.suggestionsEnabled} onToggle={() => togglePref("suggestionsEnabled")} />}
          </div>

          {/* Coming soon — collapsed row */}
          <button
            onClick={() => setShowSoonExpanded((v) => !v)}
            className="w-full flex items-center gap-4 rounded-xl px-4 py-3 hover:bg-black/[0.03] transition-colors text-left"
          >
            <span className="text-xl flex-shrink-0">🚀</span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-black/80">Coming soon</div>
              <div className="text-xs text-black/40">Notifications, Google Calendar sync &amp; more</div>
            </div>
            <span className={`text-black/25 transition-transform duration-200 ${showSoonExpanded ? "rotate-90" : ""}`}>›</span>
          </button>
          {showSoonExpanded && (
            <div className="mx-4 mb-1 rounded-xl border border-black/[0.05] bg-black/[0.02] divide-y divide-black/[0.04] overflow-hidden">
              <div className="flex items-center gap-3 px-4 py-3 opacity-50">
                <span className="text-base">🔔</span>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-semibold text-black/70">Notifications</div>
                  <div className="text-[11px] text-black/40">Reminders for upcoming events</div>
                </div>
                <span className="text-[10px] text-black/30 font-bold bg-black/[0.06] rounded-full px-2 py-0.5">Soon</span>
              </div>
              <div className="flex items-center gap-3 px-4 py-3 opacity-50">
                <span className="text-base">🗓</span>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-semibold text-black/70">Google Calendar sync</div>
                  <div className="text-[11px] text-black/40">Two-way sync with your Google Calendar</div>
                </div>
                <span className="text-[10px] text-black/30 font-bold bg-black/[0.06] rounded-full px-2 py-0.5">Soon</span>
              </div>
            </div>
          )}

          {/* Data & privacy — opens modal */}
          <button
            onClick={() => setShowPrivacyModal(true)}
            className="w-full flex items-center gap-4 rounded-xl px-4 py-3 hover:bg-black/[0.03] transition-colors text-left"
          >
            <span className="text-xl flex-shrink-0">🔒</span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-black/80">Data &amp; privacy</div>
              <div className="text-xs text-black/40">All data stored locally on your device</div>
            </div>
            <span className="text-black/20 flex-shrink-0">›</span>
          </button>

          {/* Privacy modal */}
          {showPrivacyModal && (
            <div
              className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/30 backdrop-blur-sm px-4 pb-4 sm:pb-0"
              onClick={() => setShowPrivacyModal(false)}
            >
              <div
                className="w-full max-w-sm rounded-3xl bg-white border border-black/[0.06] shadow-2xl p-6 space-y-4"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-2xl bg-black/[0.05] grid place-items-center flex-shrink-0">
                    <span className="text-lg">🔒</span>
                  </div>
                  <div>
                    <div className="text-base font-bold text-black/80">Data &amp; Privacy</div>
                    <div className="text-xs text-black/40">How LifeOS stores your information</div>
                  </div>
                </div>
                <div className="space-y-3 text-sm text-black/60 leading-relaxed">
                  <p>
                    <span className="font-semibold text-black/80">100% local storage.</span> All your plans, calendar blocks, and preferences are saved only in your browser&apos;s localStorage. Nothing is sent to any server.
                  </p>
                  <p>
                    <span className="font-semibold text-black/80">AI calls are stateless.</span> When you generate a plan or import a syllabus, your text is sent to the AI API for that request only and is not stored or used for training.
                  </p>
                  <p>
                    <span className="font-semibold text-black/80">Clear your data anytime.</span> Clearing your browser&apos;s site data for this app removes everything instantly.
                  </p>
                </div>
                <button
                  onClick={() => setShowPrivacyModal(false)}
                  className="w-full rounded-2xl bg-black/[0.05] py-3 text-sm font-bold text-black/60 hover:bg-black/[0.08] transition-colors"
                >
                  Got it
                </button>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
