"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  addCalendarBlock,
  deleteCalendarBlock,
  loadCalendar,
  saveCalendar,
  updateCalendarBlock,
  type CalendarBlock,
} from "../lib/storage";
import { useToast } from "../components/Toast";

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

function isoDateLocal(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const iso = `${get("year")}-${get("month")}-${get("day")}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : d.toISOString().slice(0, 10);
}

function startOfWeek(d: Date) {
  const dt = new Date(d);
  dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
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

function minuteTopPx(mins: number, startHour: number, hourRowPx: number) {
  return ((mins - startHour * 60) / 60) * hourRowPx;
}

function truncTitle(title: string, max = 28) {
  const t = title.trim();
  return t.length <= max ? t : t.slice(0, max - 1) + "…";
}

type LayoutBlock = CalendarBlock & { col: number; cols: number };

function layoutDayBlocks(blocks: CalendarBlock[]): LayoutBlock[] {
  if (blocks.length === 0) return [];
  const sorted = [...blocks].sort((a, b) =>
    a.startMin !== b.startMin ? a.startMin - b.startMin : (b.endMin - b.startMin) - (a.endMin - a.startMin)
  );
  const clusterOf = new Array<number>(sorted.length).fill(-1);
  let nextCluster = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (clusterOf[i] === -1) clusterOf[i] = nextCluster++;
    const ci = clusterOf[i];
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[i].endMin > sorted[j].startMin && sorted[j].endMin > sorted[i].startMin) {
        if (clusterOf[j] === -1) clusterOf[j] = ci;
        else if (clusterOf[j] !== ci) {
          const old = clusterOf[j];
          for (let k = 0; k < sorted.length; k++) if (clusterOf[k] === old) clusterOf[k] = ci;
        }
      }
    }
  }
  const clusterPos: Record<number, number> = {};
  const clusterSize: Record<number, number> = {};
  for (let i = 0; i < sorted.length; i++) clusterSize[clusterOf[i]] = (clusterSize[clusterOf[i]] ?? 0) + 1;
  const result: LayoutBlock[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const c = clusterOf[i];
    const pos = clusterPos[c] ?? 0;
    clusterPos[c] = pos + 1;
    result.push({ ...sorted[i], col: pos, cols: clusterSize[c] });
  }
  return result;
}

function minsToHHMM(mins: number) {
  return `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`;
}
function hhmmToMins(hhmm: string) {
  const m = hhmm.match(/^(\d{2}):(\d{2})$/);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : 0;
}
function minsTo12h(mins: number) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const ampm = h < 12 ? "AM" : "PM";
  return `${h % 12 || 12}:${pad2(m)} ${ampm}`;
}

function overlaps(a: { startMin: number; endMin: number }, b: { startMin: number; endMin: number }) {
  return a.startMin < b.endMin && b.startMin < a.endMin;
}

function findNextFree(blocks: CalendarBlock[], startMin: number, durationMin: number, startHour: number, endHour: number, stepMin: number) {
  const windowStart = startHour * 60, windowEnd = endHour * 60;
  let t = clamp(Math.round(startMin / stepMin) * stepMin, windowStart, windowEnd - durationMin);
  for (let i = 0; i < 200; i++) {
    const candidate = { startMin: t, endMin: t + durationMin };
    if (!blocks.some((b) => overlaps(candidate, b))) return candidate;
    t += stepMin;
    if (t + durationMin > windowEnd) break;
  }
  return { startMin: clamp(startMin, windowStart, windowEnd - durationMin), endMin: clamp(startMin + durationMin, windowStart + durationMin, windowEnd) };
}

// ── Skeleton loader ───────────────────────────────────────────
function CalendarSkeleton() {
  return (
    <div className="w-full grid gap-6 lg:grid-cols-[220px_1fr] animate-pulse">
      <aside className="hidden lg:block space-y-4">
        <div className="rounded-2xl bg-black/[0.04] h-64" />
        <div className="rounded-2xl bg-black/[0.04] h-28" />
      </aside>
      <div className="space-y-4">
        <div className="flex justify-between items-center">
          <div className="h-8 w-40 rounded-xl bg-black/[0.06]" />
          <div className="h-9 w-32 rounded-xl bg-black/[0.04]" />
        </div>
        <div className="rounded-2xl border border-black/[0.06] overflow-hidden">
          <div className="h-10 bg-black/[0.03]" />
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex gap-2 border-t border-black/[0.04] px-2 py-3">
              <div className="h-3 w-8 rounded bg-black/[0.05]" />
              <div className="flex-1 space-y-2">
                {i % 3 === 0 && <div className="h-8 rounded-lg bg-black/[0.06]" style={{ width: `${40 + (i * 13) % 40}%` }} />}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Block color helper ────────────────────────────────────────
function blockColors(kind?: string, customColor?: string) {
  if (customColor && kind === "syllabus") {
    return {
      style: { backgroundColor: `${customColor}18`, borderColor: `${customColor}55`, color: customColor },
      cls: "",
    };
  }
  const cls =
    kind === "prep"       ? "bg-blue-50 border-blue-200 text-blue-800"       :
    kind === "follow-up"  ? "bg-emerald-50 border-emerald-200 text-emerald-800" :
    kind === "travel"     ? "bg-amber-50 border-amber-200 text-amber-800"    :
    kind === "reminder"   ? "bg-violet-50 border-violet-200 text-violet-800" :
    kind === "buffer"     ? "bg-orange-50 border-orange-200 text-orange-800" :
    kind === "syllabus"   ? "bg-fuchsia-50 border-fuchsia-200 text-fuchsia-800" :
                           "bg-[var(--lifeos-pink)]/8 border-[var(--lifeos-pink)]/25 text-black/80";
  return { style: undefined, cls };
}

function dotColor(kind?: string) {
  return kind === "prep"      ? "bg-blue-400"     :
         kind === "follow-up" ? "bg-emerald-400"  :
         kind === "travel"    ? "bg-amber-400"    :
         kind === "reminder"  ? "bg-violet-400"   :
         kind === "buffer"    ? "bg-orange-400"   :
         kind === "syllabus"  ? "bg-fuchsia-400"  :
                                "bg-[var(--lifeos-pink)]";
}

export default function CalendarPage() {
  const { toast } = useToast();

  const [cursor, setCursor] = useState(() => {
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
    } catch { /* ignore */ }
    return new Date();
  });

  const [items, setItems] = useState<CalendarBlock[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  // viewMode: "week" | "agenda"
  const [viewMode, setViewMode] = useState<"week" | "agenda">("week");
  // detail card: shows quick-view before edit
  const [detailId, setDetailId] = useState<string | null>(null);
  const [todayISO, setTodayISO] = useState("");
  const [overflowPopover, setOverflowPopover] = useState<string | null>(null);
  // drag preview
  const [dragPreview, setDragPreview] = useState<{ date: string; startMin: number; endMin: number } | null>(null);

  // Edit modal drafts
  const [draftTitle, setDraftTitle] = useState("");
  const [draftDate, setDraftDate] = useState("");
  const [draftStart, setDraftStart] = useState(0);
  const [draftEnd, setDraftEnd] = useState(0);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ id: string; duration: number; offsetMin: number; moved: boolean } | null>(null);

  const startHour = 6, endHour = 24, stepMin = 10, hourRowPx = 56;
  const gridHeightPx = (endHour - startHour) * hourRowPx;
  const timeColPx = 48;

  useEffect(() => {
    setItems(loadCalendar());
    setTodayISO(isoDateLocal(new Date()));
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try { window.localStorage.setItem("lifeos_calendar_cursor_v1", isoDateLocal(cursor)); } catch { /* ignore */ }
  }, [cursor]);

  const weekStart = useMemo(() => startOfWeek(cursor), [cursor]);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    return d;
  }), [weekStart]);

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

  function persist(updated: CalendarBlock[]) { setItems(updated); }

  function pointerToSlot(clientX: number, clientY: number) {
    const scrollEl = scrollRef.current, gridEl = bodyRef.current;
    if (!scrollEl || !gridEl) return null;
    const r = scrollEl.getBoundingClientRect();
    const gridW = gridEl.offsetWidth;
    const x = clamp(clientX - r.left - timeColPx, 0, gridW - timeColPx - 1);
    const colW = (gridW - timeColPx) / 7;
    const dayIdx = clamp(Math.floor(x / colW), 0, 6);
    const date = isoDateLocal(days[dayIdx]);
    const y = clamp(clientY - r.top, 0, gridHeightPx);
    const mins = startHour * 60 + (y / hourRowPx) * 60;
    const snapped = Math.round(mins / stepMin) * stepMin;
    return { date, startMin: clamp(snapped, startHour * 60, endHour * 60) };
  }

  function onBlockPointerDown(e: React.PointerEvent, b: CalendarBlock) {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { id: b.id, duration: Math.max(10, b.endMin - b.startMin), offsetMin: 0, moved: false };
    const slot = pointerToSlot(e.clientX, e.clientY);
    if (slot) dragRef.current.offsetMin = clamp(slot.startMin - b.startMin, -12 * 60, 12 * 60);
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
    setItems((prev) => prev.map((b) => b.id === id ? { ...b, date: slot.date, startMin, endMin } : b));
    // Show drag preview ghost
    setDragPreview({ date: slot.date, startMin, endMin });
  }

  function onPointerUp() {
    const d = dragRef.current;
    if (!d) return;
    const id = d.id;
    const moved = d.moved;
    dragRef.current = null;
    setDragPreview(null);
    const movedBlock = items.find((b) => b.id === id);
    if (!movedBlock) return;
    const updated = updateCalendarBlock(id, { date: movedBlock.date, startMin: movedBlock.startMin, endMin: movedBlock.endMin });
    persist(updated);
    if (moved) toast(`Moved to ${formatDayLabel(new Date(`${movedBlock.date}T12:00:00`))} · ${minsTo12h(movedBlock.startMin)}`, "info");
  }

  function openDetail(id: string) { setDetailId(id); }
  function openEditor(id: string) { setDetailId(null); setActiveId(id); }

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
    toast("Changes saved", "success");
  }

  function deleteActive() {
    if (!activeId) return;
    if (!window.confirm("Are you sure you want to delete this time block?")) return;
    const title = items.find((b) => b.id === activeId)?.title ?? "Block";
    const updated = deleteCalendarBlock(activeId);
    persist(updated);
    setActiveId(null);
    toast(`"${title}" deleted`, "info");
  }

  function clearCalendar(scope: "day" | "week" | "month" | "all") {
    const msg = scope === "all" ? "Are you sure you want to clear your entire calendar?" :
                scope === "month" ? "Are you sure you want to clear this month?" :
                scope === "week" ? "Are you sure you want to clear this week?" :
                "Are you sure you want to clear this day?";
    if (!window.confirm(msg)) return;
    const all = loadCalendar();
    const cursorIso = isoDateLocal(cursor);
    const keep = all.filter((b) => {
      if (scope === "all") return false;
      if (scope === "day") return b.date !== cursorIso;
      if (scope === "week") return !inWeek.has(b.date);
      const [by, bm] = b.date.split("-").map(Number);
      return !(by === cursor.getFullYear() && bm === cursor.getMonth() + 1);
    });
    saveCalendar(keep);
    setItems(keep);
    setActiveId(null);
    toast(`Calendar cleared (${scope})`, "info");
  }

  function onDoubleClickEmpty(e: React.MouseEvent, date: string) {
    const el = bodyRef.current;
    if (!el) return;
    if ((e.target as HTMLElement).closest("[data-block]")) return;
    const r = el.getBoundingClientRect();
    const y = clamp(e.clientY - r.top, 0, gridHeightPx);
    const mins = startHour * 60 + (y / hourRowPx) * 60;
    const startMin = Math.round(mins / stepMin) * stepMin;
    const slot = findNextFree(items.filter((b) => b.date === date), startMin, 50, startHour, endHour, stepMin);
    const block: CalendarBlock = { id: generateId(), date, title: "New block", startMin: slot.startMin, endMin: slot.endMin, meta: { kind: "manual" } };
    addCalendarBlock(block);
    setItems(loadCalendar());
    setActiveId(block.id);
  }

  const hours = useMemo(() => Array.from({ length: endHour - startHour + 1 }, (_, i) => startHour + i), [startHour, endHour]);

  // ── Agenda view data ──────────────────────────────────────────
  const agendaDays = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const result: { date: string; label: string; blocks: CalendarBlock[] }[] = [];
    for (let i = 0; i < 30; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      const iso = isoDateLocal(d);
      const dayBlocks = items.filter((b) => b.date === iso).sort((a, b) => a.startMin - b.startMin);
      result.push({
        date: iso,
        label: i === 0 ? "Today" : i === 1 ? "Tomorrow" :
          d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }),
        blocks: dayBlocks,
      });
    }
    return result.filter((d) => d.blocks.length > 0 || d.date === todayISO);
  }, [items, todayISO]);

  if (!loaded) return <CalendarSkeleton />;

  return (
    <div className="w-full">
      <div className="w-full grid gap-6 lg:grid-cols-[220px_1fr]">

        {/* ── Mini calendar sidebar ── */}
        <aside className="hidden lg:block space-y-4">
          <div className="rounded-2xl bg-white border border-black/[0.06] p-5">
            <div className="text-sm font-extrabold text-black" style={{ letterSpacing: "-0.02em" }}>{formatHeader(cursor)}</div>
            <div className="mt-4 grid grid-cols-7 gap-1 text-center">
              {["M","T","W","T","F","S","S"].map((d, i) => (
                <div key={i} className="text-[10px] font-bold text-black/30">{d}</div>
              ))}
            </div>
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
                      onClick={() => { setCursor(d); setViewMode("week"); }}
                      className={
                        "h-7 rounded-lg text-[11px] font-semibold transition-all " +
                        (isToday ? "bg-[var(--lifeos-pink)] text-white shadow-[0_2px_8px_rgba(255,107,107,0.35)]" :
                         isInWeek && isThisMonth ? "bg-[var(--lifeos-pink)]/10 text-[var(--lifeos-pink)] font-bold" :
                         isThisMonth ? "hover:bg-black/[0.05] text-black/70" : "text-black/20")
                      }
                      aria-label={iso}
                    >
                      {d.getDate()}
                    </button>
                  );
                });
              })()}
            </div>
            <div className="mt-4 grid grid-cols-3 gap-1.5">
              <button onClick={() => { const d = new Date(cursor); d.setMonth(d.getMonth() - 1); setCursor(d); }}
                className="rounded-xl border border-black/[0.07] bg-white py-2 text-xs font-bold text-black/50 hover:bg-black/[0.04] transition-colors">← Prev</button>
              <button onClick={() => setCursor(new Date())}
                className="rounded-xl bg-[var(--lifeos-pink)] py-2 text-xs font-bold text-white hover:opacity-90 transition-opacity">Today</button>
              <button onClick={() => { const d = new Date(cursor); d.setMonth(d.getMonth() + 1); setCursor(d); }}
                className="rounded-xl border border-black/[0.07] bg-white py-2 text-xs font-bold text-black/50 hover:bg-black/[0.04] transition-colors">Next →</button>
            </div>
          </div>
          <div className="rounded-2xl bg-white border border-black/[0.06] p-5">
            <div className="text-[11px] font-bold uppercase tracking-widest text-black/30 mb-2">Tips</div>
            <ul className="space-y-2">
              {["Generate a plan, then tap Add to Calendar.", "Double-click any slot to create a block.", "Drag blocks to reschedule them."].map((tip, i) => (
                <li key={i} className="flex items-start gap-2 text-xs text-black/50">
                  <span className="text-[var(--lifeos-pink)] flex-shrink-0">✦</span>{tip}
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
              <div className="text-2xl font-extrabold text-black" style={{ letterSpacing: "-0.03em" }}>{formatHeader(cursor)}</div>
            </div>
            <div className="flex items-center gap-2">
              {/* View toggle */}
              <div className="flex rounded-xl border border-black/[0.08] overflow-hidden">
                <button
                  onClick={() => setViewMode("week")}
                  className={`px-3 py-2 text-xs font-bold transition-colors ${viewMode === "week" ? "bg-[var(--lifeos-pink)] text-white" : "bg-white text-black/50 hover:bg-black/[0.04]"}`}
                >Week</button>
                <button
                  onClick={() => setViewMode("agenda")}
                  className={`px-3 py-2 text-xs font-bold transition-colors border-l border-black/[0.08] ${viewMode === "agenda" ? "bg-[var(--lifeos-pink)] text-white" : "bg-white text-black/50 hover:bg-black/[0.04]"}`}
                >Agenda</button>
              </div>
              {viewMode === "week" && (
                <>
                  <button onClick={() => { const d = new Date(cursor); d.setDate(d.getDate() - 7); setCursor(d); }}
                    className="h-9 w-9 flex items-center justify-center rounded-xl border border-black/[0.08] bg-white text-black/60 hover:bg-black/[0.04] hover:scale-105 active:scale-95 transition-all font-bold">←</button>
                  <button onClick={() => { const d = new Date(cursor); d.setDate(d.getDate() + 7); setCursor(d); }}
                    className="h-9 w-9 flex items-center justify-center rounded-xl border border-black/[0.08] bg-white text-black/60 hover:bg-black/[0.04] hover:scale-105 active:scale-95 transition-all font-bold">→</button>
                </>
              )}
              <select
                onChange={(e) => { const v = e.target.value as "" | "day" | "week" | "month" | "all"; if (!v) return; clearCalendar(v); e.currentTarget.value = ""; }}
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

          {/* ── AGENDA VIEW ── */}
          {viewMode === "agenda" && (
            <div className="space-y-3">
              {agendaDays.length === 0 && (
                <div className="rounded-2xl border border-dashed border-black/[0.08] bg-white py-16 text-center">
                  <div className="text-4xl mb-3">📭</div>
                  <p className="text-sm font-semibold text-black/40">Nothing coming up in the next 30 days.</p>
                  <p className="mt-1 text-xs text-black/25">Generate a plan or import your syllabus to get started.</p>
                </div>
              )}
              {agendaDays.map(({ date, label, blocks }) => (
                <div key={date} className="rounded-2xl bg-white border border-black/[0.06] overflow-hidden">
                  {/* Day header */}
                  <div className={`flex items-center gap-3 px-4 py-2.5 border-b border-black/[0.04] ${date === todayISO ? "bg-[var(--lifeos-pink)]/5" : "bg-black/[0.015]"}`}>
                    <span className={`text-xs font-extrabold ${date === todayISO ? "text-[var(--lifeos-pink)]" : "text-black/50"}`}>{label}</span>
                    <span className="text-[10px] text-black/25">{blocks.length} block{blocks.length !== 1 ? "s" : ""}</span>
                  </div>
                  {/* Blocks list */}
                  <div className="divide-y divide-black/[0.04]">
                    {blocks.map((b) => {
                      const kind = b.meta?.kind as string | undefined;
                      const customColor = (b.meta as any)?.color as string | undefined;
                      const { cls, style } = blockColors(kind, customColor);
                      const isDue = b.startMin >= 23 * 60;
                      return (
                        <button
                          key={b.id}
                          onClick={() => openDetail(b.id)}
                          className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-black/[0.02] active:bg-black/[0.04] transition-colors group"
                        >
                          <div className={`flex-shrink-0 h-2 w-2 rounded-full ${dotColor(kind)}`} />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-semibold text-black/80 truncate">{b.title}</div>
                            <div className="text-xs text-black/35">{isDue ? "Due" : `${minsTo12h(b.startMin)} – ${minsTo12h(b.endMin)}`}</div>
                          </div>
                          {kind && <span className={`text-[10px] font-bold flex-shrink-0 px-2 py-0.5 rounded-full border ${cls}`} style={style}>{kind}</span>}
                          <span className="text-black/20 group-hover:text-black/50 transition-colors flex-shrink-0">›</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ── WEEK VIEW ── */}
          {viewMode === "week" && (
            <>
              <div className="overflow-hidden rounded-2xl border border-black/[0.06] bg-white shadow-[0_2px_12px_rgba(0,0,0,0.05)]">
                <div ref={scrollRef} className="w-full">
                  {/* Header row */}
                  <div className="grid border-b border-black/[0.05] bg-black/[0.015]"
                    style={{ gridTemplateColumns: `${timeColPx}px repeat(7, 1fr)` }}>
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

                  {/* Due row */}
                  {(() => {
                    const isDue = (b: CalendarBlock) => b.startMin >= 23 * 60;
                    const hasDueBlocks = days.some((d) => weekBlocks.some((b) => b.date === isoDateLocal(d) && isDue(b)));
                    if (!hasDueBlocks) return null;
                    return (
                      <div className="grid border-b border-black/[0.07]"
                        style={{ gridTemplateColumns: `${timeColPx}px repeat(7, 1fr)`, backgroundColor: "rgba(217,108,125,0.06)" }}>
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
                                const bgColor = customColor ? `${customColor}22` : kind === "syllabus" ? "#fce7eb" : "#fef3c7";
                                const textColor = customColor ? customColor : kind === "syllabus" ? "#9d1f35" : "#92400e";
                                const borderColor = customColor ? `${customColor}66` : kind === "syllabus" ? "#f9a8b4" : "#fcd34d";
                                return (
                                  <button key={b.id} onClick={() => openDetail(b.id)}
                                    className="w-full rounded-md px-1.5 py-0.5 text-left truncate hover:opacity-80 transition-opacity"
                                    style={{ backgroundColor: bgColor, color: textColor, border: `1px solid ${borderColor}`, fontSize: 10, fontWeight: 700, lineHeight: 1.4 }}
                                    title={b.title}>
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
                  <div ref={bodyRef} className="grid"
                    style={{ gridTemplateColumns: `${timeColPx}px repeat(7, 1fr)` }}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerUp}>
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
                        <div key={date}
                          className={`relative border-l border-black/[0.04] ${isToday ? "bg-[var(--lifeos-pink)]/[0.02]" : "bg-white"}`}
                          style={{ height: gridHeightPx }}
                          onDoubleClick={(e) => onDoubleClickEmpty(e, date)}
                          onClick={() => setOverflowPopover(null)}>
                          {hours.map((h) => (
                            <div key={h} style={{ height: hourRowPx }}
                              className={`border-b ${h % 2 === 0 ? "border-black/[0.05]" : "border-black/[0.025]"}`} />
                          ))}

                          {/* Drag preview ghost */}
                          {dragPreview && dragPreview.date === date && (
                            <div className="absolute pointer-events-none z-20 left-1 right-1 rounded-lg border-2 border-dashed border-[var(--lifeos-pink)] bg-[var(--lifeos-pink)]/10"
                              style={{
                                top: minuteTopPx(dragPreview.startMin, startHour, hourRowPx),
                                height: Math.max(20, minuteTopPx(dragPreview.endMin, startHour, hourRowPx) - minuteTopPx(dragPreview.startMin, startHour, hourRowPx)),
                              }} />
                          )}

                          {/* Blocks */}
                          {(() => {
                            const timedBlocks = dayBlocks.filter((b) => b.startMin < 23 * 60);
                            const laid = layoutDayBlocks(timedBlocks);
                            const primaries = laid.filter((b) => b.col === 0);
                            const overflows = laid.filter((b) => b.col > 0);
                            const primaryMap = new Map<string, { primary: LayoutBlock; overflow: LayoutBlock[] }>();
                            for (const p of primaries) primaryMap.set(p.id, { primary: p, overflow: [] });
                            for (const ov of overflows) {
                              const parent = primaries.find((p) => p.startMin < ov.endMin && ov.startMin < p.endMin);
                              if (parent && primaryMap.has(parent.id)) primaryMap.get(parent.id)!.overflow.push(ov);
                            }
                            return Array.from(primaryMap.values()).map(({ primary: b, overflow }) => {
                              const topPx = minuteTopPx(b.startMin, startHour, hourRowPx);
                              const heightPx = Math.max(24, minuteTopPx(b.endMin, startHour, hourRowPx) - topPx);
                              const timeLabel = `${minsToHHMM(b.startMin)}–${minsToHHMM(b.endMin)}`;
                              const short = truncTitle(b.title, 26);
                              const isPopoverOpen = overflowPopover === b.id;
                              const kind = b.meta?.kind as string | undefined;
                              const customColor = (b.meta as any)?.color as string | undefined;
                              const { cls: blockColor, style: blockStyle } = blockColors(kind, customColor);
                              const isDragging = dragRef.current?.id === b.id;

                              return (
                                <div key={b.id} className="absolute"
                                  style={{ top: topPx, height: heightPx, left: 2, right: 2, zIndex: isDragging ? 30 : 10 }}>
                                  <div
                                    data-block
                                    className={`w-full h-full cursor-grab select-none overflow-hidden rounded-lg border p-1 text-left transition-all hover:shadow-md hover:scale-[1.02] active:cursor-grabbing active:scale-[0.98] ${blockColor} ${isDragging ? "opacity-60 shadow-lg" : ""}`}
                                    style={blockStyle}
                                    title={b.meta?.fullDetail ? `${b.title}\n${b.meta.fullDetail}` : b.title}
                                    onPointerDown={(e) => onBlockPointerDown(e, b)}
                                    onClick={() => !dragRef.current?.moved && openDetail(b.id)}
                                  >
                                    <div className="truncate text-[10px] font-bold leading-tight">{short}</div>
                                    {heightPx >= 32 && <div className="mt-0.5 text-[9px] opacity-60 leading-tight truncate">{timeLabel}</div>}
                                  </div>

                                  {overflow.length > 0 && (
                                    <button
                                      className="absolute bottom-1 right-1 z-20 rounded-full bg-black/60 px-1.5 py-0.5 text-[10px] font-bold text-white hover:bg-black/80 transition-colors"
                                      onClick={(e) => { e.stopPropagation(); setOverflowPopover(isPopoverOpen ? null : b.id); }}>
                                      +{overflow.length}
                                    </button>
                                  )}

                                  {isPopoverOpen && (
                                    <div className="absolute left-0 z-50 mt-1 w-60 rounded-2xl border border-black/[0.08] bg-white shadow-[0_8px_32px_rgba(0,0,0,0.12)] overflow-hidden"
                                      style={{ top: "100%" }}
                                      onClick={(e) => e.stopPropagation()}>
                                      <div className="px-3 py-2.5 text-[10px] font-bold uppercase tracking-widest text-black/30 border-b border-black/[0.05]">
                                        {overflow.length + 1} overlapping
                                      </div>
                                      {[b, ...overflow].map((ov) => (
                                        <button key={ov.id}
                                          className="flex w-full items-start gap-2.5 px-3 py-3 text-left hover:bg-black/[0.03] transition-colors border-b border-black/[0.04] last:border-b-0"
                                          onClick={() => { setOverflowPopover(null); openDetail(ov.id); }}>
                                          <span className={`mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full ${dotColor(ov.meta?.kind as string)}`} />
                                          <div>
                                            <div className="text-xs font-semibold text-black/80 leading-tight">{ov.title}</div>
                                            <div className="text-[10px] text-black/35 mt-0.5">{minsToHHMM(ov.startMin)}–{minsToHHMM(ov.endMin)}</div>
                                          </div>
                                        </button>
                                      ))}
                                      <button className="w-full px-3 py-2 text-[10px] text-black/30 hover:text-black/60 transition-colors" onClick={() => setOverflowPopover(null)}>Close</button>
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
                <div className="mt-4 rounded-2xl border border-dashed border-black/[0.08] bg-white py-14 text-center">
                  <div className="text-5xl mb-4 select-none">📅</div>
                  <p className="text-base font-bold text-black/40">Your calendar is empty</p>
                  <p className="mt-1 text-sm text-black/25">Generate a plan on the home screen, then tap <span className="font-semibold">Add to Calendar</span>.</p>
                  <p className="mt-3 text-xs text-black/20">Or double-click any slot above to create a block manually.</p>
                </div>
              )}
            </>
          )}
        </section>

        {/* ── Event detail card (quick-view) ── */}
        <AnimatePresence>
          {detailId && (() => {
            const b = items.find((x) => x.id === detailId);
            if (!b) return null;
            const kind = b.meta?.kind as string | undefined;
            const customColor = (b.meta as any)?.color as string | undefined;
            const { cls, style } = blockColors(kind, customColor);
            const isDue = b.startMin >= 23 * 60;
            return (
              <motion.div
                key="detail-backdrop"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/30 p-0 sm:p-4"
                onMouseDown={() => setDetailId(null)}
              >
                <motion.div
                  key="detail-card"
                  initial={{ opacity: 0, y: 40, scale: 0.96 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 20, scale: 0.96 }}
                  transition={{ type: "spring", stiffness: 380, damping: 28 }}
                  className="w-full sm:max-w-md rounded-t-3xl sm:rounded-3xl bg-white shadow-[0_24px_64px_rgba(0,0,0,0.18)] p-6"
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  {/* Kind badge + color dot */}
                  <div className="flex items-center gap-2 mb-3">
                    <span className={`h-2.5 w-2.5 rounded-full flex-shrink-0 ${dotColor(kind)}`} />
                    <span className={`text-[11px] font-bold uppercase tracking-widest ${cls}`} style={style}>{kind ?? "manual"}</span>
                  </div>

                  {/* Title */}
                  <h2 className="text-xl font-extrabold text-black leading-tight" style={{ letterSpacing: "-0.025em" }}>{b.title}</h2>

                  {/* Time */}
                  <div className="mt-2 flex items-center gap-1.5 text-sm text-black/50 font-medium">
                    <span>🕐</span>
                    <span>{isDue ? "Due all day" : `${minsTo12h(b.startMin)} – ${minsTo12h(b.endMin)}`}</span>
                    <span className="text-black/25">·</span>
                    <span>{new Date(`${b.date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</span>
                  </div>

                  {/* Duration */}
                  {!isDue && (
                    <div className="mt-1 flex items-center gap-1.5 text-xs text-black/35 font-medium">
                      <span>⏱</span>
                      <span>{(() => { const dur = b.endMin - b.startMin; return dur >= 60 ? `${Math.floor(dur/60)}h${dur%60 ? ` ${dur%60}m` : ""}` : `${dur}m`; })()}</span>
                    </div>
                  )}

                  {/* Source note */}
                  {b.meta?.source && (
                    <div className="mt-2 text-xs text-black/30 italic truncate">{b.meta.source}</div>
                  )}

                  {/* Actions */}
                  <div className="mt-5 flex gap-2">
                    <button
                      onClick={() => openEditor(b.id)}
                      className="flex-1 rounded-2xl bg-[var(--lifeos-pink)] px-4 py-2.5 text-sm font-bold text-white shadow-[0_2px_8px_rgba(255,107,107,0.3)] hover:shadow-[0_4px_16px_rgba(255,107,107,0.4)] hover:scale-[1.02] active:scale-[0.98] transition-all"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => setDetailId(null)}
                      className="rounded-2xl border border-black/[0.09] bg-white px-4 py-2.5 text-sm font-semibold text-black/60 hover:bg-black/[0.03] hover:scale-[1.01] active:scale-[0.98] transition-all"
                    >
                      Close
                    </button>
                  </div>
                </motion.div>
              </motion.div>
            );
          })()}
        </AnimatePresence>

        {/* ── Edit modal ── */}
        <AnimatePresence>
          {activeId && (
            <motion.div
              key="edit-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/30 p-0 sm:p-4"
              onMouseDown={() => setActiveId(null)}
            >
              <motion.div
                key="edit-modal"
                initial={{ opacity: 0, y: 40, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 20, scale: 0.96 }}
                transition={{ type: "spring", stiffness: 380, damping: 28 }}
                className="w-full sm:max-w-lg rounded-t-3xl sm:rounded-3xl bg-white shadow-[0_24px_64px_rgba(0,0,0,0.18)] p-6"
                onMouseDown={(e) => e.stopPropagation()}
              >
                <div className="text-lg font-extrabold text-black mb-5" style={{ letterSpacing: "-0.025em" }}>Edit block</div>
                <div className="space-y-4">
                  <div>
                    <label className="text-[10px] font-bold uppercase tracking-widest text-black/35 block mb-1.5">Title</label>
                    <input
                      value={draftTitle}
                      onChange={(e) => setDraftTitle(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && saveEditor()}
                      className="w-full rounded-2xl border border-black/[0.09] bg-black/[0.02] px-4 py-3 text-sm font-semibold text-black outline-none focus:border-[var(--lifeos-pink)] transition-colors"
                    />
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="col-span-3 sm:col-span-1">
                      <label className="text-[10px] font-bold uppercase tracking-widest text-black/35 block mb-1.5">Day</label>
                      <select value={draftDate} onChange={(e) => setDraftDate(e.target.value)}
                        className="w-full rounded-2xl border border-black/[0.09] bg-black/[0.02] px-3 py-3 text-sm font-semibold text-black outline-none focus:border-[var(--lifeos-pink)] transition-colors">
                        {days.map((d) => { const iso = isoDateLocal(d); return <option key={iso} value={iso}>{formatWeekday(d)} {formatDayLabel(d)}</option>; })}
                      </select>
                    </div>
                    <div className="col-span-3 sm:col-span-1">
                      <label className="text-[10px] font-bold uppercase tracking-widest text-black/35 block mb-1.5">Start</label>
                      <input type="time" value={minsToHHMM(draftStart)} onChange={(e) => setDraftStart(hhmmToMins(e.target.value))}
                        className="w-full rounded-2xl border border-black/[0.09] bg-black/[0.02] px-3 py-3 text-sm font-semibold text-black outline-none focus:border-[var(--lifeos-pink)] transition-colors" />
                    </div>
                    <div className="col-span-3 sm:col-span-1">
                      <label className="text-[10px] font-bold uppercase tracking-widest text-black/35 block mb-1.5">End</label>
                      <input type="time" value={minsToHHMM(draftEnd)} onChange={(e) => setDraftEnd(hhmmToMins(e.target.value))}
                        className="w-full rounded-2xl border border-black/[0.09] bg-black/[0.02] px-3 py-3 text-sm font-semibold text-black outline-none focus:border-[var(--lifeos-pink)] transition-colors" />
                    </div>
                  </div>
                </div>
                <div className="mt-6 flex items-center justify-between gap-2">
                  <button onClick={deleteActive}
                    className="rounded-xl border border-red-200 bg-red-50 px-5 py-2.5 text-sm font-bold text-red-600 hover:bg-red-100 hover:scale-[1.02] active:scale-[0.97] transition-all">
                    Delete
                  </button>
                  <div className="flex items-center gap-2">
                    <button onClick={() => setActiveId(null)}
                      className="rounded-xl border border-black/[0.08] bg-white px-5 py-2.5 text-sm font-bold text-black/60 hover:bg-black/[0.04] hover:scale-[1.01] active:scale-[0.97] transition-all">
                      Cancel
                    </button>
                    <button onClick={saveEditor}
                      className="rounded-xl bg-[var(--lifeos-pink)] px-5 py-2.5 text-sm font-bold text-white shadow-[0_2px_8px_rgba(255,107,107,0.3)] hover:shadow-[0_4px_14px_rgba(255,107,107,0.4)] hover:scale-[1.02] active:scale-[0.97] transition-all">
                      Save changes
                    </button>
                  </div>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
