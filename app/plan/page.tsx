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

function WhiteCard({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cx("rounded-2xl border border-[var(--lifeos-border-soft)] bg-white", className)}>
      {children}
    </div>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-[var(--lifeos-border-soft)] bg-white px-3 py-1 text-xs text-black/70">
      {children}
    </span>
  );
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

  const todayBlocks = useMemo(() => {
    return calendar
      .filter((b) => b.date === todayIso)
      .slice()
      .sort((a, b) => a.startMin - b.startMin);
  }, [calendar, todayIso]);

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
      .sort((a, b) => (a.date === b.date ? a.startMin - b.startMin : a.date.localeCompare(b.date)));
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
    return fromSchedule;
  }, [latestPlan]);

  const attention = useMemo(() => {
    const items: string[] = [];

    const dueSoon = next7.filter((b) => b.meta?.kind === "syllabus" || /due|quiz|exam|midterm|final|deadline/i.test(b.title));
    if (dueSoon.length) items.push(`${dueSoon.length} deadline(s) in the next 7 days`);

    if (latestPlan?.profile?.risk) items.push(latestPlan.profile.risk);

    // Lightweight "overschedule" signal
    if (todayBlocks.length >= 8) items.push("Today is packed — consider adding buffer time.");

    return items.slice(0, 3);
  }, [latestPlan, next7, todayBlocks.length]);

  function addLatestPlanToCalendar() {
    if (!latest) return;
    mergeCalendarFromHistory(latest);
    setCalendar(loadCalendar());
    router.push("/calendar");
  }

  return (
    <div className="grid gap-10 lg:grid-cols-[320px_1fr]">
      {/* Left rail: command shortcuts + recent activity */}
      <aside className="rounded-2xl bg-[var(--lifeos-pink)] p-4">
        <div className="space-y-4">
          <div className="rounded-2xl bg-white p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-black/50">Command Center</div>
            <div className="mt-1 text-lg font-extrabold text-black" style={{ letterSpacing: "-0.02em" }}>
              {isoDay(todayIso)}
            </div>

            <div className="mt-4 grid gap-2">
              <button
                onClick={() => router.push("/")}
                className="w-full rounded-full border border-[var(--lifeos-border-soft)] bg-white px-4 py-2 text-sm font-semibold text-black/80"
              >
                New prompt
              </button>
              <button
                onClick={() => router.push("/calendar")}
                className="w-full rounded-full border border-[var(--lifeos-border-soft)] bg-white px-4 py-2 text-sm font-semibold text-black/80"
              >
                Open calendar
              </button>
              <button
                onClick={addLatestPlanToCalendar}
                disabled={!latest}
                className="w-full rounded-full border border-[var(--lifeos-border-soft)] bg-white px-4 py-2 text-sm font-semibold text-black/80 disabled:opacity-40"
              >
                Add latest plan
              </button>
            </div>
          </div>

          <div className="rounded-2xl bg-white p-4">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold uppercase tracking-wide text-black/50">Recent plans</div>
              <div className="text-xs text-black/40">last 10</div>
            </div>
            <div className="mt-3 space-y-2">
              {(history.length ? history : []).slice(0, 10).map((h) => (
                <button
                  key={h.id}
                  onClick={() => {
                    // jump user to the day in calendar if they want to see it
                    try {
                      window.localStorage.setItem("lifeos_calendar_cursor_v1", h.createdAt.slice(0, 10));
                    } catch {
                      // ignore
                    }
                    router.push("/calendar");
                  }}
                  className="w-full rounded-full border border-[var(--lifeos-border-soft)] bg-white px-4 py-2 text-center text-sm font-semibold text-black/70 hover:bg-black/[0.03]"
                >
                  {isoDay(h.createdAt.slice(0, 10))}
                </button>
              ))}
              {!history.length ? <div className="text-sm text-black/60">No plans yet.</div> : null}
            </div>
          </div>
        </div>
      </aside>

      {/* Main stage */}
      <section className="rounded-2xl bg-[var(--lifeos-pink)] p-6 sm:p-8">
        <div className="space-y-8">
          <WhiteCard className="p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-black/50">Dashboard</div>
                <div className="mt-2 text-2xl font-extrabold text-black" style={{ letterSpacing: "-0.02em" }}>
                  Your day at a glance
                </div>
                <div className="mt-2 text-sm text-black/70">
                  {latest ? (
                    <>
                      <span className="font-semibold">Last input:</span> {latest.input}
                    </>
                  ) : (
                    "Generate your first plan from Prompt to populate your dashboard."
                  )}
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Pill>{Math.round(profile.avgCompletion * 100)}% avg</Pill>
                <Pill>{profile.daysTracked} days tracked</Pill>
                <Pill>{todayBlocks.length} today blocks</Pill>
              </div>
            </div>
          </WhiteCard>

          <div className="grid gap-4 lg:grid-cols-3">
            <WhiteCard className="p-5">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-black/70">Focus today</div>
                <div className="text-xs text-black/45">AI-picked</div>
              </div>
              {focusToday.length ? (
                <ul className="mt-3 space-y-2">
                  {focusToday.map((t, i) => (
                    <li key={i} className="rounded-xl border border-[var(--lifeos-border-soft)] bg-[#fafafa] px-3 py-2 text-sm text-black/80">
                      {t}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="mt-3 text-sm text-black/60">No priorities yet.</div>
              )}
              {latest ? (
                <div className="mt-4 text-xs text-black/55">
                  Completion: <span className="font-semibold">{completion.done}</span> / {completion.total} ({Math.round(completion.rate * 100)}%)
                </div>
              ) : null}
            </WhiteCard>

            <WhiteCard className="p-5">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-black/70">Attention needed</div>
                <div className="text-xs text-black/45">signals</div>
              </div>
              {attention.length ? (
                <ul className="mt-3 list-disc pl-5 text-sm text-black/80">
                  {attention.map((t, i) => (
                    <li key={i} className="mb-1">
                      {t}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="mt-3 text-sm text-black/60">Nothing urgent flagged.</div>
              )}
              <div className="mt-4 rounded-xl border border-[var(--lifeos-border-soft)] bg-[#fafafa] p-3 text-sm text-black/80">
                {latestPlan?.coach ? `“${latestPlan.coach}”` : "Stay simple: pick the next task and begin."}
              </div>
            </WhiteCard>

            <WhiteCard className="p-5">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-black/70">This week</div>
                <div className="text-xs text-black/45">next 7 days</div>
              </div>
              <div className="mt-3 space-y-2">
                {next7.length ? (
                  next7.slice(0, 6).map((b) => (
                    <div
                      key={b.id}
                      className="flex items-center justify-between rounded-xl border border-[var(--lifeos-border-soft)] bg-white px-3 py-2"
                    >
                      <div className="text-sm font-semibold text-black/80">
                        {b.date === todayIso ? "Today" : isoDay(b.date)}
                      </div>
                      <div className="flex-1 px-3 text-sm text-black/70">{b.title}</div>
                      <div className="text-xs text-black/45">{minsToTime(b.startMin)}</div>
                    </div>
                  ))
                ) : (
                  <div className="text-sm text-black/60">No upcoming events yet.</div>
                )}
              </div>
              <button
                onClick={() => router.push("/calendar")}
                className="mt-4 w-full rounded-full border border-[var(--lifeos-border-soft)] bg-white px-4 py-2 text-sm font-semibold text-black/80"
              >
                View full calendar
              </button>
            </WhiteCard>
          </div>

          <WhiteCard className="p-6">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold text-black/70">Today’s timeline</div>
              <div className="text-xs text-black/45">from your calendar</div>
            </div>
            {todayBlocks.length ? (
              <div className="mt-4 space-y-2">
                {todayBlocks.slice(0, 10).map((b) => (
                  <div key={b.id} className="flex items-center justify-between rounded-xl border border-[var(--lifeos-border-soft)] bg-white px-4 py-3">
                    <div className="text-xs font-semibold uppercase tracking-wide text-black/50">
                      {minsToTime(b.startMin)}–{minsToTime(b.endMin)}
                    </div>
                    <div className="flex-1 px-4 text-sm text-black/80">{b.title}</div>
                    {b.meta?.kind ? <Pill>{b.meta.kind}</Pill> : null}
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-3 text-sm text-black/60">No blocks on today’s calendar yet.</div>
            )}
          </WhiteCard>
        </div>
      </section>
    </div>
  );
}
