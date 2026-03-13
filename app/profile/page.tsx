"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { loadPreferences, loadProfile, savePreferences, loadOnboardingProfile, type UserPreferences, type UserProfile } from "../lib/storage-sync";
import { useToast } from "../components/Toast";
import { applyAccentDarkAttribute } from "../components/AppShell";
import { useAuth } from "../components/AuthProvider";
import { isGoogleCalendarConnected } from "../lib/googleCalendar";
import { isOutlookCalendarConnected } from "../lib/outlookCalendar";

// ── Profile Picture Component ────────────────────────────────
function ProfilePicture({
  userName,
  photoUrl,
  accentColor,
  onPhotoChange,
}: {
  userName: string | null;
  photoUrl: string | null;
  accentColor: string;
  onPhotoChange: (url: string | null) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [showMenu, setShowMenu] = useState(false);

  const initials = userName
    ? userName.split(" ").map((w) => w[0]).join("").toUpperCase().slice(0, 2)
    : "?";

  function handleFile(file: File) {
    if (!file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const result = e.target?.result as string;
      if (result) {
        onPhotoChange(result);
        localStorage.setItem("openhour_profile_photo_v1", result);
      }
    };
    reader.readAsDataURL(file);
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    setShowMenu(false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  }

  function removePhoto() {
    onPhotoChange(null);
    localStorage.removeItem("openhour_profile_photo_v1");
    setShowMenu(false);
  }

  return (
    <div className="relative flex-shrink-0">
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleInputChange}
      />

      {/* Avatar */}
      <div
        className={`relative h-20 w-20 rounded-3xl overflow-hidden cursor-pointer transition-all duration-200 hover:scale-105 active:scale-95 shadow-[0_4px_20px_rgba(0,0,0,0.12)] ${dragging ? "ring-2 ring-offset-2 ring-[var(--lifeos-pink)] scale-105" : ""}`}
        onClick={() => setShowMenu((v) => !v)}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        style={{ background: photoUrl ? undefined : `linear-gradient(135deg, ${accentColor}, ${accentColor}99)` }}
      >
        {photoUrl ? (
          <img src={photoUrl} alt="Profile" className="h-full w-full object-cover" />
        ) : (
          <div className="h-full w-full flex items-center justify-center">
            <span className="text-white text-2xl font-black select-none" style={{ letterSpacing: "-0.02em" }}>
              {initials}
            </span>
          </div>
        )}

        {/* Hover overlay */}
        <div className="absolute inset-0 bg-black/0 hover:bg-black/25 transition-colors duration-200 flex items-center justify-center">
          <svg className="opacity-0 hover:opacity-100 transition-opacity w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </div>
      </div>

      {/* Online indicator */}
      <div className="absolute -bottom-0.5 -right-0.5 h-4 w-4 rounded-full bg-emerald-400 border-2 border-white shadow-sm" />

      {/* Edit menu */}
      {showMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
          <div className="absolute left-0 top-[88px] z-50 w-44 rounded-2xl overflow-hidden" style={{ background: "var(--surface-overlay)", border: "1px solid var(--divider)", boxShadow: "var(--shadow-lg)" }}>
            <button
              onClick={() => { fileInputRef.current?.click(); }}
              className="w-full flex items-center gap-3 px-4 py-3 text-sm font-semibold text-[var(--text-secondary)] hover:bg-black/[0.04] transition-colors text-left"
            >
              <span className="text-base">📷</span> Upload photo
            </button>
            <button
              onClick={() => { fileInputRef.current?.click(); }}
              className="w-full flex items-center gap-3 px-4 py-3 text-sm font-semibold text-[var(--text-secondary)] hover:bg-black/[0.04] transition-colors text-left"
            >
              <span className="text-base">🖼️</span> Choose from library
            </button>
            {photoUrl && (
              <button
                onClick={removePhoto}
                className="w-full flex items-center gap-3 px-4 py-3 text-sm font-semibold text-red-500 hover:bg-red-50 transition-colors text-left"
                style={{ borderTop: "1px solid var(--divider)" }}
              >
                <span className="text-base">🗑️</span> Remove photo
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function weekdayShort(yyyyMmDd: string) {
  const [y, m, d] = yyyyMmDd.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short" });
}

function Toggle({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className={`relative inline-flex h-[22px] w-10 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-all duration-200 focus:outline-none active:scale-95 ${enabled ? "bg-[var(--lifeos-pink)]" : "bg-black/[0.12]"}`}
      role="switch"
      aria-checked={enabled}
    >
      <span className={`pointer-events-none inline-block h-[18px] w-[18px] transform rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.25)] ring-0 transition duration-200 ${enabled ? "translate-x-[18px]" : "translate-x-0"}`} />
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
  const calRaw = typeof window !== "undefined" ? window.localStorage.getItem("openhour_calendar_v1") : null;
  const calCount = (() => {
    try { const p = JSON.parse(calRaw ?? "[]"); return Array.isArray(p) ? p.length : 0; } catch { return 0; }
  })();
  return [
    { emoji: "🎓", title: "First Import", desc: "Import your first syllabus", earned: calCount > 0 },
    { emoji: "📅", title: "First Plan", desc: "Generate your first plan", earned: days >= 1 },
    { emoji: "🔥", title: "3-Day Streak", desc: "Use OpenHour 3 days in a row", earned: days >= 3 },
    { emoji: "⭐", title: "Perfect Day", desc: "Hit 100% completion", earned: (profile.last7 ?? []).some((d) => d.completion >= 1) },
    { emoji: "🚀", title: "7-Day Streak", desc: "Use OpenHour 7 days in a row", earned: days >= 7 },
    { emoji: "📚", title: "Scholar", desc: "Add 20+ calendar blocks", earned: calCount >= 20 },
    { emoji: "💪", title: "Consistent", desc: "Average 70%+ completion", earned: avgPct >= 70 },
    { emoji: "🌟", title: "30-Day Pro", desc: "30 consecutive days tracked", earned: days >= 30 },
  ];
}

export default function ProfilePage() {
  const { toast } = useToast();
  const { user, signInWithGoogle, signOut } = useAuth();
  const [profile, setProfile] = useState<UserProfile>({ daysTracked: 0, avgCompletion: 0, last7: [] });
  const [prefs, setPrefs] = useState<UserPreferences | null>(null);
  const [accentColor, setAccentColor] = useState("#d96c7d");
  const [streak, setStreak] = useState(0);
  const [userName, setUserName] = useState<string | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [showSoonExpanded, setShowSoonExpanded] = useState(false);
  const [showPrivacyModal, setShowPrivacyModal] = useState(false);
  const [gcalConnected, setGcalConnected] = useState(false);
  const [outlookConnected, setOutlookConnected] = useState(false);

  useEffect(() => {
    setProfile(loadProfile());
    setPrefs(loadPreferences());
    setGcalConnected(isGoogleCalendarConnected());
    setOutlookConnected(isOutlookCalendarConnected());
    // Load user's name from onboarding
    const onboarding = loadOnboardingProfile();
    if (onboarding?.name && onboarding.name !== "Friend") {
      setUserName(onboarding.name.split(" ")[0]);
    }
    // Load accent color
    const saved = window.localStorage.getItem("openhour_accent_color_v1");
    if (saved) setAccentColor(saved);
    // Load profile photo
    const savedPhoto = window.localStorage.getItem("openhour_profile_photo_v1");
    if (savedPhoto) setPhotoUrl(savedPhoto);
    // Compute streak
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

  function togglePref(key: "darkMode" | "suggestionsEnabled" | "gcalWriteBack") {
    if (!prefs) return;
    const updated = { ...prefs, [key]: !prefs[key] };
    setPrefs(updated);
    savePreferences(updated);
    if (key === "darkMode") {
      document.documentElement.classList.toggle("dark", updated.darkMode);
      // Re-apply accent dark attribute whenever dark mode changes
      const accent = window.localStorage.getItem("openhour_accent_color_v1");
      if (accent) applyAccentDarkAttribute(accent);
    }
    const toastMsg =
      key === "darkMode" ? (updated.darkMode ? "Dark mode on" : "Light mode on") :
      key === "gcalWriteBack" ? (updated.gcalWriteBack ? "New blocks will sync to Google Calendar" : "Google Calendar write-back off") :
      (updated.suggestionsEnabled ? "AI suggestions on" : "AI suggestions off");
    toast(toastMsg, "info");
  }

  async function toggleNotifications() {
    if (!prefs) return;
    const enabling = !prefs.notificationsEnabled;
    if (enabling && typeof Notification !== "undefined" && Notification.permission !== "granted") {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        toast("Permission denied — enable notifications in browser settings", "error");
        return;
      }
    }
    const updated = { ...prefs, notificationsEnabled: enabling };
    setPrefs(updated);
    savePreferences(updated);
    toast(enabling ? "15-min reminders on" : "Reminders off", "info");
  }

  function changeAccent(color: string) {
    setAccentColor(color);
    document.documentElement.style.setProperty("--lifeos-pink", color);
    window.localStorage.setItem("openhour_accent_color_v1", color);
    applyAccentDarkAttribute(color);
    toast("Accent color updated", "success");
  }

  const badges = useMemo(() => computeBadges(profile), [profile]);
  const earnedCount = badges.filter((b) => b.earned).length;

  return (
    <div
      className="relative min-h-[calc(100vh-80px)] flex flex-col"
      style={{ background: "radial-gradient(ellipse 60% 40% at 50% 0%, rgba(var(--lifeos-pink-rgb), 0.055) 0%, transparent 65%)" }}
    >
      {/* ── Profile header ── */}
      <div className="flex items-center gap-5 mb-7">
        <ProfilePicture
          userName={userName}
          photoUrl={photoUrl}
          accentColor={accentColor}
          onPhotoChange={setPhotoUrl}
        />
        <div className="flex-1 min-w-0">
          <h1 className="text-[22px] font-extrabold text-black" style={{ letterSpacing: "-0.03em", lineHeight: 1.2 }}>
            {userName ? `Hey, ${userName}` : "Your Profile"}
          </h1>
          <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
            <span className="ui-badge" style={{ color: "var(--lifeos-pink)", background: "rgba(var(--lifeos-pink-rgb),0.1)" }}>
              ✦ {consistencyLabel}
            </span>
            <span className="ui-badge">
              {profile.daysTracked} day{profile.daysTracked !== 1 ? "s" : ""} tracked
            </span>
          </div>
          <p className="mt-1.5 text-[11px] text-[var(--text-faint)] font-medium">Tap your photo to change it</p>
        </div>
      </div>

      {/* ── Stat cards row ── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-5">
        <div className="col-span-2 sm:col-span-1 ui-card p-5 flex flex-col gap-1">
          <div className="ui-eyebrow">Avg completion</div>
          <div className="text-[32px] font-extrabold text-[var(--text-primary)]" style={{ letterSpacing: "-0.04em", lineHeight: 1 }}>
            {avgPct > 0 ? `${avgPct}%` : "—"}
          </div>
          <div className="text-xs text-[var(--text-faint)] font-medium mt-0.5">over recent plans</div>
          {avgPct > 0 && (
            <>
              <div className="mt-3 h-1.5 rounded-full bg-black/[0.06] overflow-hidden">
                <div className="h-full rounded-full bg-[var(--lifeos-pink)] transition-all duration-700" style={{ width: `${avgPct}%` }} />
              </div>
              <div className="mt-1.5 text-[10px] text-[var(--text-faint)] leading-snug">{coachFeedback}</div>
            </>
          )}
          {avgPct === 0 && <div className="mt-1 text-[10px] text-[var(--text-faint)]">Generate your first plan to start tracking.</div>}
        </div>

        <div className="ui-card p-5 flex flex-col gap-1">
          <div className="ui-eyebrow">Days tracked</div>
          <div className="text-[32px] font-extrabold text-[var(--text-primary)]" style={{ letterSpacing: "-0.04em", lineHeight: 1 }}>
            {profile.daysTracked > 0 ? profile.daysTracked : "—"}
          </div>
          <div className="text-xs text-[var(--text-faint)] font-medium mt-0.5">since you started</div>
        </div>

        <div className="ui-card p-5 flex flex-col gap-1">
          <div className="ui-eyebrow">Streak</div>
          <div className="text-[32px] font-extrabold text-[var(--text-primary)]" style={{ letterSpacing: "-0.04em", lineHeight: 1 }}>
            {streak > 0 ? `🔥 ${streak}` : "—"}
          </div>
          <div className="text-xs text-[var(--text-faint)] font-medium mt-0.5">{streak > 0 ? "days in a row" : "Start today!"}</div>
        </div>
      </div>

      {/* ── Last 7 days bar chart ── */}
      <div className="ui-card p-5 mb-4">
        <div className="flex items-center justify-between mb-4">
          <div className="text-xs font-bold text-[var(--text-secondary)]">Last 7 days</div>
          <div className="text-[10px] text-[var(--text-faint)]">completion %</div>
        </div>
        {trend.length ? (
          <div className="flex items-end justify-between gap-1.5 h-20">
            {trend.map((d) => {
              const pct = Math.round(d.completion * 100);
              const heightPct = Math.max(6, pct);
              const barColor = pct >= 70 ? "bg-[var(--lifeos-pink)]" : pct >= 40 ? "bg-[var(--lifeos-pink)]/50" : "bg-black/[0.07]";
              return (
                <div key={d.date} className="flex flex-col items-center gap-1.5 flex-1 group">
                  <div className="opacity-0 group-hover:opacity-100 transition-opacity text-[10px] font-bold text-[var(--text-muted)] pointer-events-none">{pct}%</div>
                  <div className="w-full flex items-end" style={{ height: 56 }}>
                    <div className={`w-full rounded-md transition-all duration-500 hover:opacity-80 ${barColor}`} style={{ height: `${heightPct}%` }} title={`${d.date} · ${pct}%`} />
                  </div>
                  <div className="text-[9px] font-bold text-[var(--text-faint)] uppercase tracking-wide">{weekdayShort(d.date)}</div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="h-20 flex items-center justify-center">
            <p className="text-xs text-[var(--text-faint)]">No data yet — generate your first plan.</p>
          </div>
        )}
      </div>

      {/* ── Achievements ── */}
      <div className="ui-card p-5 mb-4">
        <div className="flex items-center justify-between mb-4">
          <div className="ui-eyebrow">Achievements</div>
          <div className="text-xs font-semibold text-[var(--text-muted)]">{earnedCount}/{badges.length} earned</div>
        </div>
        <div className="grid grid-cols-4 sm:grid-cols-8 gap-2.5">
          {badges.map((badge) => (
            <div key={badge.title} className="group flex flex-col items-center gap-1.5 relative" title={`${badge.title}: ${badge.desc}`}>
              <div className={`h-11 w-11 rounded-[14px] flex items-center justify-center text-xl transition-all duration-200 ${badge.earned ? "shadow-[var(--shadow-sm)]" : "grayscale opacity-30"}`}
                style={badge.earned ? { background: "rgba(var(--lifeos-pink-rgb),0.09)", boxShadow: "0 1px 6px rgba(var(--lifeos-pink-rgb),0.12)" } : { background: "var(--surface-subtle)" }}>
                {badge.emoji}
              </div>
              <div className={`text-[9px] font-bold text-center leading-tight ${badge.earned ? "text-[var(--text-secondary)]" : "text-[var(--text-faint)]"}`}>{badge.title}</div>
              {badge.earned && (
                <div className="absolute -top-0.5 -right-0.5 h-3.5 w-3.5 rounded-full bg-emerald-400 border-2 border-white flex items-center justify-center">
                  <span className="text-white" style={{ fontSize: 7, lineHeight: 1 }}>✓</span>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ── AI coach card ── */}
      <div className="rounded-2xl border p-5 mb-4" style={{ borderColor: "rgba(var(--lifeos-pink-rgb),0.2)", background: "rgba(var(--lifeos-pink-rgb),0.04)" }}>
        <div className="flex items-start gap-3">
          <div className="h-8 w-8 rounded-[10px] bg-[var(--lifeos-pink)] flex-shrink-0 grid place-items-center" style={{ boxShadow: "var(--shadow-accent)" }}>
            <span className="text-white text-sm font-bold">✦</span>
          </div>
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest mb-1.5" style={{ color: "rgba(var(--lifeos-pink-rgb),0.6)" }}>Coach tip</div>
            <p className="text-sm font-semibold text-[var(--text-secondary)] leading-relaxed">{suggestion}</p>
          </div>
        </div>
      </div>

      {/* ── Cloud sync banner (shown only when not signed in) ── */}
      {!user && (
        <div className="rounded-2xl border border-[var(--lifeos-pink)]/25 bg-gradient-to-br from-[var(--lifeos-pink)]/8 to-[var(--lifeos-pink)]/3 p-5 mb-4">
          <div className="flex items-start gap-4">
            <div className="h-11 w-11 rounded-2xl bg-[var(--lifeos-pink)]/15 flex-shrink-0 grid place-items-center">
              <span className="text-2xl">☁️</span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-bold text-black/80 mb-0.5">Back up your data</div>
              <div className="text-xs text-black/50 leading-relaxed mb-4">
                Sign in with Google to sync your calendar and preferences across all your devices — free, always.
              </div>
              <button
                onClick={signInWithGoogle}
                className="flex items-center gap-2.5 rounded-xl bg-white border border-black/10 px-4 py-2.5 text-sm font-bold text-black shadow-sm hover:border-black/20 hover:shadow transition-all"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4 flex-shrink-0" aria-hidden="true">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                </svg>
                Sign in with Google
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Settings section ── */}
      <div className="ui-card p-5">
        <div className="ui-eyebrow mb-4">Settings</div>
        <div className="space-y-0.5">

          {/* Accent color */}
          <div className="ui-settings-row" style={{ cursor: "default" }}>
            <div className="ui-settings-icon">🎨</div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-[var(--text-primary)]">Accent color</div>
              <div className="text-xs text-[var(--text-faint)]">Personalise your OpenHour theme</div>
            </div>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              {ACCENT_COLORS.map(({ color, label }) => (
                <button
                  key={color}
                  onClick={() => changeAccent(color)}
                  className="h-[18px] w-[18px] rounded-full transition-all hover:scale-125 active:scale-95 flex-shrink-0"
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
          <div className="ui-settings-row">
            <div className="ui-settings-icon">🌙</div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-[var(--text-primary)]">Dark mode</div>
              <div className="text-xs text-[var(--text-faint)]">Switch to a darker interface</div>
            </div>
            {prefs !== null && <Toggle enabled={prefs.darkMode} onToggle={() => togglePref("darkMode")} />}
          </div>

          {/* AI suggestions toggle */}
          <div className="ui-settings-row">
            <div className="ui-settings-icon">✨</div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-[var(--text-primary)]">AI suggestions</div>
              <div className="text-xs text-[var(--text-faint)]">Show prep & recovery ideas after scheduling</div>
            </div>
            {prefs !== null && <Toggle enabled={prefs.suggestionsEnabled} onToggle={() => togglePref("suggestionsEnabled")} />}
          </div>

          {/* Notifications toggle */}
          <div className="ui-settings-row">
            <div className="ui-settings-icon">🔔</div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-[var(--text-primary)]">Notifications</div>
              <div className="text-xs text-[var(--text-faint)]">15-min reminders for today&apos;s events</div>
            </div>
            {prefs !== null && <Toggle enabled={prefs.notificationsEnabled ?? false} onToggle={toggleNotifications} />}
          </div>

          {/* Google Calendar write-back — only shown when GCal is connected */}
          {gcalConnected && (
            <div className="ui-settings-row">
              <div className="ui-settings-icon">📤</div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-[var(--text-primary)]">Sync new blocks to Google</div>
                <div className="text-xs text-[var(--text-faint)]">New OpenHour events are added to Google Calendar</div>
              </div>
              {prefs !== null && <Toggle enabled={prefs.gcalWriteBack ?? false} onToggle={() => togglePref("gcalWriteBack")} />}
            </div>
          )}

          {/* Outlook Calendar — connection status indicator */}
          {outlookConnected && (
            <div className="ui-settings-row">
              <div className="ui-settings-icon">
                <span className="inline-flex h-5 w-5 items-center justify-center rounded text-[9px] font-extrabold text-white" style={{ backgroundColor: "#0078d4" }}>M</span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-[var(--text-primary)]">Outlook Calendar</div>
                <div className="text-xs text-[var(--text-faint)]">Connected · events appear in your calendar view</div>
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: "#0078d4" }} />
                <span className="text-xs font-semibold" style={{ color: "#0078d4" }}>Active</span>
              </div>
            </div>
          )}

          {/* Cloud sync row — shows only when signed in */}
          {user && (
            <div className="ui-settings-row">
              <div className="ui-settings-icon">☁️</div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-[var(--text-primary)]">Cloud sync</div>
                <div className="text-xs text-[var(--text-faint)] truncate">Syncing as {user.email}</div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className="h-2 w-2 rounded-full bg-emerald-400" style={{ boxShadow: "0 0 5px rgba(52,211,153,0.7)" }} />
                <button
                  onClick={() => { signOut(); toast("Signed out", "info"); }}
                  className="text-xs text-[var(--text-faint)] hover:text-[var(--text-muted)] transition-colors px-3 py-1.5 rounded-lg hover:bg-black/[0.05] font-semibold"
                >
                  Sign out
                </button>
              </div>
            </div>
          )}

          {/* Coming soon — collapsed row */}
          <button
            onClick={() => setShowSoonExpanded((v) => !v)}
            className="ui-settings-row w-full text-left"
          >
            <div className="ui-settings-icon">🚀</div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-[var(--text-primary)]">Coming soon</div>
              <div className="text-xs text-[var(--text-faint)]">Google Calendar sync &amp; more</div>
            </div>
            <span className={`text-[var(--text-faint)] transition-transform duration-200 text-sm ${showSoonExpanded ? "rotate-90" : ""}`}>›</span>
          </button>
          {showSoonExpanded && (
            <div className="mx-2 mb-1 rounded-xl border divide-y overflow-hidden" style={{ borderColor: "var(--divider)", background: "var(--surface-subtle)" }}>
              <div className="flex items-center gap-3 px-4 py-3 opacity-50">
                <span className="text-base">🔔</span>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-semibold text-[var(--text-secondary)]">Reminders (advanced)</div>
                  <div className="text-[11px] text-[var(--text-faint)]">Custom reminder times &amp; recurring schedules</div>
                </div>
                <span className="text-[10px] text-[var(--text-faint)] font-bold rounded-full px-2 py-0.5" style={{ background: "var(--surface-subtle)" }}>Soon</span>
              </div>
              <div className="flex items-center gap-3 px-4 py-3 opacity-50">
                <span className="text-base">🗓</span>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-semibold text-[var(--text-secondary)]">Google Calendar sync</div>
                  <div className="text-[11px] text-[var(--text-faint)]">Two-way sync with your Google Calendar</div>
                </div>
                <span className="text-[10px] text-[var(--text-faint)] font-bold rounded-full px-2 py-0.5" style={{ background: "var(--surface-subtle)" }}>Soon</span>
              </div>
            </div>
          )}

          {/* Data & privacy — opens modal */}
          <button
            onClick={() => setShowPrivacyModal(true)}
            className="ui-settings-row w-full text-left"
          >
            <div className="ui-settings-icon">🔒</div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-[var(--text-primary)]">Data &amp; privacy</div>
              <div className="text-xs text-[var(--text-faint)]">All data stored locally on your device</div>
            </div>
            <span className="text-[var(--text-faint)] flex-shrink-0 text-sm">›</span>
          </button>

          {/* Privacy modal */}
          {showPrivacyModal && (
            <div
              className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/30 backdrop-blur-sm px-4 pb-4 sm:pb-0"
              onClick={() => setShowPrivacyModal(false)}
            >
              <div
                className="w-full max-w-sm rounded-3xl shadow-[var(--shadow-xl)] p-6 space-y-4"
                style={{ background: "var(--surface-raised)", border: "1px solid var(--divider)" }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-2xl grid place-items-center flex-shrink-0" style={{ background: "var(--surface-subtle)" }}>
                    <span className="text-lg">🔒</span>
                  </div>
                  <div>
                    <div className="text-base font-bold text-[var(--text-primary)]">Data &amp; Privacy</div>
                    <div className="text-xs text-[var(--text-faint)]">How OpenHour stores your information</div>
                  </div>
                </div>
                <div className="space-y-3 text-sm text-[var(--text-muted)] leading-relaxed">
                  <p>
                    <span className="font-semibold text-[var(--text-secondary)]">100% local storage.</span> All your plans, calendar blocks, and preferences are saved only in your browser&apos;s localStorage. Nothing is sent to any server.
                  </p>
                  <p>
                    <span className="font-semibold text-[var(--text-secondary)]">AI calls are stateless.</span> When you generate a plan or import a syllabus, your text is sent to the AI API for that request only and is not stored or used for training.
                  </p>
                  <p>
                    <span className="font-semibold text-[var(--text-secondary)]">Clear your data anytime.</span> Clearing your browser&apos;s site data for this app removes everything instantly.
                  </p>
                </div>
                <button
                  onClick={() => setShowPrivacyModal(false)}
                  className="w-full rounded-2xl py-3 text-sm font-bold text-[var(--text-muted)] hover:opacity-80 transition-opacity"
                  style={{ background: "var(--surface-subtle)" }}
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
