export const HISTORY_KEY = "openhour_history_v1";

function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// --- Custom event keywords (learned locally) ---
export const CUSTOM_EVENT_KEYWORDS_KEY = "openhour_custom_event_keywords_v1";

export function loadCustomEventKeywords(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(CUSTOM_EVENT_KEYWORDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function saveCustomEventKeywords(keywords: string[]) {
  if (typeof window === "undefined") return;
  const unique = Array.from(new Set(keywords.map((k) => k.trim().toLowerCase()).filter(Boolean)));
  window.localStorage.setItem(CUSTOM_EVENT_KEYWORDS_KEY, JSON.stringify(unique));
}

export function addCustomEventKeyword(keyword: string) {
  const k = keyword.trim().toLowerCase();
  if (!k) return;
  const existing = loadCustomEventKeywords();
  if (existing.includes(k)) return;
  saveCustomEventKeywords([...existing, k]);
}

export type Plan = {
  detectedTasks?: string[];
  assumptions?: string[];
  priorities: string[];
  schedule: { time: string; plan: string[] }[];
  habit: { title: string; why: string; how: string };
  coach: string;
  personalInsight?: string;
  streak?: number;
  profile?: {
    summary: string;
    doMore: string[];
    doLess: string[];
    risk: string;
  } | null;
};

export type HistoryItem = {
  id: string;
  createdAt: string; // ISO string
  input: string;
  plan: Plan;
};

export function loadHistory(): HistoryItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as HistoryItem[]) : [];
  } catch {
    return [];
  }
}

export function saveHistory(items: HistoryItem[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(HISTORY_KEY, JSON.stringify(items));
}

export function addToHistory(item: HistoryItem, limit = 30): HistoryItem[] {
  const updated = [item, ...loadHistory()].slice(0, limit);
  saveHistory(updated);
  return updated;
}

export function getLatestHistoryItem(): HistoryItem | null {
  const h = loadHistory();
  return h[0] ?? null;
}

export type DoneMap = Record<string, boolean>;

export function doneKey(historyId: string) {
  return `openhour_done_v1:${historyId}`;
}

export function loadDone(historyId: string): DoneMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(doneKey(historyId));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as DoneMap) : {};
  } catch {
    return {};
  }
}

export function saveDone(historyId: string, done: DoneMap) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(doneKey(historyId), JSON.stringify(done));
}

export type UserProfile = {
  daysTracked: number;
  avgCompletion: number;
  last7: { date: string; completion: number }[];
};

const PROFILE_KEY = "openhour_profile_v1";

export function loadProfile(): UserProfile {
  if (typeof window === "undefined") return { daysTracked: 0, avgCompletion: 0, last7: [] };
  try {
    // Compute daysTracked and last7 dynamically from calendar + history data
    // so the stats stay accurate without needing a manual save step.
    const base: UserProfile = (() => {
      const raw = window.localStorage.getItem(PROFILE_KEY);
      if (!raw) return { daysTracked: 0, avgCompletion: 0, last7: [] };
      const parsed = JSON.parse(raw);
      return (parsed && typeof parsed === "object" ? parsed : {}) as UserProfile;
    })();

    // Compute daysTracked = number of distinct dates with at least one calendar block
    const calRaw = window.localStorage.getItem("openhour_calendar_v1");
    const calendar: Array<{ date: string }> = (() => {
      try { const p = JSON.parse(calRaw ?? "[]"); return Array.isArray(p) ? p : []; } catch { return []; }
    })();
    const distinctDates = new Set(calendar.map((b) => b.date).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)));
    const daysTracked = Math.max(base.daysTracked ?? 0, distinctDates.size);

    // Build last7: for each of the last 7 calendar days, record how many blocks were scheduled.
    // We use "blocks scheduled" as a proxy for completion since we don't have per-day done state.
    // Blocks per day (capped at 1.0 once >= 3 blocks) → completion ratio.
    const last7: { date: string; completion: number }[] = [];
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const blocksOnDay = calendar.filter((b) => b.date === iso).length;
      // Normalise: 0 blocks = 0, 1 block = 0.33, 2 = 0.67, 3+ = 1.0
      const completion = blocksOnDay >= 3 ? 1 : blocksOnDay / 3;
      last7.push({ date: iso, completion });
    }

    // avgCompletion: average of last7 days that had any blocks (skip zero days from average)
    const activeDays = last7.filter((d) => d.completion > 0);
    const avgCompletion = activeDays.length
      ? activeDays.reduce((s, d) => s + d.completion, 0) / activeDays.length
      : (base.avgCompletion ?? 0);

    return { daysTracked, avgCompletion, last7 };
  } catch {
    return { daysTracked: 0, avgCompletion: 0, last7: [] };
  }
}

export function saveProfile(p: UserProfile) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
}

// ─────────────────────────────────────────────────────────────
// Onboarding Profile  (set once on first launch)
// ─────────────────────────────────────────────────────────────

export type OnboardingProfile = {
  name: string;
  role: string;
  wakeHour: number;   // 4–12
  sleepHour: number;  // 19–26 (stored as 0–2 for past midnight)
  completedAt: string; // ISO
};

const ONBOARDING_KEY = "openhour_onboarding_v1";

export function saveOnboardingProfile(profile: OnboardingProfile) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(ONBOARDING_KEY, JSON.stringify(profile));
  // Immediately seed UserPreferences with wake/sleep hours so session 1
  // already feels personalized — no feedback required.
  const prefs = loadPreferences();
  if (prefs.preferredStartHour === null) {
    prefs.preferredStartHour = profile.wakeHour;
  }
  if (prefs.preferredEndHour === null) {
    prefs.preferredEndHour = profile.sleepHour <= 3 ? profile.sleepHour + 24 : profile.sleepHour;
  }
  savePreferences(prefs);
}

export function loadOnboardingProfile(): OnboardingProfile | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(ONBOARDING_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as OnboardingProfile;
  } catch {
    return null;
  }
}

export function hasCompletedOnboarding(): boolean {
  if (typeof window === "undefined") return false;
  return !!window.localStorage.getItem(ONBOARDING_KEY);
}

// ─────────────────────────────────────────────────────────────
// Learned User Preferences  (grows with every feedback session)
// ─────────────────────────────────────────────────────────────

export type UserPreferences = {
  // Scheduling style
  preferredStartHour: number | null;   // e.g. 8 = likes starting at 8am
  preferredEndHour: number | null;     // e.g. 22 = fine scheduling until 10pm
  avoidedHours: number[];              // e.g. [12,13] = never schedule during lunch
  preferredDurations: Record<string, number>; // e.g. { run: 45, meeting: 30 }

  // Content preferences learned from thumbs down / corrections
  dislikedSuggestionKinds: string[];   // kinds the user consistently thumbs-downs
  likedSuggestionKinds: string[];      // kinds the user consistently thumbs-ups

  // Free-text notes the AI can append
  styleNotes: string[];                // e.g. "User prefers evening workouts"

  // App settings
  darkMode: boolean;                   // dark mode toggle
  suggestionsEnabled: boolean;         // whether to show AI prep suggestions after scheduling
  notificationsEnabled: boolean;       // 15-min browser reminders for today's events
  suggestPrefs: Record<string, boolean>; // per-context suggestion opt-in/out e.g. { workout: true, coffee: false }

  // Meta
  totalFeedbackSessions: number;
  lastUpdated: string;                 // ISO timestamp
};

const PREFERENCES_KEY = "openhour_preferences_v1";

export function loadPreferences(): UserPreferences {
  const def: UserPreferences = {
    preferredStartHour: null,
    preferredEndHour: null,
    avoidedHours: [],
    preferredDurations: {},
    dislikedSuggestionKinds: [],
    likedSuggestionKinds: [],
    styleNotes: [],
    darkMode: false,
    suggestionsEnabled: true,
    notificationsEnabled: false,
    suggestPrefs: {},
    totalFeedbackSessions: 0,
    lastUpdated: new Date().toISOString(),
  };
  if (typeof window === "undefined") return def;
  try {
    const raw = window.localStorage.getItem(PREFERENCES_KEY);
    if (!raw) return def;
    const parsed = JSON.parse(raw);
    return { ...def, ...parsed };
  } catch {
    return def;
  }
}

export function savePreferences(p: UserPreferences) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(p));
}

