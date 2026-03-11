/**
 * user-learning-profile.ts
 * ─────────────────────────────────────────────────────────────
 * Builds and persists a rich behavioural profile from the user's
 * entire planning history. This is the "memory" layer that makes
 * the AI feel like it knows the user.
 *
 * The profile is recomputed on demand from localStorage history —
 * no separate write step needed for most fields. Heavy fields
 * (gymDays, frequentPeople, etc.) are derived from the last
 * 60 history entries so they stay fresh.
 */

const SMART_PROFILE_KEY = "openhour_smart_profile_v1";

export type SmartUserProfile = {
  // ── Scheduling habits ────────────────────────────────────────
  typicalWakeMin: number | null;      // minutes from midnight, e.g. 7*60 = 420
  typicalSleepMin: number | null;     // e.g. 23*60 = 1380
  preferredWorkPeriod: "AM" | "PM" | "mixed" | null;
  gymDays: number[];                  // 0=Sun … 6=Sat, e.g. [1,3,5] = MWF
  defaultMeetingDurationMin: number;  // learned from past meetings
  prefersWeekendSocial: boolean;

  // ── Activity fingerprint ─────────────────────────────────────
  topActivities: string[];            // e.g. ["gym","study","run","dentist"]
  frequentPeople: string[];           // e.g. ["sarah","jake","mom"]
  frequentLocations: string[];        // e.g. ["gym","office","library"]

  // ── Time-of-day patterns ─────────────────────────────────────
  activityTimeMap: Record<string, number>;  // activity → typical startMin
  // e.g. { gym: 420, run: 390, study: 840, dinner: 1080 }

  // ── Meta ─────────────────────────────────────────────────────
  totalInputs: number;
  lastComputedAt: string;             // ISO
};

const DEFAULT_PROFILE: SmartUserProfile = {
  typicalWakeMin: null,
  typicalSleepMin: null,
  preferredWorkPeriod: null,
  gymDays: [],
  defaultMeetingDurationMin: 60,
  prefersWeekendSocial: false,
  topActivities: [],
  frequentPeople: [],
  frequentLocations: [],
  activityTimeMap: {},
  totalInputs: 0,
  lastComputedAt: "",
};

// ── Helpers ───────────────────────────────────────────────────

