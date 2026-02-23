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
    return generateId();
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
    // Persist calendar cursor so after importing a syllabus (semester dates) the view can
    // jump to the relevant week instead of staying on "today".
    if (typeof window === "undefined") return new Date();
    try {
      const raw = window.localStorage.getItem("lifeos_calendar_cursor_v1");
      if (raw && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        const d = new Date(`${raw}T12:00:00`);
        if (!Number.isNaN(d.getTime())) return d;
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
  // Show the full day down to midnight (24:00) so late events are visible.
  const endHour = 24;
  const stepMin = 10;
  const hourRowPx = 72; // height per hour row in px
  // Grid height must be EXACTLY (endHour - startHour) * hourRowPx so that
  // minuteTopPct() percentages line up perfectly with the hour-divider rows.
  // Do NOT add +1 here — the +1 was causing every block to render ~1 row too high.
  const gridHeightPx = (endHour - startHour) * hourRowPx;

  // Wider columns so titles don't collide. (We still truncate to guarantee no overflow.)
  const timeColPx = 84;
  // Make the calendar wider so blocks have enough room for readable titles.
  const dayColMinPx = 260;

  useEffect(() => {
    setItems(loadCalendar());
    // Set today's ISO date client-side only — avoids server/client hydration mismatch
    // that would occur from calling new Date() during render.
    setTodayISO(todayISO);
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

    // Account for horizontal scroll.
    const x = clamp(clientX - r.left + scrollEl.scrollLeft - timeColPx, 0, gridEl.scrollWidth - timeColPx - 1);
    const colW = (gridEl.scrollWidth - timeColPx) / 7;
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
      <div className="w-full grid gap-10 lg:grid-cols-[320px_1fr]">
      <aside className="hidden lg:block">
        <div className="rounded-2xl border border-[var(--lifeos-border-soft)] bg-white p-5">
          <div className="text-sm font-semibold text-black/70">{formatHeader(cursor)}</div>
          <div className="mt-4 grid grid-cols-7 gap-2 text-center text-xs text-black/60">
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i}>{["M", "T", "W", "T", "F", "S", "S"][i]}</div>
            ))}
          </div>
          <div className="mt-2 grid grid-cols-7 gap-2">
            {(() => {
              const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
              const start = startOfWeek(first);
              return Array.from({ length: 42 }, (_, i) => {
                const d = new Date(start);
                d.setDate(d.getDate() + i);
                const iso = isoDateLocal(d);
                const isThisMonth = d.getMonth() === cursor.getMonth();
                const isToday = iso === todayISO;

                return (
                  <button
                    key={iso}
                    onClick={() => setCursor(d)}
                    className={
                      "h-8 rounded-lg text-xs font-semibold transition " +
                      (isToday
                        ? "bg-[var(--lifeos-pink)] text-white"
                        : isThisMonth
                          ? "bg-black/[0.03] text-black/80 hover:bg-black/[0.06]"
                          : "text-black/30")
                    }
                    aria-label={iso}
                  >
                    {d.getDate()}
                  </button>
                );
              });
            })()}
          </div>

          <div className="mt-5 grid grid-cols-3 gap-2">
            <button
              onClick={() => {
                const d = new Date(cursor);
                d.setMonth(d.getMonth() - 1);
                setCursor(d);
              }}
              className="w-full rounded-full border border-[var(--lifeos-border-soft)] bg-white px-0 py-2 text-xs font-semibold text-black/70"
            >
              Prev
            </button>
            <button
              onClick={() => setCursor(new Date())}
              className="w-full rounded-full border border-[var(--lifeos-border-soft)] bg-white px-0 py-2 text-xs font-semibold text-black/70"
            >
              Today
            </button>
            <button
              onClick={() => {
                const d = new Date(cursor);
                d.setMonth(d.getMonth() + 1);
                setCursor(d);
              }}
              className="w-full rounded-full border border-[var(--lifeos-border-soft)] bg-white px-0 py-2 text-xs font-semibold text-black/70"
            >
              Next
            </button>
          </div>

          <div className="mt-6 text-xs text-black/60">
            Tip: generate a plan, then tap <span className="font-semibold">Add to Calendar</span>.
            <div className="mt-2">You can also double‑click to add a block.</div>
          </div>
        </div>
      </aside>

      <section>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-black/50">Calendar</div>
            <div className="mt-1 text-2xl font-extrabold text-black" style={{ letterSpacing: "-0.02em" }}>
              Week
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                const d = new Date(cursor);
                d.setDate(d.getDate() - 7);
                setCursor(d);
              }}
              className="rounded-full border border-[var(--lifeos-border-soft)] bg-white px-4 py-2 text-sm font-semibold text-black/70"
            >
              ←
            </button>
            <button
              onClick={() => {
                const d = new Date(cursor);
                d.setDate(d.getDate() + 7);
                setCursor(d);
              }}
              className="rounded-full border border-[var(--lifeos-border-soft)] bg-white px-4 py-2 text-sm font-semibold text-black/70"
            >
              →
            </button>

            <div className="ml-2 flex items-center gap-2">
              <select
                onChange={(e) => {
                  const v = e.target.value as "" | "day" | "week" | "month" | "all";
                  if (!v) return;
                  clearCalendar(v);
                  e.currentTarget.value = "";
                }}
                className="rounded-full border border-[var(--lifeos-border-soft)] bg-white px-4 py-2 text-sm font-semibold text-black/70"
                defaultValue=""
                aria-label="Clear calendar"
              >
                <option value="">Clear…</option>
                <option value="day">Clear day</option>
                <option value="week">Clear week</option>
                <option value="month">Clear month</option>
                <option value="all">Clear all</option>
              </select>
            </div>
          </div>
        </div>

        <div className="mt-6 overflow-hidden rounded-2xl border border-[var(--lifeos-border-soft)] bg-white">
          <div ref={scrollRef} className="overflow-x-auto">
          <div className="min-w-[1624px]">
          {/* Header row */}
          <div
            className="grid border-b border-[var(--lifeos-border-soft)] bg-black/[0.02]"
            style={{ gridTemplateColumns: `${timeColPx}px repeat(7, minmax(${dayColMinPx}px, 1fr))` }}
          >
            <div className="p-3 text-xs text-black/40"> </div>
            {days.map((d) => {
              const iso = isoDateLocal(d);
              const isToday = iso === todayISO;
              return (
                <div key={iso} className="p-3 text-center">
                  <div className={`text-xs ${isToday ? "text-[var(--lifeos-pink)]" : "text-black/50"}`}>{formatWeekday(d)}</div>
                  <div className={`text-sm font-semibold ${isToday ? "text-[var(--lifeos-pink)]" : "text-black"}`}>{formatDayLabel(d)}</div>
                </div>
              );
            })}
          </div>

          {/* Body */}
          <div
            ref={bodyRef}
            className="grid"
            style={{ gridTemplateColumns: `${timeColPx}px repeat(7, minmax(${dayColMinPx}px, 1fr))` }}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            {/* time labels */}
            <div className="relative" style={{ height: gridHeightPx }}>
              {hours.map((h) => (
                <div key={h} style={{ height: hourRowPx }} className="px-3 text-[11px] text-black/50">
                  {pad2(h)}:00
                </div>
              ))}
            </div>

            {days.map((d) => {
              const date = isoDateLocal(d);
              const dayBlocks = weekBlocks.filter((b) => b.date === date);

              return (
                <div
                  key={date}
                  className="relative border-l border-[var(--lifeos-border-soft)] bg-[var(--lifeos-cream)]"
                  style={{ height: gridHeightPx }}
                  onDoubleClick={(e) => onDoubleClickEmpty(e, date)}
                  onClick={() => setOverflowPopover(null)}
                >
                  {/* hour grid */}
                  {hours.map((h) => (
                    <div key={h} style={{ height: hourRowPx }} className="border-b border-black/[0.04]" />
                  ))}

                  {/* blocks — Option B layout:
                      - Primary block (col=0) renders full-width.
                      - Overflow siblings (col>0) are hidden; the primary shows a "+N more" badge.
                      - Clicking the badge opens a small popover listing the hidden blocks.
                      - Clicking a popover item opens that block's editor. */}
                  {(() => {
                    const laid = layoutDayBlocks(dayBlocks);
                    // Group by their group identity: all blocks with the same
                    // "group anchor" (the primary block) share a group.
                    // We identify groups by the primary block's id.
                    // Build a map: primaryId → overflow siblings
                    const primaryMap = new Map<string, { primary: LayoutBlock; overflow: LayoutBlock[] }>();
                    // We need to re-group: blocks with col=0 are primaries,
                    // blocks with col>0 belong to the most-recent primary that overlaps them.
                    const primaries: LayoutBlock[] = laid.filter((b) => b.col === 0);
                    const overflows: LayoutBlock[] = laid.filter((b) => b.col > 0);

                    for (const p of primaries) {
                      primaryMap.set(p.id, { primary: p, overflow: [] });
                    }
                    for (const ov of overflows) {
                      // Find the primary that this overflow overlaps with
                      const parent = primaries.find(
                        (p) => p.startMin < ov.endMin && ov.startMin < p.endMin
                      );
                      if (parent && primaryMap.has(parent.id)) {
                        primaryMap.get(parent.id)!.overflow.push(ov);
                      }
                    }

                    return Array.from(primaryMap.values()).map(({ primary: b, overflow }) => {
                      const topPx    = minuteTopPx(b.startMin, startHour, hourRowPx);
                      const heightPx = Math.max(24, minuteTopPx(b.endMin, startHour, hourRowPx) - topPx);
                      const timeLabel = `${minsToHHMM(b.startMin)}–${minsToHHMM(b.endMin)}`;
                      const short = truncTitle(b.title, 26);
                      const isPopoverOpen = overflowPopover === b.id;

                      // Color by kind
                      const kind = b.meta?.kind as string | undefined;
                      const blockColor =
                        kind === "prep"       ? "bg-blue-50 ring-blue-200"     :
                        kind === "follow-up"  ? "bg-green-50 ring-green-200"   :
                        kind === "travel"     ? "bg-amber-50 ring-amber-200"   :
                        kind === "reminder"   ? "bg-purple-50 ring-purple-200" :
                        kind === "buffer"     ? "bg-orange-50 ring-orange-200" :
                                               "bg-white ring-black/10";

                      return (
                        <div
                          key={b.id}
                          className="absolute"
                          style={{ top: topPx, height: heightPx, left: 4, right: 4, zIndex: 10 }}
                        >
                          {/* Primary block — full width */}
                          <div
                            data-block
                            className={`w-full h-full cursor-grab select-none overflow-hidden rounded-xl p-2 text-left shadow-sm ring-1 active:cursor-grabbing ${blockColor}`}
                            title={b.meta?.fullDetail ? `${b.title}\n${b.meta.fullDetail}` : b.title}
                            onPointerDown={(e) => onBlockPointerDown(e, b)}
                            onClick={() => openEditor(b.id)}
                          >
                            <div className="truncate text-xs font-semibold text-black/80 leading-tight">{short}</div>
                            {heightPx >= 36 && (
                              <div className="mt-0.5 text-[10px] text-black/40 leading-tight truncate">{timeLabel}</div>
                            )}
                          </div>

                          {/* +N more badge — only shown when there are overflow siblings */}
                          {overflow.length > 0 && (
                            <button
                              className="absolute bottom-1 right-1 z-20 rounded-full bg-black/70 px-1.5 py-0.5 text-[10px] font-bold text-white hover:bg-black transition-colors"
                              onClick={(e) => {
                                e.stopPropagation();
                                setOverflowPopover(isPopoverOpen ? null : b.id);
                              }}
                            >
                              +{overflow.length}
                            </button>
                          )}

                          {/* Overflow popover */}
                          {isPopoverOpen && (
                            <div
                              className="absolute left-0 z-50 mt-1 w-56 rounded-2xl border border-black/10 bg-white shadow-xl overflow-hidden"
                              style={{ top: "100%" }}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <div className="px-3 py-2 text-[10px] font-bold uppercase tracking-wide text-black/40 border-b border-black/5">
                                {overflow.length + 1} overlapping events
                              </div>
                              {/* Show primary at top too for easy reference */}
                              {[b, ...overflow].map((ov) => {
                                const ovKind = ov.meta?.kind as string | undefined;
                                const dot =
                                  ovKind === "prep"      ? "bg-blue-400"   :
                                  ovKind === "follow-up" ? "bg-green-400"  :
                                  ovKind === "travel"    ? "bg-amber-400"  :
                                  ovKind === "reminder"  ? "bg-purple-400" :
                                  ovKind === "buffer"    ? "bg-orange-400" :
                                                          "bg-black/30";
                                return (
                                  <button
                                    key={ov.id}
                                    className="flex w-full items-start gap-2 px-3 py-2.5 text-left hover:bg-black/[0.03] transition-colors border-b border-black/5 last:border-b-0"
                                    onClick={() => { setOverflowPopover(null); openEditor(ov.id); }}
                                  >
                                    <span className={`mt-1 h-2 w-2 flex-shrink-0 rounded-full ${dot}`} />
                                    <div>
                                      <div className="text-xs font-semibold text-black/80 leading-tight">{ov.title}</div>
                                      <div className="text-[10px] text-black/40 mt-0.5">{minsToHHMM(ov.startMin)}–{minsToHHMM(ov.endMin)}</div>
                                    </div>
                                  </button>
                                );
                              })}
                              <button
                                className="w-full px-3 py-2 text-[10px] text-black/30 hover:text-black/60 transition-colors text-center"
                                onClick={() => setOverflowPopover(null)}
                              >
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
        </div>

        {items.length === 0 ? (
          <div className="mt-6 rounded-2xl border border-[var(--lifeos-border-soft)] bg-white p-5 text-sm text-black/70">
            Your calendar is empty. Generate a plan, then tap <span className="font-semibold">Add to Calendar</span>.
          </div>
        ) : null}
      </section>

      {/* Edit modal */}
      {activeId ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onMouseDown={() => setActiveId(null)}>
          <div
            className="w-full max-w-lg rounded-3xl border border-[var(--lifeos-border-soft)] bg-white p-6"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="text-lg font-extrabold text-black" style={{ letterSpacing: "-0.02em" }}>
              Edit block
            </div>

            <div className="mt-5 space-y-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-black/50">Title</div>
                <input
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  className="mt-1 w-full rounded-2xl border border-[var(--lifeos-border-soft)] px-4 py-3 text-sm outline-none"
                />
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-3 sm:col-span-1">
                  <div className="text-xs font-semibold uppercase tracking-wide text-black/50">Day</div>
                  <select
                    value={draftDate}
                    onChange={(e) => setDraftDate(e.target.value)}
                    className="mt-1 w-full rounded-2xl border border-[var(--lifeos-border-soft)] px-3 py-3 text-sm outline-none"
                  >
                    {days.map((d) => {
                      const iso = isoDateLocal(d);
                      return (
                        <option key={iso} value={iso}>
                          {formatWeekday(d)} {formatDayLabel(d)}
                        </option>
                      );
                    })}
                  </select>
                </div>

                <div className="col-span-3 sm:col-span-1">
                  <div className="text-xs font-semibold uppercase tracking-wide text-black/50">Start</div>
                  <input
                    type="time"
                    value={minsToHHMM(draftStart)}
                    onChange={(e) => setDraftStart(hhmmToMins(e.target.value))}
                    className="mt-1 w-full rounded-2xl border border-[var(--lifeos-border-soft)] px-3 py-3 text-sm outline-none"
                  />
                </div>

                <div className="col-span-3 sm:col-span-1">
                  <div className="text-xs font-semibold uppercase tracking-wide text-black/50">End</div>
                  <input
                    type="time"
                    value={minsToHHMM(draftEnd)}
                    onChange={(e) => setDraftEnd(hhmmToMins(e.target.value))}
                    className="mt-1 w-full rounded-2xl border border-[var(--lifeos-border-soft)] px-3 py-3 text-sm outline-none"
                  />
                </div>
              </div>
            </div>

            <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
              <button
                onClick={deleteActive}
                className="rounded-full border border-red-200 bg-red-50 px-5 py-2 text-sm font-semibold text-red-700"
              >
                Delete
              </button>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setActiveId(null)}
                  className="rounded-full border border-[var(--lifeos-border)] bg-white px-5 py-2 text-sm font-semibold text-black/70"
                >
                  Cancel
                </button>
                <button
                  onClick={saveEditor}
                  className="rounded-full bg-[var(--lifeos-pink)] px-5 py-2 text-sm font-semibold text-white"
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      </div>
    </div>
  );
}