export function updatePreferences(partial: Partial<UserPreferences>) {
  const current = loadPreferences();
  savePreferences({ ...current, ...partial, lastUpdated: new Date().toISOString() });
}

// ─────────────────────────────────────────────────────────────
// Feedback events  (raw signal — one entry per thumbs up/down)
// ─────────────────────────────────────────────────────────────

export type FeedbackSignal =
  | "thumbs_up"
  | "thumbs_down"
  | "too_early"
  | "too_late"
  | "too_long"
  | "too_short"
  | "wrong_day"
  | "not_relevant";

export type FeedbackEntry = {
  id: string;
  createdAt: string;
  blockTitle: string;
  blockKind: string;
  blockDate: string;
  startMin: number;
  endMin: number;
  signal: FeedbackSignal;
  note?: string;          // optional free-text from user
  prompt?: string;        // the original input that generated this block
};

const FEEDBACK_KEY = "openhour_feedback_v1";

export function loadFeedback(): FeedbackEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(FEEDBACK_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveFeedback(entries: FeedbackEntry[]) {
  if (typeof window === "undefined") return;
  // Keep max 200 most recent entries to avoid bloat
  window.localStorage.setItem(FEEDBACK_KEY, JSON.stringify(entries.slice(0, 200)));
}

export function addFeedback(entry: Omit<FeedbackEntry, "id" | "createdAt">) {
  const existing = loadFeedback();
  const newEntry: FeedbackEntry = {
    ...entry,
    id: Math.random().toString(36).slice(2),
    createdAt: new Date().toISOString(),
  };
  saveFeedback([newEntry, ...existing]);
  return newEntry;
}

// Distil raw feedback into a human-readable summary string for AI prompts
export function buildPreferenceContext(prefs: UserPreferences, recentFeedback: FeedbackEntry[]): string {
  const lines: string[] = [];

  if (prefs.styleNotes.length > 0) {
    lines.push("Learned user preferences:");
    prefs.styleNotes.slice(0, 8).forEach((n) => lines.push(`  • ${n}`));
  }

  if (prefs.preferredStartHour !== null) {
    lines.push(`  • Prefers scheduling no earlier than ${prefs.preferredStartHour}:00`);
  }
  if (prefs.preferredEndHour !== null) {
    lines.push(`  • Prefers scheduling no later than ${prefs.preferredEndHour}:00`);
  }
  if (prefs.avoidedHours.length > 0) {
    const hrs = prefs.avoidedHours.map((h) => `${h}:00`).join(", ");
    lines.push(`  • Avoid scheduling during: ${hrs}`);
  }
  if (Object.keys(prefs.preferredDurations).length > 0) {
    const durs = Object.entries(prefs.preferredDurations)
      .map(([k, v]) => `${k}=${v}min`)
      .join(", ");
    lines.push(`  • Preferred event durations: ${durs}`);
  }
  if (prefs.dislikedSuggestionKinds.length > 0) {
    lines.push(`  • User dislikes these suggestion types: ${prefs.dislikedSuggestionKinds.join(", ")}`);
  }
  if (prefs.likedSuggestionKinds.length > 0) {
    lines.push(`  • User appreciates these suggestion types: ${prefs.likedSuggestionKinds.join(", ")}`);
  }

  // Show last 5 thumbs-down signals as concrete examples
  const dislikes = recentFeedback
    .filter((f) => f.signal === "thumbs_down" || f.signal === "not_relevant" || f.signal === "too_early" || f.signal === "too_late")
    .slice(0, 5);
  if (dislikes.length > 0) {
    lines.push("Recent negative feedback (avoid repeating):");
    dislikes.forEach((f) => {
      const time = `${Math.floor(f.startMin / 60)}:${String(f.startMin % 60).padStart(2, "0")}`;
      lines.push(`  ✗ "${f.blockTitle}" at ${time} — ${f.signal.replace(/_/g, " ")}${f.note ? `: ${f.note}` : ""}`);
    });
  }

  const likes = recentFeedback
    .filter((f) => f.signal === "thumbs_up")
    .slice(0, 5);
  if (likes.length > 0) {
    lines.push("Recent positive feedback (do more of this):");
    likes.forEach((f) => {
      const time = `${Math.floor(f.startMin / 60)}:${String(f.startMin % 60).padStart(2, "0")}`;
      lines.push(`  ✓ "${f.blockTitle}" at ${time}`);
    });
  }

  return lines.length > 0 ? lines.join("\n") : "";
}

// ------------------------------
// ------------------------------
// Calendar (V1)
// ------------------------------

export type CalendarBlock = {
  id: string;
  date: string; // YYYY-MM-DD
  title: string;
  startMin: number; // minutes from 00:00
  endMin: number; // minutes from 00:00
  sourceHistoryId?: string;
  meta?: {
    kind?: "plan" | "syllabus" | "manual";
    confidence?: number;
    source?: string;
    fullDetail?: string; // original user input, shown on hover in calendar
    color?: string;      // user-picked hex color (syllabus course color)
    seriesId?: string;   // UUID shared by all blocks in a recurring series
    seriesRule?: string; // e.g. "weekly:MO,WE,FR" for display/editing
  };
};

const CALENDAR_KEY = "openhour_calendar_v1";

export function loadCalendar(): CalendarBlock[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(CALENDAR_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CalendarBlock[]) : [];
  } catch {
    return [];
  }
}

export function saveCalendar(items: CalendarBlock[]) {
  if (typeof window === "undefined") return true;
  try {
    // Reduce localStorage bloat: keep metadata tiny to avoid QuotaExceededError.
    const compact = items.map((b) => {
      const src = b.meta?.source;
      const safeSource =
        typeof src === "string" ? (src.length > 180 ? src.slice(0, 180) + "…" : src) : undefined;
      const meta = b.meta
        ? {
            kind: b.meta.kind,
            confidence: b.meta.confidence,
            // Only keep very small source snippets (or omit entirely)
            source: safeSource,
            // Preserve user-picked course color
            color: (b.meta as any)?.color ?? undefined,
            // Preserve recurring series identifiers
            seriesId: b.meta.seriesId ?? undefined,
            seriesRule: b.meta.seriesRule ?? undefined,
          }
        : undefined;
      return meta ? { ...b, meta } : b;
    });

    window.localStorage.setItem(CALENDAR_KEY, JSON.stringify(compact));
    return true;
  } catch (e) {
    // QuotaExceededError (or private-mode storage) can land here.
    console.error("saveCalendar failed", e);
    return false;
  }
}

export function addCalendarBlock(block: CalendarBlock) {
  // Load existing calendar blocks.
  // We'll potentially prune old AI-generated "plan" blocks on the affected dates,
  // so a new plan doesn't keep accumulating incorrect/duplicate blocks.
  const allRaw = loadCalendar();
  saveCalendar([block, ...allRaw]);
}

export function updateCalendarBlock(id: string, patch: Partial<CalendarBlock>) {
  // Load existing calendar blocks.
  // We'll potentially prune old AI-generated "plan" blocks on the affected dates,
  // so a new plan doesn't keep accumulating incorrect/duplicate blocks.
  const allRaw = loadCalendar();
  const updated = allRaw.map((b) => (b.id === id ? { ...b, ...patch } : b));
  saveCalendar(updated);
  return updated;
}

export function deleteCalendarBlock(id: string) {
  // Load existing calendar blocks.
  // We'll potentially prune old AI-generated "plan" blocks on the affected dates,
  // so a new plan doesn't keep accumulating incorrect/duplicate blocks.
  const allRaw = loadCalendar();
  const updated = allRaw.filter((b) => b.id !== id);
  saveCalendar(updated);
  return updated;
}

/** Delete every block that belongs to a recurring series. */
export function deleteCalendarSeries(seriesId: string): CalendarBlock[] {
  const updated = loadCalendar().filter((b) => b.meta?.seriesId !== seriesId);
  saveCalendar(updated);
  return updated;
}

