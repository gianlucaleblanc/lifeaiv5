import OpenAI from "openai";
import { NextResponse } from "next/server";

const POSTHOG_KEY = "phc_5rgri5Bb6XL3CW4b8w82qMPWjCtwTIzGQ7eH54cMGve";
async function captureServerEvent(event: string, properties: Record<string, any>) {
  try {
    await fetch("https://us.i.posthog.com/capture/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: POSTHOG_KEY,
        event,
        distinct_id: "server",
        properties,
      }),
    });
  } catch { /* non-blocking */ }
}

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const DEFAULT_TIMEZONE = "America/New_York";
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
  // English
  if (/\b(mon|monday)\b/.test(t)) return 1;
  if (/\b(tue|tues|tuesday)\b/.test(t)) return 2;
  if (/\b(wed|wednesday)\b/.test(t)) return 3;
  if (/\b(thu|thur|thurs|thursday)\b/.test(t)) return 4;
  if (/\b(fri|friday)\b/.test(t)) return 5;
  if (/\b(sat|saturday)\b/.test(t)) return 6;
  if (/\b(sun|sunday)\b/.test(t)) return 0;
  // French
  if (/\b(lun|lundi)\b/.test(t)) return 1;
  if (/\b(mar|mardi)\b/.test(t)) return 2;
  if (/\b(mer|mercredi)\b/.test(t)) return 3;
  if (/\b(jeu|jeudi)\b/.test(t)) return 4;
  if (/\b(ven|vendredi)\b/.test(t)) return 5;
  if (/\b(sam|samedi)\b/.test(t)) return 6;
  if (/\b(dim|dimanche)\b/.test(t)) return 0;
  // Spanish
  if (/\b(lunes)\b/.test(t)) return 1;
  if (/\b(martes)\b/.test(t)) return 2;
  if (/\b(mi[eé]rcoles|miercoles)\b/.test(t)) return 3;
  if (/\b(jueves)\b/.test(t)) return 4;
  if (/\b(viernes)\b/.test(t)) return 5;
  if (/\b(s[aá]bado|sabado)\b/.test(t)) return 6;
  if (/\b(domingo)\b/.test(t)) return 0;
  // German
  if (/\b(mo|montag)\b/.test(t)) return 1;
  if (/\b(di|dienstag)\b/.test(t)) return 2;
  if (/\b(mi|mittwoch)\b/.test(t)) return 3;
  if (/\b(do|donnerstag)\b/.test(t)) return 4;
  if (/\b(fr|freitag)\b/.test(t)) return 5;
  if (/\b(sa|samstag)\b/.test(t)) return 6;
  if (/\b(so|sonntag)\b/.test(t)) return 0;
  // Portuguese
  if (/\b(segunda|seg)\b/.test(t)) return 1;
  if (/\b(ter[cç]a|ter)\b/.test(t)) return 2;
  if (/\b(quarta|qua)\b/.test(t)) return 3;
  if (/\b(quinta|qui)\b/.test(t)) return 4;
  if (/\b(sexta|sex)\b/.test(t)) return 5;
  if (/\b(s[aá]bado)\b/.test(t)) return 6;
  if (/\b(domingo|dom)\b/.test(t)) return 0;
  // Italian
  if (/\b(lunedì|lunedi)\b/.test(t)) return 1;
  if (/\b(martedì|martedi)\b/.test(t)) return 2;
  if (/\b(mercoledì|mercoledi)\b/.test(t)) return 3;
  if (/\b(giovedì|giovedi)\b/.test(t)) return 4;
  if (/\b(venerdì|venerdi)\b/.test(t)) return 5;
  if (/\b(sabato)\b/.test(t)) return 6;
  if (/\b(domenica)\b/.test(t)) return 0;
  return null;
}

function nextIsoForWeekday(now: Date, target: Weekday, tz: string = DEFAULT_TIMEZONE): string {
  const d = new Date(now);
  d.setHours(12, 0, 0, 0);
  const cur = d.getDay() as Weekday;
  let delta = (target - cur + 7) % 7;
  // If the user says "Friday" and today is Friday, assume today (delta=0)
  d.setDate(d.getDate() + delta);
  return isoDateInTimeZone(d, tz);
}

