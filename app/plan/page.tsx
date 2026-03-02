"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  loadHistory,
  type HistoryItem,
  loadProfile,
  type UserProfile,
  loadCalendar,
  type CalendarBlock,
  mergeCalendarFromHistory,
  loadDone,
  type DoneMap,
} from "../lib/storage";

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function isoDay(isoDate: string) {
  const d = new Date(`${isoDate}T12:00:00`);
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function minsToTime(mins: number) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function getTodayIso() {
  return new Date().toISOString().slice(0, 10);
}

function makeTaskId(blockTime: string, taskText: string) {
  return `${blockTime}::${taskText}`.toLowerCase();
}

// Kind → color map
function kindColor(kind?: string) {
  switch (kind) {
    case "syllabus": return { bg: "bg-violet-50", text: "text-violet-600", dot: "bg-violet-400" };
    case "prep":     return { bg: "bg-blue-50",   text: "text-blue-600",   dot: "bg-blue-400" };
    case "travel":   return { bg: "bg-amber-50",  text: "text-amber-600",  dot: "bg-amber-400" };
    case "manual":   return { bg: "bg-emerald-50",text: "text-emerald-600",dot: "bg-emerald-400" };
    default:         return { bg: "bg-[var(--lifeos-pink)]/8", text: "text-[var(--lifeos-pink)]", dot: "bg-[var(--lifeos-pink)]" };
  }
}

// ── Stat card ──────────────────────────────────────────────────
function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-2xl bg-white border border-black/[0.06] p-5 flex flex-col gap-1">
      <div className="text-[11px] font-bold uppercase tracking-widest text-black/35">{label}</div>
      <div className="text-3xl font-extrabold text-black" style={{ letterSpacing: "-0.03em" }}>{value}</div>
      {sub && <div className="text-xs text-black/45 font-medium">{sub}</div>}
    </div>
  );
}

