import OpenAI from "openai";
import { NextResponse } from "next/server";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const USER_TIMEZONE = "Europe/Madrid";
// Normalize model name - ensure it's a valid OpenAI model
const rawModel = process.env.OPENAI_MODEL || "gpt-4o";
const DEFAULT_MODEL = rawModel.trim() || "gpt-4o";

type Weekday = 0|1|2|3|4|5|6; // Sun..Sat

function nowInTimeZone(tz: string): Date {
  // Creates a Date whose wall-clock components match the provided timezone.
  // This avoids the common "server is UTC" drift when interpreting "Friday".
  const s = new Date().toLocaleString("en-US", { timeZone: tz });
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

function isoDateInTimeZone(date: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const y = get("year");
  const m = get("month");
  const d = get("day");
  const iso = `${y}-${m}-${d}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : date.toISOString().slice(0, 10);
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
  // If the user says "Friday" and today is Friday, assume today (delta=0)
  d.setDate(d.getDate() + delta);
  return isoDateInTimeZone(d, USER_TIMEZONE);
}

function resolvePlanningDate(input: string, now: Date): { iso: string; label: string; source: string } {
  const trimmed = String(input ?? "");
  const lower = trimmed.toLowerCase();

  // 1) Explicit ISO date
  const isoMatch = trimmed.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (isoMatch) {
    return { iso: isoMatch[1], label: isoMatch[1], source: "explicit ISO date" };
  }

  // 2) Numeric date (MM/DD[/YYYY] or DD/MM[/YYYY])
  const md = trimmed.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(20\d{2}))?\b/);
  if (md) {
    const a = parseInt(md[1], 10);
    const b = parseInt(md[2], 10);
    const year = md[3] ? parseInt(md[3], 10) : now.getFullYear();

    // Heuristic: if first number > 12, it's DD/MM. Otherwise assume MM/DD (US-style).
    const month = a > 12 ? b : a;
    const day = a > 12 ? a : b;
    const d = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
    if (!Number.isNaN(d.getTime())) {
      return { iso: d.toISOString().slice(0, 10), label: `${d.toISOString().slice(0, 10)}`, source: "numeric date" };
    }
  }

  // 3) Weekday reference (Friday, Fri, etc.)
  // Inputs often mention multiple weekdays ("flight Friday... pack Thursday night...").
  // We MUST anchor planning to the *primary* event day (usually the dated appointment like "flight").
  // Strategy:
  //   a) Prefer weekdays that are directly tied to a strong event keyword (flight/meeting/exam/etc.)
  //   b) Otherwise, prefer an explicit "on <weekday>" reference
  //   c) Otherwise, fall back to the last weekday mentioned in the text

  const weekdayNames = "mon|monday|tue|tues|tuesday|wed|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday";
  const primaryKinds = "flight|meeting|call|appointment|interview|exam|quiz|deadline|due";

  // a) Keyword-tied weekday ("flight on Friday", "exam Friday", etc.)
  {
    const re = new RegExp(`\\b(?:${primaryKinds})\\b[^\\n\\.]{0,80}?\\b(?:on\\s+)?(${weekdayNames})\\b`, "i");
    const m = trimmed.match(re);
    const wd = m ? parseWeekdayToken(m[1]) : null;
    if (wd !== null) {
      const iso = nextIsoForWeekday(now, wd);
      const label = new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "short", day: "numeric" });
      return { iso, label, source: "weekday (primary event)" };
    }
  }

  // b) Explicit "on <weekday>" reference
  {
    const m = trimmed.match(new RegExp(`\\bon\\s+(${weekdayNames})\\b`, "i"));
    const wd = m ? parseWeekdayToken(m[1]) : null;
    if (wd !== null) {
      const iso = nextIsoForWeekday(now, wd);
      const label = new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "short", day: "numeric" });
      return { iso, label, source: "weekday (on <weekday>)" };
    }
  }

  // c) Last weekday mentioned in the text
  {
    const reAll = new RegExp(`\\b(${weekdayNames})\\b`, "gi");
    let last: string | null = null;
    let mm: RegExpExecArray | null;
    while ((mm = reAll.exec(trimmed)) !== null) last = mm[1];
    const wd = last ? parseWeekdayToken(last) : null;
    if (wd !== null) {
      const iso = nextIsoForWeekday(now, wd);
      const label = new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "short", day: "numeric" });
      return { iso, label, source: "weekday (last mention)" };
    }
  }

  // Default: today
  const iso = isoDateInTimeZone(now, USER_TIMEZONE);
  const label = new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "short", day: "numeric" });
  return { iso, label, source: "default today" };
}

type Plan = {
"detectedTasks": string[],
  "assumptions": string[],  
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

// Try to safely parse JSON from the model response.
// If it includes extra text, we extract the first JSON object.
function safeJsonParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    // Try to extract a JSON object from the text
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      const slice = text.slice(start, end + 1);
      return JSON.parse(slice);
    }
    throw new Error("Model did not return valid JSON.");
  }
}

function isNonEmptyString(x: any): x is string {
  return typeof x === "string" && x.trim().length > 0;
}

async function withTimeout<T>(p: Promise<T>, ms = 12000): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("OpenAI request timed out.")), ms)
    ),
  ]);
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const input = body?.input;
    // Learned preferences passed from client (stored in localStorage, sent on each request)
    const preferenceContext: string = typeof body?.preferenceContext === "string" ? body.preferenceContext : "";

    if (!isNonEmptyString(input)) {
      return NextResponse.json(
        { error: "Missing or invalid 'input' (must be a non-empty string)." },
        { status: 400 }
      );
    }

    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json(
        { error: "Missing OPENAI_API_KEY in environment variables." },
        { status: 500 }
      );
    }

    const nowTz = nowInTimeZone(USER_TIMEZONE);
    const planning = resolvePlanningDate(input, nowTz);
    const todayIso = isoDateInTimeZone(nowTz, USER_TIMEZONE);

    const systemPrompt = `
You are LifeOS, a strict, context-aware planner.

DATE CONTEXT (CRITICAL):
- The user's timezone is ${USER_TIMEZONE}.
- "Now" in the user's timezone is: ${nowTz.toISOString()}.
- Today (user timezone) is: ${todayIso}.
- If the user references a weekday/date in their input, you MUST plan for that referenced date — not today.
- If the user says e.g. "flight Friday at 10:30", interpret it as the NEXT upcoming Friday (unless the user explicitly says "this past Friday"), and treat "10:30" as 10:30 (24-hour) if no am/pm is given.

PLANNING TARGET:
- Target date for this plan: ${planning.iso} (${planning.label}). (Derived from: ${planning.source})

ABSOLUTE RULES:
1) You MUST base the plan on the user's input. The plan must clearly reflect what they typed.
2) DO NOT assume school, studying, essays, work, meetings, gym, groceries, or chores unless the user explicitly mentions them.
3) If the user mentions a constraint (deadline, time window, bedtime), you MUST respect it in the schedule.
4) DO NOT add any tasks that the user did not explicitly request. No "support" steps (no shower, stretching, commute, prep) unless the user explicitly asked for them.
5) Top priorities MUST directly reference the user's tasks/constraints (use their wording when possible).
6) Return ONLY valid JSON. No markdown. No commentary.
7) detectedTasks MUST have at least 1 item. Extract the user's tasks/constraints as short phrases.
8) assumptions MUST include any inferred details (durations, intensity, ordering, missing times). If the user provides no times, include "No specific times provided".
9) If the user input contains verbs like "run", "swim", "sleep", those MUST appear in detectedTasks.
10) If you need to pick a duration, put it in assumptions (e.g., "Run = 30 minutes").

