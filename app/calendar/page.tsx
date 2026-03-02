"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  addCalendarBlock,
  deleteCalendarBlock,
  loadCalendar,
  saveCalendar,
  updateCalendarBlock,
  type CalendarBlock,
} from "../lib/storage";

function pad2(n: number) {
  return n.toString().padStart(2, "0");
}

function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// IMPORTANT: Do NOT use Date.toISOString().slice(0,10) for calendar-day keys.
// toISOString() returns a UTC date, which can shift the day for users in non-UTC timezones.
function isoDateLocal(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const y = get("year");
  const m = get("month");
  const day = get("day");
  const iso = `${y}-${m}-${day}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : d.toISOString().slice(0, 10);
}

function startOfWeek(d: Date) {
  const dt = new Date(d);
  const day = dt.getDay(); // 0 Sun
  const diff = (day + 6) % 7; // Monday start
  dt.setDate(dt.getDate() - diff);
  dt.setHours(0, 0, 0, 0);
  return dt;
}

function formatHeader(d: Date) {
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function formatDayLabel(d: Date) {
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatWeekday(d: Date) {
  return d.toLocaleDateString(undefined, { weekday: "short" });
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function minuteTopPct(mins: number, startHour: number, endHour: number) {
  const start = startHour * 60;
  const end = endHour * 60;
  const t = clamp(mins, start, end);
  return ((t - start) / (end - start)) * 100;
}

// Pixel-precise version: converts minutes to an exact pixel offset so blocks
// land exactly on hour-divider lines instead of drifting due to % rounding.
function minuteTopPx(mins: number, startHour: number, hourRowPx: number) {
  const offsetMins = mins - startHour * 60;
  return (offsetMins / 60) * hourRowPx;
}

function truncTitle(title: string, max = 28) {
  const t = title.trim();
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 1)) + "…";
}

// ─── Overlap layout: assign column positions so overlapping blocks sit side-by-side ───
type LayoutBlock = CalendarBlock & { col: number; cols: number };

function layoutDayBlocks(blocks: CalendarBlock[]): LayoutBlock[] {
  if (blocks.length === 0) return [];

  // Sort by start time, then longer duration first so the most prominent block
  // in any overlapping cluster becomes the "primary" (col=0).
  const sorted = [...blocks].sort((a, b) =>
    a.startMin !== b.startMin
      ? a.startMin - b.startMin
      : (b.endMin - b.startMin) - (a.endMin - a.startMin)
  );

  // Build overlap clusters: two blocks are in the same cluster if they overlap
  // (directly or transitively). Use union-find style grouping.
  const clusterOf = new Array<number>(sorted.length).fill(-1);
  let nextCluster = 0;

  for (let i = 0; i < sorted.length; i++) {
    if (clusterOf[i] === -1) {
      clusterOf[i] = nextCluster++;
    }
    const ci = clusterOf[i];
    for (let j = i + 1; j < sorted.length; j++) {
      // Two blocks overlap if one starts before the other ends
      if (sorted[i].endMin > sorted[j].startMin && sorted[j].endMin > sorted[i].startMin) {
        if (clusterOf[j] === -1) {
          clusterOf[j] = ci; // join same cluster
        } else if (clusterOf[j] !== ci) {
          // Merge: reassign all j-cluster members to ci
          const old = clusterOf[j];
          for (let k = 0; k < sorted.length; k++) {
            if (clusterOf[k] === old) clusterOf[k] = ci;
          }
        }
      }
    }
  }

  // Within each cluster, assign position: first block = col 0 (primary), rest = col 1,2,…
  const clusterPos: Record<number, number> = {};
  const clusterSize: Record<number, number> = {};

  // Count cluster sizes first
  for (let i = 0; i < sorted.length; i++) {
    const c = clusterOf[i];
    clusterSize[c] = (clusterSize[c] ?? 0) + 1;
  }

  const result: LayoutBlock[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const c = clusterOf[i];
    const pos = clusterPos[c] ?? 0;
    clusterPos[c] = pos + 1;
    result.push({ ...sorted[i], col: pos, cols: clusterSize[c] });
  }

  return result;
}

type ClearScope = "day" | "week" | "month" | "all";

function minsToHHMM(mins: number) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${pad2(h)}:${pad2(m)}`;
}

