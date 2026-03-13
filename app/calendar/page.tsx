"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  addCalendarBlock,
  deleteCalendarBlock,
  deleteCalendarSeries,
  loadCalendar,
  saveCalendar,
  updateCalendarBlock,
  updateCalendarSeries,
  loadTodos,
  scheduleTodoItem,
  deleteTodoItem,
  type CalendarBlock,
  type TodoItem,
} from "../lib/storage-sync";
import { useToast } from "../components/Toast";
import {
  isGoogleCalendarConnected,
  fetchGoogleEventsForWeek,
  signInWithGoogleCalendar,
  signOutGoogleCalendar,
  exchangeCodeForTokens,
  type GoogleCalendarEvent,
} from "../lib/googleCalendar";
import {
  isOutlookCalendarConnected,
  fetchOutlookEventsForWeek,
  signInWithOutlook,
  signOutOutlook,
  exchangeOutlookCodeForTokens,
  type OutlookCalendarEvent,
} from "../lib/outlookCalendar";

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

// ── Conflict detection ────────────────────────────────────────
function blocksOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number) {
  return aStart < bEnd && bStart < aEnd;
}

type ExternalEvent = (GoogleCalendarEvent | OutlookCalendarEvent) & { date: string; startMin: number; endMin: number };

function blockConflictsWithGoogle(block: CalendarBlock, externalEvents: ExternalEvent[]): ExternalEvent | null {
  if (block.startMin >= 24 * 60) return null; // due-row items can't conflict
  for (const ge of externalEvents) {
    if (ge.isAllDay) continue;
    if (ge.date !== block.date) continue;
    if (blocksOverlap(block.startMin, block.endMin, ge.startMin, ge.endMin)) return ge;
  }
  return null;
}

type LayoutBlock = CalendarBlock & { col: number; cols: number };

function layoutDayBlocks(blocks: CalendarBlock[]): LayoutBlock[] {
  if (blocks.length === 0) return [];

  const sorted = [...blocks].sort((a, b) =>
    a.startMin !== b.startMin ? a.startMin - b.startMin : (b.endMin - b.startMin) - (a.endMin - a.startMin)
  );
  const n = sorted.length;

  // ── Step 1: find connected overlap groups via union-find ──────────────────
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x: number): number { return parent[x] === x ? x : (parent[x] = find(parent[x])); }
  function union(a: number, b: number) { parent[find(a)] = find(b); }
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      if (sorted[i].endMin > sorted[j].startMin && sorted[j].endMin > sorted[i].startMin)
        union(i, j);

  // ── Step 2: within each group, assign columns greedily ───────────────────
  // colEnds[groupRoot][c] = endMin of last block in column c of that group
  const groupColEnds: Record<number, number[]> = {};
  const colAssign = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const g = find(i);
    if (!groupColEnds[g]) groupColEnds[g] = [];
    const ends = groupColEnds[g];
    let placed = false;
    for (let c = 0; c < ends.length; c++) {
      if (ends[c] <= sorted[i].startMin) {
        colAssign[i] = c;
        ends[c] = sorted[i].endMin;
        placed = true;
        break;
      }
    }
    if (!placed) {
      colAssign[i] = ends.length;
      ends.push(sorted[i].endMin);
    }
  }

  // ── Step 3: cols = max columns used in this block's group ────────────────
  // (all members of the same group share the same cols value for visual consistency)
  const groupCols: Record<number, number> = {};
  for (let i = 0; i < n; i++) {
    const g = find(i);
    groupCols[g] = Math.max(groupCols[g] ?? 0, colAssign[i] + 1);
  }

  return sorted.map((b, i) => ({
    ...b,
    col: colAssign[i],
    cols: groupCols[find(i)],
  }));
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

// ── iCal export helpers ───────────────────────────────────────
function blockToVEvent(b: CalendarBlock): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const [y, mo, d] = b.date.split("-").map(Number);
  const sh = Math.floor(b.startMin / 60), sm = b.startMin % 60;
  const eh = Math.floor(b.endMin / 60), em = b.endMin % 60;
  const dtStart = `${y}${p(mo)}${p(d)}T${p(sh)}${p(sm)}00`;
  const dtEnd   = `${y}${p(mo)}${p(d)}T${p(eh)}${p(em)}00`;
  const summary = b.title.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
  return [
    "BEGIN:VEVENT",
    `UID:${b.id}@openhour`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `SUMMARY:${summary}`,
    "END:VEVENT",
  ].join("\r\n");
}

function exportIcal(blocks: CalendarBlock[]): void {
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//OpenHour//EN",
    "CALSCALE:GREGORIAN",
    ...blocks.map(blockToVEvent),
    "END:VCALENDAR",
  ].join("\r\n");
  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "openhour-calendar.ics";
  a.click();
  URL.revokeObjectURL(url);
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