/** Patch title/startMin/endMin across every block in a recurring series. */
export function updateCalendarSeries(
  seriesId: string,
  patch: Partial<Pick<CalendarBlock, "title" | "startMin" | "endMin">>
): CalendarBlock[] {
  const updated = loadCalendar().map((b) => {
    if (b.meta?.seriesId !== seriesId) return b;
    const next = { ...b, ...patch };
    // Ensure endMin stays after startMin when only one is provided
    if (patch.startMin !== undefined && patch.endMin === undefined) {
      const dur = b.endMin - b.startMin;
      next.endMin = patch.startMin + dur;
    }
    return next;
  });
  saveCalendar(updated);
  return updated;
}

function normalizeTitle(s: string) {
  return s.trim().replace(/\s+/g, " ");
}

function normalizeEventTitle(raw: string): string {
  let s = normalizeTitle(raw);

  // Strip trailing punctuation that often appears in LLM phrases ("tomorrow," "Friday.")
  // and breaks later normalization rules.
  s = s.replace(/\s+/g, " ").trim().replace(/[\.,;:!?]+$/g, "");

  // Remove common conversational lead-ins that should not become event titles.
  s = s
    .replace(/^and\s+/i, "")
    // e.g. "I want to run", "Today I need to study", "Tomorrow I would like to run"
    .replace(/^(?:today\s+|tomorrow\s+)?i\s+(?:would\s+like\s+to|would\s+like|have|got|need|need\s+to|want|want\s+to)\s+/i, "")
    // e.g. "to run tomorrow" -> "run tomorrow"
    .replace(/^to\s+/i, "")
    // e.g. "Tomorrow run" -> "run"
    .replace(/^tomorrow\s+/i, "")
    .replace(/^today\s+/i, "")
    .replace(/^please\s+/i, "")
    .trim();

  // Strip leading articles for cleaner professional titles.
  s = s.replace(/^(?:a|an|the)\s+/i, "").trim();

  // Remove trailing relative-day words that sometimes leak into titles.
  s = s.replace(/[\.,;:!?]+$/g, "");
  s = s.replace(/\b(?:today|tomorrow)\b\s*$/i, "").trim();

  // Remove trailing weekday phrases ("on Friday", "Friday") from titles.
  s = s
    .replace(/\s+on\s+(mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b\s*$/i, "")
    .replace(/\s+(mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b\s*$/i, "")
    .trim();

  // Drop time-of-day section headers that sometimes appear in model schedules.
  if (/^(morning|afternoon|evening|night|today)$/i.test(s)) return "";

  // Normalize extremely generic meeting phrasing.
  if (/^meetings?$/i.test(s)) return "Meeting";
  if (/^have\s+meetings?$/i.test(s)) return "Meeting";
  if (/^attend\s+meetings?$/i.test(s)) return "Meeting";
  if (/^meeting\s*(s)?$/i.test(s)) return "Meeting";
  if (/^i\s+have\s+meetings?$/i.test(s)) return "Meeting";

  // If it starts with "meeting" but includes extra context, keep the context.
  s = s.replace(/^meetings\b/i, "Meeting");
  s = s.replace(/^meeting\b/i, "Meeting");

  // Capitalize the first letter (we keep the rest as-is to preserve acronyms).
  if (s.length >= 1) s = s[0].toUpperCase() + s.slice(1);

  // Prefer professional, concise names for common intents.
  const low = s.toLowerCase();

  // Keyword precedence matters (e.g., "pack for flight" should be "Pack", not "Flight").
  if (/\b(pack|packing|luggage|suitcase)\b/.test(low)) return "Pack";
  if (/\b(airport|tsa|check[- ]?in|gate|terminal)\b/.test(low) || /\b(get|go|head|travel)\b[^\n]{0,20}\bairport\b/.test(low)) {
    return "Travel to Airport";
  }
  if (/\bflight\b/.test(low)) return "Flight";

  // Strong activity intents should collapse to a clean title even if extra words remain.
  if (/^run\b/.test(low) || /\brun\b/.test(low)) return "Run";
  if (/^swim\b/.test(low) || /\bswim\b/.test(low)) return "Swim";
  if (/^jump\b/.test(low) || /\bjump\b/.test(low)) return "Jump";

  // Avoid extremely generic event titles that confuse users.
  if (/^due$/i.test(s)) return "Deadline";

  // Drop leading articles for a more professional look ("a flight" -> "flight").
  s = s.replace(/^(a|an|the)\s+/i, "");

  // If it's a single word, title-case it.
  if (/^[a-z]+$/i.test(s)) {
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  }

  return s;
}

function overlaps(a: { startMin: number; endMin: number }, b: { startMin: number; endMin: number }) {
  return a.startMin < b.endMin && b.startMin < a.endMin;
}

function keywordWindow(title: string): { start: number; end: number } | null {
  const t = title.toLowerCase();
  const has = (k: string) => t.includes(k);

  if (has("breakfast")) return { start: 6 * 60, end: 10 * 60 };
  if (has("lunch")) return { start: 11 * 60 + 30, end: 14 * 60 };
  if (has("dinner") || has("supper")) return { start: 17 * 60 + 30, end: 20 * 60 + 30 };
  if (has("sleep") || has("bed") || has("bedtime")) return { start: 21 * 60, end: 23 * 60 + 30 };

  // Workouts: broad window; availability decides
  if (has("gym") || has("workout") || has("run") || has("swim") || has("exercise")) {
    return { start: 7 * 60, end: 20 * 60 };
  }

  // Academic work blocks: afternoon/evening window (never at midnight)
  if (
    has("assignment") || has("homework") || has("essay") ||
    has("paper") || has("problem set") || has("pset") ||
    has("study") || has("studying") || has("reading")
  ) {
    return { start: 13 * 60, end: 22 * 60 }; // 1 PM – 10 PM
  }

  return null;
}

function parseExplicitTimeToMins(text: string): number | null {
  // Matches:
  // - 7pm, 7 pm, 7:30pm, 7:30 pm
  // - 10:30 AM, 10:30 a.m.
  // - at 7pm, @ 7 pm
  const cleaned = String(text ?? "")
    // normalize a.m./p.m.
    .replace(/\b([ap])\.\s*m\.\b/gi, "$1m")
    .replace(/\b([ap])\.m\.\b/gi, "$1m")
    // normalize weird separators
    .replace(/(\d)\.(\d{2})\s*(am|pm)\b/gi, "$1:$2 $3");

  const m = cleaned.match(/\b(?:at\s*|@\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const ap = m[3].toLowerCase();
  if (h === 12) h = ap === "am" ? 0 : 12;
  else if (ap === "pm") h += 12;
  const total = h * 60 + min;
  if (total < 0 || total > 24 * 60) return null;
  return total;
}

function parse24hTimeToMins(text: string): number | null {
  // Matches: 10:30, at 10:30, @ 10:30 (24h or ambiguous). We treat 0–23 as hours.
  // This helps with EU-style inputs where users often omit am/pm.
  const m = text.match(/\b(?:at\s*|@\s*)?(\d{1,2}):(\d{2})\b/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  if (h < 0 || h > 23) return null;
  if (min < 0 || min > 59) return null;
  return h * 60 + min;
}


function parseAmbiguousTimeToMins(text: string, hint?: { preferPM?: boolean }): number | null {
  // Matches: 2:30, at 2:30 (no am/pm). Users often omit AM/PM.
  // Heuristic:
  // - 1–7 => assume PM (e.g., 2:30 => 14:30), unless explicitly "morning"
  // - 8–11 => assume AM
  // - 12 => noon
  // - 13–23 => treat as 24h
  const cleaned = String(text ?? "").toLowerCase();
  const m = cleaned.match(/\b(?:at\s*|@\s*)?(\d{1,2}):(\d{2})\b/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  if (min < 0 || min > 59) return null;

  // If the user said "morning", bias toward AM.
  const mentionsMorning = /\b(morning|am)\b/.test(cleaned);
  const mentionsEvening = /\b(evening|night|pm)\b/.test(cleaned);

  if (h < 0 || h > 23) return null;
  if (h >= 13) return h * 60 + min;

  // 0–12 are ambiguous; interpret.
  if (h === 12) return 12 * 60 + min;

  if (mentionsMorning) return h * 60 + min;
  if (mentionsEvening) return (h + 12) * 60 + min;

  // Default heuristic for missing AM/PM:
  if (h >= 8 && h <= 11) return h * 60 + min;

  // 1–7 → default to PM (common for times like "2:30 Thursday")
  // Allow explicit hint override.
  const preferPM = hint?.preferPM ?? true;
  return preferPM ? (h + 12) * 60 + min : h * 60 + min;
}

function parseDurationToMins(text: string): number | null {
  // Matches:
  // - for 2 hours, 2 hrs, 2h
  // - for 90 minutes, 90 min, 1.5 hours
  const cleaned = String(text ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

  // e.g., "1.5 hours"
  let m = cleaned.match(/\b(\d+(?:\.\d+)?)\s*(?:hours|hour|hrs|hr|h)\b/);
  if (m) {
    const hours = parseFloat(m[1]);
    if (Number.isFinite(hours) && hours > 0) return Math.round(hours * 60);
  }

  m = cleaned.match(/\b(\d{1,3})\s*(?:minutes|minute|mins|min|m)\b/);
  if (m) {
    const mins = parseInt(m[1], 10);
    if (Number.isFinite(mins) && mins > 0) return mins;
  }

  // "for 2 hours" pattern
  m = cleaned.match(/\bfor\s+(\d+(?:\.\d+)?)\s*(?:hours|hour|hrs|hr|h)\b/);
  if (m) {
    const hours = parseFloat(m[1]);
    if (Number.isFinite(hours) && hours > 0) return Math.round(hours * 60);
  }
  m = cleaned.match(/\bfor\s+(\d{1,3})\s*(?:minutes|minute|mins|min|m)\b/);
  if (m) {
    const mins = parseInt(m[1], 10);
    if (Number.isFinite(mins) && mins > 0) return mins;
  }

  return null;
}

function startOfNextWeekMonday(now: Date): Date {
  // Next week's Monday (not the current week's Monday)
  const d = new Date(now);
  const day = d.getDay(); // 0 Sun..6 Sat
  const daysUntilNextMonday = ((8 - day) % 7) || 7;
  d.setDate(d.getDate() + daysUntilNextMonday);
  d.setHours(0, 0, 0, 0);
  return d;
}

function isoDateLocalFrom(date: Date): string {
  return isoDateLocal(date);
}

function addDaysISO(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + days);
  return isoDateLocal(d);
}

function extractRelativeAnchoredTasks(input: string, now: Date): Array<{ title: string; date: string; atMin?: number; durationMin?: number }> {
  // Handles "tomorrow I have to run for 2 hours", "today workout", etc.
  const out: Array<{ title: string; date: string; atMin?: number; durationMin?: number }> = [];
  const rel = resolveRelativeBaseDate(input, now);
  const baseDate = rel.date;

  // Look for common activities/errands in relative-day prompts.
  const re = /\b(?:today|tomorrow|tonight)\b[^\n\.]{0,140}?\b(run|workout|gym|lift|study|homework|assignment|essay|paper|project|meeting|call|appointment|tour|museum|class|lecture|exam|quiz)\b([^\n\.]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    const raw = m[1] ?? "";
    const rest = String(m[2] ?? "");
    let title = normalizeEventTitle(raw);
    if (/^gym$/i.test(raw)) title = "Gym";
    if (/^lift$/i.test(raw)) title = "Lift";
    if (/^workout$/i.test(raw)) title = "Workout";

    const whole = input.slice(m.index, Math.min(input.length, m.index + 200));
    const atMin =
      parseExplicitTimeToMins(rest) ??
      parseAmbiguousTimeToMins(rest) ??
      parseExplicitTimeToMins(whole) ??
      parseAmbiguousTimeToMins(whole);

    const durationMin = parseDurationToMins(rest) ?? parseDurationToMins(whole) ?? undefined;

    out.push({ title, date: baseDate, atMin: atMin ?? undefined, durationMin });
  }

  // Handle patterns like "tomorrow I have to run for 2 hours" (no explicit verb capture above if punctuation differs)
  const re2 = /\b(?:today|tomorrow|tonight)\b[^\n\.]{0,160}?\bto\s+(run|workout|study|lift)\b([^\n\.]*)/gi;
  while ((m = re2.exec(input)) !== null) {
    const raw = m[1] ?? "";
    const rest = String(m[2] ?? "");
    const whole = input.slice(m.index, Math.min(input.length, m.index + 200));
    const durationMin = parseDurationToMins(rest) ?? parseDurationToMins(whole) ?? undefined;
    out.push({ title: normalizeEventTitle(raw), date: baseDate, durationMin });
  }

  return out;
}

function extractFlexibleNextWeekTasks(input: string, now: Date): Array<{ title: string; startDate: string; endDate: string; durationMin: number }> {
  // Handles: "Set up 2 hours ... to run next week", "Schedule a 90 minute study block next week"
  const out: Array<{ title: string; startDate: string; endDate: string; durationMin: number }> = [];
  if (!/\bnext\s+week\b/i.test(input)) return out;

  const durationMin = parseDurationToMins(input);
  if (!durationMin) return out;

  // pick a title
  let title = "Focus block";
  if (/\brun\b/i.test(input)) title = "Run";
  else if (/\bgym|workout|lift\b/i.test(input)) title = "Workout";
  else if (/\bstudy|homework|assignment|paper|essay|project\b/i.test(input)) title = "Study";

  const start = startOfNextWeekMonday(now);
  const startIso = isoDateLocalFrom(start);
  const endIso = addDaysISO(startIso, 6);

  out.push({ title, startDate: startIso, endDate: endIso, durationMin });
  return out;
}

function extractTimeTaggedTitles(input: string): Array<{ title: string; atMin: number }> {
  // Pull phrases like "meeting at 7pm" or "call mom @ 5:30pm".
  // We keep this intentionally conservative to avoid garbage.
  const out: Array<{ title: string; atMin: number }> = [];

  // 1) Handles: "meeting at 7pm" (single time)
  // 2) Handles: "meetings at 7pm and 9pm" (multiple times in one sentence)
  // 3) Handles: "call mom @ 5:30pm, 6pm" (comma list)
  // We anchor on the first explicit time marker (at/@), then extract up to 4 time tokens
  // that may be joined by "and" or commas.
  const re = /([A-Za-z][^\n\r,.]{0,60}?)\s+(?:at|@)\s*([0-9: apm,\sand]{2,40})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    const phrase = normalizeTitle(m[1]);
    if (!phrase) continue;

    // Guard against accidental captures that are basically empty, like "at 10:30 AM".
    // These create junk blocks and are almost never what the user intended.
    if (/^at\b/i.test(phrase) || phrase.length < 3) continue;

    // IMPORTANT:
    // If the phrase itself includes a weekday (e.g. "flight on Friday at 10:30am"),
    // we should NOT treat it as a "base day" time-tagged event.
    // Those must be handled by weekday-anchored extraction so they land on the right date.
    if (parseWeekdayToken(phrase) !== null) continue;

    const timesChunk = m[2] ?? "";
    const timeRe = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/gi;
    const found: number[] = [];
    let t: RegExpExecArray | null;
    while ((t = timeRe.exec(timesChunk)) !== null) {
      const atMin = parseExplicitTimeToMins(`${t[1]}:${t[2] ?? "00"}${t[3]}`);
      if (atMin !== null) found.push(atMin);
      if (found.length >= 4) break;
    }
    if (found.length === 0) {
      // Fallback: maybe the chunk is only a single time without am/pm (common in EU locales)
      const single24 = parse24hTimeToMins(timesChunk);
      if (single24 !== null) found.push(single24);
    }
    if (found.length === 0) continue;

    // Clean common lead-ins + normalize to a usable event title
    const cleaned = normalizeEventTitle(phrase);
    if (!cleaned) continue;

    for (const atMin of found) {
      out.push({ title: cleaned || "Event", atMin });
    }
  }
  return out;
}

type Weekday = 0|1|2|3|4|5|6; // Sun..Sat

// IMPORTANT: Do NOT use Date.toISOString().slice(0,10) for calendar-day dates.
// That returns a UTC date which can shift the day for users in non-UTC timezones.
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

function addDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}

function resolveRelativeBaseDate(input: string, now: Date): { date: string; anchor: "today"|"tomorrow"|"createdAt" } {
  const t = String(input ?? "").toLowerCase();
  // Only use relative anchors when the user did NOT specify an explicit weekday.
  // (Weekday anchoring is handled elsewhere.)
  if (parseWeekdayToken(t) !== null) return { date: isoDateLocal(now), anchor: "today" };

  if (/\btomorrow\b/.test(t)) return { date: isoDateLocal(addDays(now, 1)), anchor: "tomorrow" };
  if (/\btoday\b/.test(t)) return { date: isoDateLocal(now), anchor: "today" };

  return { date: isoDateLocal(now), anchor: "today" };
}

function enrichGenericTitle(title: string, input: string): string {
  const t = normalizeTitle(title);
  const low = t.toLowerCase();
  if (low !== "deadline" && low !== "due") return t;

  const src = String(input ?? "").toLowerCase();
  // Try to promote a more specific label so the calendar isn't full of "due".
  if (src.includes("essay")) return "Essay due";
  if (src.includes("paper")) return "Paper due";
  if (src.includes("midterm")) return "Midterm";
  if (src.includes("final")) return "Final";
  if (src.includes("exam")) return "Exam";
  if (src.includes("quiz")) return "Quiz";
  if (src.includes("project")) return "Project due";
  if (src.includes("assignment")) return "Assignment due";
  if (src.includes("homework") || src.includes("hw")) return "Homework due";
  return "Deadline";
}

function parseWeekdayToken(text: string): Weekday | null {
  const t = text.toLowerCase();
  if (/\b(mon|monday)\b/.test(t)) return 1;
  if (/\b(tue|tues|tuesday)\b/.test(t)) return 2;
  if (/\b(wed|wednesday)\b/.test(t)) return 3;
  if (/\b(thu|thur|thurs|thursday)\b/.test(t)) return 4;
  if (/\b(fri|friday)\b/.test(t)) return 5;
  if (/\b(sat|saturday)\b/.test(t)) return 6;
  if (/\b(sun|sunday)\b/.test(t)) return 0;
  return null;
}

function nextIsoForWeekday(now: Date, target: Weekday): string {
  const d = new Date(now);
  d.setHours(12, 0, 0, 0);
  const cur = d.getDay() as Weekday;
  let delta = (target - cur + 7) % 7;
  // If the user says "Friday" and today is Friday, assume today (delta=0).
  d.setDate(d.getDate() + delta);
  return isoDateLocal(d);
}

function timeOfDayWindow(token: string): { start: number; end: number } | null {
  const t = token.toLowerCase();
  if (t.includes("morning")) return { start: 7 * 60, end: 12 * 60 };
  if (t.includes("afternoon")) return { start: 12 * 60, end: 17 * 60 + 30 };
  if (t.includes("evening")) return { start: 17 * 60, end: 21 * 60 + 30 };
  if (t.includes("night") || t.includes("tonight")) return { start: 18 * 60, end: 23 * 60 }; // keep it late but not "all day"
  return null;
}

function extractWeekdayContextTasks(input: string, now: Date): Array<{ title: string; date: string; window?: { start: number; end: number }; atMin?: number }> {
  // Handles phrases like:
  // - "on Thursday night to pack"
  // - "Friday morning to get to the airport"
  // - "Thursday evening pack"
  // This is critical because the user's *support tasks* are often anchored to a weekday,
  // but won't match our limited list of "event kinds".
  // IMPORTANT: The user's input can contain MULTIPLE weekdays in one sentence.
  // A naive regex that starts at the first weekday (e.g., "Friday...") can accidentally
  // swallow context actions that are actually anchored to a later weekday ("Thursday night to pack").
  //
  // Strategy:
  // 1) Find each weekday occurrence and treat the text until the NEXT weekday as its "chunk".
  // 2) Inside each chunk, extract one or more action phrases (split on "and" / commas).
  // 3) Normalize common travel/flight phrases.
  const out: Array<{ title: string; date: string; window?: { start: number; end: number }; atMin?: number }> = [];
  const lower = input.toLowerCase();
  const flightContext = lower.includes("flight") || lower.includes("airport");

  const weekdayRe = /\b(mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/gi;
  const hits: Array<{ token: string; idx: number }> = [];
  let mm: RegExpExecArray | null;
  while ((mm = weekdayRe.exec(input)) !== null) {
    hits.push({ token: mm[1], idx: mm.index });
  }
  if (hits.length === 0) return out;

  for (let i = 0; i < hits.length; i++) {
    const token = hits[i].token;
    const startIdx = hits[i].idx;
    const endIdx = i + 1 < hits.length ? hits[i + 1].idx : input.length;
    const chunk = input.slice(startIdx, endIdx);

    const wd = parseWeekdayToken(token);
    if (wd === null) continue;
    const date = nextIsoForWeekday(now, wd);

    // Optional time-of-day window token near the beginning of the chunk.
    const todMatch = chunk.match(/\b(morning|afternoon|evening|night|tonight)\b/i);
    const window = todMatch ? timeOfDayWindow(todMatch[1]) ?? undefined : undefined;

    // Pull a local time only from THIS chunk (so a Friday "10:30" doesn't get applied to Thursday packing).
    const atMin = parseExplicitTimeToMins(chunk) ?? parse24hTimeToMins(chunk) ?? undefined;

    // Remove the leading weekday/tod phrase and common filler.
    let rest = chunk
      .replace(new RegExp(`^\\s*(?:on\\s+)?${token}\\b`, "i"), "")
      .replace(/\b(morning|afternoon|evening|night|tonight)\b/i, "")
      .replace(/^\s*[,\-:]+\s*/, "")
      .replace(/^\s*(?:please\s+)?(?:schedule|plan|set aside|add)\b/i, "")
      .trim();

    if (!rest) continue;

    // Split into candidate actions.
    const candidates = rest
      .split(/\band\b|,|;|\n|\./i)
      .map((s) => normalizeTitle(s))
      .filter(Boolean)
      .map((s) => s.replace(/^\b(?:to\s+)?/i, "").trim())
      .filter((s) => s.length >= 2 && s.length <= 70);

    for (const cand of candidates) {
      // If the candidate contains another weekday token, it's probably spillover; skip it.
      if (parseWeekdayToken(cand) !== null) continue;

      // Avoid junk actions like "at 10:30 AM" or "schedule some time".
      if (/^\s*(?:at\s*)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*$/i.test(cand)) continue;
      if (/\b(schedule|plan)\b\s*\b(some\s+)?time\b/i.test(cand)) continue;
      if (/^\s*(some\s+time|time)\s*$/i.test(cand)) continue;

      let title = normalizeEventTitle(cand);
      if (!title) continue;

      if (/get to the airport|to the airport|airport/i.test(title)) title = "Travel to the airport";
      if (/pack/i.test(title) && flightContext) title = "Pack";

      out.push({ title, date, window: window ?? undefined, atMin });
    }
  }

  return out;
}

function extractWeekdayAnchoredTasks(input: string, now: Date): Array<{ title: string; date: string; atMin?: number; durationMin?: number }> {
  // Extract things like "flight on Friday" or "meeting on Friday at 7pm".
  // This prevents weekday-relative events from being wrongly placed on "today".
  const out: Array<{ title: string; date: string; atMin?: number; durationMin?: number }> = [];

  const re = /(flight|meeting|meetings|call|appointment|appt|interview|exam|quiz|deadline|due|class|lecture|tour|dinner|reservation|concert|train|bus|run|swim|workout|gym|hike|yoga|therapy|show|game|match|race|drive|ride)[^\n\.]{0,140}?\b(?:on\s+)?(mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b([^\n\.]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    const rawKind = m[1] ?? "";
    const wd = parseWeekdayToken(m[2] ?? "");
    if (wd === null) continue;
    const rest = String(m[3] ?? "");

    // Normalize a human title
    let title = normalizeEventTitle(rawKind);

    if (/^tour$/i.test(rawKind)) {
      const m2 = (" " + rest).match(/\btour\s+of\s+([^\n\.,]{2,60})/i);
      if (m2 && m2[1]) title = `Tour of ${normalizeTitle(m2[1])}`;
      else title = "Tour";
    }
    if (/^flight$/i.test(rawKind)) title = "Flight";
    if (/^meetings?$/i.test(rawKind)) title = "Meeting";
    if (/^lecture$/i.test(rawKind)) title = "Class";
    if (/^class$/i.test(rawKind)) title = "Class";

    // Time can appear before or after the weekday ("flight at 10:30 Friday" or "flight Friday at 10:30").
    const wholeMatch = input.slice(m.index, Math.min(input.length, m.index + 180));
    const atMin =
      parseExplicitTimeToMins(rest) ??
      parseAmbiguousTimeToMins(rest) ??
      parseExplicitTimeToMins(wholeMatch) ??
      parseAmbiguousTimeToMins(wholeMatch);

    const durationMin = parseDurationToMins(rest) ?? parseDurationToMins(wholeMatch) ?? undefined;
    out.push({ title, date: nextIsoForWeekday(now, wd), atMin: atMin ?? undefined, durationMin });
  }

  // Also handle "on Friday I have a flight" ordering.
  const re2 = /\b(?:on\s+)?(mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b[^\n\.]{0,90}?(flight|meeting|meetings|call|appointment|appt|interview|exam|quiz|deadline|due|class|lecture|tour|dinner|reservation|concert|train|bus)\b([^\n\.]*)/gi;
  while ((m = re2.exec(input)) !== null) {
    const wd = parseWeekdayToken(m[1] ?? "");
    if (wd === null) continue;
    const rawKind = m[2] ?? "";
    const rest = String(m[3] ?? "");
    let title = normalizeEventTitle(rawKind);

    if (/^tour$/i.test(rawKind)) {
      const m2 = (" " + rest).match(/\btour\s+of\s+([^\n\.,]{2,60})/i);
      if (m2 && m2[1]) title = `Tour of ${normalizeTitle(m2[1])}`;
      else title = "Tour";
    }
    if (/^flight$/i.test(rawKind)) title = "Flight";
    if (/^meetings?$/i.test(rawKind)) title = "Meeting";
    if (/^lecture$/i.test(rawKind)) title = "Class";
    if (/^class$/i.test(rawKind)) title = "Class";
    const wholeMatch = input.slice(m.index, Math.min(input.length, m.index + 180));
    const atMin =
      parseExplicitTimeToMins(rest) ??
      parseAmbiguousTimeToMins(rest) ??
      parseExplicitTimeToMins(wholeMatch) ??
      parseAmbiguousTimeToMins(wholeMatch);
    const durationMin = parseDurationToMins(rest) ?? parseDurationToMins(wholeMatch) ?? undefined;
    out.push({ title, date: nextIsoForWeekday(now, wd), atMin: atMin ?? undefined, durationMin });
  }

  // If we detected a weekday-anchored primary event (Flight/Meeting/Exam/etc.) but couldn't find a time,
  // and the input contains exactly one explicit time, use it.
  const globalTime = parseExplicitTimeToMins(input) ?? parse24hTimeToMins(input);
  if (typeof globalTime === "number") {
    for (const a of out) {
      if (a.atMin === undefined && /^(flight|meeting|call|appointment|interview|exam|quiz|class)$/i.test(a.title)) {
        a.atMin = globalTime;
      }
    }
  }

  return out;
}

function findNextSlot(existing: CalendarBlock[], durationMin: number, window: { start: number; end: number }, stepMin: number) {
  const day = existing
    .slice()
    .sort((x, y) => x.startMin - y.startMin)
    .map((b) => ({ startMin: b.startMin, endMin: b.endMin }));

  for (let t = window.start; t + durationMin <= window.end; t += stepMin) {
    const candidate = { startMin: t, endMin: t + durationMin };
    if (!day.some((b) => overlaps(candidate, b))) return candidate;
  }

  return null;
}

/**
 * Merge a newly generated HistoryItem into the calendar without disturbing existing blocks.
 * Rules:
 * - If the title implies a time-of-day window (e.g., dinner), schedule into the next available slot INSIDE that window.
 * - Otherwise (no time specified), default to next available slot after "now" (A).
 * - Existing blocks are NEVER moved.
 */
export type CalendarMergePreview = {
  baseDate: string;
  hasWeekdayInInput: boolean;
  affectedDates: string[];
  proposed: CalendarBlock[];
  merged: CalendarBlock[];
};

/**
 * Compute a proposed merge (without saving). Used for confirmation flows.
 */
export function previewCalendarFromHistory(
  history: HistoryItem,
  opts?: { stepMin?: number; durationMin?: number; now?: Date }
): CalendarMergePreview {
  return computeCalendarMerge(history, opts);
}

/**
 * Apply a set of user-approved blocks to the calendar, pruning old AI "plan" blocks on affected days.
 */
export function applyApprovedPlanBlocks(preview: CalendarMergePreview, approved: CalendarBlock[]): CalendarBlock[] {
  const allRaw = loadCalendar();
  const affected = new Set(preview.affectedDates);
  const base = preview.hasWeekdayInInput
    ? allRaw.filter((b) => !(affected.has(b.date) && b.meta?.kind === "plan"))
    : allRaw;

  // De-dupe against existing blocks (same day, same title, same start).
  const key = (b: CalendarBlock) => `${b.date}::${b.title.toLowerCase()}::${b.startMin}::${b.endMin}`;
  const existingKeys = new Set(base.map(key));
  const final = approved.filter((b) => !existingKeys.has(key(b)));

  const merged = [...final, ...base];
  saveCalendar(merged);
  return merged;
}

export function mergeCalendarFromHistory(history: HistoryItem, opts?: { stepMin?: number; durationMin?: number; now?: Date }) {
  const computed = computeCalendarMerge(history, opts);
  saveCalendar(computed.merged);
  return computed.merged;
}

function computeCalendarMerge(history: HistoryItem, opts?: { stepMin?: number; durationMin?: number; now?: Date }): CalendarMergePreview {
  // NOTE: a single input can mention events on different weekdays (e.g. "flight on Friday").
  // We handle explicit weekday-tagged items by scheduling them onto the next occurrence
  // of that weekday, instead of incorrectly forcing everything onto history.createdAt.

  // ── FULL-DAY PLAN SHORTCUT ────────────────────────────────────────────────────────────────
  // When the input was produced by the DayPlanModal ("Plan my whole day today."), we bypass
  // ALL the normal NLP extraction logic and instead directly convert the AI's schedule[]
  // array (which already has exact clock times) into calendar blocks. This avoids the issue
  // where hasExplicitAnchor=true suppresses schedule-derived titles.
  if ((history.input ?? "").startsWith("Plan my whole day today.")) {
    const now = opts?.now ?? new Date();
    const baseDate = isoDateLocal(now);
    const allRaw = loadCalendar();
    // Remove existing "plan" blocks from today so we get a clean slate
    const base = allRaw.filter((b) => !(b.date === baseDate && b.meta?.kind === "plan"));

    const schedule = history.plan?.schedule ?? [];
    const newBlocks: CalendarBlock[] = [];

    // Helper: parse "7:00 AM" / "11:30 PM" / "10:30 am" → minutes since midnight
    function parseScheduleTime(t: string): number | null {
      const m = String(t ?? "").match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
      if (!m) return null;
      let h = parseInt(m[1], 10);
      const min = m[2] ? parseInt(m[2], 10) : 0;
      const ap = m[3].toLowerCase();
      if (h === 12) h = ap === "am" ? 0 : 12;
      else if (ap === "pm") h += 12;
      return h * 60 + min;
    }

    // Parse start times
    const parsed: { title: string; startMin: number }[] = [];
    for (const slot of schedule) {
      const startMin = parseScheduleTime(slot.time ?? "");
      if (startMin === null) continue;
      const items: string[] = Array.isArray(slot.plan) ? slot.plan : [];
      for (const item of items) {
        const title = normalizeEventTitle(String(item ?? "").slice(0, 80));
        if (!title) continue;
        parsed.push({ title, startMin });
      }
    }

    // Build blocks — end time = next block's start, or start + 60 for last
    for (let i = 0; i < parsed.length; i++) {
      const { title, startMin } = parsed[i];
      // End time: next block start, or start + 60 min
      const nextStart = parsed[i + 1]?.startMin;
      const endMin = nextStart !== undefined && nextStart > startMin
        ? Math.min(nextStart, startMin + 120) // cap at 2 hours max per block
        : Math.min(startMin + 60, 24 * 60);
      newBlocks.push({
        id: generateId(),
        date: baseDate,
        title,
        startMin,
        endMin,
        sourceHistoryId: history.id,
        meta: { kind: "plan" },
      });
    }

    const merged = [...newBlocks, ...base];
    return {
      baseDate,
      hasWeekdayInInput: false,
      affectedDates: [baseDate],
      proposed: newBlocks,
      merged,
    };
  }
  // ── END FULL-DAY PLAN SHORTCUT ────────────────────────────────────────────────────────────

  const allRaw = loadCalendar();

  const stepMin = opts?.stepMin ?? 10;
  const durationMin = opts?.durationMin ?? 50;
  const now = opts?.now ?? new Date();

  // createdAt is stored as an ISO string (UTC). Convert to a local calendar date so
  // we don't shift the day for users in non-UTC timezones.
  const createdAtDate = new Date(history.createdAt);
  const createdAtLocal = isoDateLocal(Number.isNaN(createdAtDate.getTime()) ? new Date() : createdAtDate);

  // Weekday-anchored items (e.g., "flight on Friday") AND weekday-anchored support tasks
  // (e.g., "Thursday night to pack", "Friday morning to get to the airport").
  // These MUST not get pulled onto baseDate.
  const anchored = extractWeekdayAnchoredTasks(history.input ?? "", now);
  const anchoredContext = extractWeekdayContextTasks(history.input ?? "", now);
  const relativeAnchored = extractRelativeAnchoredTasks(history.input ?? "", now);
  const flexibleNextWeek = extractFlexibleNextWeekTasks(history.input ?? "", now);
  const anchoredKeys = new Set<string>();

  // Some prompts include weekday words in ways that can be tricky (punctuation, line breaks).
  // If we successfully extracted ANY weekday-anchored items, treat the input as weekday-anchored
  // even if the simple token test fails.
  const hasWeekdayInInput =
    anchored.length > 0 ||
    anchoredContext.length > 0 ||
    parseWeekdayToken(history.input ?? "") !== null;

  // If the user says "tomorrow" (or "today") without specifying a weekday/date,
  // anchor scheduling to that relative day instead of history.createdAt.
  const rel = resolveRelativeBaseDate(history.input ?? "", now);
  const baseDate = hasWeekdayInInput ? createdAtLocal : rel.date;

  // If the user is planning around a flight, it's common to ask for "get to the airport".
  // We'll try to place airport travel *before* the flight when possible.
  const flightStartByDate = new Map<string, number>();
  for (const a of anchored) {
    if (a.title.toLowerCase() === "flight" && typeof a.atMin === "number") {
      flightStartByDate.set(a.date, a.atMin);
    }
  }

  // If the user is planning around explicit weekdays (e.g., "Friday") we treat a newly
  // generated plan as authoritative for those involved dates. This prevents the UX where
  // older, incorrectly-placed plan blocks remain on the calendar and make it look like
  // the AI is "still wrong" after a fix.
  const affectedDates = new Set<string>([baseDate]);
  for (const a of anchored) affectedDates.add(a.date);
  for (const c of anchoredContext) affectedDates.add(c.date);
  for (const r of relativeAnchored) affectedDates.add(r.date);
  const base = hasWeekdayInInput
    ? allRaw.filter((b) => !(affectedDates.has(b.date) && b.meta?.kind === "plan"))
    : allRaw;

  // We'll gather new blocks across potentially multiple dates.
  const newBlocks: CalendarBlock[] = [];

  const addBlock = (date: string, title: string, startMin: number, endMin: number, metaKind: string) => {
    const normalized = normalizeEventTitle(title).slice(0, 80) || "Event";
    const finalTitle = enrichGenericTitle(normalized, history.input ?? "");
    newBlocks.push({
      id: generateId(),
      date,
      title: finalTitle,
      startMin,
      endMin,
      sourceHistoryId: history.id,
      meta: { kind: metaKind as any },
    });
  };

  // We merge per-date, preserving existing blocks.
  const existingFor = (date: string) => base.filter((b) => b.date === date);

  const isTodayBase = isoDateLocal(now) === baseDate;
  const nowMinBase = isTodayBase ? now.getHours() * 60 + now.getMinutes() : 6 * 60;

  const schedule = history.plan?.schedule ?? [];
  // Flatten all schedule items instead of using bucket labels (MORNING/AFTERNOON/EVENING)
  // so we never create blocks titled "AFTERNOON" at 06:00.
  const titles = schedule
    .flatMap((b) => (Array.isArray(b?.plan) ? b.plan : []))
    .map((t) => normalizeEventTitle(String(t).slice(0, 160)))
    .filter((t) => typeof t === "string" && t.trim().length > 0)
    // Extra guard: never create blocks that are just meta labels.
    .filter((t) => !/^\s*(this week|today|week)\s*$/i.test(t));

  // If the user gave explicit anchors (weekday/date/tomorrow/time), they are usually
  // asking to place *specific* events, not to auto-generate a full day routine.
  // In that case we should NOT create additional schedule-derived blocks.
  // (Users can still request a full plan explicitly: "plan my day", "build me a schedule", etc.)
  const broadPlanRequest = /\b(plan\s+my\s+(?:day|week)|make\s+(?:me\s+)?a\s+plan|build\s+(?:me\s+)?(?:a\s+)?schedule|create\s+(?:me\s+)?(?:a\s+)?schedule|organize\s+my\s+(?:day|week)|routine|agenda)\b/i.test(
    String(history.input || "")
  );
  const hasExplicitAnchor =
    hasWeekdayInInput ||
    /\b(?:today|tomorrow|tonight|next\s+week|next\s+month|next\s+year)\b/i.test(String(history.input || "")) ||
    /\b20\d{2}-\d{2}-\d{2}\b/.test(String(history.input || "")) ||
    /\b\d{1,2}:\d{2}\b/.test(String(history.input || "")) ||
    /\b\d{1,2}\s*(?:am|pm)\b/i.test(String(history.input || ""));

  const allowScheduleDerivedTitles = broadPlanRequest || !hasExplicitAnchor;

  // 1) Schedule weekday-anchored items first, so they never incorrectly land on baseDate.
  for (const a of anchored) {
    const existingForDay = existingFor(a.date);
    const title = normalizeEventTitle(a.title);
    if (!title) continue;

    const norm = title.toLowerCase();
    const key = `${a.date}::${norm}::${a.atMin ?? ""}`;
    anchoredKeys.add(key);

    if (a.atMin !== undefined) {
      if (existingForDay.some((b) => b.title.toLowerCase() === norm && b.startMin === a.atMin)) continue;
      addBlock(a.date, title, a.atMin, Math.min(a.atMin + (a.durationMin ?? durationMin), 24 * 60), "plan");
      continue;
    }

    if (existingForDay.some((b) => b.title.toLowerCase() === norm)) continue;
    const windowFromKeywords = keywordWindow(title) ?? { start: 6 * 60, end: 24 * 60 };
    const slot = findNextSlot([...existingForDay, ...newBlocks.filter((b) => b.date === a.date)], (a.durationMin ?? durationMin), windowFromKeywords, stepMin);
    if (!slot) continue;
    addBlock(a.date, title, slot.startMin, slot.startMin + (a.durationMin ?? durationMin), "plan");
  }

  // 1b) Weekday-anchored context tasks ("Thursday night to pack", etc.).
  // These frequently lack an explicit time, so we place them into a time-of-day window when provided.
  for (const c of anchoredContext) {
    const title = normalizeEventTitle(c.title);
    if (!title) continue;
    const date = c.date;
    const norm = title.toLowerCase();
    const key = `${date}::${norm}::${c.atMin ?? ""}`;
    anchoredKeys.add(key);

    const existingForDay = existingFor(date);

    if (c.atMin !== undefined) {
      if (existingForDay.some((b) => b.title.toLowerCase() === norm && b.startMin === c.atMin)) continue;
      addBlock(date, title, c.atMin, Math.min(c.atMin + durationMin, 24 * 60), "plan");
      continue;
    }

    // If the exact same title already exists on that target day, don't duplicate.
    if (existingForDay.some((b) => b.title.toLowerCase() === norm)) continue;
    if (newBlocks.some((b) => b.date === date && b.title.toLowerCase() === norm)) continue;

    const window = c.window ?? keywordWindow(title) ?? { start: 6 * 60, end: 24 * 60 };

    // Heuristic: If this is an airport-travel task on the same day as a flight with a known start,
    // schedule it earlier that morning (e.g., ~90 minutes before the flight) instead of "as early as possible".
    const looksLikeAirport = /\b(airport|get to the airport|to the airport)\b/i.test(title);
    const flightStart = flightStartByDate.get(date);
    if (looksLikeAirport && typeof flightStart === "number") {
      const desiredStart = Math.max(window.start, Math.min(window.end - durationMin, flightStart - 90));
      const desired = { startMin: desiredStart, endMin: desiredStart + durationMin };
      const dayBlocks = [...existingForDay, ...newBlocks.filter((b) => b.date === date)];
      if (!dayBlocks.some((b) => overlaps(desired, b))) {
        addBlock(date, title, desired.startMin, desired.endMin, "plan");
        continue;
      }

      // If that slot overlaps, search for the latest available slot before the flight.
      const latestWindow = { start: window.start, end: Math.min(window.end, flightStart) };
      let placed: { startMin: number; endMin: number } | null = null;
      for (let t = latestWindow.end - durationMin; t >= latestWindow.start; t -= stepMin) {
        const cand = { startMin: t, endMin: t + durationMin };
        if (!dayBlocks.some((b) => overlaps(cand, b))) {
          placed = cand;
          break;
        }
      }
      if (placed) {
        addBlock(date, title, placed.startMin, placed.endMin, "plan");
        continue;
      }
    }

    const slot = findNextSlot([...existingForDay, ...newBlocks.filter((b) => b.date === date)], durationMin, window, stepMin);
    if (!slot) continue;
    addBlock(date, title, slot.startMin, slot.endMin, "plan");
  }


  // 1c) Relative-day anchored tasks ("tomorrow run for 2 hours", etc.)
  for (const r of relativeAnchored) {
    const existingForDay = existingFor(r.date);
    const title = normalizeEventTitle(r.title);
    if (!title) continue;

    const norm = title.toLowerCase();
    const key = `${r.date}::${norm}::${r.atMin ?? ""}`;
    if (anchoredKeys.has(key)) continue;

    const dur = r.durationMin ?? durationMin;

    if (r.atMin !== undefined) {
      if (existingForDay.some((b) => b.title.toLowerCase() === norm && b.startMin === r.atMin)) continue;
      addBlock(r.date, title, r.atMin, Math.min(r.atMin + dur, 24 * 60), "plan");
      continue;
    }

    if (existingForDay.some((b) => b.title.toLowerCase() === norm)) continue;
    const window = keywordWindow(title) ?? { start: 6 * 60, end: 24 * 60 };
    const slot = findNextSlot([...existingForDay, ...newBlocks.filter((b) => b.date === r.date)], dur, window, stepMin);
    if (!slot) continue;
    addBlock(r.date, title, slot.startMin, slot.startMin + dur, "plan");
  }

  // 1d) Flexible requests like "Set up 2 hours to run next week"
  for (const f of flexibleNextWeek) {
    // Iterate days in the range, pick the first available slot.
    const rangeDays: string[] = [];
    const start = new Date(f.startDate + "T00:00:00");
    const end = new Date(f.endDate + "T00:00:00");
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      rangeDays.push(isoDateLocal(d));
    }

    let placed = false;
    for (const date of rangeDays) {
      if (placed) break;
      const existingForDay = existingFor(date);
      const window = keywordWindow(f.title) ?? { start: 6 * 60, end: 24 * 60 };
      const slot = findNextSlot([...existingForDay, ...newBlocks.filter((b) => b.date === date)], f.durationMin, window, stepMin);
      if (!slot) continue;
      addBlock(date, f.title, slot.startMin, slot.startMin + f.durationMin, "plan");
      placed = true;
    }
  }

  // 2) Explicit times without weekday ("meeting at 7pm") should apply to the base day.
  // BUT: if the user's input mentions ANY weekday, we skip this step entirely.
  // Otherwise, inputs like "flight Friday at 10:30" can incorrectly create a "time-only" block on today.
  const timeTaggedNorms = new Set<string>();
  if (!hasWeekdayInInput) {
    const timeTagged = extractTimeTaggedTitles(history.input ?? "");
    for (const t of timeTagged) {
      const norm = normalizeEventTitle(t.title).toLowerCase();
      if (norm) timeTaggedNorms.add(norm);
      const key = `${baseDate}::${norm}::${t.atMin}`;
      if (anchoredKeys.has(key)) continue;

      const existingForDay = existingFor(baseDate);
      if (existingForDay.some((b) => b.title.toLowerCase() === norm && b.startMin === t.atMin)) continue;
      addBlock(baseDate, t.title, t.atMin, Math.min(t.atMin + durationMin, 24 * 60), "plan");
    }
  }

  if (allowScheduleDerivedTitles) for (const rawTitle of titles) {
    const title = normalizeEventTitle(rawTitle);
    if (!title) continue;
    const norm = title.toLowerCase();

    // If the user explicitly time-tagged this item (e.g., "run at 9am"),
    // do NOT also add a second, model-suggested version of the same thing.
    if (timeTaggedNorms.has(norm)) continue;

    // De-dupe: skip if same title already exists on that day.
    const existingForDay = existingFor(baseDate);
    if (existingForDay.some((b) => b.title.toLowerCase() === norm)) continue;
    if (newBlocks.some((b) => b.date === baseDate && b.title.toLowerCase() === norm)) continue;

    // If the title itself includes an explicit time (rare but possible), honor it.
    const explicit = parseExplicitTimeToMins(title);
    if (explicit !== null) {
      addBlock(baseDate, title, explicit, Math.min(explicit + durationMin, 24 * 60), "plan");
      continue;
    }

    const windowFromKeywords = keywordWindow(title);
    const window = windowFromKeywords
      ? windowFromKeywords
      : { start: Math.max(nowMinBase, 6 * 60), end: 24 * 60 };

    const slot = findNextSlot([...existingForDay, ...newBlocks.filter((b) => b.date === baseDate)], durationMin, window, stepMin);
    if (!slot) continue;

    addBlock(baseDate, title, slot.startMin, slot.endMin, "plan");
  }

  const merged = [...newBlocks, ...base];
  return {
    baseDate,
    hasWeekdayInInput,
    affectedDates: Array.from(affectedDates),
    proposed: newBlocks,
    merged,
  };
}

export type SyllabusEvent = {
  title: string;
  date: string; // YYYY-MM-DD
  startTime?: string; // HH:MM
  endTime?: string; // HH:MM
  kind?: string;
  confidence?: number;
  source?: string;
};

export function addSyllabusEventsToCalendar(events: SyllabusEvent[], color?: string) {
  const all = loadCalendar();
  const newBlocks: CalendarBlock[] = [];

  // Default due time for graded items when no time is given: 11:59pm.
  // We render this as a small "deadline" block in the last 10 minutes of the day so it's visible.
  const defaultDuration = 30;
  const dueWindow = { start: 23 * 60 + 50, end: 24 * 60 }; // 23:50–24:00 (represents 11:59pm)

  function parseHHMMToMins(hhmm: string) {
    const m = hhmm.match(/^(\d{2}):(\d{2})$/);
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }

  for (const e of events) {
    const date = e.date;
    if (!date) continue;

    const parsedStart = e.startTime ? parseHHMMToMins(e.startTime) : null;
    const parsedEnd = e.endTime ? parseHHMMToMins(e.endTime) : null;

    let startMin: number;
    let endMin: number;

    if (parsedStart !== null) {
      startMin = parsedStart;
      endMin = parsedEnd !== null ? parsedEnd : Math.min(startMin + defaultDuration, 24 * 60);
    } else {
      startMin = dueWindow.start;
      endMin = dueWindow.end;
    }

    if (endMin <= startMin) endMin = Math.min(startMin + defaultDuration, 24 * 60);

    newBlocks.push({
      id: generateId(),
      date,
      title: normalizeTitle(e.title).slice(0, 80) || "Syllabus item",
      startMin,
      endMin,
      meta: {
        kind: "syllabus",
        confidence: e.confidence,
        // IMPORTANT: do NOT persist large source blobs; they can exceed localStorage quota.
        // If needed, a tiny snippet is kept by saveCalendar() anyway.
        source: e.source ? String(e.source).slice(0, 180) : undefined,
        color: color || undefined,
      },
    });
  }

  const ok = saveCalendar([...newBlocks, ...all]);
  return { ok, newBlocks };
}





