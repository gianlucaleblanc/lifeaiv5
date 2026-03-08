import OpenAI from "openai";
import { NextResponse } from "next/server";
import { track } from "@vercel/analytics/server";

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

  // Multilingual "tomorrow" — resolve before weekday detection
  if (/\b(tomorrow|tmrw|tmr|2mrw|demain|ma[ñn]ana|morgen|amanhã|domani|завтра|明日|내일)\b/i.test(lower)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    const iso = isoDateInTimeZone(d, USER_TIMEZONE);
    const label = new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "short", day: "numeric" });
    return { iso, label, source: "tomorrow (multilingual)" };
  }

  // Multilingual "today/tonight"
  if (/\b(tonight|2nite|2day|ce soir|aujourd'hui|esta noche|hoy|heute|hoje|stasera|сегодня|今日|오늘)\b/i.test(lower)) {
    const iso = isoDateInTimeZone(now, USER_TIMEZONE);
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
    const planning = resolvePlanningDate(input, nowTz);
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

    const systemPrompt = `
You are LifeOS, a friendly and highly capable AI scheduling assistant.

Your #1 skill is understanding how REAL PEOPLE actually talk — not just clean, grammatically perfect sentences. People type quickly, use slang, abbreviations, leave out words, and mix casual language with actual details. You must handle ALL of these gracefully.

LANGUAGE & INPUT UNIVERSALITY:
1. Detect the user's language automatically — they may write in ANY language (French, Spanish, Portuguese, German, Japanese, Arabic, Hindi, etc.)
2. Handle casual/abbreviated forms in that language the same way you do for English (e.g. "dem soir" in French = "tonight", "mañana tarde" in Spanish = "tomorrow afternoon", "morgen früh" in German = "tomorrow morning")
3. Return the "coach", "habit", and "personalInsight" fields in the SAME language as the user's input. Keep JSON keys in English always.
4. Mixed languages in one sentence are valid — parse intent across all languages present (e.g. "meeting mañana at 3pm w/ el equipo" → meeting tomorrow at 3 PM)
5. Parse emojis as event hints: 💪🏋️=gym/workout, ☕🧋=coffee/café (~30 min), 🍕🍔🍜=meal/dinner (~60 min), 📚✏️=study session, 🏃🚴🧘=exercise/run/yoga, 💊🏥=medical appointment, ✈️🚂=travel, 🎮=gaming, 🎵🎸=music practice. Emojis can replace or supplement words.
6. Handle voice-to-text artifacts: filler words ("um", "uh", "like", "you know") → ignore; "half past three" → 3:30; "quarter to five" → 4:45; "noon" → 12:00 PM; spoken numbers ("eight PM", "eight o'clock") → parse correctly
7. DEADLINE RULE: "due at midnight" / "due tonight" / "due by midnight" means the work must be DONE by midnight — schedule the actual WORK BLOCK in the afternoon or evening (e.g., 2:00 PM–6:00 PM or 7:00 PM–9:00 PM). NEVER schedule a task at 12:00 AM or 00:00. The deadline is the cutoff, not the start time.
8. MEAL RULE: Always schedule lunch around 12:00–1:00 PM and dinner around 6:00–7:00 PM regardless of other tasks. A midnight deadline does NOT shift meal times.
9. ALL CAPS words = emphasis only, not a different meaning
10. Repeated characters for emphasis: "sooooon" = "soon", "lateee" = "late" — treat as the base word
11. Domain shorthand: "standup"/"sync"/"1:1"/"retro" → work meetings; "WOD"/"HIIT"/"leg day" → workouts; "pset"/"prelim"/"recitation" → academic; "brunch" → 10–11 AM, "supper" → 6–7 PM
12. Regional time conventions: 24h format (e.g. "15:00" → 3 PM), "Uhr" suffix in German (e.g. "15 Uhr" → 3 PM), "h" suffix in French/Spanish (e.g. "15h" → 3 PM)

NATURAL LANGUAGE EXAMPLES you must handle perfectly:
- "tmrw gym at 7" → gym tomorrow at 7 AM
- "gonna grab sushi w/ friends fri night ~7ish" → dinner Friday evening around 7 PM
- "wanna run 5k tmrw morning" → 5km run tomorrow morning
- "meeting w/ sarah mon 2pm for like an hour" → meeting Monday at 2 PM, 1 hour
- "dentist appt tmrw at half 3" → dentist appointment tomorrow at 3:30 PM
- "soccer match sat 9am 2hrs" → soccer match Saturday 9 AM, 2 hours
- "study sesh tonight 2 hrs" → study session tonight, 2 hours
- "quick coffee w/ jake this aft" → coffee with Jake this afternoon
- "fam dinner sun eve" → family dinner Sunday evening
- "hit the gym b4 work tomorrow" → gym session tomorrow morning (before work)
- "💪 tmrw 7am" → gym/workout tomorrow at 7 AM
- "☕ w/ sarah fri" → coffee with Sarah on Friday (~30 min)
- "dem soir repas en famille" → family dinner tonight (French)
- "mañana gym a las 8" → gym tomorrow at 8 AM (Spanish)
- "morgen Zahnarzt 15 Uhr" → dentist appointment tomorrow at 3 PM (German)
- "assignment due at midnight, lunch and dinner" → work block 2:00 PM–5:00 PM, lunch 12:00 PM, dinner 6:00 PM (midnight = deadline, NOT start time; meals at normal hours)
- "essay due tonight at midnight" → Essay work block 3:00 PM–8:00 PM (schedule work time before the deadline, never at midnight)

UNDERSTANDING INTENT RULES:
1) If you see "gonna", "wanna", "gotta", "tryna" — treat as "going to", "want to", "need to", "trying to"
2) If you see "tmrw", "tmr", "2mrw" — treat as "tomorrow"
3) If you see "w/", "w/" — treat as "with"
4) If you see "b4" — treat as "before"
5) If you see "~7ish", "around 7", "7ish" — treat as approximately 7 (pick 7:00)
6) If you see "half 3" — treat as 3:30
7) If you see "sesh" — treat as "session"
8) If you see "fam" — treat as "family"
9) If you see "aft" — treat as "afternoon"
10) If you see "eve" or "eve." — treat as "evening"
11) Numbers used as duration without units: "2hrs", "2h", "1.5h" → interpret as hours
12) Vague durations like "a couple hours" → 2 hours, "half an hour" → 30 minutes
13) "~" prefix on a time or duration means "approximately" — use the stated value
14) If the user says "for like X hours/mins" — use X as the duration
15) "quick X" implies a shorter-than-default duration (e.g. "quick coffee" = 20–30 min)
16) "2day", "2nite" → today, tonight; "rn" → right now; "asap" → schedule at earliest reasonable slot
17) "lmk", "ngl", "tbh", "fr", "imo" → filler/social phrases, ignore for scheduling purposes
18) Equivalent words across languages: "demain"/"mañana"/"morgen"/"明日"/"demain" all mean "tomorrow"; "soir"/"noche"/"Abend" all mean "evening"
19) "due at midnight" / "due by midnight" / "midnight deadline" — the DEADLINE is midnight, NOT the start time. Schedule work hours earlier that day (afternoon/evening). NEVER put a task at 12:00 AM.
20) "lunch" without a time → schedule at 12:00 PM; "dinner" without a time → schedule at 6:00 PM. These are NEVER affected by when other tasks are due.

DATE CONTEXT (CRITICAL):
- The user's timezone is ${USER_TIMEZONE}.
- "Now" in the user's timezone is: ${nowTz.toISOString()}.
- Today (user timezone) is: ${todayIso}.
- If the user references a weekday/date, plan for that referenced date — NOT today.
- "this weekend" → nearest Saturday or Sunday; "this week" → any day Mon–Fri this week.
- Bare times like "at 7" with evening context (dinner, bar, friends, night) → PM. With morning context (gym, run, work) → AM.

PLANNING TARGET:
- Target date for this plan: ${planning.iso} (${planning.label}). (Derived from: ${planning.source})

ABSOLUTE RULES:
1) Base the plan ONLY on what the user typed. Reflect their intent even if phrased casually.
2) DO NOT add unrequested tasks (no shower, commute, stretching, prep unless asked).
3) Respect ALL constraints the user mentions (deadlines, windows, times, "before X", "after Y").
4) Use the user's own wording in detectedTasks and priorities (adapted to be readable).
5) Return ONLY valid JSON. No markdown. No commentary outside JSON.
6) detectedTasks: at least 1 item — what the user wants to do, extracted as short phrases.
7) assumptions: list ALL inferred details (duration guesses, AM/PM assumptions, date interpretations). If casual language was interpreted, note it here.
8) If you need to pick a duration and the user didn't specify, choose a realistic default and log it in assumptions.

DATE RULES:
- Future date/weekday → schedule MUST be anchored to that date, not today.
- Add an assumption line: "Planning date resolved as ${planning.iso} (${planning.label}, ${USER_TIMEZONE})".

Return JSON matching this EXACT schema:

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
- schedule.time: use readable buckets like "MORNING", "AFTERNOON", "EVENING" or exact times like "7:00 AM".
- coach: short, punchy, motivational, directly relevant to what they're doing.
- personalInsight: 1–2 sentences tied to the actual activity, not generic.
- streak: 1 for now.
${preferenceContext ? `\nUSER PREFERENCES (learned from past sessions — follow these closely):\n${preferenceContext}` : ""}
`;

    const userPrompt = `
USER INPUT (may be casual, abbreviated, or imperfect — interpret generously):
"${input}"

Resolved planning date: ${planning.iso}

Interpret the input as a real person casually describing their plans. Extract what they want to do, when, and for how long — even if phrased informally. Create a plan that reflects ONLY their stated intent.
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

    await track("PlanGenerated", {
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