// ── Mobile jump controls: ← [Day|Week|Month] → ──────────────────────────────
function MobileJumpControls({ cursor, setCursor }: { cursor: Date; setCursor: (d: Date) => void }) {
  const [jump, setJump] = useState<"day" | "week" | "month">("day");

  function move(dir: -1 | 1) {
    const d = new Date(cursor);
    if (jump === "day") d.setDate(d.getDate() + dir);
    else if (jump === "week") d.setDate(d.getDate() + dir * 7);
    else d.setMonth(d.getMonth() + dir);
    setCursor(d);
  }

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={() => move(-1)}
        className="h-9 w-9 flex items-center justify-center rounded-xl border border-black/[0.08] bg-white text-black/60 active:scale-95 transition-all font-bold"
      >←</button>

      {/* Jump size pill */}
      <div className="flex rounded-xl border border-black/[0.08] overflow-hidden text-[11px] font-bold">
        {(["day", "week", "month"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setJump(s)}
            className={`px-2.5 py-2 capitalize transition-colors ${
              jump === s
                ? "bg-[var(--lifeos-pink)] text-white"
                : "bg-white text-black/40 hover:bg-black/[0.04]"
            }`}
          >
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      <button
        onClick={() => move(1)}
        className="h-9 w-9 flex items-center justify-center rounded-xl border border-black/[0.08] bg-white text-black/60 active:scale-95 transition-all font-bold"
      >→</button>
    </div>
  );
}

export default function CalendarPage() {
  const { toast } = useToast();

  const [cursor, setCursor] = useState(() => {
    if (typeof window === "undefined") return new Date();
    try {
      const jumpFlag = window.sessionStorage.getItem("openhour_calendar_jump_v1");
      if (jumpFlag === "1") {
        window.sessionStorage.removeItem("openhour_calendar_jump_v1");
        const raw = window.localStorage.getItem("openhour_calendar_cursor_v1");
        if (raw && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
          const d = new Date(`${raw}T12:00:00`);
          if (!Number.isNaN(d.getTime())) return d;
        }
      }
    } catch { /* ignore */ }
    return new Date();
  });

  const [items, setItems] = useState<CalendarBlock[]>([]);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Todo drag state: dragging a todo item onto the calendar grid
  const todoDragRef = useRef<{ id: string; title: string; durationMin: number; moved: boolean } | null>(null);
  const [todoDragPreview, setTodoDragPreview] = useState<{ date: string; startMin: number; endMin: number; title: string } | null>(null);
  // viewMode: "week" | "agenda"
  const [viewMode, setViewMode] = useState<"week" | "agenda">("week");
  // detail card: shows quick-view before edit
  const [detailId, setDetailId] = useState<string | null>(null);
  const [todayISO, setTodayISO] = useState("");
  const [overflowPopover, setOverflowPopover] = useState<string | null>(null);
  // drag preview
  const [dragPreview, setDragPreview] = useState<{ date: string; startMin: number; endMin: number } | null>(null);
  // mobile responsive
  const [isMobile, setIsMobile] = useState(false);
  // series edit modal
  const [seriesModalBlock, setSeriesModalBlock] = useState<CalendarBlock | null>(null);
  const [seriesDraftTitle, setSeriesDraftTitle] = useState("");
  const [seriesDraftStart, setSeriesDraftStart] = useState(0);
  const [seriesDraftEnd, setSeriesDraftEnd] = useState(0);

  // Edit modal drafts
  const [draftTitle, setDraftTitle] = useState("");
  const [draftDate, setDraftDate] = useState("");
  const [draftStart, setDraftStart] = useState(0);
  const [draftEnd, setDraftEnd] = useState(0);

  // Google Calendar integration
  const [gcalConnected, setGcalConnected] = useState(false);
  const [googleEvents, setGoogleEvents] = useState<GoogleCalendarEvent[]>([]);
  const [gcalLoading, setGcalLoading] = useState(false);

  // Outlook Calendar integration
  const [outlookConnected, setOutlookConnected] = useState(false);
  const [outlookEvents, setOutlookEvents] = useState<OutlookCalendarEvent[]>([]);
  const [outlookLoading, setOutlookLoading] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ id: string; duration: number; offsetMin: number; moved: boolean } | null>(null);

  const startHour = 6, endHour = 24, stepMin = 10, hourRowPx = 56;
  const gridHeightPx = (endHour - startHour) * hourRowPx;
  const timeColPx = 48;
  const minDayColPx = 120; // minimum width per day column before horizontal scroll kicks in

  useEffect(() => {
    setItems(loadCalendar());
    setTodos(loadTodos());
    setTodayISO(isoDateLocal(new Date()));
    setLoaded(true);
  }, []);

  // Re-read calendar after cloud merge on sign-in
  useEffect(() => {
    function onCloudSync() {
      setItems(loadCalendar());
      setTodos(loadTodos());
    }
    window.addEventListener("openhour:cloud-sync", onCloudSync);
    return () => window.removeEventListener("openhour:cloud-sync", onCloudSync);
  }, []);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 640);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try { window.localStorage.setItem("openhour_calendar_cursor_v1", isoDateLocal(cursor)); } catch { /* ignore */ }
  }, [cursor]);

  // ── Google Calendar: check connection status on mount + handle OAuth callback ──
  useEffect(() => {
    if (typeof window === "undefined") return;

    const connected = isGoogleCalendarConnected();
    setGcalConnected(connected);

    // Check if we're returning from Google OAuth (URL has ?gcal_code=...)
    const params = new URLSearchParams(window.location.search);
    const gcalCode = params.get("gcal_code");
    const gcalState = params.get("gcal_state");

    if (gcalCode && gcalState) {
      // Verify state matches what we saved before redirecting
      const savedState = localStorage.getItem("openhour_gcal_oauth_state");
      const codeVerifier = localStorage.getItem("openhour_gcal_code_verifier");

      if (savedState === gcalState && codeVerifier) {
        const redirectUri = `${window.location.origin}/api/auth/google-calendar/callback`;
        exchangeCodeForTokens(gcalCode, codeVerifier, redirectUri).then((success) => {
          // Clean up PKCE state
          localStorage.removeItem("openhour_gcal_code_verifier");
          localStorage.removeItem("openhour_gcal_oauth_state");
          if (success) {
            setGcalConnected(true);
            toast("Google Calendar connected!", "success");
          } else {
            toast("Failed to connect Google Calendar. Try again.", "error");
          }
        });
      }

      // Remove OAuth params from URL cleanly
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete("gcal_code");
      cleanUrl.searchParams.delete("gcal_state");
      window.history.replaceState({}, "", cleanUrl.toString());
    }

    // ── Outlook Calendar: check connection + handle OAuth callback ──
    const outlookOk = isOutlookCalendarConnected();
    setOutlookConnected(outlookOk);

    const outlookCode = params.get("outlook_code");
    const outlookState = params.get("outlook_state");

    if (outlookCode && outlookState) {
      const savedOutlookState = localStorage.getItem("openhour_outlook_oauth_state");
      const outlookVerifier = localStorage.getItem("openhour_outlook_code_verifier");

      if (savedOutlookState === outlookState && outlookVerifier) {
        const redirectUri = `${window.location.origin}/api/auth/outlook/callback`;
        exchangeOutlookCodeForTokens(outlookCode, outlookVerifier, redirectUri).then((success) => {
          localStorage.removeItem("openhour_outlook_code_verifier");
          localStorage.removeItem("openhour_outlook_oauth_state");
          if (success) {
            setOutlookConnected(true);
            toast("Outlook Calendar connected!", "success");
          } else {
            toast("Failed to connect Outlook Calendar. Try again.", "error");
          }
        });
      }

      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete("outlook_code");
      cleanUrl.searchParams.delete("outlook_state");
      window.history.replaceState({}, "", cleanUrl.toString());
    }
  }, []);

  const weekStart = useMemo(() => startOfWeek(cursor), [cursor]);

  // ── Google Calendar: fetch events whenever week changes ──
  useEffect(() => {
    if (!gcalConnected || typeof window === "undefined") return;
    setGcalLoading(true);
    fetchGoogleEventsForWeek(weekStart).then((events) => {
      setGoogleEvents(events);
      setGcalLoading(false);
    }).catch(() => setGcalLoading(false));
  }, [gcalConnected, weekStart]);

  // ── Outlook Calendar: fetch events whenever week changes ──
  useEffect(() => {
    if (!outlookConnected || typeof window === "undefined") return;
    setOutlookLoading(true);
    fetchOutlookEventsForWeek(weekStart).then((events) => {
      setOutlookEvents(events);
      setOutlookLoading(false);
    }).catch(() => setOutlookLoading(false));
  }, [outlookConnected, weekStart]);

  const visibleDays = isMobile ? 3 : 7;
  const days = useMemo(() => Array.from({ length: visibleDays }, (_, i) => {
    const d = new Date(isMobile ? cursor : weekStart);
    if (isMobile) {
      // On mobile, show cursor day in the center (cursor - 1, cursor, cursor + 1)
      d.setDate(d.getDate() - 1 + i);
    } else {
      d.setDate(d.getDate() + i);
    }
    return d;
  }), [weekStart, cursor, visibleDays, isMobile]);

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
    const colW = (gridW - timeColPx) / visibleDays;
    const dayIdx = clamp(Math.floor(x / colW), 0, visibleDays - 1);
    const date = isoDateLocal(days[dayIdx]);
    // Fix: account for scroll position so Y is correct even when scrolled down
    const scrollTop = scrollEl.scrollTop;
    const y = clamp(clientY - r.top + scrollTop, 0, gridHeightPx);
    const mins = startHour * 60 + (y / hourRowPx) * 60;
    const snapped = Math.round(mins / stepMin) * stepMin;
    return { date, startMin: clamp(snapped, startHour * 60, endHour * 60) };
  }

  // Window-level pointer handlers so drag works even when finger drifts outside the grid
  const windowDragMove = useRef<((e: PointerEvent) => void) | null>(null);
  const windowDragUp = useRef<((e: PointerEvent) => void) | null>(null);

  function attachWindowDragListeners() {
    windowDragMove.current = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const slot = pointerToSlot(e.clientX, e.clientY);
      if (!slot) return;
      d.moved = true;
      const startMin = clamp(slot.startMin - d.offsetMin, startHour * 60, endHour * 60 - d.duration);
      const endMin = startMin + d.duration;
      const id = d.id;
      setItems((prev) => prev.map((b) => b.id === id ? { ...b, date: slot.date, startMin, endMin } : b));
      setDragPreview({ date: slot.date, startMin, endMin });
    };
    windowDragUp.current = () => {
      detachWindowDragListeners();
      const d = dragRef.current;
      if (!d) return;
      const id = d.id;
      const moved = d.moved;
      dragRef.current = null;
      setDragPreview(null);
      setItems((prev) => {
        const movedBlock = prev.find((b) => b.id === id);
        if (!movedBlock) return prev;
        const updated = updateCalendarBlock(id, { date: movedBlock.date, startMin: movedBlock.startMin, endMin: movedBlock.endMin });
        if (moved) toast(`Moved to ${formatDayLabel(new Date(`${movedBlock.date}T12:00:00`))} · ${minsTo12h(movedBlock.startMin)}`, "info");
        return updated;
      });
    };
    window.addEventListener("pointermove", windowDragMove.current);
    window.addEventListener("pointerup", windowDragUp.current);
    window.addEventListener("pointercancel", windowDragUp.current);
  }

  function detachWindowDragListeners() {
    if (windowDragMove.current) window.removeEventListener("pointermove", windowDragMove.current);
    if (windowDragUp.current) {
      window.removeEventListener("pointerup", windowDragUp.current);
      window.removeEventListener("pointercancel", windowDragUp.current);
    }
    windowDragMove.current = null;
    windowDragUp.current = null;
  }

  // ── Todo-drag: drag a todo chip from the sidebar onto the calendar ────────
  const todoWindowDragMove = useRef<((e: PointerEvent) => void) | null>(null);
  const todoWindowDragUp = useRef<((e: PointerEvent) => void) | null>(null);

  function attachTodoDragListeners() {
    todoWindowDragMove.current = (e: PointerEvent) => {
      const d = todoDragRef.current;
      if (!d) return;
      const slot = pointerToSlot(e.clientX, e.clientY);
      if (!slot) return;
      d.moved = true;
      const startMin = clamp(slot.startMin, startHour * 60, endHour * 60 - d.durationMin);
      const endMin = startMin + d.durationMin;
      setTodoDragPreview({ date: slot.date, startMin, endMin, title: d.title });
    };
    todoWindowDragUp.current = () => {
      detachTodoDragListeners();
      const d = todoDragRef.current;
      if (!d || !todoDragPreview || !d.moved) {
        todoDragRef.current = null;
        setTodoDragPreview(null);
        return;
      }
      const { date, startMin, endMin } = todoDragPreview;
      const id = d.id;
      todoDragRef.current = null;
      setTodoDragPreview(null);

      // Remove from todo list, add to calendar
      const { todo } = scheduleTodoItem(id, date, startMin, endMin);
      if (!todo) return;
      const block: CalendarBlock = {
        id: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2),
        date,
        title: todo.title,
        startMin,
        endMin,
        meta: { kind: "manual", fullDetail: todo.notes },
      };
      addCalendarBlock(block);
      setItems(loadCalendar());
      setTodos(loadTodos());
      toast(`"${todo.title}" scheduled for ${formatDayLabel(new Date(`${date}T12:00:00`))} · ${minsTo12h(startMin)}`, "success");
    };
    window.addEventListener("pointermove", todoWindowDragMove.current);
    window.addEventListener("pointerup", todoWindowDragUp.current);
    window.addEventListener("pointercancel", todoWindowDragUp.current);
  }

  function detachTodoDragListeners() {
    if (todoWindowDragMove.current) window.removeEventListener("pointermove", todoWindowDragMove.current);
    if (todoWindowDragUp.current) {
      window.removeEventListener("pointerup", todoWindowDragUp.current);
      window.removeEventListener("pointercancel", todoWindowDragUp.current);
    }
    todoWindowDragMove.current = null;
    todoWindowDragUp.current = null;
  }

  function onTodoPointerDown(e: React.PointerEvent, todo: TodoItem) {
    e.preventDefault();
    e.stopPropagation();
    todoDragRef.current = {
      id: todo.id,
      title: todo.title,
      durationMin: todo.durationMin ?? 60,
      moved: false,
    };
    attachTodoDragListeners();
  }

  function onBlockPointerDown(e: React.PointerEvent, b: CalendarBlock) {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { id: b.id, duration: Math.max(10, b.endMin - b.startMin), offsetMin: 0, moved: false };
    const slot = pointerToSlot(e.clientX, e.clientY);
    if (slot) dragRef.current.offsetMin = clamp(slot.startMin - b.startMin, -12 * 60, 12 * 60);
    attachWindowDragListeners();
  }

  // Keep these as no-ops on the grid body — real work is on window listeners now
  function onPointerMove(_e: React.PointerEvent) {}
  function onPointerUp() {}

  function openDetail(id: string) { setDetailId(id); }
  function openEditor(id: string) { setDetailId(null); setActiveId(id); }

  function addBlankEvent() {
    const todayIso = isoDateLocal(new Date());
    // Default to 9am–10am today
    const block: CalendarBlock = {
      id: generateId(),
      date: todayIso,
      title: "",
      startMin: 9 * 60,
      endMin: 10 * 60,
      meta: { kind: "manual" },
    };
    addCalendarBlock(block);
    setItems(loadCalendar());
    setActiveId(block.id);
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

  function openSeriesModal(block: CalendarBlock) {
    setDetailId(null);
    setSeriesModalBlock(block);
    setSeriesDraftTitle(block.title);
    setSeriesDraftStart(block.startMin);
    setSeriesDraftEnd(block.endMin);
  }

  function saveSeriesModal() {
    if (!seriesModalBlock?.meta?.seriesId) return;
    const updated = updateCalendarSeries(seriesModalBlock.meta.seriesId, {
      title: seriesDraftTitle.trim() || seriesModalBlock.title,
      startMin: seriesDraftStart,
      endMin: Math.max(seriesDraftStart + 10, seriesDraftEnd),
    });
    persist(updated);
    setSeriesModalBlock(null);
    toast("All events in series updated", "success");
  }

  function deleteSeriesAll() {
    if (!seriesModalBlock?.meta?.seriesId) return;
    if (!window.confirm("Delete all events in this recurring series?")) return;
    const updated = deleteCalendarSeries(seriesModalBlock.meta.seriesId);
    persist(updated);
    setSeriesModalBlock(null);
    toast("Series deleted", "info");
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
          <div className="ui-card p-5">
            <div className="text-sm font-extrabold text-[var(--text-primary)]" style={{ letterSpacing: "-0.02em" }}>{formatHeader(cursor)}</div>
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
          {/* ── To-Do List Panel ── */}
          <div className="ui-card p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="ui-eyebrow">To-Do</div>
              {todos.length > 0 && (
                <span className="text-[10px] font-bold text-black/30 bg-black/[0.05] rounded-full px-2 py-0.5">{todos.length}</span>
              )}
            </div>
            {todos.length === 0 ? (
              <div className="text-center py-4">
                <div className="text-2xl mb-1">📋</div>
                <p className="text-[11px] font-medium text-black/30 leading-snug">
                  Not sure when to schedule something?<br />
                  Use "Not sure yet" when generating a plan.
                </p>
              </div>
            ) : (
              <ul className="space-y-1.5">
                {todos.map((todo) => (
                  <li
                    key={todo.id}
                    className="group flex items-center gap-2 rounded-xl border border-black/[0.07] bg-white px-3 py-2 cursor-grab active:cursor-grabbing hover:border-emerald-200 hover:bg-emerald-50/50 transition-all select-none"
                    title="Drag onto the calendar to schedule"
                    onPointerDown={(e) => onTodoPointerDown(e, todo)}
                    style={{ touchAction: "none" }}
                  >
                    <span className="text-base flex-shrink-0" aria-hidden>📌</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-[12px] font-semibold text-black/80 truncate">{todo.title}</p>
                      {todo.durationMin && (
                        <p className="text-[10px] text-black/35">
                          ~{todo.durationMin < 60 ? `${todo.durationMin}m` : `${Math.floor(todo.durationMin / 60)}h${todo.durationMin % 60 ? ` ${todo.durationMin % 60}m` : ""}`}
                        </p>
                      )}
                    </div>
                    <button
                      className="opacity-0 group-hover:opacity-100 text-black/25 hover:text-red-400 transition-all text-xs"
                      title="Remove from To-Do"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => {
                        const updated = deleteTodoItem(todo.id);
                        setTodos(updated);
                        toast(`"${todo.title}" removed`, "info");
                      }}
                    >✕</button>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-[10px] text-black/25 text-center">
              {todos.length > 0 ? "Drag any item onto the calendar to schedule it" : ""}
            </p>
          </div>

          <div className="ui-card p-5">
            <div className="ui-eyebrow mb-2.5">Tips</div>
            <ul className="space-y-2.5">
              {["Generate a plan, then tap Add to Calendar.", "Double-click any slot to create a block.", "Drag blocks to reschedule them.", "Drag To-Do items onto the grid to schedule them."].map((tip, i) => (
                <li key={i} className="flex items-start gap-2 text-xs" style={{ color: "var(--text-muted)" }}>
                  <span className="text-[var(--lifeos-pink)] flex-shrink-0 font-bold">✦</span>{tip}
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
              <div className="ui-eyebrow mb-0.5">Calendar</div>
              <div className="text-[22px] font-extrabold text-[var(--text-primary)]" style={{ letterSpacing: "-0.03em", lineHeight: 1.2 }}>{formatHeader(cursor)}</div>
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
                  {/* Mobile: jump-size pill (Day / Week / Month) + arrows */}
                  {isMobile && (
                    <MobileJumpControls cursor={cursor} setCursor={setCursor} />
                  )}
                  {/* Desktop: always jump by week */}
                  {!isMobile && (
                    <>
                      <button onClick={() => { const d = new Date(cursor); d.setDate(d.getDate() - 7); setCursor(d); }}
                        className="h-9 w-9 flex items-center justify-center rounded-xl border border-black/[0.08] bg-white text-black/60 hover:bg-black/[0.04] hover:scale-105 active:scale-95 transition-all font-bold">←</button>
                      <button onClick={() => { const d = new Date(cursor); d.setDate(d.getDate() + 7); setCursor(d); }}
                        className="h-9 w-9 flex items-center justify-center rounded-xl border border-black/[0.08] bg-white text-black/60 hover:bg-black/[0.04] hover:scale-105 active:scale-95 transition-all font-bold">→</button>
                    </>
                  )}
                </>
              )}
              {/* Add event button */}
              <button
                onClick={addBlankEvent}
                className="h-9 flex items-center gap-1.5 rounded-xl bg-[var(--lifeos-pink)] px-3.5 text-xs font-bold text-white shadow-[0_2px_8px_rgba(217,108,125,0.3)] hover:shadow-[0_4px_14px_rgba(217,108,125,0.4)] hover:scale-[1.03] active:scale-[0.97] transition-all"
                title="Add event manually"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                  <path d="M12 5v14M5 12h14" />
                </svg>
                Add
              </button>

              {/* Google Calendar connect/disconnect button */}
              {gcalConnected ? (
                <button
                  onClick={async () => {
                    await signOutGoogleCalendar();
                    setGcalConnected(false);
                    setGoogleEvents([]);
                    toast("Google Calendar disconnected", "info");
                  }}
                  className="h-9 flex items-center gap-1.5 rounded-xl border border-[#4285f4]/30 bg-[#e8f0fe] px-3 text-xs font-bold text-[#4285f4] hover:bg-[#d2e3fc] hover:scale-[1.02] active:scale-[0.97] transition-all"
                  title="Google Calendar connected — click to disconnect"
                >
                  <span className="font-extrabold text-[10px] bg-[#4285f4] text-white rounded px-1 py-0.5">G</span>
                  {gcalLoading ? "Syncing…" : "Connected"}
                </button>
              ) : (
                <button
                  onClick={async () => {
                    setGcalLoading(true);
                    await signInWithGoogleCalendar();
                  }}
                  disabled={gcalLoading}
                  className="h-9 flex items-center gap-1.5 rounded-xl border border-black/[0.08] bg-white px-3 text-xs font-bold text-black/55 hover:bg-black/[0.04] hover:scale-[1.02] active:scale-[0.97] transition-all disabled:opacity-50"
                  title="Connect Google Calendar"
                >
                  <span className="font-extrabold text-[10px] bg-[#4285f4] text-white rounded px-1 py-0.5">G</span>
                  {gcalLoading ? "Connecting…" : "Connect Google"}
                </button>
              )}

              {/* Outlook Calendar connect/disconnect button */}
              {outlookConnected ? (
                <button
                  onClick={async () => {
                    await signOutOutlook();
                    setOutlookConnected(false);
                    setOutlookEvents([]);
                    toast("Outlook Calendar disconnected", "info");
                  }}
                  className="h-9 flex items-center gap-1.5 rounded-xl border border-[#0078d4]/30 bg-[#deecf9] px-3 text-xs font-bold text-[#0078d4] hover:bg-[#c7e0f4] hover:scale-[1.02] active:scale-[0.97] transition-all"
                  title="Outlook Calendar connected — click to disconnect"
                >
                  <span className="font-extrabold text-[10px] bg-[#0078d4] text-white rounded px-1 py-0.5">M</span>
                  {outlookLoading ? "Syncing…" : "Connected"}
                </button>
              ) : (
                <button
                  onClick={async () => {
                    setOutlookLoading(true);
                    await signInWithOutlook();
                  }}
                  disabled={outlookLoading}
                  className="h-9 flex items-center gap-1.5 rounded-xl border border-black/[0.08] bg-white px-3 text-xs font-bold text-black/55 hover:bg-black/[0.04] hover:scale-[1.02] active:scale-[0.97] transition-all disabled:opacity-50"
                  title="Connect Outlook Calendar"
                >
                  <span className="font-extrabold text-[10px] bg-[#0078d4] text-white rounded px-1 py-0.5">M</span>
                  {outlookLoading ? "Connecting…" : "Connect Outlook"}
                </button>
              )}

              {/* Export .ics button */}
              <button
                onClick={() => { exportIcal(items); toast("Calendar exported as .ics", "success"); }}
                className="h-9 flex items-center gap-1.5 rounded-xl border border-black/[0.08] bg-white px-3 text-xs font-bold text-black/55 hover:bg-black/[0.04] hover:scale-[1.02] active:scale-[0.97] transition-all"
                title="Export calendar as .ics file"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
                </svg>
                Export
              </button>

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
                      const conflictGe = blockConflictsWithGoogle(b, [...googleEvents, ...outlookEvents] as ExternalEvent[]);
                      return (
                        <button
                          key={b.id}
                          onClick={() => openDetail(b.id)}
                          className={`w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-black/[0.02] active:bg-black/[0.04] transition-colors group ${conflictGe ? "bg-orange-50/60 border-l-2 border-orange-400" : ""}`}
                        >
                          <div className={`flex-shrink-0 h-2 w-2 rounded-full ${conflictGe ? "bg-orange-400" : dotColor(kind)}`} />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-semibold text-black/80 truncate">{b.title}</div>
                            <div className="text-xs text-black/35">{isDue ? "Due" : `${minsTo12h(b.startMin)} – ${minsTo12h(b.endMin)}`}</div>
                            {conflictGe && <div className="text-[10px] text-orange-500 font-semibold">⚠️ Conflicts with &ldquo;{conflictGe.title}&rdquo;</div>}
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
              {/* ── Conflict banner ── */}
              {(() => {
                const allExternal = [...googleEvents, ...outlookEvents] as ExternalEvent[];
                const conflicts = weekBlocks.filter((b) => blockConflictsWithGoogle(b, allExternal));
                if (conflicts.length === 0) return null;
                const hasGoogle = googleEvents.length > 0;
                const hasOutlook = outlookEvents.length > 0;
                const calLabel = hasGoogle && hasOutlook ? "Google / Outlook Calendar" : hasOutlook ? "Outlook Calendar" : "Google Calendar";
                return (
                  <div className="mb-3 flex items-center gap-2.5 rounded-xl border border-orange-200 bg-orange-50 px-4 py-2.5">
                    <span className="text-base flex-shrink-0">⚠️</span>
                    <div className="flex-1 min-w-0">
                      <span className="text-xs font-bold text-orange-700">
                        {conflicts.length} block{conflicts.length !== 1 ? "s overlap" : " overlaps"} with {calLabel}
                      </span>
                      <span className="ml-2 text-xs text-orange-500">
                        {conflicts.map((b) => `"${b.title}"`).join(", ")}
                      </span>
                    </div>
                  </div>
                );
              })()}

              {/* Outer card — overflow-x scroll so columns never squish below minDayColPx */}
              <div className="rounded-2xl overflow-x-auto overflow-y-hidden" style={{ border: "1px solid var(--divider)", background: "var(--surface-raised)", boxShadow: "var(--shadow-sm)" }}>
                {/* Inner min-width wrapper so the grid can exceed the card width */}
                <div
                  ref={scrollRef}
                  style={{ minWidth: timeColPx + visibleDays * minDayColPx }}
                >
                  {/* Column template shared by all rows */}
                  {(() => {
                    const colTemplate = `${timeColPx}px repeat(${visibleDays}, minmax(${minDayColPx}px, 1fr))`;

                    return (
                      <>
                        {/* Header row */}
                        <div className="grid border-b border-black/[0.05] bg-black/[0.015]"
                          style={{ gridTemplateColumns: colTemplate }}>
                          {/* Sticky time-col spacer */}
                          <div className="sticky left-0 z-20 bg-black/[0.015] p-2" />
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
                              style={{ gridTemplateColumns: colTemplate, backgroundColor: "rgba(217,108,125,0.06)" }}>
                              <div className="sticky left-0 z-20 flex items-center justify-end pr-1.5 py-1.5" style={{ backgroundColor: "rgba(217,108,125,0.06)" }}>
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
                          style={{ gridTemplateColumns: colTemplate }}
                          onPointerMove={onPointerMove}
                          onPointerUp={onPointerUp}
                          onPointerCancel={onPointerUp}>
                          {/* Time labels — sticky left, absolutely positioned labels */}
                          <div className="sticky left-0 z-20 relative border-r border-black/[0.04] bg-white" style={{ height: gridHeightPx + 12 }}>
                            {hours.map((h) => (
                              <div key={h} className="absolute flex items-center justify-end pr-1.5"
                                style={{ top: minuteTopPx(h * 60, startHour, hourRowPx) - 5, right: 0, left: 0, height: 10 }}>
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
                                style={{ height: gridHeightPx + 12 }}
                                onDoubleClick={(e) => onDoubleClickEmpty(e, date)}
                                onClick={() => setOverflowPopover(null)}>
                                {Array.from({ length: endHour - startHour }, (_, i) => startHour + i).map((h) => (
                                  <div key={h} style={{ height: hourRowPx }}
                                    className={`border-b ${h % 2 === 0 ? "border-black/[0.05]" : "border-black/[0.025]"}`} />
                                ))}

                                {/* Drag preview ghost — block being moved */}
                                {dragPreview && dragPreview.date === date && (
                                  <div className="absolute pointer-events-none z-20 left-1 right-1 rounded-lg border-2 border-dashed border-[var(--lifeos-pink)] bg-[var(--lifeos-pink)]/10"
                                    style={{
                                      top: minuteTopPx(dragPreview.startMin, startHour, hourRowPx),
                                      height: Math.max(20, minuteTopPx(dragPreview.endMin, startHour, hourRowPx) - minuteTopPx(dragPreview.startMin, startHour, hourRowPx)),
                                    }} />
                                )}

                                {/* Todo drag ghost — todo item being dragged from sidebar */}
                                {todoDragPreview && todoDragPreview.date === date && (
                                  <div className="absolute pointer-events-none z-20 left-1 right-1 rounded-lg border-2 border-dashed border-emerald-400 bg-emerald-50/80 flex items-center px-2"
                                    style={{
                                      top: minuteTopPx(todoDragPreview.startMin, startHour, hourRowPx),
                                      height: Math.max(24, minuteTopPx(todoDragPreview.endMin, startHour, hourRowPx) - minuteTopPx(todoDragPreview.startMin, startHour, hourRowPx)),
                                    }}>
                                    <span className="text-[11px] font-bold text-emerald-700 truncate">📋 {todoDragPreview.title}</span>
                                  </div>
                                )}

                                {/* Blocks — each laid out with real col/cols positioning */}
                                {(() => {
                                  const timedBlocks = dayBlocks.filter((b) => b.startMin < 24 * 60);
                                  const laid = layoutDayBlocks(timedBlocks);
                                  return laid.map((b) => {
                                    const topPx = minuteTopPx(b.startMin, startHour, hourRowPx);
                                    const heightPx = Math.max(24, minuteTopPx(b.endMin, startHour, hourRowPx) - topPx);
                                    const timeLabel = `${minsToHHMM(b.startMin)}–${minsToHHMM(b.endMin)}`;
                                    const kind = b.meta?.kind as string | undefined;
                                    const customColor = (b.meta as any)?.color as string | undefined;
                                    const { cls: blockColor, style: blockStyle } = blockColors(kind, customColor);
                                    const isDragging = dragRef.current?.id === b.id;
                                    const conflictGe = blockConflictsWithGoogle(b, [...googleEvents, ...outlookEvents] as ExternalEvent[]);

                                    // Compact mode when column is narrow (≤ minDayColPx px per lane)
                                    const laneWidthPx = minDayColPx / b.cols;
                                    const compact = laneWidthPx < 80;
                                    const short = truncTitle(b.title, compact ? 10 : 26);

                                    const colW = 100 / b.cols;
                                    const leftPct = b.col * colW;
                                    const rightPct = 100 - leftPct - colW;
                                    const GUTTER = 1;

                                    return (
                                      <div key={b.id} className="absolute"
                                        style={{
                                          top: topPx,
                                          height: heightPx,
                                          left: `calc(${leftPct}% + ${b.col === 0 ? 2 : GUTTER}px)`,
                                          right: `calc(${rightPct}% + ${b.col === b.cols - 1 ? 2 : GUTTER}px)`,
                                          zIndex: isDragging ? 30 : 10,
                                        }}>
                                        <div
                                          data-block
                                          className={`w-full h-full cursor-grab select-none overflow-hidden rounded-lg border text-left transition-all hover:shadow-md hover:scale-[1.02] active:cursor-grabbing active:scale-[0.98] ${blockColor} ${isDragging ? "opacity-60 shadow-lg" : ""} ${compact ? "p-0.5" : "p-1"} ${conflictGe ? "ring-2 ring-orange-400 ring-offset-0" : ""}`}
                                          style={{
                                            ...blockStyle,
                                            touchAction: "none",
                                            ...(conflictGe ? { boxShadow: "inset 3px 0 0 #f97316" } : {}),
                                          }}
                                          title={conflictGe ? `⚠️ Conflicts with "${conflictGe.title}" in Google Calendar` : (b.meta?.fullDetail ? `${b.title}\n${b.meta.fullDetail}` : b.title)}
                                          onPointerDown={(e) => onBlockPointerDown(e, b)}
                                          onClick={() => !dragRef.current?.moved && openDetail(b.id)}
                                        >
                                          <div className={`flex items-center gap-0.5 min-w-0`}>
                                            {conflictGe && <span className="flex-shrink-0 text-[9px]">⚠️</span>}
                                            <div className={`truncate font-bold leading-tight flex-1 ${compact ? "text-[9px]" : "text-[10px]"}`}>{short}</div>
                                          </div>
                                          {!compact && heightPx >= 32 && <div className="mt-0.5 text-[9px] opacity-60 leading-tight truncate">{timeLabel}</div>}
                                        </div>
                                      </div>
                                    );
                                  });
                                })()}

                                {/* Google Calendar events (read-only overlay) */}
                                {googleEvents
                                  .filter((ge) => ge.date === isoDateLocal(d) && !ge.isAllDay && ge.startMin < 24 * 60)
                                  .map((ge) => {
                                    const topPx = minuteTopPx(ge.startMin, startHour, hourRowPx);
                                    const heightPx = Math.max(20, minuteTopPx(ge.endMin, startHour, hourRowPx) - topPx);
                                    const showCal = heightPx >= 36;
                                    const bgColor = (ge.color ?? "#4285f4") + "22";
                                    const borderColor = ge.color ?? "#4285f4";
                                    return (
                                      <div
                                        key={ge.id}
                                        className="absolute pointer-events-none overflow-hidden rounded-md"
                                        style={{
                                          top: topPx,
                                          height: heightPx,
                                          left: 2,
                                          right: 2,
                                          zIndex: 5,
                                          background: bgColor,
                                          borderLeft: `3px solid ${borderColor}`,
                                          padding: "2px 4px",
                                          opacity: 0.85,
                                        }}
                                        title={`${ge.title}${ge.calendarName ? ` · ${ge.calendarName}` : ""}`}
                                      >
                                        <div className="flex items-center gap-1 min-w-0">
                                          <span className="truncate text-[9px] font-bold text-gray-700 flex-1 leading-tight">{ge.title}</span>
                                          <span className="flex-shrink-0 text-[7px] font-extrabold text-[#4285f4] bg-[#e8f0fe] rounded px-0.5 leading-tight">G</span>
                                        </div>
                                        {showCal && ge.calendarName && (
                                          <div className="text-[8px] text-gray-400 truncate leading-tight mt-0.5">{ge.calendarName}</div>
                                        )}
                                      </div>
                                    );
                                  })}

                                {/* Outlook Calendar events (read-only overlay) */}
                                {outlookEvents
                                  .filter((oe) => oe.date === isoDateLocal(d) && !oe.isAllDay && oe.startMin < 24 * 60)
                                  .map((oe) => {
                                    const topPx = minuteTopPx(oe.startMin, startHour, hourRowPx);
                                    const heightPx = Math.max(20, minuteTopPx(oe.endMin, startHour, hourRowPx) - topPx);
                                    const showCal = heightPx >= 36;
                                    const bgColor = (oe.color ?? "#0078d4") + "22";
                                    const borderColor = oe.color ?? "#0078d4";
                                    return (
                                      <div
                                        key={oe.id}
                                        className="absolute pointer-events-none overflow-hidden rounded-md"
                                        style={{
                                          top: topPx,
                                          height: heightPx,
                                          left: 2,
                                          right: 2,
                                          zIndex: 5,
                                          background: bgColor,
                                          borderLeft: `3px solid ${borderColor}`,
                                          padding: "2px 4px",
                                          opacity: 0.85,
                                        }}
                                        title={`${oe.title}${oe.calendarName ? ` · ${oe.calendarName}` : ""}`}
                                      >
                                        <div className="flex items-center gap-1 min-w-0">
                                          <span className="truncate text-[9px] font-bold text-gray-700 flex-1 leading-tight">{oe.title}</span>
                                          <span className="flex-shrink-0 text-[7px] font-extrabold text-[#0078d4] bg-[#deecf9] rounded px-0.5 leading-tight">M</span>
                                        </div>
                                        {showCal && oe.calendarName && (
                                          <div className="text-[8px] text-gray-400 truncate leading-tight mt-0.5">{oe.calendarName}</div>
                                        )}
                                      </div>
                                    );
                                  })}
                              </div>
                            );
                          })}
                        </div>{/* end body grid */}
                      </>
                    );
                  })()}
                </div>{/* end scrollRef inner */}
              </div>{/* end outer scroll card */}

              {/* Empty state */}
              {items.length === 0 && (
                <div className="mt-4 rounded-2xl border border-dashed border-black/[0.08] bg-white py-14 text-center">
                  <div className="text-5xl mb-4 select-none">📅</div>
                  <p className="text-base font-bold text-black/40">Your calendar is empty</p>
                  <p className="mt-1 text-sm text-black/25">Generate a plan on the home screen, or click <span className="font-semibold">+ Add</span> above to create an event manually.</p>
                  <p className="mt-3 text-xs text-black/20">You can also double-click any time slot to create a block.</p>
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

                  {/* Series badge */}
                  {b.meta?.seriesId && (
                    <div className="mt-2 flex items-center gap-1.5">
                      <span className="text-[10px] font-bold text-black/30 bg-black/[0.05] rounded-full px-2 py-0.5">
                        🔁 Recurring series
                      </span>
                    </div>
                  )}

                  {/* Actions */}
                  <div className="mt-5 space-y-2">
                    <div className="flex gap-2">
                      <button
                        onClick={() => openEditor(b.id)}
                        className="flex-1 rounded-2xl bg-[var(--lifeos-pink)] px-4 py-2.5 text-sm font-bold text-white shadow-[0_2px_8px_rgba(255,107,107,0.3)] hover:shadow-[0_4px_16px_rgba(255,107,107,0.4)] hover:scale-[1.02] active:scale-[0.98] transition-all"
                      >
                        Edit this event
                      </button>
                      <button
                        onClick={() => setDetailId(null)}
                        className="rounded-2xl border border-black/[0.09] bg-white px-4 py-2.5 text-sm font-semibold text-black/60 hover:bg-black/[0.03] hover:scale-[1.01] active:scale-[0.98] transition-all"
                      >
                        Close
                      </button>
                    </div>
                    {b.meta?.seriesId && (
                      <button
                        onClick={() => openSeriesModal(b)}
                        className="w-full rounded-2xl border border-black/[0.08] bg-white px-4 py-2.5 text-sm font-semibold text-black/60 hover:bg-black/[0.04] hover:scale-[1.01] active:scale-[0.98] transition-all"
                      >
                        Edit all in series
                      </button>
                    )}
                  </div>
                </motion.div>
              </motion.div>
            );
          })()}
        </AnimatePresence>

        {/* ── Series edit modal ── */}
        <AnimatePresence>
          {seriesModalBlock && (
            <motion.div
              key="series-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/30 p-0 sm:p-4"
              onMouseDown={() => setSeriesModalBlock(null)}
            >
              <motion.div
                key="series-modal"
                initial={{ opacity: 0, y: 40, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 20, scale: 0.96 }}
                transition={{ type: "spring", stiffness: 380, damping: 28 }}
                className="w-full sm:max-w-lg rounded-t-3xl sm:rounded-3xl bg-white shadow-[0_24px_64px_rgba(0,0,0,0.18)] p-6"
                onMouseDown={(e) => e.stopPropagation()}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-base">🔁</span>
                  <div className="text-lg font-extrabold text-black" style={{ letterSpacing: "-0.025em" }}>Edit recurring series</div>
                </div>
                <p className="text-xs text-black/40 mb-5">Changes apply to all events in this series.</p>
                <div className="space-y-4">
                  <div>
                    <label className="text-[10px] font-bold uppercase tracking-widest text-black/35 block mb-1.5">Title</label>
                    <input
                      value={seriesDraftTitle}
                      onChange={(e) => setSeriesDraftTitle(e.target.value)}
                      className="w-full rounded-2xl border border-black/[0.09] bg-black/[0.02] px-4 py-3 text-sm font-semibold text-black outline-none focus:border-[var(--lifeos-pink)] transition-colors"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-[10px] font-bold uppercase tracking-widest text-black/35 block mb-1.5">Start time</label>
                      <input type="time" value={minsToHHMM(seriesDraftStart)} onChange={(e) => setSeriesDraftStart(hhmmToMins(e.target.value))}
                        className="w-full rounded-2xl border border-black/[0.09] bg-black/[0.02] px-3 py-3 text-sm font-semibold text-black outline-none focus:border-[var(--lifeos-pink)] transition-colors" />
                    </div>
                    <div>
                      <label className="text-[10px] font-bold uppercase tracking-widest text-black/35 block mb-1.5">End time</label>
                      <input type="time" value={minsToHHMM(seriesDraftEnd)} onChange={(e) => setSeriesDraftEnd(hhmmToMins(e.target.value))}
                        className="w-full rounded-2xl border border-black/[0.09] bg-black/[0.02] px-3 py-3 text-sm font-semibold text-black outline-none focus:border-[var(--lifeos-pink)] transition-colors" />
                    </div>
                  </div>
                </div>
                <div className="mt-6 flex items-center justify-between gap-2">
                  <button onClick={deleteSeriesAll}
                    className="rounded-xl border border-red-200 bg-red-50 px-5 py-2.5 text-sm font-bold text-red-600 hover:bg-red-100 hover:scale-[1.02] active:scale-[0.97] transition-all">
                    Delete series
                  </button>
                  <div className="flex items-center gap-2">
                    <button onClick={() => setSeriesModalBlock(null)}
                      className="rounded-xl border border-black/[0.08] bg-white px-5 py-2.5 text-sm font-bold text-black/60 hover:bg-black/[0.04] hover:scale-[1.01] active:scale-[0.97] transition-all">
                      Cancel
                    </button>
                    <button onClick={saveSeriesModal}
                      className="rounded-xl bg-[var(--lifeos-pink)] px-5 py-2.5 text-sm font-bold text-white shadow-[0_2px_8px_rgba(255,107,107,0.3)] hover:shadow-[0_4px_14px_rgba(255,107,107,0.4)] hover:scale-[1.02] active:scale-[0.97] transition-all">
                      Update all
                    </button>
                  </div>
                </div>
              </motion.div>
            </motion.div>
          )}
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
                  <div className="grid grid-cols-2 gap-3">
                    <div className="col-span-2">
                      <label className="text-[10px] font-bold uppercase tracking-widest text-black/35 block mb-1.5">Date</label>
                      <input type="date" value={draftDate} onChange={(e) => setDraftDate(e.target.value)}
                        className="w-full rounded-2xl border border-black/[0.09] bg-black/[0.02] px-3 py-3 text-sm font-semibold text-black outline-none focus:border-[var(--lifeos-pink)] transition-colors" />
                    </div>
                    <div>
                      <label className="text-[10px] font-bold uppercase tracking-widest text-black/35 block mb-1.5">Start time</label>
                      <input type="time" value={minsToHHMM(draftStart)} onChange={(e) => setDraftStart(hhmmToMins(e.target.value))}
                        className="w-full rounded-2xl border border-black/[0.09] bg-black/[0.02] px-3 py-3 text-sm font-semibold text-black outline-none focus:border-[var(--lifeos-pink)] transition-colors" />
                    </div>
                    <div>
                      <label className="text-[10px] font-bold uppercase tracking-widest text-black/35 block mb-1.5">End time</label>
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
