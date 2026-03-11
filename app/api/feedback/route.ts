import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { NextResponse } from "next/server";

const USE_CLAUDE = !!process.env.ANTHROPIC_API_KEY;
const DEFAULT_MODEL = USE_CLAUDE ? "claude-opus-4-5-20251101" : (process.env.OPENAI_MODEL || "gpt-4o");

async function callAI(system: string, user: string, maxTokens = 1024): Promise<string> {
  if (USE_CLAUDE) {
    const c = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const res = await c.messages.create({
      model: DEFAULT_MODEL, max_tokens: maxTokens, temperature: 1,
      system, messages: [{ role: "user", content: user }],
    });
    return (res.content?.[0] as any)?.text ?? "{}";
  }
  const c = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const res = await c.chat.completions.create({
    model: DEFAULT_MODEL, max_tokens: maxTokens, temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
  });
  return res.choices?.[0]?.message?.content ?? "{}";
}

// This route receives a batch of feedback entries + the current preferences,
// and asks the AI to distil them into updated preference notes.
// It runs after every feedback session (called client-side after submit).

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const { feedback, currentPreferences, sessionInput } = body;

    if (!Array.isArray(feedback) || feedback.length === 0) {
      return NextResponse.json({ preferences: currentPreferences ?? {} });
    }

    if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
      return NextResponse.json({ preferences: currentPreferences ?? {} }, { status: 200 });
    }

    // Format feedback for the prompt
    const feedbackLines = feedback.map((f: any) => {
      const hour = Math.floor((f.startMin ?? 0) / 60);
      const min = String((f.startMin ?? 0) % 60).padStart(2, "0");
      const dur = Math.round(((f.endMin ?? 0) - (f.startMin ?? 0)));
      return `- "${f.blockTitle}" (${f.blockKind}, ${hour}:${min}, ${dur}min) → ${f.signal.replace(/_/g, " ")}${f.note ? ` | note: "${f.note}"` : ""}`;
    }).join("\n");

    const existingNotes = Array.isArray(currentPreferences?.styleNotes)
      ? currentPreferences.styleNotes.join("\n")
      : "";

    const system = `You are a personal AI scheduling assistant that learns from user feedback to improve future plans.

Given a batch of feedback signals from the user, extract clear, actionable scheduling preferences.

Feedback signals:
- thumbs_up: user loved this block — note what they liked (time, type, duration)
- thumbs_down: user disliked this block — note what to avoid
- too_early: block was scheduled too early in the day
- too_late: block was scheduled too late in the day
- too_long: event duration was too long
- too_short: event duration was too short
- wrong_day: block was on wrong day
- not_relevant: suggestion wasn't relevant to them

Return a JSON object with ONLY these fields (all optional, only include if feedback clearly signals them):
{
  "preferredStartHour": number | null,       // earliest comfortable hour (e.g. 9)
  "preferredEndHour": number | null,          // latest comfortable hour (e.g. 21)
  "avoidedHours": number[],                   // hours to never schedule (e.g. [12, 13])
  "preferredDurations": { [eventKind: string]: number }, // durations in minutes
  "dislikedSuggestionKinds": string[],        // kinds to avoid suggesting
  "likedSuggestionKinds": string[],           // kinds to prioritize
  "styleNotes": string[]                      // 1-sentence plain-english notes, max 8 total, keep the best from existing + new
}

RULES:
- Only update fields that feedback CLEARLY supports. Don't invent preferences.
- styleNotes should be concise and actionable: "User prefers workouts before 9am", "User dislikes packing reminders", "User likes 45min run blocks"
- Merge with existing notes — keep the most useful, deduplicate, max 8 notes total
- If no clear signal for a field, omit it or return null/empty
- Return ONLY valid JSON, no markdown`;

    const user = `Existing preferences:\n${existingNotes || "(none yet)"}\n\nNew feedback from this session:\n${feedbackLines}\n\nOriginal prompt that generated these blocks: "${sessionInput ?? ""}"`;

    const rawText = await callAI(system, user, 1024);
    let updates: any = {};
    try { updates = JSON.parse(rawText); } catch { updates = {}; }

    // Merge with current preferences safely
    const merged = {
      ...currentPreferences,
      ...(updates.preferredStartHour !== undefined && { preferredStartHour: updates.preferredStartHour }),
      ...(updates.preferredEndHour !== undefined && { preferredEndHour: updates.preferredEndHour }),
      ...(Array.isArray(updates.avoidedHours) && { avoidedHours: updates.avoidedHours }),
      ...(updates.preferredDurations && typeof updates.preferredDurations === "object" && {
        preferredDurations: { ...(currentPreferences?.preferredDurations ?? {}), ...updates.preferredDurations },
      }),
      ...(Array.isArray(updates.dislikedSuggestionKinds) && { dislikedSuggestionKinds: updates.dislikedSuggestionKinds }),
      ...(Array.isArray(updates.likedSuggestionKinds) && { likedSuggestionKinds: updates.likedSuggestionKinds }),
      ...(Array.isArray(updates.styleNotes) && { styleNotes: updates.styleNotes.slice(0, 8) }),
      totalFeedbackSessions: (currentPreferences?.totalFeedbackSessions ?? 0) + 1,
      lastUpdated: new Date().toISOString(),
    };

    return NextResponse.json({ preferences: merged });
  } catch (e: any) {
    console.error("Feedback API error:", e?.message);
    return NextResponse.json({ preferences: {}, error: e?.message ?? "failed" }, { status: 200 });
  }
}