function countBy<T>(arr: T[], key: (x: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of arr) {
    const k = key(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function topN(freq: Record<string, number>, n: number): string[] {
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => k);
}

// Common words to ignore when extracting people / activities
const STOP_WORDS = new Set([
  "a","an","the","and","or","but","so","at","to","for","of","in","on","with",
  "my","me","i","we","you","they","it","is","are","was","have","has","need",
  "want","going","gonna","gotta","will","today","tomorrow","tonight","this",
  "next","some","from","that","then","just","like","time","get","do","be",
  "can","plan","make","schedule","add","set","block","session","hour","min",
  "morning","afternoon","evening","night","am","pm","monday","tuesday",
  "wednesday","thursday","friday","saturday","sunday",
]);

const ACTIVITY_KEYWORDS = [
  "gym","workout","run","running","walk","yoga","swim","cycling","bike","hike",
  "lift","pilates","crossfit","spin","tennis","soccer","basketball","golf",
  "study","homework","assignment","essay","paper","reading","lecture","class",
  "meeting","call","standup","sync","interview","presentation","retro",
  "dentist","doctor","therapy","appointment","checkup",
  "dinner","lunch","breakfast","brunch","coffee","drinks",
  "flight","travel","airport","hotel","packing","pack",
  "shopping","groceries","errands","laundry","cleaning","cook",
];

const PERSON_RE = /\bw(?:ith)?\s+([A-Z][a-z]{2,})\b/g;
const LOCATION_KEYWORDS = ["gym","office","library","home","school","university","studio","cafe","hospital"];

function extractPeople(text: string): string[] {
  const people: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(PERSON_RE.source, PERSON_RE.flags);
  while ((m = re.exec(text)) !== null) {
    const name = m[1].toLowerCase();
    if (!STOP_WORDS.has(name)) people.push(name);
  }
  return people;
}

function extractActivities(text: string): string[] {
  const lower = text.toLowerCase();
  return ACTIVITY_KEYWORDS.filter((kw) => lower.includes(kw));
}

function extractLocations(text: string): string[] {
  const lower = text.toLowerCase();
  return LOCATION_KEYWORDS.filter((loc) => lower.includes(loc));
}

// ── Core: compute from history ────────────────────────────────

interface HistoryLike {
  input: string;
  createdAt: string;
  plan?: {
    schedule?: Array<{ time: string; plan: string[] }>;
  };
}

export function computeSmartProfile(history: HistoryLike[]): SmartUserProfile {
  if (!history.length) return { ...DEFAULT_PROFILE, lastComputedAt: new Date().toISOString() };

  const recent = history.slice(0, 60); // last 60 entries

  // ── Activity / people / location frequency ───────────────────
  const actFreq: Record<string, number> = {};
  const peopleFreq: Record<string, number> = {};
  const locFreq: Record<string, number> = {};
  const actTimeAccum: Record<string, number[]> = {};

  for (const item of recent) {
    const text = item.input ?? "";
    for (const act of extractActivities(text)) {
      actFreq[act] = (actFreq[act] ?? 0) + 1;
    }
    for (const person of extractPeople(text)) {
      peopleFreq[person] = (peopleFreq[person] ?? 0) + 1;
    }
    for (const loc of extractLocations(text)) {
      locFreq[loc] = (locFreq[loc] ?? 0) + 1;
    }

    // Extract activity → time mappings from schedule blocks
    const schedule = item.plan?.schedule ?? [];
    for (const slot of schedule) {
      const timeStr = slot.time ?? "";
      const timeMins = parseScheduleTime(timeStr);
      if (timeMins === null) continue;
      for (const planItem of slot.plan ?? []) {
        const lower = planItem.toLowerCase();
        for (const kw of ACTIVITY_KEYWORDS) {
          if (lower.includes(kw)) {
            if (!actTimeAccum[kw]) actTimeAccum[kw] = [];
            actTimeAccum[kw].push(timeMins);
          }
        }
      }
    }
  }

  // Average times per activity
  const activityTimeMap: Record<string, number> = {};
  for (const [act, times] of Object.entries(actTimeAccum)) {
    if (times.length >= 2) {
      activityTimeMap[act] = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
    }
  }

  // ── Gym day detection ─────────────────────────────────────────
  const gymDayFreq: Record<number, number> = {};
  for (const item of recent) {
    const text = (item.input ?? "").toLowerCase();
    if (!/(gym|workout|lift|run|exercise)/i.test(text)) continue;
    try {
      const d = new Date(item.createdAt);
      if (!Number.isNaN(d.getTime())) {
        const dow = d.getDay();
        gymDayFreq[dow] = (gymDayFreq[dow] ?? 0) + 1;
      }
    } catch { /* skip */ }
  }
  const gymDays = Object.entries(gymDayFreq)
    .filter(([, cnt]) => cnt >= 2)                     // appeared on this weekday ≥2 times
    .sort(([, a], [, b]) => b - a)
    .slice(0, 4)
    .map(([d]) => parseInt(d, 10));

  // ── Work period preference ────────────────────────────────────
  const workTimes: number[] = actTimeAccum["study"] ?? [];
  const meetingTimes: number[] = actTimeAccum["meeting"] ?? [];
  const allWorkTimes = [...workTimes, ...meetingTimes];
  let preferredWorkPeriod: SmartUserProfile["preferredWorkPeriod"] = null;
  if (allWorkTimes.length >= 3) {
    const avg = allWorkTimes.reduce((a, b) => a + b, 0) / allWorkTimes.length;
    if (avg < 12 * 60) preferredWorkPeriod = "AM";
    else if (avg > 14 * 60) preferredWorkPeriod = "PM";
    else preferredWorkPeriod = "mixed";
  }

  // ── Weekend social preference ─────────────────────────────────
  let weekendSocialCount = 0;
  for (const item of recent) {
    const text = (item.input ?? "").toLowerCase();
    if (!/(dinner|lunch|coffee|drinks|hang|friend|party|bar|restaurant)/i.test(text)) continue;
    try {
      const d = new Date(item.createdAt);
      const dow = d.getDay();
      if (dow === 0 || dow === 6) weekendSocialCount++;
    } catch { /* skip */ }
  }
  const prefersWeekendSocial = weekendSocialCount >= 2;

  // ── Meeting duration preference ───────────────────────────────
  // Parse durations mentioned alongside "meeting" / "call"
  const meetingDurationRe = /\b(?:meeting|call|sync|standup)\b.{0,40}?\b(\d+)\s*(?:hour|hr|h\b|min(?:ute)?)/gi;
  const meetingDurations: number[] = [];
  for (const item of recent) {
    let m: RegExpExecArray | null;
    const re = new RegExp(meetingDurationRe.source, meetingDurationRe.flags);
    while ((m = re.exec(item.input ?? "")) !== null) {
      const val = parseInt(m[1], 10);
      const unit = m[0].match(/hour|hr|h\b/i) ? 60 : 1;
      meetingDurations.push(val * unit);
    }
  }
  const defaultMeetingDurationMin = meetingDurations.length >= 3
    ? Math.round(meetingDurations.reduce((a, b) => a + b, 0) / meetingDurations.length)
    : 60;

  return {
    typicalWakeMin: null,       // set from OnboardingProfile externally
    typicalSleepMin: null,
    preferredWorkPeriod,
    gymDays,
    defaultMeetingDurationMin,
    prefersWeekendSocial,
    topActivities: topN(actFreq, 8),
    frequentPeople: topN(peopleFreq, 5),
    frequentLocations: topN(locFreq, 5),
    activityTimeMap,
    totalInputs: history.length,
    lastComputedAt: new Date().toISOString(),
  };
}

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

// ── Load / save / rebuild ──────────────────────────────────────

export function loadSmartProfile(): SmartUserProfile {
  if (typeof window === "undefined") return { ...DEFAULT_PROFILE };
  try {
    const raw = window.localStorage.getItem(SMART_PROFILE_KEY);
    if (!raw) return { ...DEFAULT_PROFILE };
    return JSON.parse(raw) as SmartUserProfile;
  } catch {
    return { ...DEFAULT_PROFILE };
  }
}

export function saveSmartProfile(p: SmartUserProfile): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SMART_PROFILE_KEY, JSON.stringify(p));
}