function hhmmToMins(hhmm: string) {
  const m = hhmm.match(/^(\d{2}):(\d{2})$/);
  if (!m) return 0;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function overlaps(a: { startMin: number; endMin: number }, b: { startMin: number; endMin: number }) {
  return a.startMin < b.endMin && b.startMin < a.endMin;
}

function findNextFree(
  blocks: CalendarBlock[],
  startMin: number,
  durationMin: number,
  startHour: number,
  endHour: number,
  stepMin: number
) {
  const windowStart = startHour * 60;
  const windowEnd = endHour * 60;
  let t = clamp(startMin, windowStart, windowEnd - durationMin);
  t = Math.round(t / stepMin) * stepMin;

  for (let i = 0; i < 200; i++) {
    const candidate = { startMin: t, endMin: t + durationMin };
    if (!blocks.some((b) => overlaps(candidate, b))) return candidate;
    t += stepMin;
    if (t + durationMin > windowEnd) break;
  }
  return { startMin: clamp(startMin, windowStart, windowEnd - durationMin), endMin: clamp(startMin + durationMin, windowStart + durationMin, windowEnd) };
}

export default function CalendarPage() {
  const [cursor, setCursor] = useState(() => {
    // Always open on the current week by default.
    // Only jump to the syllabus-import cursor if the user came directly from importing
    // (detected by a sessionStorage flag set during import).
    if (typeof window === "undefined") return new Date();
    try {
      const jumpFlag = window.sessionStorage.getItem("lifeos_calendar_jump_v1");
      if (jumpFlag === "1") {
        window.sessionStorage.removeItem("lifeos_calendar_jump_v1");
        const raw = window.localStorage.getItem("lifeos_calendar_cursor_v1");
        if (raw && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
          const d = new Date(`${raw}T12:00:00`);
          if (!Number.isNaN(d.getTime())) return d;
        }
      }
    } catch {
      // ignore
    }
    return new Date();
  });
  const [items, setItems] = useState<CalendarBlock[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  // todayISO is set client-side only (via useEffect) to avoid server/client hydration mismatch.
  const [todayISO, setTodayISO] = useState("");
  // Popover state: which block's "+N more" badge is open
  const [overflowPopover, setOverflowPopover] = useState<string | null>(null);

  // Edit modal drafts
  const [draftTitle, setDraftTitle] = useState("");
  const [draftDate, setDraftDate] = useState("");
  const [draftStart, setDraftStart] = useState(0);
  const [draftEnd, setDraftEnd] = useState(0);

  // Layout + drag
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    id: string;
    duration: number;
    offsetMin: number;
    moved: boolean;
  } | null>(null);

  const startHour = 6;
  const endHour = 24;
  const stepMin = 10;
  const hourRowPx = 56; // tighter rows so more hours fit without vertical scroll
  const gridHeightPx = (endHour - startHour) * hourRowPx;

  // Narrow time column so day columns get maximum width
  const timeColPx = 48;
  // No minimum — let columns be exactly 1fr so all 7 fit without horizontal scroll
  const dayColMinPx = 0;

  useEffect(() => {
    setItems(loadCalendar());
    // Set today's ISO date client-side only — avoids server/client hydration mismatch
    // that would occur from calling new Date() during render.
    setTodayISO(isoDateLocal(new Date()));
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("lifeos_calendar_cursor_v1", isoDateLocal(cursor));
    } catch {
      // ignore
    }
  }, [cursor]);

  const weekStart = useMemo(() => startOfWeek(cursor), [cursor]);
  const days = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) => {
        const d = new Date(weekStart);
        d.setDate(d.getDate() + i);
        return d;
      }),
    [weekStart]
  );

  const inWeek = useMemo(() => new Set(days.map((d) => isoDateLocal(d))), [days]);
  const weekBlocks = useMemo(() => items.filter((b) => inWeek.has(b.date)), [items, inWeek]);

  useEffect(() => {
    const b = activeId ? items.find((x) => x.id === activeId) : null;
    if (!b) return;
    setDraftTitle(b.title);
    setDraftDate(b.date);
    setDraftStart(b.startMin);
    setDraftEnd(b.endMin);
  }, [activeId, items]);

  function persist(updated: CalendarBlock[]) {
    setItems(updated);
  }

  function pointerToSlot(clientX: number, clientY: number) {
    const scrollEl = scrollRef.current;
    const gridEl = bodyRef.current;
    if (!scrollEl || !gridEl) return null;
    const r = scrollEl.getBoundingClientRect();

    // Use offsetWidth — no horizontal scroll, columns fill viewport width.
    const gridW = gridEl.offsetWidth;
    const x = clamp(clientX - r.left - timeColPx, 0, gridW - timeColPx - 1);
    const colW = (gridW - timeColPx) / 7;
    const dayIdx = clamp(Math.floor(x / colW), 0, 6);
    const date = isoDateLocal(days[dayIdx]);

    const y = clamp(clientY - r.top, 0, gridHeightPx);
    // Use pixel math: each hourRowPx pixels = 1 hour = 60 minutes
    const mins = startHour * 60 + (y / hourRowPx) * 60;
    const snapped = Math.round(mins / stepMin) * stepMin;
    return { date, startMin: clamp(snapped, startHour * 60, endHour * 60) };
  }

  function onBlockPointerDown(e: React.PointerEvent, b: CalendarBlock) {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = {
      id: b.id,
      duration: Math.max(10, b.endMin - b.startMin),
      offsetMin: 0,
      moved: false,
    };

    const slot = pointerToSlot(e.clientX, e.clientY);
    if (slot) {
      dragRef.current.offsetMin = clamp(slot.startMin - b.startMin, -12 * 60, 12 * 60);
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    const slot = pointerToSlot(e.clientX, e.clientY);
    if (!slot) return;
    d.moved = true;

    const startMin = clamp(slot.startMin - d.offsetMin, startHour * 60, endHour * 60 - d.duration);
    const endMin = startMin + d.duration;
    const id = d.id;

    // Optimistic UI update
    setItems((prev) => prev.map((b) => (b.id === id ? { ...b, date: slot.date, startMin, endMin } : b)));
  }

  function onPointerUp() {
    const d = dragRef.current;
    if (!d) return;
    const id = d.id;
    dragRef.current = null;

    const movedBlock = items.find((b) => b.id === id);
    if (!movedBlock) return;
    // Persist
    const updated = updateCalendarBlock(id, { date: movedBlock.date, startMin: movedBlock.startMin, endMin: movedBlock.endMin });
    persist(updated);
  }

  function openEditor(id: string) {
    setActiveId(id);
  }

  function saveEditor() {
    if (!activeId) return;
    const updated = updateCalendarBlock(activeId, {
      title: draftTitle.trim() || "Untitled",
      date: draftDate,
      startMin: draftStart,
      endMin: Math.max(draftStart + 10, draftEnd),
    });
    persist(updated);
    setActiveId(null);
  }

  function deleteActive() {
    if (!activeId) return;
    if (!window.confirm("Are you sure you want to delete this time block?")) return;
    const updated = deleteCalendarBlock(activeId);
    persist(updated);
    setActiveId(null);
  }

  function clearCalendar(scope: "day" | "week" | "month" | "all") {
    const msg =
      scope === "all"
        ? "Are you sure you want to clear your entire calendar?"
        : scope === "month"
          ? "Are you sure you want to clear this month?"
          : scope === "week"
            ? "Are you sure you want to clear this week?"
            : "Are you sure you want to clear this day?";
    if (!window.confirm(msg)) return;

    const all = loadCalendar();

    const keep = all.filter((b) => {
      if (scope === "all") return false;

      // Day = cursor date
      const cursorIso = isoDateLocal(cursor);
      if (scope === "day") return b.date !== cursorIso;

      // Week = current visible week
      if (scope === "week") return !inWeek.has(b.date);

      // Month = cursor month
      const y = cursor.getFullYear();
      const m = cursor.getMonth() + 1;
      const [by, bm] = b.date.split("-").map(Number);
      return !(by === y && bm === m);
    });

    saveCalendar(keep);
    setItems(keep);
    setActiveId(null);
  }

  function onDoubleClickEmpty(e: React.MouseEvent, date: string) {
    const el = bodyRef.current;
    if (!el) return;
    // Only react if clicking inside the column's background (not on an event)
    if ((e.target as HTMLElement).closest("[data-block]") ) return;

    const r = el.getBoundingClientRect();
    const y = clamp(e.clientY - r.top, 0, gridHeightPx);
    // Pixel-precise: each hourRowPx px = 1 hour
    const mins = startHour * 60 + (y / hourRowPx) * 60;
    const startMin = Math.round(mins / stepMin) * stepMin;

    const duration = 50;
    const dayBlocks = items.filter((b) => b.date === date);
    const slot = findNextFree(dayBlocks, startMin, duration, startHour, endHour, stepMin);

    const block: CalendarBlock = {
      id: generateId(),
      date,
      title: "New block",
      startMin: slot.startMin,
      endMin: slot.endMin,
      meta: { kind: "manual" },
    };

    addCalendarBlock(block);
    setItems(loadCalendar());
    setActiveId(block.id);
  }

  const hours = useMemo(() => Array.from({ length: endHour - startHour + 1 }, (_, i) => startHour + i), [startHour, endHour]);

  return (
    <div className="w-full">
      <div className="w-full grid gap-6 lg:grid-cols-[220px_1fr]">

        {/* ── Mini calendar sidebar ── */}
        <aside className="hidden lg:block space-y-4">
          <div className="rounded-2xl bg-white border border-black/[0.06] p-5">

            {/* Month header */}
            <div className="text-sm font-extrabold text-black" style={{ letterSpacing: "-0.02em" }}>{formatHeader(cursor)}</div>

            {/* Weekday labels */}
            <div className="mt-4 grid grid-cols-7 gap-1 text-center">
              {["M","T","W","T","F","S","S"].map((d, i) => (
                <div key={i} className="text-[10px] font-bold text-black/30">{d}</div>
              ))}
            </div>

            {/* Day cells */}
            <div className="mt-1 grid grid-cols-7 gap-1">
              {(() => {
                const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
                const start = startOfWeek(first);
                return Array.from({ length: 42 }, (_, i) => {
                  const d = new Date(start);
                  d.setDate(d.getDate() + i);
                  const iso = isoDateLocal(d);
                  const isThisMonth = d.getMonth() === cursor.getMonth();
                  const isToday = iso === todayISO;
                  const isInWeek = inWeek.has(iso);
                  return (
                    <button
                      key={iso}
                      onClick={() => setCursor(d)}
                      className={
                        "h-7 rounded-lg text-[11px] font-semibold transition-all " +
                        (isToday
                          ? "bg-[var(--lifeos-pink)] text-white shadow-[0_2px_8px_rgba(255,107,107,0.35)]"
                          : isInWeek && isThisMonth
                            ? "bg-[var(--lifeos-pink)]/10 text-[var(--lifeos-pink)] font-bold"
                            : isThisMonth
                              ? "hover:bg-black/[0.05] text-black/70"
                              : "text-black/20")
                      }
                      aria-label={iso}
                    >
                      {d.getDate()}
                    </button>
                  );
                });
              })()}
            </div>

            {/* Month nav */}
            <div className="mt-4 grid grid-cols-3 gap-1.5">
              <button
                onClick={() => { const d = new Date(cursor); d.setMonth(d.getMonth() - 1); setCursor(d); }}
                className="rounded-xl border border-black/[0.07] bg-white py-2 text-xs font-bold text-black/50 hover:bg-black/[0.04] transition-colors"
              >← Prev</button>
              <button
                onClick={() => setCursor(new Date())}
                className="rounded-xl bg-[var(--lifeos-pink)] py-2 text-xs font-bold text-white"
              >Today</button>
              <button
                onClick={() => { const d = new Date(cursor); d.setMonth(d.getMonth() + 1); setCursor(d); }}
                className="rounded-xl border border-black/[0.07] bg-white py-2 text-xs font-bold text-black/50 hover:bg-black/[0.04] transition-colors"
              >Next →</button>
            </div>
          </div>

          {/* Tips */}
          <div className="rounded-2xl bg-white border border-black/[0.06] p-5">
            <div className="text-[11px] font-bold uppercase tracking-widest text-black/30 mb-2">Tips</div>
            <ul className="space-y-2">
              {[
                "Generate a plan, then tap Add to Calendar.",
                "Double-click any slot to create a block.",
                "Drag blocks to reschedule them.",
              ].map((tip, i) => (
                <li key={i} className="flex items-start gap-2 text-xs text-black/50">
                  <span className="text-[var(--lifeos-pink)] flex-shrink-0">✦</span>
                  {tip}
                </li>
              ))}
            </ul>
          </div>
        </aside>

        {/* ── Main calendar section ── */}
        <section>

          {/* Toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
            <div>
              <div className="text-[11px] font-bold uppercase tracking-widest text-black/30">Calendar</div>
              <div className="text-2xl font-extrabold text-black" style={{ letterSpacing: "-0.03em" }}>
                {formatHeader(cursor)}
              </div>
            </div>

            <div className="flex items-center gap-2">
              {/* Week nav */}
              <button
                onClick={() => { const d = new Date(cursor); d.setDate(d.getDate() - 7); setCursor(d); }}
                className="h-9 w-9 flex items-center justify-center rounded-xl border border-black/[0.08] bg-white text-black/60 hover:bg-black/[0.04] transition-colors font-bold"
              >←</button>
              <button
                onClick={() => { const d = new Date(cursor); d.setDate(d.getDate() + 7); setCursor(d); }}
                className="h-9 w-9 flex items-center justify-center rounded-xl border border-black/[0.08] bg-white text-black/60 hover:bg-black/[0.04] transition-colors font-bold"
              >→</button>

              {/* Clear dropdown */}
              <select
                onChange={(e) => {
                  const v = e.target.value as "" | "day" | "week" | "month" | "all";
                  if (!v) return;
                  clearCalendar(v);
                  e.currentTarget.value = "";
                }}
                className="h-9 rounded-xl border border-black/[0.08] bg-white px-3 text-xs font-bold text-black/50 hover:bg-black/[0.04] transition-colors outline-none cursor-pointer"
                defaultValue=""
                aria-label="Clear calendar"
              >
                <option value="">🗑 Clear…</option>
                <option value="day">Clear day</option>
                <option value="week">Clear week</option>
                <option value="month">Clear month</option>
                <option value="all">Clear all</option>
              </select>
            </div>
          </div>

          {/* Calendar grid */}
          <div className="overflow-hidden rounded-2xl border border-black/[0.06] bg-white shadow-[0_2px_12px_rgba(0,0,0,0.05)]">
            <div ref={scrollRef} className="w-full">

                {/* Header row */}
                <div
                  className="grid border-b border-black/[0.05] bg-black/[0.015]"
                  style={{ gridTemplateColumns: `${timeColPx}px repeat(7, 1fr)` }}
                >
                  <div className="p-2" />
                  {days.map((d) => {
                    const iso = isoDateLocal(d);
                    const isToday = iso === todayISO;
                    return (
                      <div key={iso} className="py-2 px-1 text-center">
                        <div className={`text-[9px] font-bold uppercase tracking-widest ${isToday ? "text-[var(--lifeos-pink)]" : "text-black/30"}`}>
                          {formatWeekday(d)}
                        </div>
                        <div className={`mt-0.5 mx-auto inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${isToday ? "bg-[var(--lifeos-pink)] text-white shadow-[0_2px_8px_rgba(255,107,107,0.35)]" : "text-black/70"}`}>
                          {d.getDate()}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* ── Deadlines row — shows events with startMin ≥ 23:00 (graded items default to 23:50) ── */}
                {(() => {
                  // Threshold: anything at or after 11pm is a "deadline" event, not a timed block.
                  // storage.ts stores graded items at startMin=1430 (23:50) or startMin=1439 (23:59).
                  const isDue = (b: CalendarBlock) => b.startMin >= 23 * 60;
                  const hasDueBlocks = days.some((d) => {
                    const iso = isoDateLocal(d);
                    return weekBlocks.some((b) => b.date === iso && isDue(b));
                  });
                  if (!hasDueBlocks) return null;
                  return (
                    <div
                      className="grid border-b border-black/[0.07]"
                      style={{ gridTemplateColumns: `${timeColPx}px repeat(7, 1fr)`, backgroundColor: "rgba(217,108,125,0.06)" }}
                    >
                      <div className="flex items-center justify-end pr-1.5 py-1.5">
                        <span className="text-[9px] font-extrabold text-[var(--lifeos-pink)] uppercase tracking-widest leading-none">Due</span>
                      </div>
                      {days.map((d) => {
                        const iso = isoDateLocal(d);
                        const dueBlocks = weekBlocks.filter((b) => b.date === iso && isDue(b));
                        return (
                          <div key={iso} className="border-l border-black/[0.04] py-1 px-0.5 flex flex-col gap-0.5 min-h-[28px]">
                            {dueBlocks.map((b) => {
                              const customColor = (b.meta as any)?.color as string | undefined;
                              const kind = b.meta?.kind as string | undefined;
                              const bgColor = customColor
                                ? `${customColor}22`
                                : kind === "syllabus" ? "#fce7eb" : "#fef3c7";
                              const textColor = customColor
                                ? customColor
                                : kind === "syllabus" ? "#9d1f35" : "#92400e";
                              const borderColor = customColor
                                ? `${customColor}66`
                                : kind === "syllabus" ? "#f9a8b4" : "#fcd34d";
                              return (
                                <button
                                  key={b.id}
                                  onClick={() => openEditor(b.id)}
                                  className="w-full rounded-md px-1.5 py-0.5 text-left truncate"
                                  style={{ backgroundColor: bgColor, color: textColor, border: `1px solid ${borderColor}`, fontSize: 10, fontWeight: 700, lineHeight: 1.4 }}
                                  title={b.title}
                                >
                                  {truncTitle(b.title, 20)}
                                </button>
                              );
                            })}
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}

                {/* Body */}
                <div
                  ref={bodyRef}
                  className="grid"
                  style={{ gridTemplateColumns: `${timeColPx}px repeat(7, 1fr)` }}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={onPointerUp}
                >
                  {/* Time labels */}
                  <div className="relative border-r border-black/[0.04]" style={{ height: gridHeightPx }}>
                    {hours.map((h) => (
                      <div key={h} style={{ height: hourRowPx }} className="flex items-start justify-end pr-1.5 pt-1">
                        <span className="text-[9px] font-semibold text-black/25 tabular-nums leading-none">{pad2(h)}</span>
                      </div>
                    ))}
                  </div>

                  {/* Day columns */}
                  {days.map((d) => {
                    const date = isoDateLocal(d);
                    const dayBlocks = weekBlocks.filter((b) => b.date === date);
                    const isToday = date === todayISO;

                    return (
                      <div
                        key={date}
                        className={`relative border-l border-black/[0.04] ${isToday ? "bg-[var(--lifeos-pink)]/[0.02]" : "bg-white"}`}
                        style={{ height: gridHeightPx }}
                        onDoubleClick={(e) => onDoubleClickEmpty(e, date)}
                        onClick={() => setOverflowPopover(null)}
                      >
                        {/* Hour grid lines */}
                        {hours.map((h) => (
                          <div key={h} style={{ height: hourRowPx }} className={`border-b ${h % 2 === 0 ? "border-black/[0.05]" : "border-black/[0.025]"}`} />
                        ))}

                        {/* Blocks — exclude deadline blocks (startMin ≥ 23:00, shown in the Due row above) */}
                        {(() => {
                          const timedBlocks = dayBlocks.filter(
                            (b) => b.startMin < 23 * 60
                          );
                          const laid = layoutDayBlocks(timedBlocks);
                          const primaries: LayoutBlock[] = laid.filter((b) => b.col === 0);
                          const overflows: LayoutBlock[] = laid.filter((b) => b.col > 0);
                          const primaryMap = new Map<string, { primary: LayoutBlock; overflow: LayoutBlock[] }>();
                          for (const p of primaries) primaryMap.set(p.id, { primary: p, overflow: [] });
                          for (const ov of overflows) {
                            const parent = primaries.find((p) => p.startMin < ov.endMin && ov.startMin < p.endMin);
                            if (parent && primaryMap.has(parent.id)) primaryMap.get(parent.id)!.overflow.push(ov);
                          }

                          return Array.from(primaryMap.values()).map(({ primary: b, overflow }) => {
                            const topPx    = minuteTopPx(b.startMin, startHour, hourRowPx);
                            const heightPx = Math.max(24, minuteTopPx(b.endMin, startHour, hourRowPx) - topPx);
                            const timeLabel = `${minsToHHMM(b.startMin)}–${minsToHHMM(b.endMin)}`;
                            const short = truncTitle(b.title, 26);
                            const isPopoverOpen = overflowPopover === b.id;

                            const kind = b.meta?.kind as string | undefined;
                            const customColor = (b.meta as any)?.color as string | undefined;

                            // Use custom course color if present (syllabus blocks with user-picked color)
                            const blockStyle = customColor && kind === "syllabus"
                              ? {
                                  backgroundColor: `${customColor}18`,
                                  borderColor: `${customColor}55`,
                                  color: customColor,
                                }
                              : undefined;

                            const blockColor = customColor && kind === "syllabus"
                              ? "" // inline style handles coloring
                              : kind === "prep"       ? "bg-blue-50 border-blue-200 text-blue-800"     :
                                kind === "follow-up"  ? "bg-emerald-50 border-emerald-200 text-emerald-800" :
                                kind === "travel"     ? "bg-amber-50 border-amber-200 text-amber-800"   :
                                kind === "reminder"   ? "bg-violet-50 border-violet-200 text-violet-800":
                                kind === "buffer"     ? "bg-orange-50 border-orange-200 text-orange-800":
                                kind === "syllabus"   ? "bg-fuchsia-50 border-fuchsia-200 text-fuchsia-800":
                                                       "bg-[var(--lifeos-pink)]/8 border-[var(--lifeos-pink)]/25 text-black/80";

                            return (
                              <div
                                key={b.id}
                                className="absolute"
                                style={{ top: topPx, height: heightPx, left: 2, right: 2, zIndex: 10 }}
                              >
                                <div
                                  data-block
                                  className={`w-full h-full cursor-grab select-none overflow-hidden rounded-lg border p-1 text-left transition-shadow hover:shadow-md active:cursor-grabbing ${blockColor}`}
                                  style={blockStyle}
                                  title={b.meta?.fullDetail ? `${b.title}\n${b.meta.fullDetail}` : b.title}
                                  onPointerDown={(e) => onBlockPointerDown(e, b)}
                                  onClick={() => openEditor(b.id)}
                                >
                                  <div className="truncate text-[10px] font-bold leading-tight">{short}</div>
                                  {heightPx >= 32 && (
                                    <div className="mt-0.5 text-[9px] opacity-60 leading-tight truncate">{timeLabel}</div>
                                  )}
                                </div>

                                {overflow.length > 0 && (
                                  <button
                                    className="absolute bottom-1 right-1 z-20 rounded-full bg-black/60 px-1.5 py-0.5 text-[10px] font-bold text-white hover:bg-black/80 transition-colors"
                                    onClick={(e) => { e.stopPropagation(); setOverflowPopover(isPopoverOpen ? null : b.id); }}
                                  >
                                    +{overflow.length}
                                  </button>
                                )}

                                {isPopoverOpen && (
                                  <div
                                    className="absolute left-0 z-50 mt-1 w-60 rounded-2xl border border-black/[0.08] bg-white shadow-[0_8px_32px_rgba(0,0,0,0.12)] overflow-hidden"
                                    style={{ top: "100%" }}
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <div className="px-3 py-2.5 text-[10px] font-bold uppercase tracking-widest text-black/30 border-b border-black/[0.05]">
                                      {overflow.length + 1} overlapping
                                    </div>
                                    {[b, ...overflow].map((ov) => {
                                      const ovKind = ov.meta?.kind as string | undefined;
                                      const dot =
                                        ovKind === "prep"      ? "bg-blue-400"     :
                                        ovKind === "follow-up" ? "bg-emerald-400"  :
                                        ovKind === "travel"    ? "bg-amber-400"    :
                                        ovKind === "reminder"  ? "bg-violet-400"   :
                                        ovKind === "buffer"    ? "bg-orange-400"   :
                                                                "bg-[var(--lifeos-pink)]";
                                      return (
                                        <button
                                          key={ov.id}
                                          className="flex w-full items-start gap-2.5 px-3 py-3 text-left hover:bg-black/[0.03] transition-colors border-b border-black/[0.04] last:border-b-0"
                                          onClick={() => { setOverflowPopover(null); openEditor(ov.id); }}
                                        >
                                          <span className={`mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full ${dot}`} />
                                          <div>
                                            <div className="text-xs font-semibold text-black/80 leading-tight">{ov.title}</div>
                                            <div className="text-[10px] text-black/35 mt-0.5">{minsToHHMM(ov.startMin)}–{minsToHHMM(ov.endMin)}</div>
                                          </div>
                                        </button>
                                      );
                                    })}
                                    <button className="w-full px-3 py-2 text-[10px] text-black/30 hover:text-black/60 transition-colors" onClick={() => setOverflowPopover(null)}>
                                      Close
                                    </button>
                                  </div>
                                )}
                              </div>
                            );
                          });
                        })()}
                      </div>
                    );
                  })}
                </div>
            </div>
          </div>

          {/* Empty state */}
          {items.length === 0 && (
            <div className="mt-4 rounded-2xl border border-dashed border-black/[0.08] bg-white py-10 text-center">
              <p className="text-sm text-black/35">Your calendar is empty.</p>
              <p className="mt-1 text-xs text-black/25">Generate a plan, then tap <span className="font-semibold">Add to Calendar</span>.</p>
            </div>
          )}
        </section>

        {/* ── Edit modal ── */}
        {activeId && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onMouseDown={() => setActiveId(null)}>
            <div
              className="w-full max-w-lg rounded-3xl bg-white shadow-[0_24px_64px_rgba(0,0,0,0.18)] p-6"
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="text-lg font-extrabold text-black mb-5" style={{ letterSpacing: "-0.025em" }}>Edit block</div>

              <div className="space-y-4">
                <div>
                  <label className="text-[10px] font-bold uppercase tracking-widest text-black/35 block mb-1.5">Title</label>
                  <input
                    value={draftTitle}
                    onChange={(e) => setDraftTitle(e.target.value)}
                    className="w-full rounded-2xl border border-black/[0.09] bg-black/[0.02] px-4 py-3 text-sm font-semibold text-black outline-none focus:border-[var(--lifeos-pink)] transition-colors"
                  />
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-3 sm:col-span-1">
                    <label className="text-[10px] font-bold uppercase tracking-widest text-black/35 block mb-1.5">Day</label>
                    <select
                      value={draftDate}
                      onChange={(e) => setDraftDate(e.target.value)}
                      className="w-full rounded-2xl border border-black/[0.09] bg-black/[0.02] px-3 py-3 text-sm font-semibold text-black outline-none focus:border-[var(--lifeos-pink)] transition-colors"
                    >
                      {days.map((d) => {
                        const iso = isoDateLocal(d);
                        return <option key={iso} value={iso}>{formatWeekday(d)} {formatDayLabel(d)}</option>;
                      })}
                    </select>
                  </div>
                  <div className="col-span-3 sm:col-span-1">
                    <label className="text-[10px] font-bold uppercase tracking-widest text-black/35 block mb-1.5">Start</label>
                    <input
                      type="time"
                      value={minsToHHMM(draftStart)}
                      onChange={(e) => setDraftStart(hhmmToMins(e.target.value))}
                      className="w-full rounded-2xl border border-black/[0.09] bg-black/[0.02] px-3 py-3 text-sm font-semibold text-black outline-none focus:border-[var(--lifeos-pink)] transition-colors"
                    />
                  </div>
                  <div className="col-span-3 sm:col-span-1">
                    <label className="text-[10px] font-bold uppercase tracking-widest text-black/35 block mb-1.5">End</label>
                    <input
                      type="time"
                      value={minsToHHMM(draftEnd)}
                      onChange={(e) => setDraftEnd(hhmmToMins(e.target.value))}
                      className="w-full rounded-2xl border border-black/[0.09] bg-black/[0.02] px-3 py-3 text-sm font-semibold text-black outline-none focus:border-[var(--lifeos-pink)] transition-colors"
                    />
                  </div>
                </div>
              </div>

              <div className="mt-6 flex items-center justify-between gap-2">
                <button
                  onClick={deleteActive}
                  className="rounded-xl border border-red-200 bg-red-50 px-5 py-2.5 text-sm font-bold text-red-600 hover:bg-red-100 transition-colors"
                >
                  Delete
                </button>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setActiveId(null)}
                    className="rounded-xl border border-black/[0.08] bg-white px-5 py-2.5 text-sm font-bold text-black/60 hover:bg-black/[0.04] transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={saveEditor}
                    className="rounded-xl bg-[var(--lifeos-pink)] px-5 py-2.5 text-sm font-bold text-white shadow-[0_2px_8px_rgba(255,107,107,0.3)] hover:shadow-[0_4px_14px_rgba(255,107,107,0.4)] transition-shadow"
                  >
                    Save changes
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
