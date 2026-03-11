/**
 * /api/plan/stream
 * ─────────────────────────────────────────────────────────────
 * Streaming variant of /api/plan.
 *
 * Uses OpenAI's streaming API to:
 * 1. Stream the coach message token-by-token (SSE events: type "coach")
 * 2. Emit the full plan JSON once complete (SSE event: type "plan")
 * 3. Emit a "done" event to signal completion
 *
 * Client usage:
 *   const es = new EventSource(url) — NOT used here (POST body needed)
 *   Use fetch + ReadableStream with getReader() instead.
 *
 * SSE format (each line):
 *   data: {"type":"coach","delta":"text chunk"}\n\n
 *   data: {"type":"plan","plan":{...}}\n\n
 *   data: {"type":"done"}\n\n
 *   data: {"type":"error","message":"..."}\n\n
 */

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const DEFAULT_TIMEZONE = "America/New_York";
const DEFAULT_MODEL = "claude-opus-4-5-20251101";

// ── Shared utilities (duplicated from route.ts to keep files independent) ──────

type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

function nowInTimeZone(tz: string): Date {
  const s = new Date().toLocaleString("en-US", { timeZone: tz });
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

function isoDateInTimeZone(date: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const iso = `${get("year")}-${get("month")}-${get("day")}`;
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

function nextIsoForWeekday(now: Date, target: Weekday, tz = DEFAULT_TIMEZONE): string {
  const d = new Date(now);
  d.setHours(12, 0, 0, 0);
  const cur = d.getDay() as Weekday;
  const delta = (target - cur + 7) % 7;
  d.setDate(d.getDate() + delta);
  return isoDateInTimeZone(d, tz);
}

function safeJsonParse(text: string): any {
  try { return JSON.parse(text); } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error("Model did not return valid JSON.");
  }
}

function isNonEmptyString(x: any): x is string {
  return typeof x === "string" && x.trim().length > 0;
}

function sseChunk(data: object): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

// ── POST handler ──────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return new Response(
      `data: ${JSON.stringify({ type: "error", message: "Missing ANTHROPIC_API_KEY" })}\n\n`,
      { status: 500, headers: { "Content-Type": "text/event-stream" } }
    );
  }

  let body: any;
  try { body = await req.json(); } catch { body = {}; }

  const input = body?.input;
  if (!isNonEmptyString(input)) {
    return new Response(
      `data: ${JSON.stringify({ type: "error", message: "Missing input" })}\n\n`,
      { status: 400, headers: { "Content-Type": "text/event-stream" } }
    );
  }

  const USER_TIMEZONE: string =
    typeof body?.timezone === "string" && body.timezone.length > 0
      ? body.timezone
      : DEFAULT_TIMEZONE;
  const preferenceContext: string =
    typeof body?.preferenceContext === "string" ? body.preferenceContext : "";
  const recentHistory: string =
    typeof body?.recentHistory === "string" ? body.recentHistory : "";
  const smartProfile: string =
    typeof body?.smartProfile === "string" ? body.smartProfile : "";

  const nowTz = nowInTimeZone(USER_TIMEZONE);
  const todayIso = isoDateInTimeZone(nowTz, USER_TIMEZONE);

  const tomorrowIso = (() => {
    const d = new Date(nowTz);
    d.setDate(d.getDate() + 1);
    return isoDateInTimeZone(d, USER_TIMEZONE);
  })();

  // Build DATE MAP
  const weekdayNames = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
  const resolvedDates: string[] = [];
  const inputLower = input.toLowerCase();
  for (let i = 0; i < weekdayNames.length; i++) {
    const name = weekdayNames[i];
    if (inputLower.includes(name) || inputLower.includes(name.slice(0, 3))) {
      resolvedDates.push(`"${name}" = ${nextIsoForWeekday(nowTz, i as Weekday, USER_TIMEZONE)}`);
    }
  }
  if (/\b(today|tonight)\b/i.test(input)) resolvedDates.push(`"today/tonight" = ${todayIso}`);
  if (/\b(tomorrow|tmrw|tmr)\b/i.test(input)) resolvedDates.push(`"tomorrow" = ${tomorrowIso}`);

  const dateMapSection = resolvedDates.length > 0
    ? `DATE MAP (use these exact ISO dates):\n${resolvedDates.join("\n")}`
    : "";

  // RAG context
  const ragContext = (() => {
    const cal: any[] = Array.isArray(body?.calendarContext) ? body.calendarContext : [];
    if (!cal.length) return "";
    const words = input.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
    const relevant = cal
      .filter((b: any) => b?.title && words.some((w) => b.title.toLowerCase().includes(w)))
      .sort((a: any, b: any) => (b.date ?? "").localeCompare(a.date ?? ""))
      .slice(0, 6);
    if (!relevant.length) return "";
    return `RELEVANT PAST EVENTS:\n${relevant.map((b: any) => `- ${b.title} on ${b.date} at ${Math.floor(b.startMin/60)}:${String(b.startMin%60).padStart(2,"0")}`).join("\n")}`;
  })();

  const STATIC_SYSTEM = `You are LifeOS — a scheduling engine that thinks like a brilliant personal assistant.

You never guess wrong about dates silently. You flag uncertainty rather than assume.
You treat every input as if a real person typed it quickly on their phone.
You understand slang, abbreviations, every language, mixed languages, emojis, voice-to-text.

UNBREAKABLE RULES:
• Each event gets its OWN date. NEVER collapse multiple day references onto one date.
• "tomorrow" and any weekday are always different ISO dates.
• Midnight = deadline cutoff. Schedule WORK before it, never AT 12:00 AM.
• Only schedule what was asked. No invented commutes, showers, or prep.

DURATION DEFAULTS: gym=60, run=45, coffee=30, meeting=60, dinner=90, lunch=60, study=90, dentist=60, packing=60.`;

  const DYNAMIC_CONTEXT = [
    `DATE CONTEXT:`,
    `Timezone: ${USER_TIMEZONE}`,
    `Today: ${todayIso}  |  Tomorrow: ${tomorrowIso}`,
    dateMapSection,
    ragContext,
    preferenceContext ? `USER PREFERENCES:\n${preferenceContext}` : "",
    smartProfile,
    recentHistory ? `RECENT HISTORY:\n${recentHistory}` : "",
  ].filter(Boolean).join("\n\n");

  const userPrompt = `USER INPUT: "${input}"
${dateMapSection ? `\nCRITICAL: Use DATE MAP above. Every event on its own date.` : `Today is ${todayIso}.`}`;

  // ── Create ReadableStream to pipe SSE chunks ─────────────────────────────────
  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (data: object) => controller.enqueue(sseChunk(data));

      try {
        // Phase 1: Stream the COACH message token-by-token for progressive display
        // Anthropic streaming uses stream() method with async iteration.
        const coachStream = client.messages.stream({
          model: DEFAULT_MODEL,
          max_tokens: 100,
          system: `${STATIC_SYSTEM}\n\n${DYNAMIC_CONTEXT}`,
          messages: [
            {
              role: "user",
              content: `${userPrompt}\n\nWrite ONLY a short, punchy, motivational coach message (1-2 sentences) directly about what the user is doing today. Be specific to their activity. No generic phrases. No JSON.`,
            },
          ],
        });

        let coachText = "";
        for await (const event of coachStream) {
          if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
            const delta = event.delta.text ?? "";
            if (delta) {
              coachText += delta;
              enqueue({ type: "coach", delta });
            }
          }
        }

        // Phase 2: Get the full structured plan via Anthropic tool use (non-streaming)
        const planTool: Anthropic.Tool = {
          name: "create_plan",
          description: "Create a structured daily plan and calendar schedule from natural language input",
          input_schema: {
            type: "object" as const,
            properties: {
              detectedTasks: { type: "array", items: { type: "string" } },
              assumptions:   { type: "array", items: { type: "string" } },
              priorities:    { type: "array", items: { type: "string" } },
              schedule: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    time: { type: "string" },
                    plan: { type: "array", items: { type: "string" } },
                  },
                  required: ["time", "plan"],
                },
              },
              habit: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  why:   { type: "string" },
                  how:   { type: "string" },
                },
                required: ["title", "why", "how"],
              },
              coach:          { type: "string" },
              personalInsight:{ type: "string" },
              streak:         { type: "number" },
              confidence:     { type: "number" },
              ambiguities:    { type: "array", items: { type: "string" } },
            },
            required: ["detectedTasks","assumptions","priorities","schedule","habit","coach","personalInsight","streak","confidence","ambiguities"],
          },
        };

        const planCall = await client.messages.create({
          model: DEFAULT_MODEL,
          max_tokens: 4096,
          temperature: 1,
          tool_choice: { type: "tool", name: "create_plan" },
          tools: [planTool],
          system: `${STATIC_SYSTEM}\n\n${DYNAMIC_CONTEXT}`,
          messages: [
            { role: "user", content: userPrompt },
          ],
        });

        const toolUseBlock = planCall.content?.find((b: any) => b.type === "tool_use") as any;
        let raw: any;
        if (toolUseBlock?.input) {
          raw = toolUseBlock.input;
        } else {
          const textBlock = planCall.content?.find((b: any) => b.type === "text") as any;
          raw = safeJsonParse(textBlock?.text ?? "{}");
        }

        // Override coach with the streamed version (more fluid, already shown to user)
        if (coachText.trim()) raw.coach = coachText.trim();

        // Normalise + emit
        const plan = {
          detectedTasks:   Array.isArray(raw?.detectedTasks)   ? raw.detectedTasks.filter((x: any) => typeof x === "string") : [],
          assumptions:     Array.isArray(raw?.assumptions)     ? raw.assumptions.filter((x: any) => typeof x === "string")   : [],
          priorities:      Array.isArray(raw?.priorities)      ? raw.priorities.filter((x: any) => typeof x === "string")    : [],
          schedule:        Array.isArray(raw?.schedule)
            ? raw.schedule.filter((b: any) => b && typeof b === "object").map((b: any) => ({
                time: typeof b.time === "string" ? b.time : "TODAY",
                plan: Array.isArray(b.plan) ? b.plan.filter((x: any) => typeof x === "string") : [],
              })).filter((b: any) => b.plan.length > 0)
            : [],
          habit:           raw?.habit && typeof raw.habit === "object"
            ? raw.habit
            : { title: "Tiny habit", why: "Build momentum.", how: "Do it for 2 minutes." },
          coach:           typeof raw?.coach === "string" ? raw.coach : "You've got this.",
          personalInsight: typeof raw?.personalInsight === "string" ? raw.personalInsight : "",
          streak:          typeof raw?.streak === "number" ? raw.streak : 1,
          confidence:      typeof raw?.confidence === "number" ? Math.min(1, Math.max(0, raw.confidence)) : undefined,
          ambiguities:     Array.isArray(raw?.ambiguities) ? raw.ambiguities.filter((x: any) => typeof x === "string") : [],
          profile:         null,
        };

        // Add planning date assumption
        const planningLine = `Planning date: ${todayIso} (Today, ${USER_TIMEZONE})`;
        if (!plan.assumptions.some((a: any) => String(a).toLowerCase().includes("planning date"))) {
          plan.assumptions = [planningLine, ...plan.assumptions];
        }

        enqueue({ type: "plan", plan });
        enqueue({ type: "done" });
      } catch (err: any) {
        enqueue({ type: "error", message: err?.message ?? "Unknown error" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