/**
 * Rebuild the profile from history and save it.
 * Call this after each new plan is added to history.
 */
export function rebuildAndSaveSmartProfile(
  history: HistoryLike[],
  onboardingWakeHour?: number | null,
  onboardingSleepHour?: number | null,
): SmartUserProfile {
  const profile = computeSmartProfile(history);
  if (onboardingWakeHour != null) profile.typicalWakeMin = onboardingWakeHour * 60;
  if (onboardingSleepHour != null) profile.typicalSleepMin = onboardingSleepHour * 60;
  saveSmartProfile(profile);
  return profile;
}

/**
 * Serialise the profile into a compact string to inject into the AI system prompt.
 */
export function formatSmartProfileForPrompt(p: SmartUserProfile): string {
  if (!p.totalInputs) return "";
  const lines: string[] = ["USER BEHAVIOURAL PROFILE (learned from history):"];

  if (p.typicalWakeMin !== null) {
    lines.push(`  • Typically wakes at ${minsToTime(p.typicalWakeMin)}`);
  }
  if (p.typicalSleepMin !== null) {
    lines.push(`  • Typically sleeps at ${minsToTime(p.typicalSleepMin)}`);
  }
  if (p.preferredWorkPeriod) {
    lines.push(`  • Prefers ${p.preferredWorkPeriod} for focused work`);
  }
  if (p.gymDays.length) {
    const dayNames = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    lines.push(`  • Usually exercises on: ${p.gymDays.map((d) => dayNames[d]).join(", ")}`);
  }
  if (p.defaultMeetingDurationMin !== 60) {
    lines.push(`  • Typical meeting length: ${p.defaultMeetingDurationMin} min`);
  }
  if (p.prefersWeekendSocial) {
    lines.push(`  • Prefers social activities (dinner, drinks) on weekends`);
  }
  if (p.topActivities.length) {
    lines.push(`  • Most common activities: ${p.topActivities.slice(0, 5).join(", ")}`);
  }
  if (p.frequentPeople.length) {
    lines.push(`  • Frequently schedules with: ${p.frequentPeople.join(", ")}`);
  }
  if (Object.keys(p.activityTimeMap).length) {
    const examples = Object.entries(p.activityTimeMap)
      .slice(0, 5)
      .map(([act, min]) => `${act} @ ${minsToTime(min)}`)
      .join(", ");
    lines.push(`  • Typical activity times: ${examples}`);
  }

  return lines.join("\n");
}

function minsToTime(mins: number): string {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  const ap = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12} ${ap}` : `${h12}:${String(m).padStart(2, "0")} ${ap}`;
}
