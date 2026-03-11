/**
 * nlp-preprocess.ts
 * ─────────────────────────────────────────────────────────────
 * Normalises casual / abbreviated natural-language input BEFORE
 * it is sent to the AI. Cleaning the text here means the model
 * sees fewer edge-cases and produces better structured output.
 *
 * This module is pure — no side-effects, no imports from storage.
 */

// ── Abbreviation / slang expansion ────────────────────────────
const SLANG_MAP: Array<[RegExp, string | ((...args: string[]) => string)]> = [
  // Temporal shorthands
  [/\btmrw\b|\btmr\b|\b2mrw\b/gi, "tomorrow"],
  [/\b2day\b|\btoday\b/gi, "today"],
  [/\b2nite\b|\btonite\b/gi, "tonight"],
  [/\brn\b/gi, "right now"],
  [/\basap\b/gi, "as soon as possible"],

  // Prepositions / particles
  [/\bw\/\s*/gi, "with "],
  [/\bb4\b/gi, "before"],
  [/\b4\b(?=\s+\w)/gi, "for"],   // "4 an hour" → "for an hour"

  // Contractions / fillers
  [/\bgonna\b/gi, "going to"],
  [/\bwanna\b/gi, "want to"],
  [/\bgotta\b/gi, "have to"],
  [/\btryna\b/gi, "trying to"],
  [/\bngl\b|\btbh\b|\bfr\b|\bimo\b|\blmk\b|\bbtw\b/gi, ""],  // social filler → strip
  [/\bum\b|\buh\b|\blike,?\b(?=\s)/gi, ""],                   // voice-to-text filler → strip

  // Duration shorthand
  [/\b(\d+(?:\.\d+)?)\s*hrs?\b/gi, "$1 hours"],
  [/\b(\d+(?:\.\d+)?)\s*h\b(?!\w)/gi, "$1 hours"],
  [/\b(\d+)\s*mins?\b/gi, "$1 minutes"],
  [/\ba\s+couple\s+(?:of\s+)?hours?\b/gi, "2 hours"],
  [/\bhalf\s+an?\s+hour\b/gi, "30 minutes"],
  [/\bquarter\s+(?:of\s+an?\s+)?hour\b/gi, "15 minutes"],

  // Approximate time markers
  [/~(\d)/g, "approximately $1"],
  [/\b(\d+)ish\b/gi, "approximately $1"],

  // Time-of-day phrases
  [/\bhalf\s+(\d+)\b/gi, "$1:30"],   // "half 3" → "3:30"
  [/\bquarter\s+to\s+(\d+)\b/gi, (_, h) => `${parseInt(h, 10) - 1}:45`],
  [/\bquarter\s+past\s+(\d+)\b/gi, "$1:15"],
  [/\bnoon\b/gi, "12:00 PM"],
  [/\bmidday\b/gi, "12:00 PM"],
  [/\bmidnight\b/gi, "midnight"],   // keep literal — AI needs to recognise it as a deadline

  // Vocabulary
  [/\bsesh\b/gi, "session"],
  [/\bfam\b/gi, "family"],
  [/\buff\b/gi, "afternoon"],
  [/\baft\b/gi, "afternoon"],
  [/\beve\b\.?/gi, "evening"],
  [/\bappt\b/gi, "appointment"],
  [/\bdr\.?\b(?=\s+[A-Z])/g, "doctor"],
  [/\bmtg\b/gi, "meeting"],
  [/\bcall\s+w\//gi, "call with"],
  [/\brsvp\b/gi, ""],               // not schedulable on its own

  // Punctuation cleanup (keep commas for multi-event parsing)
  [/\s{2,}/g, " "],
];

/**
 * Normalise free-text input for the AI.
 * Returns the cleaned string (and the original, for logging).
 */
export function preprocessInput(raw: string): { cleaned: string; original: string } {
  let s = raw.trim();
  for (const [pattern, replacement] of SLANG_MAP) {
    // TypeScript requires explicit cast for the overloaded String.prototype.replace
    s = s.replace(pattern, replacement as string);
  }
  // Collapse multiple spaces / leading-trailing whitespace
  s = s.replace(/\s{2,}/g, " ").trim();
  return { cleaned: s, original: raw };
}

// ── Spoken-number expansion (optional, for voice inputs) ──────
const SPOKEN_NUMBERS: Record<string, string> = {
  one: "1", two: "2", three: "3", four: "4", five: "5",
  six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  eleven: "11", twelve: "12",
};

export function expandSpokenNumbers(s: string): string {
  return s.replace(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b(?=\s*(am|pm|o'clock|hours?|minutes?|min))/gi,
    (_, word) => SPOKEN_NUMBERS[word.toLowerCase()] ?? word
  );
}

/**
 * Full pipeline: spoken-number expansion → slang normalisation.
 */
export function fullyPreprocess(raw: string): string {
  return preprocessInput(expandSpokenNumbers(raw)).cleaned;
}