export default function PlanPage() {
  const router = useRouter();

  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [profile, setProfile] = useState<UserProfile>(() => ({ daysTracked: 0, avgCompletion: 0, last7: [] }));
  const [calendar, setCalendar] = useState<CalendarBlock[]>([]);

  useEffect(() => {
    setHistory(loadHistory());
    setProfile(loadProfile());
    setCalendar(loadCalendar());
  }, []);

  const todayIso = useMemo(() => getTodayIso(), []);
  const latest = history[0] ?? null;
  const latestPlan = latest?.plan ?? null;

  const todayBlocks = useMemo(() =>
    calendar.filter((b) => b.date === todayIso).slice().sort((a, b) => a.startMin - b.startMin),
    [calendar, todayIso]
  );

  const next7 = useMemo(() => {
    const start = new Date(`${todayIso}T12:00:00`);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    const inRange = (iso: string) => {
      const d = new Date(`${iso}T12:00:00`);
      return d.getTime() >= start.getTime() && d.getTime() < end.getTime();
    };
    return calendar
      .filter((b) => inRange(b.date))
      .slice()
      .sort((a, b) => a.date === b.date ? a.startMin - b.startMin : a.date.localeCompare(b.date));
  }, [calendar, todayIso]);

  const completion = useMemo(() => {
    if (!latest?.id || !latestPlan?.schedule?.length) return { done: 0, total: 0, rate: 0 };
    const done: DoneMap = loadDone(latest.id);
    const all = latestPlan.schedule.flatMap((b) => (b.plan ?? []).map((t) => makeTaskId(b.time, t)));
    const total = all.length;
    const doneCount = all.filter((id) => !!done[id]).length;
    return { done: doneCount, total, rate: total ? doneCount / total : 0 };
  }, [latest?.id, latestPlan]);

  const focusToday = useMemo(() => {
    const fromPlan = (latestPlan?.priorities ?? []).filter(Boolean).slice(0, 4);
    if (fromPlan.length) return fromPlan;
    const fromSchedule = (latestPlan?.schedule ?? [])
      .flatMap((b) => b.plan ?? [])
      .map((x) => String(x))
      .filter(Boolean)
      .slice(0, 4);
    if (fromSchedule.length) return fromSchedule;
    // Fall back to today's calendar blocks as focus items
    return todayBlocks.slice(0, 4).map((b) => b.title);
  }, [latestPlan, todayBlocks]);

  const attention = useMemo(() => {
    const items: string[] = [];
    const dueSoon = next7.filter((b) => b.meta?.kind === "syllabus" || /due|quiz|exam|midterm|final|deadline/i.test(b.title));
    if (dueSoon.length) items.push(`${dueSoon.length} deadline${dueSoon.length > 1 ? "s" : ""} in the next 7 days`);
    if (latestPlan?.profile?.risk) items.push(latestPlan.profile.risk);
    if (todayBlocks.length >= 6) items.push("Today is packed — consider adding buffer time.");
    // Surface the next upcoming exam/quiz/deadline by name
    const nextDeadline = next7.find((b) => /exam|quiz|midterm|final|deadline|due/i.test(b.title));
    if (nextDeadline && !dueSoon.length) {
      items.push(`Upcoming: ${nextDeadline.title} on ${isoDay(nextDeadline.date)}`);
    }
    return items.slice(0, 3);
  }, [latestPlan, next7, todayBlocks.length]);

  function addLatestPlanToCalendar() {
    if (!latest) return;
    mergeCalendarFromHistory(latest);
    setCalendar(loadCalendar());
    router.push("/calendar");
  }

  const completionPct = Math.round(completion.rate * 100);

  return (
    <div className="space-y-8">

      {/* ── Top stats bar ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Today" value={todayBlocks.length} sub="blocks scheduled" />
        <StatCard label="This week" value={next7.length} sub="upcoming events" />
        <StatCard label="Avg completion" value={`${Math.round((profile.avgCompletion ?? 0) * 100)}%`} sub="recent plans" />
        <StatCard label="Days tracked" value={profile.daysTracked} sub="since you started" />
      </div>

      {/* ── Main 2-column layout ── */}
      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">

        {/* ── Left sidebar ── */}
        <aside className="space-y-4">

          {/* Quick actions */}
          <div className="rounded-2xl bg-white border border-black/[0.06] p-5">
            <div className="text-[11px] font-bold uppercase tracking-widest text-black/35 mb-3">Quick actions</div>
            <div className="space-y-2">
              <button
                onClick={() => router.push("/")}
                className="w-full flex items-center gap-3 rounded-xl bg-[var(--lifeos-pink)] px-4 py-3 text-sm font-bold text-white text-left shadow-[0_2px_8px_rgba(255,107,107,0.3)] hover:shadow-[0_4px_14px_rgba(255,107,107,0.4)] transition-shadow"
              >
                <span className="text-base">✦</span> New prompt
              </button>
              <button
                onClick={() => router.push("/calendar")}
                className="w-full flex items-center gap-3 rounded-xl border border-black/[0.07] bg-white px-4 py-2.5 text-sm font-semibold text-black/70 text-left hover:bg-black/[0.025] transition-colors"
              >
                <span>📅</span> Open calendar
              </button>
              <button
                onClick={addLatestPlanToCalendar}
                disabled={!latest}
                className="w-full flex items-center gap-3 rounded-xl border border-black/[0.07] bg-white px-4 py-2.5 text-sm font-semibold text-black/70 text-left hover:bg-black/[0.025] transition-colors disabled:opacity-35 disabled:cursor-not-allowed"
              >
                <span>📥</span> Add latest plan
              </button>
            </div>
          </div>

          {/* Recent plans */}
          <div className="rounded-2xl bg-white border border-black/[0.06] p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="text-[11px] font-bold uppercase tracking-widest text-black/35">Recent plans</div>
              <div className="text-[10px] text-black/30">last 10</div>
            </div>
            <div className="space-y-1.5">
              {history.slice(0, 10).map((h) => (
                <button
                  key={h.id}
                  onClick={() => {
                    try { window.localStorage.setItem("lifeos_calendar_cursor_v1", h.createdAt.slice(0, 10)); } catch { /* ignore */ }
                    router.push("/calendar");
                  }}
                  className="w-full rounded-xl border border-black/[0.05] bg-black/[0.02] px-3 py-2 text-left text-xs font-semibold text-black/60 hover:bg-black/[0.04] hover:text-black/80 transition-colors truncate"
                >
                  {isoDay(h.createdAt.slice(0, 10))}
                </button>
              ))}
              {!history.length && <div className="text-xs text-black/40 py-1">No plans yet. Generate one from the home screen.</div>}
            </div>
          </div>
        </aside>

        {/* ── Right main ── */}
        <div className="space-y-5">

          {/* Last input banner */}
          {latest && (
            <div className="rounded-2xl border border-[var(--lifeos-pink)]/20 bg-[var(--lifeos-pink)]/5 px-5 py-4">
              <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--lifeos-pink)]/70 mb-1">Last input</div>
              <p className="text-sm font-semibold text-black/80 line-clamp-2">{latest.input}</p>
            </div>
          )}

          {/* Three mini-cards row */}
          <div className="grid gap-4 sm:grid-cols-3">

            {/* Focus today */}
            <div className="rounded-2xl bg-white border border-black/[0.06] p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="text-xs font-bold text-black/70">Focus today</div>
                <span className="text-[10px] text-black/30 bg-black/[0.04] rounded-full px-2 py-0.5">AI-picked</span>
              </div>
              {focusToday.length ? (
                <ul className="space-y-1.5">
                  {focusToday.map((t, i) => (
                    <li key={i} className="flex items-start gap-2 text-xs text-black/70">
                      <span className="mt-0.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[var(--lifeos-pink)] mt-1.5" />
                      {t}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-black/35">No priorities yet — generate a plan.</p>
              )}
              {latest && completion.total > 0 && (
                <div className="mt-3 pt-3 border-t border-black/[0.05]">
                  <div className="flex items-center justify-between text-[10px] text-black/40 mb-1">
                    <span>Completion</span>
                    <span className="font-bold">{completionPct}%</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-black/[0.06] overflow-hidden">
                    <div
                      className="h-full rounded-full bg-[var(--lifeos-pink)] transition-all duration-500"
                      style={{ width: `${completionPct}%` }}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Attention needed */}
            <div className="rounded-2xl bg-white border border-black/[0.06] p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="text-xs font-bold text-black/70">Attention needed</div>
                <span className="text-[10px] text-black/30 bg-black/[0.04] rounded-full px-2 py-0.5">signals</span>
              </div>
              {attention.length ? (
                <ul className="space-y-2">
                  {attention.map((t, i) => (
                    <li key={i} className="flex items-start gap-2 text-xs text-black/70">
                      <span className="text-amber-400 flex-shrink-0">⚠</span>
                      {t}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-black/35">Nothing urgent flagged.</p>
              )}
              {latestPlan?.coach && (
                <div className="mt-3 pt-3 border-t border-black/[0.05] text-xs text-black/60 italic">
                  "{latestPlan.coach}"
                </div>
              )}
            </div>

            {/* This week */}
            <div className="rounded-2xl bg-white border border-black/[0.06] p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="text-xs font-bold text-black/70">This week</div>
                <span className="text-[10px] text-black/30 bg-black/[0.04] rounded-full px-2 py-0.5">7 days</span>
              </div>
              {next7.length ? (
                <ul className="space-y-1.5">
                  {next7.slice(0, 5).map((b) => {
                    const { dot } = kindColor(b.meta?.kind);
                    return (
                      <li key={b.id} className="flex items-center gap-2 text-xs text-black/70 min-w-0">
                        <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${dot}`} />
                        <span className="flex-1 truncate">{b.title}</span>
                        <span className="flex-shrink-0 text-[10px] text-black/35">{minsToTime(b.startMin)}</span>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-xs text-black/35">No upcoming events yet.</p>
              )}
              <button
                onClick={() => router.push("/calendar")}
                className="mt-4 w-full rounded-xl border border-black/[0.07] bg-black/[0.02] py-2 text-xs font-bold text-black/50 hover:bg-black/[0.05] transition-colors"
              >
                View full calendar →
              </button>
            </div>
          </div>

          {/* Today's timeline */}
          <div className="rounded-2xl bg-white border border-black/[0.06] p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="text-xs font-bold text-black/70">Today's timeline</div>
              <div className="text-[10px] text-black/30">{isoDay(todayIso)}</div>
            </div>

            {todayBlocks.length ? (
              <div className="space-y-2">
                {todayBlocks.slice(0, 12).map((b) => {
                  const { bg, text, dot } = kindColor(b.meta?.kind);
                  return (
                    <div key={b.id} className={`flex items-center gap-3 rounded-xl ${bg} px-4 py-3`}>
                      <span className={`h-2 w-2 flex-shrink-0 rounded-full ${dot}`} />
                      <div className="text-[11px] font-bold text-black/40 w-24 flex-shrink-0 tabular-nums">
                        {minsToTime(b.startMin)} – {minsToTime(b.endMin)}
                      </div>
                      <div className="flex-1 text-sm font-semibold text-black/80 truncate">{b.title}</div>
                      {b.meta?.kind && (
                        <span className={`text-[10px] font-bold ${text} flex-shrink-0`}>{b.meta.kind}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-black/[0.08] py-8 text-center">
                <p className="text-xs text-black/35">No blocks on today's calendar.</p>
                <button
                  onClick={() => router.push("/")}
                  className="mt-2 text-xs font-bold text-[var(--lifeos-pink)] hover:underline"
                >
                  Generate a plan →
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