DATE RULES:
- If the input contains an event on a future date/weekday, your schedule MUST be organized around that event. Do NOT place it on today.
- Add an assumption line that states the resolved planning date exactly, e.g. "Planning date resolved as 2026-02-13 (Friday, Europe/Madrid)".

Return JSON matching this exact schema:

{
  "detectedTasks": string[],
  "assumptions": string[],
  "priorities": string[],
  "schedule": { "time": string, "plan": string[] }[],
  "habit": { "title": string, "why": string, "how": string },
  "coach": string,
  "personalInsight": string,
  "streak": number,
  "profile": {
    "summary": string,
    "doMore": string[],
    "doLess": string[],
    "risk": string
  } | null
}

NOTES:
- schedule.time should be simple buckets like "MORNING", "AFTERNOON", "EVENING" or times like "8:00 AM".
- coach should be short, punchy, motivational, and relevant to the input.
- personalInsight should be 1–2 sentences and directly tied to the user's input (not generic).
- streak can be 1 for now.
${preferenceContext ? `\nUSER PREFERENCES (learned from past sessions — follow these closely):\n${preferenceContext}` : ""}
`;

    const userPrompt = `
USER INPUT (raw):
"${input}"

Resolved planning date (use this date when the user referenced a weekday/date):
${planning.iso}

