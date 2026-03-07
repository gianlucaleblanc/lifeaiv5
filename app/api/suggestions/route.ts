import OpenAI from "openai";
import { NextResponse } from "next/server";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4o";

type Anchor = {
  date: string; // YYYY-MM-DD
  startMin: number;
  endMin: number;
  title: string;
  kind?: string;
};

type Suggested = {
  title: string;
  date: string;
  startMin: number;
  endMin: number;
  kind: string;
  reason?: string;
  anchorIndex?: number; // which anchor this suggestion is for
};

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function isIsoDate(s: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function normalizeSuggestions(raw: any, anchors: Anchor[] = [], maxPerAnchor = 3): Suggested[] {
  const arr = Array.isArray(raw?.suggestions) ? raw.suggestions : [];
  const out: Suggested[] = [];

  // Track how many suggestions we've emitted per anchor
  const anchorCount: Record<number, number> = {};
  const totalMax = Math.min(anchors.length * maxPerAnchor, 3);

  for (const it of arr) {
    if (!it || typeof it !== "object") continue;
    const title = String(it.title ?? "").trim();
    const date = String(it.date ?? "").trim();
    const kind = String(it.kind ?? "reminder").trim();

    let startMin = Number(it.startMin);
    let endMin = Number(it.endMin);

    if (!title || title.length < 2) continue;
    if (!isIsoDate(date)) continue;
    if (!Number.isFinite(startMin) || !Number.isFinite(endMin)) continue;

    startMin = clamp(Math.round(startMin), 0, 24 * 60 - 15);
    endMin = clamp(Math.round(endMin), startMin + 15, 24 * 60);

    // avoid ultra-early/late times unless user explicitly asked
    if (startMin < 6 * 60) startMin = 8 * 60;
    if (endMin < startMin + 15) endMin = startMin + 30;

    // ── HARD RULE: drop any suggestion that overlaps an anchor on the same date ──
    const overlapsAnchor = anchors.some(
      (a) => a.date === date && startMin < a.endMin && endMin > a.startMin
    );
    if (overlapsAnchor) continue;

    // Determine which anchor this suggestion belongs to (by proximity/date)
    let anchorIdx = it.anchorIndex;
    if (typeof anchorIdx !== "number" || anchorIdx < 0 || anchorIdx >= anchors.length) {
      // Infer by date + closest anchor
      const sameDate = anchors
        .map((a, i) => ({ a, i }))
        .filter(({ a }) => a.date === date);
      if (sameDate.length === 1) {
        anchorIdx = sameDate[0].i;
      } else if (sameDate.length > 1) {
        // Pick closest anchor in time
        anchorIdx = sameDate.reduce((best, { a, i }) => {
          const distBest = Math.min(
            Math.abs(startMin - anchors[best].startMin),
            Math.abs(startMin - anchors[best].endMin)
          );
          const distCur = Math.min(
            Math.abs(startMin - a.startMin),
            Math.abs(startMin - a.endMin)
          );
          return distCur < distBest ? i : best;
        }, sameDate[0].i);
      } else {
        anchorIdx = 0; // fallback
      }
    }

    // Per-anchor cap: don't let one anchor dominate
    if ((anchorCount[anchorIdx] ?? 0) >= maxPerAnchor) continue;
    anchorCount[anchorIdx] = (anchorCount[anchorIdx] ?? 0) + 1;

    out.push({
      title,
      date,
      startMin,
      endMin,
      kind: kind || "reminder",
      reason: typeof it.reason === "string" ? it.reason.slice(0, 140) : undefined,
      anchorIndex: anchorIdx,
    });

    if (out.length >= totalMax) break;
  }

  return out;
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const anchor = body?.anchor ?? null;
    const input = String(body?.input ?? "").slice(0, 2000);
    const anchors: Anchor[] = Array.isArray(body?.anchors) ? body.anchors.slice(0, 8) : [];
    const preferenceContext: string = typeof body?.preferenceContext === "string" ? body.preferenceContext : "";

    if (!input.trim()) {
      return NextResponse.json({ suggestions: [] });
    }

    const isMultiAnchor = anchors.length > 1;
    const maxPerAnchor = isMultiAnchor ? 2 : 3;

    // Build a detailed anchor list with index labels
    const anchorStr = anchors.length > 0
      ? anchors.map((a, i) =>
          `  [${i}] "${a.title}" on ${a.date} from ${a.startMin} to ${a.endMin} mins-from-midnight` +
          ` (${Math.floor(a.startMin/60)}:${String(a.startMin%60).padStart(2,"0")}–${Math.floor(a.endMin/60)}:${String(a.endMin%60).padStart(2,"0")})`
        ).join("\n")
      : "  (none provided)";

    // For multi-anchor: build per-anchor instruction blocks
    const perAnchorInstructions = isMultiAnchor
      ? [
          "",
          "══════════════════════════════════════════════════",
          `MULTI-EVENT MODE: You have ${anchors.length} anchor events to cover.`,
          "══════════════════════════════════════════════════",
          `You MUST produce ${maxPerAnchor} suggestions for EACH anchor event independently.`,
          `That means at least ${anchors.length * 2} suggestions total (2+ per anchor minimum).`,
          "",
          "For each anchor, output suggestions tagged with \"anchorIndex\": N (the bracket number above).",
          "Suggestions for different anchors must NOT overlap each other.",
          "Order all suggestions chronologically across the full day.",
          "",
          "EXAMPLE output structure for 2 anchors:",
          '  { "title": "Warm-up", "date": "2025-01-10", "startMin": 510, "endMin": 525, "kind": "prep", "anchorIndex": 0, "reason": "Before the run" }',
          '  { "title": "Cool-down stretch", "date": "2025-01-10", "startMin": 660, "endMin": 675, "kind": "follow-up", "anchorIndex": 0, "reason": "After the run" }',
          '  { "title": "Pre-workout snack", "date": "2025-01-10", "startMin": 1020, "endMin": 1040, "kind": "prep", "anchorIndex": 1, "reason": "Fuel before workout" }',
          '  { "title": "Post-workout shake", "date": "2025-01-10", "startMin": 1200, "endMin": 1220, "kind": "follow-up", "anchorIndex": 1, "reason": "Recovery after workout" }',
        ]
      : [];

    const system = [
      "You are an elite personal assistant AI with deep expertise in activity planning, time management, and understanding what people need before and after different types of events.",
      "",
      "The user has scheduled the following anchor event(s):",
      anchorStr,
      ...perAnchorInstructions,
      "",
      "═══════════════════════════════════════════",
      "RULE #1 — NEVER OVERLAP ANY ANCHOR EVENT",
      "═══════════════════════════════════════════",
      "Every suggestion's [startMin, endMin) window MUST NOT overlap ANY anchor's [startMin, endMin) window on the same date.",
      "- Prep tasks must END at or before the anchor's startMin",
      "- Follow-up tasks must START at or after the anchor's endMin",
      "- This rule is ABSOLUTE and overrides all other timing preferences.",
      "- Suggestions for different anchors must also NOT overlap each other.",
      "",
      "════════════════════════════════",
      "RULE #2 — CHRONOLOGICAL ORDER",
      "════════════════════════════════",
      "1. Prep tasks come BEFORE their anchor (ordered furthest-first)",
      "2. Follow-up tasks come AFTER their anchor (ordered soonest-first)",
      "3. NO suggestion may start at the same minute as any anchor starts.",
      "",
      "════════════════════════════════════════",
      "RULE #3 — REALISTIC, NON-OVERLAPPING SUGGESTIONS",
      "════════════════════════════════════════",
      "- Suggestions must not overlap EACH OTHER either.",
      "- Keep durations realistic: warmup 10-15min, meal 20-30min, packing 20-30min, travel 30-45min.",
      "- Chain tasks sequentially so each one ends before the next begins.",
      "",
      "EXAMPLE for 'Flight at 10:00 (startMin=600, endMin=720)':",
      "WRONG ✗  Leave for airport startMin=600  (overlaps anchor!)",
      "CORRECT ✓ Leave for airport startMin=420 endMin=465  (2h35min before, ends well before 600)",
      "CORRECT ✓ Airport security/check-in startMin=465 endMin=540  (ends 1hr before flight)",
      "CORRECT ✓ Gate wait / board startMin=540 endMin=600  (ends exactly at flight start)",
      "",
      "INTELLIGENT ACTIVITY UNDERSTANDING:",
      "",
      "**WORKOUTS/EXERCISE** (run, gym, workout, training, swim, bike, hike, yoga, sports):",
      "BEFORE (all must end ≤ anchor.startMin):",
      "- Pack gear/bag (night before, 12-18hrs before) — 20min",
      "- Pre-workout meal/snack (60-90min before anchor) — 20min",
      "- Hydrate (30min before anchor) — 5min",
      "- Warm-up routine (10-15min before anchor, must end BY anchor.startMin) — 15min",
      "AFTER (all must start ≥ anchor.endMin):",
      "- Cool-down/stretch (immediately after anchor.endMin) — 15min",
      "- Shower/clean up (15min after anchor.endMin) — 20min",
      "- Post-workout meal (45min after anchor.endMin) — 30min",
      "",
      "**TRAVEL** (flight, train, bus, trip):",
      "BEFORE (all must end ≤ anchor.startMin — anchor = departure time):",
      "- Pack bags (1-2 days before) — 30min",
      "- Check-in online (24hrs before) — 10min",
      "- Charge devices (night before) — 5min",
      "- Leave for airport: set endMin = anchor.startMin - 90 (arrive 90min before departure) — 45min drive",
      "  → Leave for airport startMin = anchor.startMin - 135, endMin = anchor.startMin - 90",
      "- Airport security & check-in: startMin = anchor.startMin - 90, endMin = anchor.startMin - 30",
      "- Gate wait / board: startMin = anchor.startMin - 30, endMin = anchor.startMin",
      "AFTER (all must start ≥ anchor.endMin):",
      "- Retrieve baggage: immediately after anchor.endMin — 20min",
      "- Ground transport to destination: anchor.endMin + 20 — 30min",
      "",
      "**MEDICAL/HEALTH** (doctor, dentist, therapy, checkup):",
      "BEFORE (must end ≤ anchor.startMin):",
      "- Gather medical records (1-2 days before) — 15min",
      "- List questions for doctor (day before) — 10min",
      "- Leave / travel to clinic (ends anchor.startMin - 15) — 20min",
      "- Arrive early for paperwork (anchor.startMin - 15, ends anchor.startMin) — 15min",
      "AFTER (must start ≥ anchor.endMin):",
      "- Pick up prescriptions — 20min",
      "- Schedule follow-up — 10min",
      "",
      "**INTERVIEWS** (job interview, college interview):",
      "BEFORE (must end ≤ anchor.startMin):",
      "- Research company (2-3 days before) — 60min",
      "- Prepare answers (day before) — 45min",
      "- Choose outfit (night before) — 15min",
      "- Review notes (morning of, ends anchor.startMin - 20) — 20min",
      "- Arrive early (anchor.startMin - 15, ends anchor.startMin) — 15min",
      "AFTER (must start ≥ anchor.endMin):",
      "- Send thank-you email (same day) — 15min",
      "",
      "**PRESENTATIONS** (pitch, demo, speech, performance):",
      "BEFORE (must end ≤ anchor.startMin):",
      "- Tech check (anchor.startMin - 90, ends anchor.startMin - 30) — 60min",
      "- Arrive early for setup (anchor.startMin - 30, ends anchor.startMin) — 30min",
      "AFTER (must start ≥ anchor.endMin):",
      "- Debrief/reflect — 20min",
      "",
      "**EXAMS/TESTS**:",
      "BEFORE (must end ≤ anchor.startMin):",
      "- Study session (days before) — 90min",
      "- Review notes (night before) — 45min",
      "- Light review (morning of, ends anchor.startMin - 15) — 20min",
      "- Arrive early (anchor.startMin - 15, ends anchor.startMin) — 15min",
      "AFTER (must start ≥ anchor.endMin):",
      "- Decompress/relax — 30min",
      "",
      "**SOCIAL EVENTS** (dinner, party, date, wedding):",
      "BEFORE (must end ≤ anchor.startMin):",
      "- Confirm reservation (day before) — 5min",
      "- Get ready/dress (anchor.startMin - 60, ends anchor.startMin - 10) — 50min",
      "- Travel to venue (anchor.startMin - 10, ends anchor.startMin) — 10min",
      "AFTER (must start ≥ anchor.endMin):",
      "- Send thank-you note (next day) — 10min",
      "",
      "**MEETINGS** (work meeting, call, video call):",
      "BEFORE (must end ≤ anchor.startMin):",
      "- Review agenda (morning of or day before) — 15min",
      "- Join early (anchor.startMin - 5, ends anchor.startMin) — 5min",
      "AFTER (must start ≥ anchor.endMin):",
      "- Send recap/notes — 15min",
      "",
      "TIMING INTELLIGENCE:",
      "- Always compute times as MINUTES FROM MIDNIGHT (e.g. 9am = 540, 2pm = 840)",
      "- Respect daily boundaries: 8am (480) to 10pm (1320)",
      "- Multi-day prep (pack, research) uses a prior date with a reasonable daytime hour",
      `- Return at most ${maxPerAnchor} suggestions per anchor event. Total output MUST NOT exceed 3 suggestions.`,
      "",
      "Return ONLY valid JSON: { suggestions: Suggested[] }",
      "",
      "Each Suggested:",
      "{",
      "  title: string (specific, actionable — 'Leave for airport' not 'Travel'),",
      "  date: string (YYYY-MM-DD),",
      "  startMin: number (minutes from midnight, integer),",
      "  endMin: number (minutes from midnight, integer, > startMin),",
      "  kind: string ('prep'|'follow-up'|'reminder'|'buffer'|'travel'),",
      "  reason: string (brief why, max 80 chars),",
      ...(isMultiAnchor ? ["  anchorIndex: number (0-based index of which anchor this is for)"] : []),
      "}",
      "",
      "CRITICAL: Return suggestions in PERFECT CHRONOLOGICAL ORDER (earliest date+startMin first).",
      ...(preferenceContext ? [
        "",
        "════════════════════════════════════════",
        "USER PREFERENCES (learned from feedback — follow these closely):",
        "════════════════════════════════════════",
        preferenceContext,
      ] : []),
    ].join("\n");

    const user = JSON.stringify({ input, anchors });

    const cc = await client.chat.completions.create({
      model: DEFAULT_MODEL,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });

    const rawText = cc.choices?.[0]?.message?.content ?? "{}";
    let raw: any = {};
    try {
      raw = JSON.parse(rawText);
    } catch {
      raw = {};
    }

    const suggestions = normalizeSuggestions(raw, anchors, maxPerAnchor);
    return NextResponse.json({ suggestions });
  } catch (e: any) {
    return NextResponse.json({ suggestions: [], error: e?.message ?? "failed" }, { status: 200 });
  }
}