function resolvePlanningDate(input: string, now: Date, tz: string = DEFAULT_TIMEZONE): { iso: string; label: string; source: string } {
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

  // Multilingual "tomorrow" — resolve before weekday detection
  if (/\b(tomorrow|tmrw|tmr|2mrw|demain|ma[ñn]ana|morgen|amanhã|domani|завтра|明日|내일)\b/i.test(lower)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    const iso = isoDateInTimeZone(d, tz);
    const label = new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "short", day: "numeric" });
    return { iso, label, source: "tomorrow (multilingual)" };
  }

  // Multilingual "today/tonight"
  if (/\b(tonight|2nite|2day|ce soir|aujourd'hui|esta noche|hoy|heute|hoje|stasera|сегодня|今日|오늘)\b/i.test(lower)) {
    const iso = isoDateInTimeZone(now, tz);
    const label = new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "short", day: "numeric" });
    return { iso, label, source: "today/tonight (multilingual)" };
  }

  const weekdayNames = "mon|monday|tue|tues|tuesday|wed|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday|lun|lundi|mar|mardi|mer|mercredi|jeu|jeudi|ven|vendredi|sam|samedi|dim|dimanche|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|lunedì|martedì|mercoledì|giovedì|venerdì|sabato|domenica|segunda|ter[cç]a|quarta|quinta|sexta";
  const primaryKinds = "flight|meeting|call|appointment|interview|exam|quiz|deadline|due";

  // a) Keyword-tied weekday ("flight on Friday", "exam Friday", etc.)
  {
    const re = new RegExp(`\\b(?:${primaryKinds})\\b[^\\n\\.]{0,80}?\\b(?:on\\s+)?(${weekdayNames})\\b`, "i");
    const m = trimmed.match(re);
    const wd = m ? parseWeekdayToken(m[1]) : null;
    if (wd !== null) {
      const iso = nextIsoForWeekday(now, wd, tz);
      const label = new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "short", day: "numeric" });
      return { iso, label, source: "weekday (primary event)" };
    }
  }

  // b) Explicit "on <weekday>" reference
  {
    const m = trimmed.match(new RegExp(`\\bon\\s+(${weekdayNames})\\b`, "i"));
    const wd = m ? parseWeekdayToken(m[1]) : null;
    if (wd !== null) {
      const iso = nextIsoForWeekday(now, wd, tz);
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
      const iso = nextIsoForWeekday(now, wd, tz);
      const label = new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "short", day: "numeric" });
      return { iso, label, source: "weekday (last mention)" };
    }
  }

  // Default: today
  const iso = isoDateInTimeZone(now, tz);
  const label = new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "short", day: "numeric" });
  return { iso, label, source: "default today" };
}