Create a plan that directly reflects ONLY this input.
`;

// Use Chat Completions API exclusively for maximum reliability across all SDK versions
let raw: any;
try {
  const cc = await withTimeout(
    client.chat.completions.create({
      model: DEFAULT_MODEL,
      temperature: 0.5,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
    12000
  );

  const text = cc.choices?.[0]?.message?.content ?? "{}";
  raw = safeJsonParse(text);
} catch (apiError: any) {
  // Detailed error logging for debugging
  console.error("OpenAI API Error:", {
    message: apiError?.message,
    status: apiError?.status,
    type: apiError?.type,
    model: DEFAULT_MODEL,
  });
  
  // Return a user-friendly error
  return NextResponse.json(
    { 
      error: `AI service error: ${apiError?.message || "Unknown error"}. Please try again.`,
      details: apiError?.message 
    },
    { status: 500 }
  );
}

    // Basic shape validation + gentle fallback defaults
    const plan: Plan = {
detectedTasks: Array.isArray(raw?.detectedTasks) ? raw.detectedTasks : [],
assumptions: Array.isArray(raw?.assumptions) ? raw.assumptions : [],
      priorities: Array.isArray(raw?.priorities) ? raw.priorities : [],
      schedule: Array.isArray(raw?.schedule) ? raw.schedule : [],
      habit:
        raw?.habit && typeof raw.habit === "object"
          ? raw.habit
          : { title: "Tiny habit", why: "Build momentum.", how: "Do it for 2 minutes." },
      coach: typeof raw?.coach === "string" ? raw.coach : "You’ve got this.",
      personalInsight:
        typeof raw?.personalInsight === "string" ? raw.personalInsight : "",
      streak: typeof raw?.streak === "number" ? raw.streak : 1,
      profile:
        raw?.profile && typeof raw.profile === "object" ? raw.profile : null,
    };

    // Ensure arrays are strings
plan.detectedTasks = plan.detectedTasks.filter((x: any) => typeof x === "string");
plan.assumptions = plan.assumptions.filter((x: any) => typeof x === "string");
    plan.priorities = plan.priorities.filter((x: any) => typeof x === "string");
    plan.schedule = plan.schedule
      .filter((b: any) => b && typeof b === "object")
      .map((b: any) => ({
        time: typeof b.time === "string" ? b.time : "TODAY",
        plan: Array.isArray(b.plan) ? b.plan.filter((x: any) => typeof x === "string") : [],
      }));

    // --- FILTER: remove invented plan lines ---
    // The UI/merge logic will schedule whatever appears in schedule[].plan.
    // To keep the app professional and predictable, we only keep items that are
    // explicitly supported by the user's input (simple lexical grounding).
    {
      const inputLower = String(input ?? "").toLowerCase();
      const stop = new Set([
        "the","a","an","to","for","and","or","of","in","on","at","by","with","my","i","me","we","us",
        "today","tomorrow","tonight","this","next","please","would","like","want","need","have",
        "morning","afternoon","evening","night",
      ]);

      const normalizeLine = (s: string) =>
        String(s)
          .replace(/\([^)]*\)/g, " ")
          .replace(/\b(?:today|tomorrow|tonight)\b/gi, " ")
          .replace(/\s+/g, " ")
          .trim();

      const tokens = (s: string) =>
        normalizeLine(s)
          .toLowerCase()
          .split(/[^a-z0-9]+/g)
          .filter((t) => t.length >= 3 && !stop.has(t));

      const keep = (line: string) => {
        const tks = tokens(line);
        if (tks.length === 0) return false;

        // Always keep if it contains a primary keyword that the user mentioned.
        const primary = ["flight","airport","pack","exam","quiz","midterm","final","presentation","project","assignment","essay","paper","run","workout","gym"];
        for (const k of primary) {
          if (line.toLowerCase().includes(k) && inputLower.includes(k)) return true;
        }

        // Otherwise require at least one meaningful token to appear in the input.
        return tks.some((t) => inputLower.includes(t));
      };

      plan.schedule = plan.schedule
        .map((b) => ({ ...b, plan: b.plan.filter((p) => keep(p)) }))
        .filter((b) => b.plan.length > 0);
    }

// --- GUARANTEED grounding fallback ---
// If the model didn't populate detectedTasks/assumptions, derive them from the user's input.
if (plan.detectedTasks.length === 0) {
  const lower = input.toLowerCase();
  const tasks: string[] = [];

  // simple keyword extraction (extend over time)
  if (lower.includes("run")) tasks.push("Run");
  if (lower.includes("swim")) tasks.push("Swim");
  if (lower.includes("sleep")) {
    const m = input.match(/sleep\s+by\s+([0-9]{1,2}(:[0-9]{2})?\s?(am|pm)?)/i);
    tasks.push(m ? `Sleep by ${m[1]}` : "Sleep");
  }
  if (lower.includes("walk")) tasks.push("Walk");
  if (lower.includes("work out") || lower.includes("workout") || lower.includes("gym")) tasks.push("Workout");

  // If we still found nothing, at least reflect that input was received.
  plan.detectedTasks = tasks.length ? tasks : [input.trim().slice(0, 60)];
}

if (plan.assumptions.length === 0) {
  const assumptions: string[] = [];

  // If user didn't specify any times, be explicit
  const hasTime =
    /\b([0-9]{1,2}(:[0-9]{2})?\s?(am|pm))\b/i.test(input) ||
    /\b(by|at)\s+[0-9]{1,2}\b/i.test(input) ||
    /\bmorning\b|\bafternoon\b|\bevening\b|\btonight\b/i.test(input);

  if (!hasTime) assumptions.push("No specific times provided.");

  // Common default durations for detected tasks (only if not specified)
  if (plan.detectedTasks.includes("Run")) assumptions.push("Run = 30 minutes easy pace (adjust as needed).");
  if (plan.detectedTasks.includes("Swim")) assumptions.push("Swim = 20 minutes steady laps (adjust as needed).");

  plan.assumptions = assumptions.length ? assumptions : ["No additional assumptions."];
}

// Always include the resolved planning date so the client can display/anchor it.
// This is critical for inputs like "flight Friday at 10:30" where "Friday" must not be treated as "today".
{
  const planningLine = `Planning date resolved as ${planning.iso} (${planning.label}, ${USER_TIMEZONE})`;
  const already = plan.assumptions.some((a) => typeof a === "string" && a.toLowerCase().includes("planning date resolved"));
  if (!already) plan.assumptions = [planningLine, ...plan.assumptions];
}

    return NextResponse.json(plan);
  } catch (err: any) {
    const message =
      typeof err?.message === "string" ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
