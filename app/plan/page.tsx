"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { useToast } from "../components/Toast";
import {
  loadHistory,
  type HistoryItem,
  loadProfile,
  type UserProfile,
  loadCalendar,
  type CalendarBlock,
  mergeCalendarFromHistory,
} from "../lib/storage";

// ── Helpers ─────────────────────────────────────────────────────────────────

function getTodayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function minsToTime(mins: number) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function isoToShortDate(iso: string) {
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function daysUntil(iso: string): number {
  const today = new Date(getTodayIso() + "T00:00:00");
  const target = new Date(iso + "T00:00:00");
  return Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

// ── Kind colors ─────────────────────────────────────────────────────────────
function kindColor(kind?: string) {
  switch (kind) {
    case "syllabus": return { bg: "bg-violet-50",   text: "text-violet-600",  dot: "bg-violet-400",  border: "border-violet-200" };
    case "prep":     return { bg: "bg-blue-50",     text: "text-blue-600",    dot: "bg-blue-400",    border: "border-blue-200"   };
    case "travel":   return { bg: "bg-amber-50",    text: "text-amber-600",   dot: "bg-amber-400",   border: "border-amber-200"  };
    case "manual":   return { bg: "bg-emerald-50",  text: "text-emerald-600", dot: "bg-emerald-400", border: "border-emerald-200"};
    default:         return { bg: "bg-[var(--lifeos-pink)]/8", text: "text-[var(--lifeos-pink)]", dot: "bg-[var(--lifeos-pink)]", border: "border-[var(--lifeos-pink)]/20" };
  }
}

// Urgency chip color: red ≤2d, amber ≤7d, green ≤14d, muted otherwise
function urgencyChip(days: number) {
  if (days < 0)  return { bg: "bg-red-100",    text: "text-red-600",    label: "Overdue" };
  if (days === 0) return { bg: "bg-red-100",   text: "text-red-600",    label: "Today" };
  if (days === 1) return { bg: "bg-red-50",    text: "text-red-500",    label: "Tomorrow" };
  if (days <= 3)  return { bg: "bg-amber-50",  text: "text-amber-600",  label: `${days}d` };
  if (days <= 7)  return { bg: "bg-yellow-50", text: "text-yellow-600", label: `${days}d` };
  if (days <= 14) return { bg: "bg-emerald-50",text: "text-emerald-600",label: `${days}d` };
  return             { bg: "bg-black/[0.04]",  text: "text-black/40",   label: `${days}d` };
}

// ── Skeleton ──────────────────────────────────────────────────────────────
function PlanSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="h-28 rounded-3xl bg-black/[0.04]" />
      <div className="grid grid-cols-7 gap-1.5">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="h-16 rounded-2xl bg-black/[0.04]" />
        ))}
      </div>
      <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
        <div className="space-y-4">
          <div className="h-10 rounded-2xl bg-black/[0.04] w-40" />
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-16 rounded-2xl bg-black/[0.04]" />
          ))}
        </div>
        <div className="space-y-4">
          <div className="h-10 rounded-2xl bg-black/[0.04] w-32" />
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-20 rounded-2xl bg-black/[0.04]" />
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Mini bar chart (last 7 days) ─────────────────────────────────────────
function WeekRhythm({ last7 }: { last7: { date: string; completion: number }[] }) {
  const days = ["S", "M", "T", "W", "T", "F", "S"];
  return (
    <div className="flex items-end gap-1.5 h-10">
      {last7.map((d, i) => {
        const isToday = d.date === getTodayIso();
        const pct = Math.max(d.completion * 100, d.completion > 0 ? 8 : 0);
        return (
          <div key={i} className="flex-1 flex flex-col items-center gap-1">
            <div className="w-full relative rounded-full overflow-hidden bg-black/[0.06]" style={{ height: 28 }}>
              <motion.div
                className={`absolute bottom-0 w-full rounded-full ${isToday ? "bg-[var(--lifeos-pink)]" : "bg-black/20"}`}
                initial={{ height: 0 }}
                animate={{ height: `${pct}%` }}
                transition={{ delay: i * 0.04, type: "spring", stiffness: 300, damping: 28 }}
              />
            </div>
            <span className={`text-[9px] font-bold ${isToday ? "text-[var(--lifeos-pink)]" : "text-black/25"}`}>
              {days[(new Date(d.date + "T12:00:00")).getDay()]}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Today block row with checkbox ────────────────────────────────────────
function TodayBlockRow({
  block,
  done,
  onToggle,
  isNow,
  isPast,
}: {
  block: CalendarBlock;
  done: boolean;
  onToggle: () => void;
  isNow: boolean;
  isPast: boolean;
}) {
  const { bg, text, dot } = kindColor(block.meta?.kind);
  const dur = block.endMin - block.startMin;
  const durLabel = dur >= 60
    ? `${Math.floor(dur / 60)}h${dur % 60 ? ` ${dur % 60}m` : ""}`
    : `${dur}m`;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      className={`relative flex items-center gap-3 rounded-2xl px-4 py-3 border transition-all ${
        isNow
          ? "border-[var(--lifeos-pink)]/30 bg-[var(--lifeos-pink)]/5 shadow-sm"
          : isPast
          ? "border-black/[0.04] bg-black/[0.02] opacity-60"
          : "border-black/[0.06] bg-white"
      } ${done ? "opacity-40" : ""}`}
    >
      {/* Checkbox */}
      <button
        onClick={onToggle}
        className={`shrink-0 h-5 w-5 rounded-full border-2 flex items-center justify-center transition-all hover:scale-110 active:scale-95 ${
          done
            ? "bg-emerald-400 border-emerald-400"
            : isNow
            ? "border-[var(--lifeos-pink)] hover:bg-[var(--lifeos-pink)]/10"
            : "border-black/20 hover:border-black/40"
        }`}
        aria-label={done ? "Mark incomplete" : "Mark complete"}
      >
        {done && (
          <svg viewBox="0 0 10 8" className="h-2.5 w-2.5" fill="none">
            <path d="M1 4l2.5 2.5L9 1" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>

      {/* Time */}
      <div className="text-[11px] font-bold tabular-nums text-black/35 w-[52px] shrink-0 leading-tight">
        {minsToTime(block.startMin)}
      </div>

      {/* Title + kind */}
      <div className="flex-1 min-w-0">
        <div className={`text-sm font-semibold truncate ${done ? "line-through text-black/40" : "text-black/80"}`}>
          {block.title}
        </div>
        {block.meta?.kind && (
          <div className={`text-[10px] font-bold uppercase tracking-widest mt-0.5 ${text}`}>
            {block.meta.kind}
          </div>
        )}
      </div>

      {/* Right side */}
      <div className="flex items-center gap-2 shrink-0">
        {isNow && !done && (
          <span className="text-[9px] font-extrabold text-[var(--lifeos-pink)] uppercase tracking-widest animate-pulse">
            NOW
          </span>
        )}
        <div className={`h-2 w-2 rounded-full ${dot}`} />
        <span className="text-[10px] text-black/30 font-medium tabular-nums">{durLabel}</span>
      </div>
    </motion.div>
  );
}

// ── Deadline row ─────────────────────────────────────────────────────────
function DeadlineRow({ block }: { block: CalendarBlock }) {
  const days = daysUntil(block.date);
  const chip = urgencyChip(days);
  const color = (block.meta as any)?.color as string | undefined;

  return (
    <div className="flex items-center gap-3 py-2.5 border-b border-black/[0.04] last:border-0">
      {/* Course color dot */}
      <div
        className="h-2.5 w-2.5 rounded-full shrink-0"
        style={{ backgroundColor: color || "var(--lifeos-pink)" }}
      />
      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-black/80 truncate">{block.title}</div>
        <div className="text-[11px] text-black/40 mt-0.5">{isoToShortDate(block.date)}</div>
      </div>
      {/* Urgency chip */}
      <span className={`shrink-0 text-[10px] font-extrabold px-2 py-0.5 rounded-full ${chip.bg} ${chip.text}`}>
        {chip.label}
      </span>
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────
export default function PlanPage() {
  const router = useRouter();
  const { toast } = useToast();
  const todayIso = useMemo(() => getTodayIso(), []);

  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [profile, setProfile] = useState<UserProfile>(() => ({ daysTracked: 0, avgCompletion: 0, last7: [] }));
  const [calendar, setCalendar] = useState<CalendarBlock[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Per-block done state — keyed by blockId
  const [doneBlocks, setDoneBlocks] = useState<Record<string, boolean>>({});

  // Section toggle: "today" | "upcoming"
  const [section, setSection] = useState<"today" | "upcoming">("today");

  useEffect(() => {
    const h = loadHistory();
    setHistory(h);
    setProfile(loadProfile());
    const cal = loadCalendar();
    setCalendar(cal);

    // Load done state for today's blocks using a simple localStorage key
    try {
      const raw = window.localStorage.getItem("lifeos_done_today_v1");
      const parsed = raw ? JSON.parse(raw) : {};
      // Only keep entries from today (stale data cleared automatically)
      const todayKey = getTodayIso();
      setDoneBlocks(typeof parsed === "object" && parsed?.date === todayKey ? (parsed.done ?? {}) : {});
    } catch { /* ignore */ }

    setLoaded(true);
  }, []);

  // Persist done state when it changes
  useEffect(() => {
    if (!loaded) return;
    try {
      window.localStorage.setItem(
        "lifeos_done_today_v1",
        JSON.stringify({ date: todayIso, done: doneBlocks })
      );
    } catch { /* ignore */ }
  }, [doneBlocks, loaded, todayIso]);

  // ── Derived data ─────────────────────────────────────────────────────
  const latest = history[0] ?? null;
  const latestPlan = latest?.plan ?? null;

  const todayBlocks = useMemo(
    () =>
      calendar
        .filter((b) => b.date === todayIso)
        .sort((a, b) => a.startMin - b.startMin),
    [calendar, todayIso]
  );

  const nowMins = useMemo(() => {
    const n = new Date();
    return n.getHours() * 60 + n.getMinutes();
  }, []);

  const todayDone = Object.values(doneBlocks).filter(Boolean).length;
  const todayTotal = todayBlocks.length;
  const todayPct = todayTotal > 0 ? Math.round((todayDone / todayTotal) * 100) : 0;

  // All upcoming syllabus/deadline events in the next 45 days, sorted by date
  const upcomingDeadlines = useMemo(() => {
    const cutoff = new Date(todayIso);
    cutoff.setDate(cutoff.getDate() + 45);
    const cutoffIso = cutoff.toISOString().slice(0, 10);

    return calendar
      .filter((b) => {
        if (b.date < todayIso || b.date > cutoffIso) return false;
        // Keep syllabus events and anything that looks like a deadline/exam
        const isSyllabus = b.meta?.kind === "syllabus";
        const isDeadline = /exam|quiz|midterm|final|due|deadline|assignment|paper|project/i.test(b.title);
        return isSyllabus || isDeadline;
      })
      .sort((a, b) => a.date === b.date ? a.startMin - b.startMin : a.date.localeCompare(b.date));
  }, [calendar, todayIso]);

  // Next 7 days (excluding today)
  const next7 = useMemo(() => {
    const tomorrow = new Date(todayIso);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowIso = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
    const cutoff = new Date(todayIso);
    cutoff.setDate(cutoff.getDate() + 7);
    const cutoffIso = cutoff.toISOString().slice(0, 10);
    return calendar
      .filter((b) => b.date >= tomorrowIso && b.date <= cutoffIso)
      .sort((a, b) => a.date === b.date ? a.startMin - b.startMin : a.date.localeCompare(b.date));
  }, [calendar, todayIso]);

  // AI coach note from latest plan
  const coachNote = latestPlan?.coach ?? null;

  // Overdue blocks (past days, not today, kind=plan or no kind)
  const overdueCount = useMemo(() => {
    return calendar.filter((b) => {
      if (b.date >= todayIso) return false;
      return b.meta?.kind === "plan" || !b.meta?.kind;
    }).length;
  }, [calendar, todayIso]);

  function toggleBlock(blockId: string) {
    setDoneBlocks((prev) => ({ ...prev, [blockId]: !prev[blockId] }));
  }

  function addLatestPlanToCalendar() {
    if (!latest) return;
    mergeCalendarFromHistory(latest);
    setCalendar(loadCalendar());
    toast("Plan added to calendar", "success");
    router.push("/calendar");
  }

  if (!loaded) return <PlanSkeleton />;

  // ── Today's greeting ─────────────────────────────────────────────────
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const dateLabel = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  return (
    <div className="space-y-6 max-w-3xl mx-auto">

      {/* ── Hero header ───────────────────────────────────────────── */}
      <div className="rounded-3xl border border-black/[0.06] bg-white px-6 py-5 flex items-center justify-between gap-4">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-widest text-black/35 mb-1">{dateLabel}</div>
          <div className="text-2xl font-extrabold text-black" style={{ letterSpacing: "-0.025em" }}>
            {greeting} ✦
          </div>
          {/* Mini progress */}
          {todayTotal > 0 ? (
            <div className="mt-2 flex items-center gap-2">
              <div className="flex-1 h-1.5 rounded-full bg-black/[0.07] overflow-hidden max-w-[120px]">
                <motion.div
                  className="h-full rounded-full bg-[var(--lifeos-pink)]"
                  initial={{ width: 0 }}
                  animate={{ width: `${todayPct}%` }}
                  transition={{ type: "spring", stiffness: 200, damping: 25 }}
                />
              </div>
              <span className="text-xs font-semibold text-black/45">
                {todayDone}/{todayTotal} done today
              </span>
            </div>
          ) : (
            <p className="mt-1.5 text-xs text-black/40">No blocks scheduled today yet.</p>
          )}
        </div>

        {/* Quick action buttons */}
        <div className="flex flex-col gap-2 shrink-0">
          <button
            onClick={() => router.push("/")}
            className="flex items-center gap-2 rounded-xl bg-[var(--lifeos-pink)] px-4 py-2.5 text-xs font-bold text-white shadow-[0_2px_8px_rgba(217,108,125,0.3)] hover:shadow-[0_4px_14px_rgba(217,108,125,0.4)] hover:scale-[1.03] active:scale-[0.97] transition-all"
          >
            <span>✦</span> New plan
          </button>
          <button
            onClick={() => router.push("/calendar")}
            className="flex items-center gap-2 rounded-xl border border-black/[0.08] bg-white px-4 py-2.5 text-xs font-semibold text-black/60 hover:bg-black/[0.03] hover:scale-[1.02] active:scale-[0.97] transition-all"
          >
            <span>📅</span> Calendar
          </button>
        </div>
      </div>

      {/* ── 7-day rhythm + stats row ──────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {/* Activity bars */}
        <div className="col-span-2 rounded-2xl border border-black/[0.06] bg-white px-4 py-3.5">
          <div className="text-[10px] font-bold uppercase tracking-widest text-black/30 mb-2">Activity — last 7 days</div>
          {profile.last7.length > 0 ? (
            <WeekRhythm last7={profile.last7} />
          ) : (
            <div className="h-10 flex items-center">
              <span className="text-xs text-black/30">No data yet</span>
            </div>
          )}
        </div>

        {/* Stat: This week */}
        <div className="rounded-2xl border border-black/[0.06] bg-white px-4 py-3.5 flex flex-col justify-between">
          <div className="text-[10px] font-bold uppercase tracking-widest text-black/30">This week</div>
          <div>
            <div className="text-3xl font-extrabold text-black mt-1" style={{ letterSpacing: "-0.03em" }}>
              {next7.length}
            </div>
            <div className="text-[11px] text-black/40 font-medium">events ahead</div>
          </div>
        </div>

        {/* Stat: Deadlines */}
        <div className="rounded-2xl border border-black/[0.06] bg-white px-4 py-3.5 flex flex-col justify-between">
          <div className="text-[10px] font-bold uppercase tracking-widest text-black/30">Deadlines</div>
          <div>
            <div
              className="text-3xl font-extrabold mt-1"
              style={{ letterSpacing: "-0.03em", color: upcomingDeadlines.length > 0 ? "var(--lifeos-pink)" : "var(--lifeos-ink)" }}
            >
              {upcomingDeadlines.length}
            </div>
            <div className="text-[11px] text-black/40 font-medium">next 45 days</div>
          </div>
        </div>
      </div>

      {/* ── Section toggle ────────────────────────────────────────── */}
      <div className="flex gap-2">
        {(["today", "upcoming"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setSection(s)}
            className={`px-5 py-2 rounded-full text-sm font-bold transition-all ${
              section === s
                ? "bg-[var(--lifeos-pink)] text-white shadow-[0_2px_8px_rgba(217,108,125,0.3)]"
                : "bg-black/[0.05] text-black/50 hover:bg-black/[0.08] hover:text-black/70"
            }`}
          >
            {s === "today" ? `Today  ${todayTotal > 0 ? `(${todayTotal})` : ""}` : `Upcoming  ${upcomingDeadlines.length > 0 ? `(${upcomingDeadlines.length})` : ""}`}
          </button>
        ))}
      </div>

      <AnimatePresence mode="wait">

        {/* ══════════════════════════════════════════════════════════
            TODAY section
        ══════════════════════════════════════════════════════════ */}
        {section === "today" && (
          <motion.div
            key="today"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18 }}
            className="space-y-5"
          >
            {/* Overdue alert */}
            {overdueCount > 0 && (
              <div className="flex items-center gap-3 rounded-2xl border border-red-100 bg-red-50 px-4 py-3">
                <span className="text-red-400 text-lg shrink-0">⚠</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-bold text-red-700">
                    {overdueCount} unfinished block{overdueCount !== 1 ? "s" : ""} from previous days
                  </div>
                  <div className="text-xs text-red-400 mt-0.5">These may need to be rescheduled or cleared.</div>
                </div>
                <button
                  onClick={() => router.push("/calendar")}
                  className="shrink-0 text-xs font-bold text-red-500 hover:text-red-700 transition-colors"
                >
                  Review →
                </button>
              </div>
            )}

            {/* Today's blocks */}
            {todayBlocks.length > 0 ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between px-1">
                  <div className="text-[11px] font-bold uppercase tracking-widest text-black/35">
                    Today&apos;s schedule
                  </div>
                  {todayDone > 0 && (
                    <div className="text-xs font-semibold text-emerald-500">
                      {todayDone} completed ✓
                    </div>
                  )}
                </div>

                {/* Timeline with spine */}
                <div className="relative">
                  <div className="absolute left-[67px] top-3 bottom-3 w-px bg-black/[0.05] pointer-events-none" />
                  <div className="space-y-2">
                    {todayBlocks.map((b) => {
                      const isNow = nowMins >= b.startMin && nowMins < b.endMin;
                      const isPast = b.endMin < nowMins;
                      return (
                        <TodayBlockRow
                          key={b.id}
                          block={b}
                          done={!!doneBlocks[b.id]}
                          onToggle={() => toggleBlock(b.id)}
                          isNow={isNow}
                          isPast={isPast}
                        />
                      );
                    })}
                  </div>
                </div>

                {/* Footer: add plan CTA if there's a pending latest plan */}
                {latest && (
                  <button
                    onClick={addLatestPlanToCalendar}
                    className="mt-1 w-full rounded-xl border border-dashed border-[var(--lifeos-pink)]/30 bg-[var(--lifeos-pink)]/5 py-2.5 text-xs font-bold text-[var(--lifeos-pink)] hover:bg-[var(--lifeos-pink)]/10 transition-colors"
                  >
                    + Add latest plan to calendar
                  </button>
                )}
              </div>
            ) : (
              /* Empty today state */
              <div className="rounded-2xl border border-dashed border-black/[0.08] py-12 text-center">
                <div className="text-4xl mb-3 select-none">🗓</div>
                <p className="text-sm font-bold text-black/50">Nothing scheduled for today</p>
                <p className="mt-1 text-xs text-black/30 max-w-xs mx-auto">
                  Generate a plan on the Today screen to fill your schedule, or add blocks manually in the Calendar.
                </p>
                <div className="mt-5 flex justify-center gap-2">
                  <button
                    onClick={() => router.push("/")}
                    className="rounded-full bg-[var(--lifeos-pink)] px-5 py-2.5 text-xs font-bold text-white shadow-sm hover:shadow-md hover:scale-[1.03] active:scale-[0.97] transition-all"
                  >
                    Generate a plan →
                  </button>
                  <button
                    onClick={() => router.push("/calendar")}
                    className="rounded-full border border-black/[0.08] bg-white px-5 py-2.5 text-xs font-semibold text-black/50 hover:bg-black/[0.03] transition-all"
                  >
                    Open calendar
                  </button>
                </div>
              </div>
            )}

            {/* AI coach note */}
            {coachNote && (
              <div className="rounded-2xl border border-[var(--lifeos-pink)]/15 bg-[var(--lifeos-pink)]/5 px-5 py-4">
                <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--lifeos-pink)]/60 mb-1.5">
                  ✦ AI Coach
                </div>
                <p className="text-sm font-medium text-black/70 leading-relaxed italic">
                  &ldquo;{coachNote}&rdquo;
                </p>
              </div>
            )}

            {/* Focus priorities from latest plan */}
            {latestPlan?.priorities && latestPlan.priorities.length > 0 && (
              <div className="rounded-2xl border border-black/[0.06] bg-white px-5 py-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="text-[11px] font-bold uppercase tracking-widest text-black/35">
                    Priorities
                  </div>
                  <span className="text-[10px] bg-black/[0.04] text-black/35 font-bold rounded-full px-2 py-0.5">
                    from last plan
                  </span>
                </div>
                <ul className="space-y-2">
                  {latestPlan.priorities.slice(0, 4).map((p, i) => (
                    <li key={i} className="flex items-start gap-2.5 text-sm text-black/70">
                      <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[var(--lifeos-pink)]" />
                      {p}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </motion.div>
        )}

        {/* ══════════════════════════════════════════════════════════
            UPCOMING section
        ══════════════════════════════════════════════════════════ */}
        {section === "upcoming" && (
          <motion.div
            key="upcoming"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18 }}
            className="space-y-5"
          >

            {/* Deadlines list */}
            <div className="rounded-2xl border border-black/[0.06] bg-white overflow-hidden">
              <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-black/[0.04]">
                <div className="text-[11px] font-bold uppercase tracking-widest text-black/35">
                  Deadlines &amp; exams — next 45 days
                </div>
                <button
                  onClick={() => router.push("/calendar")}
                  className="text-xs font-bold text-[var(--lifeos-pink)] hover:opacity-70 transition-opacity"
                >
                  View all →
                </button>
              </div>

              {upcomingDeadlines.length > 0 ? (
                <div className="px-5 py-1 divide-y divide-black/[0.03]">
                  {upcomingDeadlines.map((b) => (
                    <DeadlineRow key={b.id} block={b} />
                  ))}
                </div>
              ) : (
                <div className="px-5 py-8 text-center">
                  <div className="text-3xl mb-2 select-none">🎉</div>
                  <p className="text-sm font-semibold text-black/40">No upcoming deadlines</p>
                  <p className="mt-1 text-xs text-black/25">
                    Import a syllabus to see your deadlines here.
                  </p>
                  <button
                    onClick={() => router.push("/")}
                    className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-[var(--lifeos-pink)] px-4 py-2 text-xs font-bold text-white shadow-sm hover:shadow-md hover:scale-[1.03] active:scale-[0.97] transition-all"
                  >
                    Import syllabus →
                  </button>
                </div>
              )}
            </div>

            {/* Next 7 days schedule (non-deadline events) */}
            {next7.length > 0 && (
              <div className="rounded-2xl border border-black/[0.06] bg-white overflow-hidden">
                <div className="px-5 pt-4 pb-3 border-b border-black/[0.04]">
                  <div className="text-[11px] font-bold uppercase tracking-widest text-black/35">
                    This week&apos;s schedule
                  </div>
                </div>
                <div className="px-5 py-2">
                  {/* Group by date */}
                  {(() => {
                    const grouped = new Map<string, CalendarBlock[]>();
                    for (const b of next7) {
                      if (!grouped.has(b.date)) grouped.set(b.date, []);
                      grouped.get(b.date)!.push(b);
                    }
                    return Array.from(grouped.entries()).map(([date, blocks]) => (
                      <div key={date} className="py-2.5 border-b border-black/[0.03] last:border-0">
                        <div className="text-[10px] font-extrabold uppercase tracking-widest text-black/30 mb-2">
                          {isoToShortDate(date)}
                        </div>
                        <div className="space-y-1.5">
                          {blocks.slice(0, 5).map((b) => {
                            const { dot } = kindColor(b.meta?.kind);
                            const blockColor = (b.meta as any)?.color as string | undefined;
                            return (
                              <div key={b.id} className="flex items-center gap-2.5 text-sm">
                                <div
                                  className={`h-2 w-2 rounded-full flex-shrink-0 ${blockColor ? "" : dot}`}
                                  style={blockColor ? { backgroundColor: blockColor } : undefined}
                                />
                                <span className="flex-1 text-black/70 font-medium truncate">{b.title}</span>
                                <span className="text-[11px] text-black/30 tabular-nums shrink-0">
                                  {minsToTime(b.startMin)}
                                </span>
                              </div>
                            );
                          })}
                          {blocks.length > 5 && (
                            <div className="text-[11px] text-black/30 font-medium pl-4.5">
                              +{blocks.length - 5} more
                            </div>
                          )}
                        </div>
                      </div>
                    ));
                  })()}
                </div>
              </div>
            )}

            {/* Import CTA if no upcoming events at all */}
            {next7.length === 0 && upcomingDeadlines.length === 0 && (
              <div className="rounded-2xl border border-dashed border-black/[0.08] py-10 text-center">
                <div className="text-3xl mb-2 select-none">📭</div>
                <p className="text-sm font-bold text-black/40">Nothing upcoming yet</p>
                <p className="mt-1 text-xs text-black/25 max-w-xs mx-auto">
                  Your next 7 days and deadlines will appear here once you add events.
                </p>
                <button
                  onClick={() => router.push("/")}
                  className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-[var(--lifeos-pink)] px-5 py-2 text-xs font-bold text-white shadow-sm hover:shadow-md hover:scale-[1.03] active:scale-[0.97] transition-all"
                >
                  Get started →
                </button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