type Plan = {
  detectedTasks: string[];
  assumptions: string[];
  priorities: string[];
  schedule: { time: string; plan: string[] }[];
  habit: { title: string; why: string; how: string };
  coach: string;
  personalInsight?: string;
  streak?: number;
  confidence?: number;    // 0.0–1.0 self-assessed by the model
  ambiguities?: string[]; // things the model had to guess
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
    // User's real timezone from browser (Intl.DateTimeFormat)
    const USER_TIMEZONE: string = typeof body?.timezone === "string" && body.timezone.length > 0 ? body.timezone : DEFAULT_TIMEZONE;
    // Recent history context — last 5 inputs the user has planned
    const recentHistory: string = typeof body?.recentHistory === "string" ? body.recentHistory : "";
    // Rich behavioural profile built from the user's full history
    const smartProfile: string = typeof body?.smartProfile === "string" ? body.smartProfile : "";
    // Special modes
    const isMutation: boolean = body?.mutation === true;
    const isBreakdown: boolean = body?.breakdown === true;
    const calendarBlocks: any[] = Array.isArray(body?.calendar) ? body.calendar : [];

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

    // ── MUTATION MODE: Natural language calendar edits ──────────────────────────────
    if (isMutation) {
      const nowTz = nowInTimeZone(USER_TIMEZONE);
      const todayIso = isoDateInTimeZone(nowTz, USER_TIMEZONE);

      const mutationSystem = `You are LifeOS, a calendar assistant. The user wants to edit their existing calendar events using natural language.

Given the user's instruction and their current calendar events, return a JSON object with an "operations" array.

Each operation has:
- "action": "update" | "delete"
- "id": the event ID to modify
- "patch": (only for "update") an object with any of: { "title": string, "date": string (YYYY-MM-DD), "startMin": number (minutes from 00:00), "endMin": number (minutes from 00:00) }

Today is: ${todayIso} (${USER_TIMEZONE})

LANGUAGE & INPUT UNIVERSALITY:
- The user may write in ANY language. Detect it automatically and interpret their instruction accordingly.
- Handle casual/abbreviated forms in any language (e.g. "déplace à 16h" in French = "move to 4 PM", "mover a las 4" in Spanish = "move to 4 PM", "verschiebe auf 16 Uhr" in German = "move to 4 PM").
- Mixed languages are valid (e.g. "move my reunión to tomorrow").
- Parse emojis as hints: 🗑️/❌ = delete/cancel, ✏️ = rename, ⏰/🕐 = time change.
- Voice-to-text artifacts ("um", "uh", filler words) should be ignored.
- ALL CAPS = emphasis only. "sooooon" = "soon".

TIME PARSING (any language/format):
- "4pm", "16:00", "16h", "16 Uhr", "4 o'clock" → startMin: 960
- "push back 30 min", "retrasa 30 minutos", "30 Minuten später" → add 30 to startMin and endMin
- "move to morning" → startMin: 540 (9 AM)
- "move to afternoon" → startMin: 780 (1 PM)
- "move to evening" → startMin: 1080 (6 PM)
- "tomorrow", "demain", "mañana", "morgen", "明日" → next day's date

RULES:
1. Match events by title similarity and/or time. Be flexible with approximate names and cross-language matches.
2. "move to 4pm" → startMin: 960, adjust endMin by same duration offset
3. "push back 30 minutes" → add 30 to both startMin and endMin
4. "cancel", "delete", "annuler", "eliminar", "löschen" → action: "delete"
5. "rename to X", "call it X", "renommer en X" → patch: { title: "X" }
6. Return ONLY valid JSON with the "operations" array. No markdown.
7. If no matching event found, return { "operations": [] }

Current calendar events:
${JSON.stringify(calendarBlocks.slice(0, 50).map((b: any) => ({ id: b.id, title: b.title, date: b.date, startMin: b.startMin, endMin: b.endMin })), null, 2)}`;

      const mutationUserPrompt = `User instruction: "${input}"`;

      const cc = await withTimeout(
        client.chat.completions.create({
          model: DEFAULT_MODEL,
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: mutationSystem },
            { role: "user", content: mutationUserPrompt },
          ],
        }),
        12000
      );

      const text = cc.choices?.[0]?.message?.content ?? "{}";
      const parsed = safeJsonParse(text);
      return NextResponse.json({ operations: Array.isArray(parsed?.operations) ? parsed.operations : [] });
    }

    // ── BREAKDOWN MODE: AI study plan milestones ────────────────────────────────────
    if (isBreakdown) {
      const nowTz = nowInTimeZone(USER_TIMEZONE);
      const todayIso = isoDateInTimeZone(nowTz, USER_TIMEZONE);

      const breakdownSystem = `You are LifeOS, a study planning assistant. Generate study milestone blocks for an assignment or project.

Given a task title and due date, return a JSON object with a "blocks" array of calendar blocks.

Each block has:
- "title": string — name of the milestone in the SAME language as the user's input (e.g. English: "Research", "Outline", "Draft", "Revision", "Final Review"; French: "Recherches", "Plan", "Brouillon", "Révision", "Relecture finale"; Spanish: "Investigación", "Esquema", "Borrador", "Revisión", "Repaso final")
- "date": string (YYYY-MM-DD) — schedule milestones in the days leading up to the due date
- "startMin": number (minutes from 00:00, e.g. 9*60=540 for 9 AM)
- "endMin": number (minutes from 00:00)

Today is: ${todayIso}. Schedule blocks starting from today, spread across the days before the due date.

LANGUAGE & INPUT UNIVERSALITY:
- Detect the user's language automatically from the task title/input.
- Return block titles in the SAME language as the user's input.
- Interpret task descriptions in any language (e.g. "dissertation de philo" = philosophy essay, "trabajo de historia" = history essay, "Hausarbeit" = term paper).
- Emojis in the task title are valid hints: 📚=research/study, ✏️=writing/draft, 🔬=lab/experiment.

RULES:
1. Create 4–6 milestone blocks (research, outline/plan, draft, revision, final check)
2. Space them evenly between today and the due date
3. Default session: 9 AM–10:30 AM (90 min) unless due date is very soon
4. If due date is tomorrow or today, create 2–3 blocks today
5. Return ONLY valid JSON. No markdown.`;

      const cc = await withTimeout(
        client.chat.completions.create({
          model: DEFAULT_MODEL,
          temperature: 0.3,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: breakdownSystem },
            { role: "user", content: input },
          ],
        }),
        12000
      );

      const text = cc.choices?.[0]?.message?.content ?? "{}";
      const parsed = safeJsonParse(text);
      return NextResponse.json({ blocks: Array.isArray(parsed?.blocks) ? parsed.blocks : [] });
    }

    const nowTz = nowInTimeZone(USER_TIMEZONE);
    const planning = resolvePlanningDate(input, nowTz, USER_TIMEZONE);
    const todayIso = isoDateInTimeZone(nowTz, USER_TIMEZONE);

    // ── FULL-DAY PLAN MODE ────────────────────────────────────────────────────────
    // Triggered when the input starts with our Day Plan Modal marker.
    // Uses a completely different, permissive prompt that builds a rich full-day
    // schedule and SKIPS the invented-lines filter (which would strip everything).
    const isFullDayPlan = input.startsWith("Plan my whole day today.");

    if (isFullDayPlan) {
      // Parse the structured fields out of the rich input string we built in the client
      const wakeMatch   = input.match(/wake up around (\S+)/i);
      const sleepMatch  = input.match(/go to bed around (\S+)/i);
      const energyMatch = input.match(/energy level is ([^.]+)\./i);
      const mustMatch   = input.match(/Things I must do today: ([^.]+)\./i);
      const niceMatch   = input.match(/Things I'd like to do if possible: ([^.]+)\./i);

      const wakeTime   = wakeMatch?.[1]  ?? "8am";
      const sleepTime  = sleepMatch?.[1] ?? "11pm";
      const energyDesc = energyMatch?.[1]?.trim() ?? "normal energy";
      const mustDo     = mustMatch?.[1]?.trim()   ?? "";
      const niceDo     = niceMatch?.[1]?.trim()   ?? "";

      // Derive energy tier for prompt logic
      const isLowEnergy  = energyDesc.includes("low");
      const isHighEnergy = energyDesc.includes("high");

      const fullDaySystem = `
You are LifeOS, a smart personal scheduling assistant. Your job is to build a COMPLETE, REALISTIC daily schedule for the user from wake-up to bedtime.

CRITICAL RULES:
1. Build a FULL DAY — include every time slot from wake to sleep. Do NOT leave large gaps.
2. ALWAYS include meals: Breakfast (shortly after waking), Lunch (~noon), Dinner (~6-7pm). Adjust times based on wake/sleep.
3. ALWAYS include a Morning Routine after waking (~30 min: brush teeth, get dressed, etc.).
4. ALWAYS include an Evening Wind-Down before sleep (~30 min: relax, prepare for tomorrow).
5. Add buffer/transition time between activities (10-15 min gaps are realistic).
6. Fit the user's MUST-DO items at logical times — respect any specific times they mentioned.
7. Fit the user's NICE-TO-HAVE items where they make sense in the day.
8. ENERGY LEVEL rules:
   ${isLowEnergy  ? "- LOW ENERGY: Schedule a 20-30 min afternoon nap (2-3pm). Keep workouts light or swap for a walk. Reduce screen time in the evening. Add extra rest/relaxation blocks." : ""}
   ${isHighEnergy ? "- HIGH ENERGY: Add an extra activity or challenge. Suggest a workout if not already present. Pack the morning with productive deep work. Add a bonus evening activity." : ""}
   ${!isLowEnergy && !isHighEnergy ? "- NORMAL ENERGY: Balanced mix of work, meals, activity, and rest. One workout or walk if not already mentioned." : ""}
9. Schedule.time MUST be exact clock times like "7:00 AM", "8:30 AM", "12:00 PM" — NOT vague buckets like "MORNING".
10. Each schedule entry should have exactly ONE activity in the plan array.
11. Return a schedule that covers EVERY hour of the day from wake to sleep — this is a full-day planner.

USER'S DAY PROFILE:
- Wake time: ${wakeTime}
- Bedtime: ${sleepTime}
- Energy level: ${energyDesc}
- Must-do items: ${mustDo || "none specified"}
- Nice-to-have: ${niceDo || "none"}

TODAY'S DATE: ${todayIso} (${USER_TIMEZONE})

EXAMPLE OF A GOOD FULL-DAY SCHEDULE (adapt to user's actual times):
7:00 AM → Morning Routine (brush teeth, get dressed, freshen up)
7:30 AM → Breakfast
8:00 AM → [Deep work / first must-do task]
10:00 AM → Short break / coffee
10:15 AM → [Continue work or next task]
12:00 PM → Lunch
1:00 PM → [Afternoon must-do or nice-to-have]
3:00 PM → [Snack / short walk / rest]
4:00 PM → [Another must-do or workout]
6:00 PM → Dinner
7:00 PM → [Evening activity / leisure / nice-to-have]
8:30 PM → Wind down (light reading, stretch, prepare for tomorrow)
10:30 PM → Bedtime

${preferenceContext ? `USER PREFERENCES (follow closely):\n${preferenceContext}` : ""}

Return JSON matching this EXACT schema — no extra keys, no markdown:
{
  "detectedTasks": string[],
  "assumptions": string[],
  "priorities": string[],
  "schedule": { "time": string, "plan": string[] }[],
  "habit": { "title": string, "why": string, "how": string },
  "coach": string,
  "personalInsight": string,
  "streak": number,
  "profile": null
}
`;

      const fullDayUserPrompt = `
Build a complete daily schedule for the user.

Wake time: ${wakeTime}
Bedtime: ${sleepTime}
Energy today: ${energyDesc}
Must do: ${mustDo || "nothing specific — build a great default day"}
Would like to: ${niceDo || "nothing specified"}
Date: ${todayIso}

Fill every hour from ${wakeTime} to ${sleepTime} with a realistic, personalized schedule. Include meals, a morning routine, transition time, and appropriate rest. Fit the must-do items at sensible times (respect any specific times mentioned). Add the nice-to-have items where they fit naturally.
`;

      let fullDayRaw: any;
      try {
        fullDayRaw = await withTimeout(
          client.chat.completions.create({
            model: DEFAULT_MODEL,
            temperature: 0.6,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: fullDaySystem },
              { role: "user",   content: fullDayUserPrompt },
            ],
          }),
          28_000
        );
      } catch (err: any) {
        return NextResponse.json(
          { error: `AI service error: ${err?.message ?? "Unknown error"}. Please try again.` },
          { status: 503 }
        );
      }

      let fullDayPlan: any;
      try {
        fullDayPlan = JSON.parse(fullDayRaw.choices?.[0]?.message?.content ?? "{}");
      } catch {
        return NextResponse.json({ error: "Failed to parse full-day plan from AI." }, { status: 500 });
      }

      // Normalize shape
      if (!Array.isArray(fullDayPlan.detectedTasks)) fullDayPlan.detectedTasks = ["Full day plan"];
      if (!Array.isArray(fullDayPlan.assumptions))   fullDayPlan.assumptions   = [`Wake: ${wakeTime}, Sleep: ${sleepTime}, Energy: ${energyDesc}`];
      if (!Array.isArray(fullDayPlan.priorities))     fullDayPlan.priorities    = mustDo ? mustDo.split(",").map((s: string) => s.trim()) : ["Great day"];
      if (!Array.isArray(fullDayPlan.schedule))       fullDayPlan.schedule      = [];
      if (typeof fullDayPlan.coach !== "string")      fullDayPlan.coach         = "Make today count!";
      if (typeof fullDayPlan.habit !== "object" || !fullDayPlan.habit)
        fullDayPlan.habit = { title: "Morning routine", why: "Sets the tone for the day", how: "Spend 10 min before breakfast to set intentions" };
      if (typeof fullDayPlan.personalInsight !== "string") fullDayPlan.personalInsight = "";
      fullDayPlan.streak  = 1;
      fullDayPlan.profile = null;

      // Ensure schedule items have correct shape — NO invented-lines filter for full-day plans
      fullDayPlan.schedule = fullDayPlan.schedule
        .filter((b: any) => b && typeof b === "object")
        .map((b: any) => ({
          time: typeof b.time === "string" ? b.time : "TODAY",
          plan: Array.isArray(b.plan) ? b.plan.filter((x: any) => typeof x === "string") : [],
        }))
        .filter((b: any) => b.plan.length > 0);

      // Prepend planning-date assumption
      const planningLine = `Planning date: ${todayIso} (Today, ${USER_TIMEZONE})`;
      if (!fullDayPlan.assumptions.some((a: any) => typeof a === "string" && a.toLowerCase().includes("planning date"))) {
        fullDayPlan.assumptions = [planningLine, ...fullDayPlan.assumptions];
      }

      return NextResponse.json(fullDayPlan);
    }
    // ── END FULL-DAY PLAN MODE ────────────────────────────────────────────────────

    // ── Pre-resolve all date references so the AI gets exact ISO dates ──────────────
    const tomorrowIso = (() => {
      const d = new Date(nowTz);
      d.setDate(d.getDate() + 1);
      return isoDateInTimeZone(d, USER_TIMEZONE);
    })();

    const weekdayNamesForResolution = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
    const resolvedDates: string[] = [];
    const inputLowerForDates = input.toLowerCase();

    for (let i = 0; i < weekdayNamesForResolution.length; i++) {
      const name = weekdayNamesForResolution[i];
      const short = name.slice(0, 3);
      if (inputLowerForDates.includes(name) || inputLowerForDates.includes(short)) {
        const iso = nextIsoForWeekday(nowTz, i as Weekday, USER_TIMEZONE);
        resolvedDates.push(`"${name}" = ${iso}`);
      }
    }
    if (/\b(today|tonight|this morning|this afternoon|this evening)\b/i.test(input)) {
      resolvedDates.push(`"today/tonight" = ${todayIso}`);
    }
    if (/\b(tomorrow|tmrw|tmr)\b/i.test(input)) {
      resolvedDates.push(`"tomorrow" = ${tomorrowIso}`);
    }

    const dateMapSection = resolvedDates.length > 0
      ? `DATE MAP (use these exact ISO dates — do NOT collapse multiple events onto one date):\n${resolvedDates.join("\n")}`
      : "";

    // ── STEP 1: Intent extraction (fast, low-temp) ────────────────────────────────
    // Ask the model to identify every event in plain language — no date maths yet.
    // This separates "what did the user mean?" from "when exactly?"
    const extractionSystem = `You are a calendar event extractor. Your only job is to identify every distinct event in the user's message and extract the raw scheduling information.

Return a JSON object:
{
  "events": [
    {
      "what": string,        // event title in user's own words
      "when_raw": string,    // verbatim day/time reference from user ("tomorrow night", "Friday at 6am", "this aft")
      "duration_raw": string, // verbatim duration ("2 hours", "30 min", "~1hr", "" if not mentioned)
      "notes": string        // any extra context ("before work", "with Sarah", "deadline = cutoff not start time")
    }
  ],
  "language": string         // detected language code, e.g. "en", "fr", "es"
}

RULES:
- Extract ALL distinct events, even if casually mentioned
- Preserve the user's exact wording for when_raw and duration_raw — do NOT interpret yet
- "due at midnight" → notes: "midnight is a deadline, NOT a start time. Schedule work beforehand."
- Emojis count: 💪=gym, ☕=coffee, ✈️=flight, 📚=study
- Multi-language inputs are valid — detect language and extract all events
- Return ONLY valid JSON. No markdown.`;

    const extractionUserPrompt = `User input: "${input}"`;

    let extractedEvents: Array<{ what: string; when_raw: string; duration_raw: string; notes: string }> = [];
    let detectedLanguage = "en";

    try {
      const extractionResult = await withTimeout(
        client.chat.completions.create({
          model: DEFAULT_MODEL,
          temperature: 0.1,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: extractionSystem },
            { role: "user", content: extractionUserPrompt },
          ],
        }),
        10000
      );
      const extractedRaw = safeJsonParse(extractionResult.choices?.[0]?.message?.content ?? "{}");
      extractedEvents = Array.isArray(extractedRaw?.events) ? extractedRaw.events : [];
      detectedLanguage = typeof extractedRaw?.language === "string" ? extractedRaw.language : "en";
    } catch {
      // Step 1 failure is non-fatal — Step 2 will still work from raw input
    }

    // ── FEW-SHOT EXAMPLES ─────────────────────────────────────────────────────────
    const FEW_SHOT_EXAMPLES = `
WORKED EXAMPLES (study these carefully):

Example 1:
Input: "Flight Friday at 6am, need to pack tomorrow night"
Today=Wednesday(2025-01-15), Tomorrow=2025-01-16, Friday=2025-01-17
→ schedule: [{ time:"6:00 AM", plan:["Flight"] }] on 2025-01-17, [{ time:"8:00 PM", plan:["Pack"] }] on 2025-01-16
RULE: "tomorrow" and "Friday" are DIFFERENT dates. Never collapse them.

Example 2:
Input: "dentist tmrw at half 3, then dinner w/ sarah fri 7ish"
Today=Wednesday, Tomorrow=2025-01-16, Friday=2025-01-17
→ Dentist on 2025-01-16 at 3:30 PM (90 min). Dinner with Sarah on 2025-01-17 at 7:00 PM (2 hrs).

Example 3:
Input: "essay due at midnight"
Today=2025-01-15
→ Essay work block on 2025-01-15, schedule 2:00 PM–6:00 PM. NEVER at 12:00 AM. Midnight = deadline cutoff.

Example 4:
Input: "💪 tmrw 7am"
→ Gym/Workout tomorrow at 7:00 AM (60 min default).

Example 5:
Input: "mañana gym a las 8, cenar con familia 8pm"
→ Gym tomorrow at 8:00 AM. Family dinner tomorrow at 8:00 PM. Respond in Spanish.

Example 6:
Input: "meeting w/ sarah mon 2pm for like an hour, study sesh tonight 2 hrs"
Today=Friday, Monday=next Monday's date, Tonight=today's date
→ Meeting with Sarah on Monday at 2:00 PM (60 min). Study session tonight at 8:00 PM (2 hrs).

Example 7:
Input: "gonna grab sushi w/ friends fri night ~7ish"
→ Dinner (sushi with friends) on Friday at 7:00 PM (~2 hrs). "gonna grab" = casual = dinner.
`;

    // ── RAG: inject relevant past calendar events for consistency ─────────────────
    const ragContext = (() => {
      const cal: any[] = Array.isArray(body?.calendarContext) ? body.calendarContext : [];
      if (!cal.length) return "";
      // Extract keywords from input to find relevant past events
      const words = input.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
      const relevant = cal
        .filter((b: any) => {
          if (!b?.title) return false;
          const t = b.title.toLowerCase();
          return words.some((w) => t.includes(w));
        })
        .sort((a: any, b: any) => (b.date ?? "").localeCompare(a.date ?? ""))
        .slice(0, 6);
      if (!relevant.length) return "";
      return `RELEVANT PAST EVENTS (use for scheduling consistency — e.g. if gym is always at 7 AM, keep that):
${relevant.map((b: any) => `- ${b.title} on ${b.date} at ${Math.floor(b.startMin/60)}:${String(b.startMin%60).padStart(2,"0")}`).join("\n")}`;
    })();

    // ── STEP 2: Full plan via TOOL CALLING ────────────────────────────────────────
    // Tool calling is more reliable than JSON prompting — the model is trained to
    // fill tool parameters correctly and cannot deviate from the schema.

    // ── STATIC system prompt (cacheable — doesn't change per-request) ─────────────
    const STATIC_SYSTEM = `You are LifeOS — a scheduling engine that thinks like a brilliant personal assistant.

You never guess wrong about dates silently. You flag uncertainty rather than assume.
You treat every input as if a real person typed it quickly on their phone.
You understand slang, abbreviations, every language, mixed languages, emojis, voice-to-text.

UNBREAKABLE RULES:
• Each event gets its OWN date. NEVER collapse multiple day references onto one date.
• "tomorrow" and any weekday are always different ISO dates.
• Midnight = deadline cutoff. Schedule WORK before it, never AT 12:00 AM.
• Only schedule what was asked. No invented commutes, showers, or prep.
• Lunch defaults to 12:00 PM. Dinner to 6:00 PM. Deadlines don't shift meals.
• "at 7" with evening context → 7 PM. With morning context → 7 AM.

DURATION DEFAULTS: gym=60, run=45, coffee=30, meeting=60, dinner=90, lunch=60, study=90, dentist=60, packing=60.

EMOJI MAP: 💪🏋️=gym, ☕=coffee(30m), 🍕🍔=meal(60m), 📚✏️=study, 🏃🚴🧘=exercise, 💊🏥=appointment, ✈️=flight, 🎮=gaming, 🎵=music.

ABBREV: tmrw=tomorrow, w/=with, b4=before, sesh=session, fam=family, aft=afternoon, eve=evening, ~X/Xish=approximately X, half N=N:30.

LANGUAGE: Detect user language. Return coach/habit/personalInsight in that language. JSON keys always English.

${FEW_SHOT_EXAMPLES}`;

    // ── DYNAMIC system context (changes per-request — not cached) ─────────────────
    const DYNAMIC_CONTEXT = [
      `DATE CONTEXT:`,
      `Timezone: ${USER_TIMEZONE}`,
      `Now: ${nowTz.toISOString()}`,
      `Today: ${todayIso}  |  Tomorrow: ${tomorrowIso}`,
      `Primary planning date: ${planning.iso} (${planning.label})`,
      dateMapSection,
      ragContext,
      preferenceContext ? `USER PREFERENCES:\n${preferenceContext}` : "",
      smartProfile,
      recentHistory ? `RECENT HISTORY (last 5 — personalise, avoid repeating):\n${recentHistory}` : "",
    ].filter(Boolean).join("\n\n");

    // ── Tool definition (schema-enforced — model cannot deviate) ──────────────────
    const planTool: any = {
      type: "function",
      function: {
        name: "create_plan",
        description: "Create a structured daily plan and calendar schedule from natural language input",
        parameters: {
          type: "object",
          properties: {
            detectedTasks: {
              type: "array", items: { type: "string" },
              description: "Short phrases for each task/event the user mentioned"
            },
            assumptions: {
              type: "array", items: { type: "string" },
              description: "All inferred details: duration guesses, AM/PM choices, date interpretations"
            },
            priorities: {
              type: "array", items: { type: "string" },
              description: "Top 1-3 priorities for this plan"
            },
            schedule: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  time: { type: "string", description: "Clock time like '7:00 AM' or bucket like 'MORNING'" },
                  plan: { type: "array", items: { type: "string" }, description: "Event titles for this time slot" }
                },
                required: ["time", "plan"]
              },
              description: "The full schedule — one entry per distinct event/time slot"
            },
            habit: {
              type: "object",
              properties: {
                title: { type: "string" },
                why: { type: "string" },
                how: { type: "string" }
              },
              required: ["title", "why", "how"],
              description: "One small habit suggestion relevant to today's activities"
            },
            coach: { type: "string", description: "Short punchy motivational message, directly relevant to what they're doing" },
            personalInsight: { type: "string", description: "1-2 sentences tied to their actual activity, not generic" },
            streak: { type: "number", description: "Streak count — use 1" },
            confidence: {
              type: "number",
              description: "0.0-1.0: how confident you are in the schedule. 1.0=certain, 0.6=guessed something, 0.3=multiple ambiguities"
            },
            ambiguities: {
              type: "array", items: { type: "string" },
              description: "Anything you had to guess: AM/PM choice, duration, which date, etc. Empty array if certain."
            }
          },
          required: ["detectedTasks","assumptions","priorities","schedule","habit","coach","personalInsight","streak","confidence","ambiguities"]
        }
      }
    };

    const userPrompt = `USER INPUT: "${input}"
${extractedEvents.length > 0 ? `\nPRE-EXTRACTED EVENTS (Step 1 guide — verify against raw input):\n${JSON.stringify(extractedEvents, null, 2)}` : ""}
Detected language: ${detectedLanguage}
CRITICAL: ${dateMapSection ? "Use DATE MAP above. Every event on its own date." : `Today is ${todayIso}.`} Do NOT collapse all events onto ${planning.iso}.`;

    let raw: any;
    try {
      const cc = await withTimeout(
        client.chat.completions.create({
          model: DEFAULT_MODEL,
          temperature: 0.3,
          tool_choice: { type: "function", function: { name: "create_plan" } },
          tools: [planTool],
          messages: [
            // Static prompt separated from dynamic context so caching applies to static part
            { role: "system", content: STATIC_SYSTEM },
            { role: "system", content: DYNAMIC_CONTEXT },
            { role: "user", content: userPrompt },
          ],
        }),
        25000
      );

      // Tool call response — parse from tool_calls, not message.content
      const toolCall = cc.choices?.[0]?.message?.tool_calls?.[0] as any;
      if (toolCall?.function?.arguments) {
        raw = safeJsonParse(toolCall.function.arguments);
      } else {
        // Fallback: try content if tool call not present
        raw = safeJsonParse(cc.choices?.[0]?.message?.content ?? "{}");
      }
    } catch (apiError: any) {
      console.error("OpenAI API Error:", {
        message: apiError?.message,
        status: apiError?.status,
        type: apiError?.type,
        model: DEFAULT_MODEL,
      });
      return NextResponse.json(
        {
          error: `AI service error: ${apiError?.message || "Unknown error"}. Please try again.`,
          details: apiError?.message,
        },
        { status: 500 }
      );
    }

    // ── STEP 3: Self-verification pass ────────────────────────────────────────────
    // The model audits its own output for the most common error class: date collapse.
    // Only runs when input mentions multiple distinct day references and confidence < 0.85.
    const hasMultipleDayRefs = resolvedDates.length >= 2;
    const shouldVerify = hasMultipleDayRefs && (typeof raw?.confidence !== "number" || raw.confidence < 0.85);

    if (shouldVerify && Array.isArray(raw?.schedule) && raw.schedule.length > 0) {
      try {
        const verifySystem = `You are a calendar plan auditor. Check the generated schedule for errors.

CHECKS:
1. DATE COLLAPSE: If the user mentioned multiple distinct days (e.g. "tomorrow" AND "Friday"), are events actually on different ISO dates? The schedule.time field alone doesn't tell you the date — look at the assumptions for "Planning date resolved" lines.
2. MIDNIGHT ERROR: Any event with a time between 12:00 AM and 1:00 AM when the user mentioned a "deadline" or "due at midnight"? That's wrong — it should be a work block earlier in the day.
3. INVENTED EVENTS: Any events in the schedule not mentioned in the original input?

${dateMapSection}

Return JSON: { "approved": boolean, "errors": string[] }
If no errors found, approved=true, errors=[].
Be strict but fair — only flag real mistakes.`;

        const verifyResult = await withTimeout(
          client.chat.completions.create({
            model: DEFAULT_MODEL,
            temperature: 0.0,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: verifySystem },
              { role: "user", content: `Original input: "${input}"\n\nGenerated plan:\n${JSON.stringify({ schedule: raw.schedule, assumptions: raw.assumptions }, null, 2)}` },
            ],
          }),
          8000
        );

        const verifyRaw = safeJsonParse(verifyResult.choices?.[0]?.message?.content ?? "{}");
        if (!verifyRaw?.approved && Array.isArray(verifyRaw?.errors) && verifyRaw.errors.length > 0) {
          // Verification found issues — add them to ambiguities so user sees warning
          const existingAmbiguities: string[] = Array.isArray(raw.ambiguities) ? raw.ambiguities : [];
          raw.ambiguities = [...existingAmbiguities, ...verifyRaw.errors.map((e: string) => `⚠️ ${e}`)];
          raw.confidence = Math.min(raw.confidence ?? 0.5, 0.6); // lower confidence
        }
      } catch {
        // Verification failure is non-fatal
      }
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
      coach: typeof raw?.coach === "string" ? raw.coach : "You've got this.",
      personalInsight:
        typeof raw?.personalInsight === "string" ? raw.personalInsight : "",
      streak: typeof raw?.streak === "number" ? raw.streak : 1,
      confidence: typeof raw?.confidence === "number" ? Math.min(1, Math.max(0, raw.confidence)) : undefined,
      ambiguities: Array.isArray(raw?.ambiguities) ? raw.ambiguities.filter((x: any) => typeof x === "string") : [],
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

    // --- FILTER: remove clearly hallucinated plan lines ---
    // Only strip lines that contain ZERO semantic overlap with the user's input.
    // We intentionally keep AI-generated context (e.g. "Study Session", "Work Block",
    // "Morning Routine") even if those exact words aren't in the input — they are
    // legitimate scheduling additions. We only remove lines that are completely
    // disconnected from anything the user mentioned.
    {
      const inputLower = String(input ?? "").toLowerCase();

      // Always-keep categories: meals, routines, generic scheduling terms the AI adds legitimately
      const alwaysKeep = [
        "lunch","dinner","breakfast","brunch","snack","meal",
        "morning routine","evening","wind down","break","buffer",
        "study","work","session","block","review","prep","practice",
        "gym","workout","exercise","run","walk","yoga","stretch",
        "sleep","rest","nap","bed",
        "commute","travel","transit",
        "flight","airport","boarding","pack","packing","check-in","check in","hotel","depart","departure","arrive","arrival",
      ];

      const keep = (line: string) => {
        const ll = line.toLowerCase();
        // Always keep common scheduling terms the AI legitimately adds
        if (alwaysKeep.some((k) => ll.includes(k))) return true;
        // Keep if any 4+ character word from the line appears in user input
        const words = ll.split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
        if (words.some((w) => inputLower.includes(w))) return true;
        // Keep if the line is short (likely a label, not an invented paragraph)
        if (line.trim().split(" ").length <= 4) return true;
        return false;
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

    void captureServerEvent("PlanGenerated", {
      scheduleItems: plan.schedule.length,
      hasDeadline: /\b(due|deadline|midnight)\b/i.test(input),
      hasMeals: /\b(lunch|dinner|breakfast)\b/i.test(input),
    });

    return NextResponse.json(plan);
  } catch (err: any) {
    const message =
      typeof err?.message === "string" ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
