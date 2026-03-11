import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { NextResponse } from "next/server";

// Lazy imports so the app can still boot even if the user hasn't run `npm install` yet.
// pdf-parse has a known issue where it tries to load a test file on import in some
// environments (Next.js App Router, Vercel, etc.) which causes a crash. We guard
// against this by wrapping the entire call and returning a clear JSON error instead
// of letting the crash bubble up as an HTML 500 page.
async function extractTextFromPdf(buf: Buffer): Promise<string> {
  try {
    const mod: any = await import("pdf-parse");
    const pdfParse = mod.default ?? mod;
    const out = await pdfParse(buf);
    return typeof out?.text === "string" ? out.text : "";
  } catch (e: any) {
    // Re-throw with a message that the caller can convert to a user-friendly error
    throw new Error(
      `PDF extraction failed: ${e?.message ?? "unknown error"}. ` +
      "Try exporting your syllabus as a DOCX from Google Docs or Word, or paste the text directly into the input box."
    );
  }
}

async function extractTextFromDocx(buf: Buffer): Promise<string> {
  const mod: any = await import("mammoth");
  const mammoth = mod.default ?? mod;
  const out = await mammoth.extractRawText({ buffer: buf });
  return typeof out?.value === "string" ? out.value : "";
}

const USE_CLAUDE = !!process.env.ANTHROPIC_API_KEY;
const DEFAULT_MODEL = USE_CLAUDE ? "claude-opus-4-6" : (process.env.OPENAI_MODEL || "gpt-4o");

async function callAI(system: string, user: string, maxTokens = 8192): Promise<string> {
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
    model: DEFAULT_MODEL, max_tokens: maxTokens, temperature: 0,
    response_format: { type: "json_object" },
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
  });
  return res.choices?.[0]?.message?.content ?? "{}";
}

function safeJsonParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error("Model did not return valid JSON.");
  }
}

async function withTimeout<T>(p: Promise<T>, ms = 45000): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("Timed out while processing the file. Try a smaller export, or upload the DOCX version if possible.")), ms)
    ),
  ]);
}

// Reduce very long syllabi to the lines most likely to contain dates/times.
// IMPORTANT: We use proportional sampling across document quarters so that
// late-semester events (weeks 12-16) are never starved by a dense early section.
function condenseForDates(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const dateish = /(\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b|\b\d{4}-\d{2}-\d{2}\b|\bmon\b|\btue\b|\bwed\b|\bthu\b|\bfri\b|\bsat\b|\bsun\b|\bdue\b|\bexam\b|\bquiz\b|\blecture\b|\bproject\b|\bassignment\b|\bjournal\b|\breading\b|\bsubmit\b|\bdeadline\b|\bhomework\b|\bpaper\b|\bdiscussion\b|\bweek\s*\d|\bmidterm\b|\bfinal\b|\bpresentation\b|\bactivity\b|\bmilestone\b|\bresponse\b|\breflection\b|\bannotation\b|\bworkshop\b)/i;

  // Step 1: collect ALL date-bearing line indices (no early exit cap).
  const allHitIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (dateish.test(lines[i])) allHitIdx.push(i);
  }

  // Step 2: divide the document into 4 equal quarters and allocate a budget per quarter.
  // Each quarter gets at most 350 of its date-bearing lines (plus ±2 context lines).
  // This prevents an early dense section from consuming the entire budget.
  const QUARTER_BUDGET = 350; // lines per quarter (4×350=1400 total, same as before)
  const quarterSize = Math.max(1, Math.ceil(lines.length / 4));
  const keepIdx = new Set<number>();

  for (let q = 0; q < 4; q++) {
    const qStart = q * quarterSize;
    const qEnd = Math.min(lines.length - 1, (q + 1) * quarterSize - 1);
    const qHits = allHitIdx.filter((i) => i >= qStart && i <= qEnd);
    // Evenly sample up to QUARTER_BUDGET hits from this quarter.
    const step = qHits.length <= QUARTER_BUDGET ? 1 : Math.ceil(qHits.length / QUARTER_BUDGET);
    for (let j = 0; j < qHits.length; j += step) {
      const i = qHits[j];
      keepIdx.add(i);
      if (i - 1 >= 0) keepIdx.add(i - 1);
      if (i - 2 >= 0) keepIdx.add(i - 2);
      if (i + 1 < lines.length) keepIdx.add(i + 1);
      if (i + 2 < lines.length) keepIdx.add(i + 2);
    }
  }

  const kept = Array.from(keepIdx)
    .sort((a, b) => a - b)
    .map((i) => lines[i]);

  // Fallback to the first chunk if heuristics keep too little.
  if (kept.join("\n").length < 2000) {
    return text.slice(0, 30000);
  }
  // Generous cap: 60k chars to give the AI more content to work with.
  return kept.join("\n").slice(0, 60000);
}

function detectSeasonYear(text: string): { season: "Spring" | "Summer" | "Fall" | "Winter"; year: number } | null {
  const m = text.match(/\b(Spring|Summer|Fall|Winter)\b\s*(20\d{2})/i);
  if (!m) return null;
  const season = (m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()) as any;
  const year = parseInt(m[2], 10);
  if (!Number.isFinite(year)) return null;
  return { season, year };
}

function detectSeasonYearFromFilename(filename: string): { season: "Spring" | "Summer" | "Fall" | "Winter"; year: number } | null {
  const base = String(filename ?? "");
  // Examples: FALL2025, Fall_2025, SPRING-2026, winter2024
  const m = base.match(/\b(Spring|Summer|Fall|Winter)[^0-9]{0,6}(20\d{2})\b/i);
  if (!m) return null;
  const season = (m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()) as any;
  const year = parseInt(m[2], 10);
  if (!Number.isFinite(year)) return null;
  return { season, year };
}

function looksGraded(title: string, kind?: string): boolean {
  // NOTE: `source` intentionally excluded — only title and kind should gate events,
  // never the source snippet, to avoid accidental keyword matches in citations.
  const t = (title ?? "").toLowerCase();
  const k = String(kind ?? "").toLowerCase();
  // Expand kind passlist to match every kind the AI schema allows.
  if ([
    "exam","quiz","assignment","project","paper","midterm","final",
    "journal","reading","discussion","review","presentation","other",
  ].some((x) => k.includes(x))) return true;
  // Title keyword list — covers every common academic assignment format.
  return [
    // Submission / deadline markers
    "due",
    "submit",
    "turn in",
    "upload",
    "post",
    "deadline",
    // Standard graded item types
    "assignment",
    "homework",
    "hw",
    "problem set",
    "pset",
    "lab report",
    "lab",
    "paper",
    "final paper",
    "quiz",
    "exam",
    "midterm",
    "final",
    "test",
    "dossier",
    "project",
    "presentation",
    "proposal",
    "draft",
    "outline",
    "bibliography",
    "peer review",
    "milestone",
    "checkpoint",
    // Reflection / response types (common in humanities/social sciences)
    "journal",
    "reading",
    "response",
    "reflection",
    "discussion",
    "annotation",
    "critique",
    "review",
    "case study",
    "field note",
    "portfolio",
    "log",
    "workshop",
    "exercise",
    "observation",
    "engagement",
    "activity",
    // Video / multimedia
    "video",
    "podcast",
    "recording",
  ].some((kw) => t.includes(kw));
}

function mostLikelyYear(text: string): number | null {
  // Pick the most common year token in the syllabus.
  const years = Array.from(text.matchAll(/\b(20\d{2})\b/g)).map((m) => parseInt(m[1], 10));
  if (years.length === 0) return null;
  const counts = new Map<number, number>();
  for (const y of years) counts.set(y, (counts.get(y) ?? 0) + 1);
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

function rewriteYear(iso: string, year: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  return `${year}-${iso.slice(5)}`;
}

function isoToDate(iso: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function dateToIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function weekdayShort(d: Date): "Sun"|"Mon"|"Tue"|"Wed"|"Thu"|"Fri"|"Sat" {
  return ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d.getDay()] as any;
}

function monthNameToNum(name: string): number | null {
  const n = name.toLowerCase();
  const map: Record<string, number> = {
    jan: 1, january: 1,
    feb: 2, february: 2,
    mar: 3, march: 3,
    apr: 4, april: 4,
    may: 5,
    jun: 6, june: 6,
    jul: 7, july: 7,
    aug: 8, august: 8,
    sep: 9, sept: 9, september: 9,
    oct: 10, october: 10,
    nov: 11, november: 11,
    dec: 12, december: 12,
  };
  return map[n] ?? null;
}

function extractExplicitClassMeetingDates(text: string, seasonYear: {season: any, year: number} | null): Set<string> {
  // Many syllabi include a list of the exact dates the class meets (often near the bottom).
  // We use this as a correctness check: recurring meetings are only generated on these dates.
  const lower = text.toLowerCase();
  // IMPORTANT: be conservative here.
  // Many syllabi contain an "Important Dates" / "Course Schedule" section that lists
  // exams, breaks, holidays, etc. Those are *not* an authoritative list of *every* class meeting.
  // If we treat them as authoritative, we incorrectly delete valid lecture meetings.
  // So we only trigger on phrases that strongly imply a full list of meeting dates.
  const triggers = [
    "class dates",
    "meeting dates",
    "dates class meets",
    "dates the class meets",
    "class meeting dates",
    "exact meeting dates",
  ];
  let startIdx = -1;
  for (const t of triggers) {
    const i = lower.lastIndexOf(t);
    if (i !== -1) { startIdx = Math.max(startIdx, i); }
  }
  // If we didn't find an explicit "full list of class meeting dates" section, do NOT
  // try to infer it from the last part of the syllabus. That heuristic caused us to
  // accidentally treat assignment/exam dates as "meeting dates" and then prune valid
  // lecture recurrences (e.g., removing Mondays when a quiz line mentions Wednesday).
  if (startIdx === -1) return new Set();

  const tail = text.slice(startIdx);
  const out = new Set<string>();

  // Match month-name dates like "Feb 3" or "February 3" (optional comma).
  const monthRe = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b\s*(\d{1,2})(?:,?\s*(20\d{2}))?/gi;
  for (const m of tail.matchAll(monthRe)) {
    const mon = monthNameToNum(m[1]);
    const day = parseInt(m[2], 10);
    if (!mon || !day) continue;
    const explicitYear = m[3] ? parseInt(m[3], 10) : null;
    const year = explicitYear ?? inferYearForMonthDay(mon, day, seasonYear);
    out.add(mmddToIso(mon, day, year));
  }

  // Match numeric dates like 9/1 or 09/01(/2025)
  const numRe = /\b(\d{1,2})\/(\d{1,2})(?:\/(20\d{2}))?\b/g;
  for (const m of tail.matchAll(numRe)) {
    const mon = parseInt(m[1], 10);
    const day = parseInt(m[2], 10);
    if (!mon || !day) continue;
    const explicitYear = m[3] ? parseInt(m[3], 10) : null;
    const year = explicitYear ?? inferYearForMonthDay(mon, day, seasonYear);
    out.add(mmddToIso(mon, day, year));
  }

  // Only treat this as an authoritative meeting list if it looks like a *full* semester list.
  // Otherwise, it's safer to return empty so we do NOT prune valid recurring lecture meetings.
  //
  // Heuristics:
  // - at least ~3 weeks worth of meetings (>= 12 distinct dates)
  // - the tail block is date-dense (most non-empty lines contain a date)
  if (out.size < 12) return new Set();

  const lines = tail.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < 8) return new Set();

  let dateLines = 0;
  for (const l of lines) {
    if (monthRe.test(l) || numRe.test(l)) dateLines += 1;
  }
  const density = dateLines / Math.max(1, lines.length);
  if (density < 0.55) return new Set();

  return out;
}

function parseCourseHeader(text: string): {
  course?: string;
  courseName?: string;
  season?: "Spring"|"Summer"|"Fall"|"Winter";
  year?: number;
  meetingDays?: Array<"Mon"|"Tue"|"Wed"|"Thu"|"Fri"|"Sat"|"Sun">;
  startTime?: string;
  endTime?: string;
  location?: string;
  sectionTimes?: Record<string, { startTime: string; endTime: string; meetingDays?: Array<"Mon"|"Tue"|"Wed"|"Thu"|"Fri"|"Sat"|"Sun"> }>;
} {
  const out: any = {};

  // Try multiple course-code formats (most specific first):
  // 1. "PSY 260E: Sports Psychology" (code + colon + name)
  // 2. "PSY 260E – Sports Psychology" / "PSY260E - Sports Psychology"
  // 3. "PSY 260E\nSports Psychology" (code on its own line, name on next)
  // 4. "Course: Sports Psychology" with code parsed separately
  const head8k = text.slice(0, 8000);

  // Room/building abbreviations that look like dept codes but are NOT course identifiers.
  // These appear in lines like "Bldg. 25 SEM 108" or "Room Ed. 25 SEM 110" and must be
  // excluded so we don't accidentally extract them as the course code.
  // We test the UPPERCASE-only prefix of the candidate (stripping any digits/suffixes).
  const ROOM_ABBREVS = new Set(["SEM","AUD","LAB","GYM","BLD","LEC","HLL","LIB","CLR",
    "REC","STU","ADM","OFF","FAC","WKS","BLDG","HALL","ROOM","BLDA","BLDB","BLDC"]);

  // Helper: returns true if a candidate course code looks like a room/building code.
  // e.g. "SEM 110" → prefix="SEM" → true; "COMM 340Ec" → prefix="COMM" → false.
  const isRoomCode = (code: string) => {
    const prefix = code.replace(/\s*\d[\w\-]*$/, "").trim(); // strip trailing " 108" or " 108E"
    return ROOM_ABBREVS.has(prefix.toUpperCase());
  };

  // Try to extract course code + name, skipping room-code false positives.
  // Pattern 1: "COMM 340Ec - Communication and Media..."  (separator on same line)
  // Pattern 2: "COMM 340Ec\nCommunication and Media..."   (name on next line)
  let foundCode = "";
  let foundName = "";

  // Pattern 1: code + inline separator + name
  {
    const rx = /\b([A-Z]{2,5}\s*\d{3,4}[A-Za-z0-9\-]{0,4})\s*[:\-–]\s*([^\n\r]{4,120}?)\s*(?:\n|$)/g;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(head8k)) !== null) {
      if (isRoomCode(m[1])) continue;
      const nameCandidate = (m[2] ?? "").trim();
      // Skip if "name" part is actually a room/location string
      if (/^\d|^(Bldg|Room|Ed\.\s*\d|Building|Floor)\b/i.test(nameCandidate)) continue;
      foundCode = normalize(m[1]);
      foundName = normalize(nameCandidate);
      break;
    }
  }

  // Pattern 2: code on its own line, name on next line
  if (!foundCode) {
    const rx = /\b([A-Z]{2,5}\s*\d{3,4}[A-Za-z0-9\-]{0,4})\s*\n+\s*([^\n\r]{4,120}?)\s*(?:\n|$)/gm;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(head8k)) !== null) {
      if (isRoomCode(m[1])) continue;
      const nameCandidate = (m[2] ?? "").trim();
      if (/^\d|^(Bldg|Room|Ed\.\s*\d|Building|Floor)\b/i.test(nameCandidate)) continue;
      foundCode = normalize(m[1]);
      foundName = normalize(nameCandidate);
      break;
    }
  }

  // Pattern 3: "PSY 260E General Sport Psychology" — code + space + title-case name, no separator.
  // Only triggers when the name starts with an uppercase letter (to avoid room codes like
  // "PSY 260E Group A 13:30"). We stop before time patterns, group/section labels, etc.
  if (!foundCode) {
    // Capture name up to: newline, digit (time starts), or Group/Section/Bldg keywords.
    const rx = /\b([A-Z]{2,5}\s*\d{3,4}[A-Za-z0-9\-]{0,4})\s+([A-Z][a-zA-Z ,:\-]{3,80}?)(?=\s*(?:\d|\n|Group\b|Section\b|Bldg\b|Room\b|Ed\.\b|Building\b|Floor\b|Spring\b|Fall\b|Summer\b|Winter\b|$))/g;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(head8k)) !== null) {
      if (isRoomCode(m[1])) continue;
      const nameCandidate = (m[2] ?? "").trim();
      // Reject obvious non-titles
      if (/^\d|^(Group|Section|Bldg|Room|Ed\.|Building|Floor|Spring|Fall|Summer|Winter)\b/i.test(nameCandidate)) continue;
      // Require at least 2 words (to avoid single-letter section like "PSY 260E A")
      if (nameCandidate.split(/\s+/).length < 2) continue;
      foundCode = normalize(m[1]);
      foundName = normalize(nameCandidate);
      break;
    }
  }

  if (foundCode) {
    out.course = foundCode;
    out.courseName = foundName;
  } else {
    // Fallback: extract just the course code (skip room codes)
    const allCodes = Array.from(head8k.matchAll(/\b([A-Z]{2,5}\s*\d{3,4}[A-Za-z0-9\-]{0,4})\b/g));
    const firstReal = allCodes.find(m => !isRoomCode(m[1]));
    if (firstReal) out.course = normalize(firstReal[1]);
    // Try to find a "Course Title:" or "Course Name:" label
    const titleLabel = head8k.match(/\b(?:course\s+(?:title|name)|title)\s*[:\-–]\s*([^\n\r]{4,120}?)\s*(?:\n|$)/i);
    if (titleLabel) out.courseName = normalize(titleLabel[1]);
  }

  const seasonYear = detectSeasonYear(text);
  if (seasonYear) {
    out.season = seasonYear.season;
    out.year = seasonYear.year;
  }

  // Section-specific times (common in syllabi)
  // Example:
  //   "Section A: 10:30 - 11:50"
  //   "Section B: 12:00 - 1:20"
  {
    const sectionTimes: Record<string, { startTime: string; endTime: string; meetingDays?: Array<"Mon"|"Tue"|"Wed"|"Thu"|"Fri"|"Sat"|"Sun"> }> = {};
    const parseTimeGuess24Local = (hhmm: string) => {
      const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
      if (!m) return null;
      let h = parseInt(m[1], 10);
      const min = m[2];
      // No AM/PM given → assume daytime classes.
      // 1–7 => PM (common), 8–11 => AM, 12 => PM
      if (h === 12) return `12:${min}`;
      if (h >= 1 && h <= 7) return `${String(h + 12).padStart(2, "0")}:${min}`;
      return `${String(h).padStart(2, "0")}:${min}`;
    };
    const rx = /\bSection\s+([A-Z])\s*:\s*(\d{1,2}:\d{2})\s*[–-]\s*(\d{1,2}:\d{2})\b/gi;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(text)) !== null) {
      const key = String(m[1] || "").toUpperCase();
      const start = m[2];
      const end = m[3];
      // The PDF often omits AM/PM; assume daytime times (handled by parseTimeGuess24 below).
      const start24 = parseTimeGuess24Local(start);
      const end24 = parseTimeGuess24Local(end);
      if (start24 && end24) {
        sectionTimes[key] = { startTime: start24, endTime: end24 };
      }
    }

    // Alternative formats, common in PDFs:
    // "Group A 13.30-14.50 pm" or "Section B 10.30-11.50am"
    const rx2 = /\b(?:Group|Section)\s+([A-Z])\s+(\d{1,2})[\.:](\d{2})\s*[–-]\s*(\d{1,2})[\.:](\d{2})\s*(AM|PM|am|pm)?\b/gi;
    while ((m = rx2.exec(text)) !== null) {
      const key = String(m[1] || "").toUpperCase();
      const sh = parseInt(m[2], 10);
      const sm = String(m[3] || "00").padStart(2, "0");
      const eh = parseInt(m[4], 10);
      const em = String(m[5] || "00").padStart(2, "0");
      const ap = String(m[6] || "").toUpperCase();

      const rawStart = `${sh}:${sm}`;
      const rawEnd = `${eh}:${em}`;

      const start24 = ap ? to24h(rawStart, ap) : (sh >= 13 ? `${String(sh).padStart(2, "0")}:${sm}` : parseTimeGuess24Local(rawStart));
      const end24 = ap ? to24h(rawEnd, ap) : (eh >= 13 ? `${String(eh).padStart(2, "0")}:${em}` : parseTimeGuess24Local(rawEnd));
      if (start24 && end24) {
        sectionTimes[key] = { startTime: start24, endTime: end24 };
      }
    }
    // Format: "Group D: Tue & Thu 13:30-14:50" or "Section A: Mon, Wed 10:30-11:50"
    // (days listed between the group label and the time)
    // Capture group 2 = the day tokens text, groups 3-6 = start/end time digits.
    const rx3 = /\b(?:Group|Section)\s+([A-Z])\s*:\s*([A-Za-z,&\s]{2,30}?)\s+(\d{1,2})[\.:](\d{2})\s*[–\-]\s*(\d{1,2})[\.:](\d{2})\b/gi;
    while ((m = rx3.exec(text)) !== null) {
      const key = String(m[1] || "").toUpperCase();
      if (sectionTimes[key]) continue; // already found via earlier regex
      const daysToken = String(m[2] || "").trim();
      const sh = parseInt(m[3], 10);
      const sm = String(m[4] || "00").padStart(2, "0");
      const eh = parseInt(m[5], 10);
      const em = String(m[6] || "00").padStart(2, "0");
      const start24 = sh >= 13 ? `${String(sh).padStart(2,"0")}:${sm}` : parseTimeGuess24Local(`${sh}:${sm}`);
      const end24 = eh >= 13 ? `${String(eh).padStart(2,"0")}:${em}` : parseTimeGuess24Local(`${eh}:${em}`);
      if (start24 && end24) {
        const parsedDays = parseDaysToken(daysToken);
        sectionTimes[key] = {
          startTime: start24,
          endTime: end24,
          ...(parsedDays.length > 0 ? { meetingDays: parsedDays } : {}),
        };
      }
    }

    if (Object.keys(sectionTimes).length > 0) out.sectionTimes = sectionTimes;
  }

  // Some syllabi list meeting DAYS separately from the meeting TIME (which may be tied to A/B sections).
  // We look for a short "Lectures:"/"Meets:" style line and extract days.
  {
    const head = text.slice(0, 8000);
    if (!out.meetingDays) {
      const lines = head.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      // Prefer lines that mention multiple days and are not office hours.
      for (const line of lines) {
        const low = line.toLowerCase();
        if (low.includes("office") && low.includes("hour")) continue;
        // Compact/common tokens: MWF, MF, MW, TTh, TR, Mon/Fri, etc.
        if (!/(\bmwf\b|\bmf\b|\bmw\b|\bwf\b|\btth\b|\btr\b|mon\b|monday|tue\b|tuesday|wed\b|wednesday|thu\b|thursday|fri\b|friday|sat\b|saturday|sun\b|sunday)/i.test(line)) continue;

        // Require at least two distinct days if we can.
        const days = parseDaysToken(line);
        if (days?.length && days.length >= 2) {
          out.meetingDays = days;
          break;
        }
      }

      // Fallback: if we still don't have days, accept a single-day match from a "meets:" style line.
      if (!out.meetingDays) {
        const mDays = head.match(/\b(?:lectures?|class(?:es)?|meets|days?)\b[^\n\r]{0,120}?(?:on\s+|:)\s*([A-Za-z\s\/,&-]{3,80})/i);
        if (mDays) {
          const days = parseDaysToken(mDays[1]);
          if (days?.length) out.meetingDays = days;
        }
      }
    }
  }

  // Meeting pattern (many formats). We try a few increasingly-permissive patterns.
  // Examples:
  // - "MWF 11:00 – 11:50AM, Room 203"
  // - "Tue/Thu 1:00-2:15 pm"
  // - "TTh 10:30 AM - 11:20 AM"
  // - "Mondays 18:00-19:15" (24h)
  // NOTE: Some syllabi format the days as a list before the time, e.g.
  //   "Mon. & Wed., 4:00-5:20pm"
  // which our simple patterns won't match because the time isn't immediately after the first day.
  // We handle that separately below.
  const patterns: RegExp[] = [
    // Handles both colon (13:30) and dot (13.30) time separators.
    // Ordered from most-specific (multi-day compact) to least-specific (single day).
    // Group 1 = day token(s), group 2 = start time, group 3 = start AM/PM,
    // group 4 = end time, group 5 = end AM/PM.
    /\b(MWF|MF|MW|WF|TTh|TR|Tue\/Thu|Tu\/Th|Mon\/Wed\/Fri|Mon\/Wed|Mon\/Fri|Mon\s*&\s*Fri|Mon\s*&\s*Wed|Wed\s*&\s*Fri|Tue\/Thu|Tue\s*&\s*Thu|Monday\s+(?:and\s+)?Wednesday|Monday\s+(?:and\s+)?Friday|Wednesday\s+(?:and\s+)?Friday|Tuesday\s+(?:and\s+)?Thursday|Mon|Tue|Wed|Thu|Fri|Sat|Sun|Mondays?|Tuesdays?|Wednesdays?|Thursdays?|Fridays?|Saturdays?|Sundays?)\b\s*(\d{1,2}[:.]\d{2})\s*(AM|PM)?\s*[–-]\s*(\d{1,2}[:.]\d{2})\s*(AM|PM)?\b[^\n\r]*?/i,
  ];

  const parseTimeGuess24 = (hhmm: string, ampm?: string | null) => {
    // Normalise dot-separator times: "13.30" → "13:30"
    const normalised = hhmm.replace(/^(\d{1,2})\.(\d{2})$/, "$1:$2");
    const m = normalised.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    let h = parseInt(m[1], 10);
    const min = m[2];
    const ap = (ampm ?? "").toUpperCase();
    if (ap === "AM" || ap === "PM") {
      return to24h(`${h}:${min}`, ap);
    }
    // No AM/PM given → assume daytime classes.
    // 1–7 => PM (common), 8–11 => AM, 12 => PM
    if (h === 12) return `12:${min}`;
    if (h >= 1 && h <= 7) return `${String(h + 12).padStart(2, "0")}:${min}`;
    return `${String(h).padStart(2, "0")}:${min}`;
  };

  for (const rx of patterns) {
    const meet = text.match(rx);
    if (!meet) continue;
    const daysToken = meet[1];
    const startRaw = meet[2];
    const startAp = meet[3] ?? null;
    const endRaw = meet[4];
    const endAp = meet[5] ?? startAp ?? null;

    const days = parseDaysToken(daysToken);
    const start = parseTimeGuess24(startRaw, startAp);
    const end = parseTimeGuess24(endRaw, endAp);
    if (!days?.length || !start) continue;

    // If we've already extracted a multi-day meeting pattern elsewhere (common when days are
    // listed separately), don't overwrite it with a weaker single-day token captured by this regex.
    const existingDays = Array.isArray(out.meetingDays) ? out.meetingDays : [];
    if (existingDays.length >= 2 && days.length < 2) {
      // keep existing
    } else {
      out.meetingDays = days;
    }
    out.startTime = start;
    out.endTime = end ?? undefined;
    break;
  }

  // Additional tolerant pattern: days list first, then a comma/semicolon, then time.
  // Examples:
  //  - "Mon. & Wed., 4:00-5:20pm"
  //  - "Tuesday and Thursday: 13:30-14:50"
  // This is intentionally constrained to the first chunk of the doc so we don't accidentally
  // parse office hours or random references.
  if (!out.startTime) {
    const head = text.slice(0, 12000);
    const lines = head.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    // Also accept dot-separator times like 13.30-14.50
    const timeRx = /(\d{1,2}[:.]\d{2})\s*(AM|PM|am|pm)?\s*[–-]\s*(\d{1,2}[:.]\d{2})\s*(AM|PM|am|pm)?/;
    for (const line of lines) {
      const low = line.toLowerCase();
      if (low.includes("office") && low.includes("hour")) continue;
      const tm = line.match(timeRx);
      if (!tm) continue;
      // Split around the time range, use the prefix as the day token.
      const idx = tm.index ?? -1;
      const prefix = idx >= 0 ? line.slice(0, idx) : line;
      // If there's a comma/colon right before the time, trim it.
      const dayToken = prefix.replace(/[,:;\s]+$/, "").trim();
      const days = parseDaysToken(dayToken);
      if (!days || days.length === 0) continue;

      const startRaw = tm[1];
      const startAp = tm[2] ?? null;
      const endRaw = tm[3];
      const endAp = tm[4] ?? startAp ?? null;
      const start = parseTimeGuess24(startRaw, startAp);
      const end = parseTimeGuess24(endRaw, endAp);
      if (!start) continue;
      out.meetingDays = days;
      out.startTime = start;
      out.endTime = end ?? undefined;
      break;
    }
  }
  return out;
}

function extractJournalDueItems(text: string, seasonYear: { season: any; year: number } | null, classStartTime?: string): any[] {
  // Goal: reliably catch items like "Submit Journal 1" that often appear in course schedules.
  // Many PDFs render tables where the DATE appears *before* the "Journal" text (sometimes on a different line).
  // Strategy:
  // 1) Find "journal" + a number (or range like 1-10)
  // 2) Look for a date token in a VERY wide context window around the match (both before & after)
  // 3) Line adjacency fallback for table-flattened PDFs (look ±5 lines)
  // 4) Section scan: if we find "journal" entries near dated schedule rows, match by proximity
  const out: any[] = [];

  const monthRe =
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b\s*(\d{1,2})(?:,?\s*(20\d{2}))?/gi;
  const numDateRe = /\b(\d{1,2})\/(\d{1,2})(?:\/(20\d{2}))?\b/;

  function findDateIsoInContext(ctx: string): string | null {
    // Try month-name date first (more reliable)
    const monthMatches = Array.from(ctx.matchAll(monthRe));
    for (const mm of monthMatches) {
      const mon = monthNameToNum(mm[1]);
      const day = parseInt(mm[2], 10);
      if (mon && day && day <= 31) {
        const explicitYear = mm[3] ? parseInt(mm[3], 10) : null;
        const y = explicitYear ?? inferYearForMonthDay(mon, day, seasonYear as any);
        return mmddToIso(mon, day, y);
      }
    }

    // Numeric date fallback
    const nn = ctx.match(numDateRe);
    if (nn) {
      const mon = parseInt(nn[1], 10);
      const day = parseInt(nn[2], 10);
      if (mon && mon <= 12 && day && day <= 31) {
        const explicitYear = nn[3] ? parseInt(nn[3], 10) : null;
        const y = explicitYear ?? inferYearForMonthDay(mon, day, seasonYear as any);
        return mmddToIso(mon, day, y);
      }
    }

    return null;
  }

  function pushJournal(jnum: number, dateIso: string, confidence: number, source: string) {
    const title = `Submit Journal ${jnum}`;
    // Dedupe by title ONLY — one entry per journal number regardless of which strategy found it.
    // If already found with higher confidence, skip. If lower confidence, replace.
    const existingIdx = out.findIndex((e) => String(e.title).toLowerCase() === title.toLowerCase());
    if (existingIdx !== -1) {
      if (confidence > (out[existingIdx].confidence ?? 0)) {
        // Higher confidence hit — replace
        out[existingIdx] = { title, date: dateIso, startTime: classStartTime, kind: "Assignment", confidence, source };
      }
      return;
    }
    out.push({
      title,
      date: dateIso,
      startTime: classStartTime,
      kind: "Assignment",
      confidence,
      source,
    });
  }

  // 1) Primary scan: broad context around each journal mention (very wide window)
  // Match patterns: "Journal 1", "Journal Entry 3", "JE 4", "Journal #5"
  const rx = /\b(?:journal\s*(?:entry)?|je)\s*#?\s*(\d{1,2})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(text)) !== null) {
    const jnum = parseInt(m[1], 10);
    if (!Number.isFinite(jnum) || jnum <= 0 || jnum > 30) continue;

    const idx = m.index ?? 0;
    // Wide context: 300 chars before, 400 chars after
    const ctx = text.slice(Math.max(0, idx - 300), Math.min(text.length, idx + 400));
    const dateIso = findDateIsoInContext(ctx);
    if (!dateIso) continue;

    const conf = /\b(submit|due|deadline|turn in|post)\b/i.test(ctx) ? 0.9 : 0.85;
    pushJournal(jnum, dateIso, conf, "journal due date (context window)");
  }

  // 2) Handle ranges: "Journal Entries 1-10" or "Journals 1-10 due Fridays"
  const rangeRx = /\b(?:journal\s*(?:entries|entry)?|je)\s*(?:#s?\s*)?(\d{1,2})\s*[-–to]+\s*(\d{1,2})\b/gi;
  while ((m = rangeRx.exec(text)) !== null) {
    const start = parseInt(m[1], 10);
    const end = parseInt(m[2], 10);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end > 30) continue;
    // If range journals are already found individually, skip
    const allFound = Array.from({length: end - start + 1}, (_, i) => start + i)
      .every((n) => out.some((e) => e.title === `Submit Journal ${n}`));
    if (allFound) continue;
    // Try to find dates associated with each journal in the range by scanning the schedule section
    // Look for "Fridays" patterns or week-by-week assignment schedule
    const idx = m.index ?? 0;
    const largectx = text.slice(Math.max(0, idx - 200), Math.min(text.length, idx + 2000));
    // Find all dates in this section
    const allDates: string[] = [];
    for (const dm of largectx.matchAll(monthRe)) {
      const mon = monthNameToNum(dm[1]);
      const day = parseInt(dm[2], 10);
      if (mon && day && day <= 31) {
        const y = dm[3] ? parseInt(dm[3], 10) : inferYearForMonthDay(mon, day, seasonYear as any);
        allDates.push(mmddToIso(mon, day, y));
      }
    }
    const uniqueDates = Array.from(new Set(allDates)).sort();
    const count = end - start + 1;
    if (uniqueDates.length >= count) {
      for (let i = 0; i < count; i++) {
        const n = start + i;
        if (!out.some((e) => e.title === `Submit Journal ${n}`)) {
          pushJournal(n, uniqueDates[i], 0.78, "journal range assignment");
        }
      }
    }
  }

  // 3) Fallback: line adjacency (table rows broken into lines) — look ±5 lines
  const lines = String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const jm = line.match(/\b(?:journal\s*(?:entry)?|je)\s*#?\s*(\d{1,2})\b/i);
    if (!jm) continue;
    const jnum = parseInt(jm[1], 10);
    if (!Number.isFinite(jnum) || jnum <= 0 || jnum > 30) continue;

    // Look at ±5 lines for date tokens (wider than before)
    const startLine = Math.max(0, i - 5);
    const endLine = Math.min(lines.length - 1, i + 5);
    const ctx = lines.slice(startLine, endLine + 1).join("  ");
    const dateIso = findDateIsoInContext(ctx);
    if (!dateIso) continue;
    pushJournal(jnum, dateIso, 0.83, "journal due date (adjacent lines)");
  }

  // 4) Schedule proximity scan: find date rows near journal mentions
  // For syllabi that have tables like: "Feb 14 | Chapter 5 | Journal 2"
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Check if this line has a date
    const dateIso = findDateIsoInContext(line);
    if (!dateIso) continue;

    // Look at nearby lines (current ±3) for journal mentions
    for (let j = Math.max(0, i - 3); j <= Math.min(lines.length - 1, i + 3); j++) {
      const nearby = lines[j];
      const jm = nearby.match(/\b(?:journal\s*(?:entry)?|je)\s*#?\s*(\d{1,2})\b/i);
      if (!jm) continue;
      const jnum = parseInt(jm[1], 10);
      if (!Number.isFinite(jnum) || jnum <= 0 || jnum > 30) continue;
      pushJournal(jnum, dateIso, 0.82, "journal due date (schedule row proximity)");
    }
  }

  return out;
}


// ── University holiday blackout ──────────────────────────────────────────────
// Returns true if the given ISO date falls within a known university break.
// Used to skip LECTURE generation on those dates.
// Graded/exam events are NEVER blocked — they still apply even during breaks.
//
// The periods below cover the most common Spanish-university breaks
// (Universidad Pablo de Olavide and similar Andalusian universities):
//   • Holy Week / Semana Santa  → Mon before Palm Sunday through Easter Sunday
//     Rule: Palm Sunday is the Sunday before Easter.
//     For 2025: Mar 30–Apr 13 (generous window — narrow per-year below).
//   • April Fair / Feria de Abril → usually the week starting 2 weeks after Easter.
//     For 2025: Apr 20–26 (Seville Feria).
//   • Christmas / New Year       → Dec 23–Jan 6 (conservative).
//   • US/generic Spring Break    → if a syllabus mentions "Spring Break" we also honour
//     any explicit dates, but since we're keyword-based on structure, we add a
//     generic Mar 10–21 window that can be overridden by explicit text.
//
// We keep this as a function so we can call it during lecture expansion.
// Build a set of ISO date strings that are "no class" days, derived from:
// 1. Dates explicitly extracted from the syllabus ("Spring Break: March 15-22", "No class April 3")
// 2. Universal fixed-calendar holidays (Christmas/New Year, which apply to all universities)
// 3. Easter/Holy Week — only applied when the syllabus itself mentions Holy Week or Semana Santa
//    (prevents silently dropping Good Friday for US universities that hold class).
// 4. Feria de Abril — ONLY applied when the syllabus explicitly mentions Feria/April Fair.
//    This is a Seville-specific break and must NOT be applied universally.
function buildNoClassDates(
  noClassRanges: Array<{ start: string; end: string }>,
  syllabusText: string,
  year: number
): Set<string> {
  const out = new Set<string>();

  // Helper: add all ISO dates in [startIso, endIso] inclusive to the set.
  function addRange(startIso: string, endIso: string): void {
    const s = isoToDate(startIso);
    const e = isoToDate(endIso);
    if (!s || !e) return;
    const cursor = new Date(s);
    cursor.setHours(12, 0, 0, 0);
    while (cursor.getTime() <= e.getTime()) {
      out.add(dateToIso(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  // 1. Syllabus-derived no-class ranges (highest priority, most accurate).
  for (const r of noClassRanges) {
    addRange(r.start, r.end);
  }

  // 2. Christmas / New Year: universally safe — no university holds class Dec 24 – Jan 1.
  // We use a narrow window to avoid over-blocking.
  for (let d = 24; d <= 31; d++) addRange(`${year}-12-${String(d).padStart(2,"0")}`, `${year}-12-${String(d).padStart(2,"0")}`);
  addRange(`${year}-01-01`, `${year}-01-01`);
  addRange(`${year + 1}-12-24`, `${year + 1}-12-31`);
  addRange(`${year + 1}-01-01`, `${year + 1}-01-01`);

  // Compute Easter Sunday for the given year (Gregorian algorithm).
  function easterSunday(yr: number): Date {
    const a = yr % 19;
    const b = Math.floor(yr / 100);
    const c = yr % 100;
    const dd = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - dd - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const mm2 = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * mm2 + 114) / 31);
    const day = ((h + l - 7 * mm2 + 114) % 31) + 1;
    const dt = new Date(`${yr}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}T12:00:00`);
    return dt;
  }

  const lowerText = syllabusText.toLowerCase();

  // 3. Holy Week (Palm Sunday – Easter Sunday) — only when syllabus mentions it.
  const mentionsHolyWeek = /\b(holy\s+week|semana\s+santa|palm\s+sunday|good\s+friday|easter\s+break|easter\s+holiday|easter\s+recess)\b/.test(lowerText);
  if (mentionsHolyWeek) {
    const easter = easterSunday(year);
    const palmSunday = new Date(easter);
    palmSunday.setDate(palmSunday.getDate() - 7);
    addRange(dateToIso(palmSunday), dateToIso(easter));
    // Also check for next year's Easter in case this is a Fall semester
    const easterNext = easterSunday(year + 1);
    const palmSundayNext = new Date(easterNext);
    palmSundayNext.setDate(palmSundayNext.getDate() - 7);
    addRange(dateToIso(palmSundayNext), dateToIso(easterNext));
  }

  // 4. Feria de Abril — ONLY when the syllabus explicitly mentions it.
  const mentionsFeria = /\b(feria\s+de\s+abril|april\s+fair|feria\s+de\s+sevilla|feria)\b/.test(lowerText);
  if (mentionsFeria) {
    const easter = easterSunday(year);
    const feriaStart = new Date(easter);
    feriaStart.setDate(feriaStart.getDate() + 13);
    const feriaEnd = new Date(easter);
    feriaEnd.setDate(feriaEnd.getDate() + 19);
    addRange(dateToIso(feriaStart), dateToIso(feriaEnd));
  }

  return out;
}

// Thin wrapper used in the lecture expansion loop.
// noClassDates is built once and passed in; this function simply does a set lookup.
function isUniversityHoliday(iso: string, noClassDates: Set<string>): boolean {
  return noClassDates.has(iso);
}

function inferDefaultTermRange(seasonHint: { season: "Spring"|"Summer"|"Fall"|"Winter", year: number } | null): { start: string; end: string } | null {
  if (!seasonHint) return null;
  const y = seasonHint.year;
  const make = (yy: number, mm: number, dd: number) => `${yy}-${String(mm).padStart(2,"0")}-${String(dd).padStart(2,"0")}`;
  if (seasonHint.season === "Spring") return { start: make(y, 1, 10), end: make(y, 5, 10) };
  if (seasonHint.season === "Summer") return { start: make(y, 5, 15), end: make(y, 8, 10) };
  if (seasonHint.season === "Fall") return { start: make(y, 8, 20), end: make(y, 12, 10) };
  if (seasonHint.season === "Winter") return { start: make(y, 12, 15), end: make(y + 1, 1, 20) };
  return null;
}

function normalize(s: string) {
  return String(s ?? "").trim().replace(/\s+/g, " ");
}

function parseDaysToken(token: string): Array<"Mon"|"Tue"|"Wed"|"Thu"|"Fri"|"Sat"|"Sun"> {
  const t = token.toLowerCase().trim();
  const days: Array<any> = [];
  const add = (d: any) => { if (!days.includes(d)) days.push(d); };

  // ── Compact multi-day tokens (must come first — most specific) ─────────────
  // MWF / Mon-Wed-Fri / Mon/Wed/Fri / Monday Wednesday Friday
  if (/\bmwf\b/.test(t) || /mon\s*[\/\-&,]\s*wed\s*[\/\-&,]\s*fri/.test(t) ||
      /monday[,\s]+wednesday[,\s]+friday/.test(t)) {
    add("Mon"); add("Wed"); add("Fri"); return days;
  }
  // TTh / TR / Tue-Thu / Tu/Th / Tuesday Thursday
  if (/\b(tth|tr)\b/.test(t) || /tue\s*[\/\-&]\s*thu/.test(t) || /tu\s*[\/\-&]\s*th\b/.test(t) ||
      /tuesday[,\s&]+thursday/.test(t) || /\btu\s*th\b/.test(t)) {
    add("Tue"); add("Thu"); return days;
  }
  // MF / M/F / M-F / Mon/Fri / Mon-Fri / Mon & Fri / Monday and Friday / Monday/Friday
  if (/\bmf\b/.test(t) || /\bm\s*\/\s*f\b/.test(t) || /\bm\s*-\s*f\b/.test(t) ||
      /mon\s*[\/\-&]\s*fri/.test(t) || /monday\s*(and|&|\/)\s*friday/.test(t)) {
    add("Mon"); add("Fri"); return days;
  }
  // MW / M/W / Mon/Wed / Mon-Wed / Mon & Wed / Monday and Wednesday / Mon. & Wed.
  if (/\bmw\b/.test(t) || /\bm\s*\/\s*w\b/.test(t) ||
      /mon\.?\s*[\/\-&]\s*wed\.?/.test(t) || /monday\s*(and|&|\/)\s*wednesday/.test(t)) {
    add("Mon"); add("Wed"); return days;
  }
  // WF / W/F / Wed/Fri / Wed & Fri / Wednesday and Friday
  if (/\bwf\b/.test(t) || /\bw\s*\/\s*f\b/.test(t) ||
      /wed\s*[\/\-&]\s*fri/.test(t) || /wednesday\s*(and|&|\/)\s*friday/.test(t)) {
    add("Wed"); add("Fri"); return days;
  }

  // ── Full/abbreviated word days ─────────────────────────────────────────────
  // (avoid single-letter matches that cause false positives)
  // Note: trailing dot supported to handle "Mon." / "Wed." abbreviations in syllabi
  // like "Mon. & Wed., 4:00-5:20pm"
  if (/\bmon(day)?s?\.?\b/.test(t)) add("Mon");
  if (/\b(tue|tues|tuesday|tuesdays|tu)\.?\b/.test(t)) add("Tue");
  if (/\bwed(nesday)?s?\.?\b/.test(t)) add("Wed");
  if (/\bthu(rsday)?s?\.?\b/.test(t) || /\bthurs\.?\b/.test(t)) add("Thu");
  if (/\bfri(day)?s?\.?\b/.test(t)) add("Fri");
  if (/\bsat(urday)?s?\.?\b/.test(t)) add("Sat");
  if (/\bsun(day)?s?\.?\b/.test(t)) add("Sun");

  // If we can't confidently determine days, return empty and let downstream logic infer
  // from concrete dates (e.g., the first meeting date) rather than guessing.
  return days;
}

function to24h(hhmm: string, ampm: string): string {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return hhmm;
  let h = parseInt(m[1], 10);
  const min = m[2];
  const ap = String(ampm ?? "").toUpperCase();
  // IMPORTANT: Some PDFs already express time in 24h even if they add an AM/PM token
  // (e.g., "13:30 pm" or "13.30-14.50 pm").
  // In those cases, we must NOT add 12 again.
  if (ap === "AM") {
    if (h === 12) h = 0;
  } else if (ap === "PM") {
    if (h < 12) h += 12;
  }
  return `${String(h).padStart(2, "0")}:${min}`;
}

function inferYearForMonthDay(month: number, day: number, seasonYear: {season: any, year: number} | null): number {
  if (!seasonYear) return new Date().getFullYear();
  if (seasonYear.season === "Fall") return month >= 7 ? seasonYear.year : seasonYear.year + 1;
  if (seasonYear.season === "Spring") return seasonYear.year;
  if (seasonYear.season === "Summer") return seasonYear.year;
  if (seasonYear.season === "Winter") return month === 12 ? seasonYear.year - 1 : seasonYear.year;
  return seasonYear.year;
}

function mmddToIso(month: number, day: number, year: number): string {
  return `${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
}

function extractTableLikeDueItems(text: string, seasonYear: {season: any, year: number} | null, classStartTime?: string): any[] {
  // Heuristic: many DOCX exports flatten the course schedule table into text that still
  // contains patterns like "M, 9/1" plus nearby "Dossier 1" in a "Due Today" column.
  const out: any[] = [];
  const re = /\b([MTWFS])\s*,\s*(\d{1,2})\/(\d{1,2})\b([\s\S]{0,220})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const month = parseInt(m[2], 10);
    const day = parseInt(m[3], 10);
    if (!month || !day) continue;
    const year = inferYearForMonthDay(month, day, seasonYear);
    const date = mmddToIso(month, day, year);
    const window = m[4] ?? "";

    // Extract multiple "Due Today" items near this row.
    const candidates = window.match(/\b(Dossier\s*\d+|Quiz\s*(?:One|Two|Three|\d+)|Final\s+Paper(?:\s*Part\s*\d+|\s*\d+)?|Research\s*Paper(?:,?\s*Draft\s*\d+)?|Paper\s*(?:Part\s*\d+|\s*\d+)?|Draft\s*Abstract|Abstract\s*Draft|Abstract|Proposal|Bibliography|Outline|Draft\s*\d+|Peer\s*Review|Presentation(?:s)?)\b/gi) ?? [];
    for (const c of candidates) {
      const title = normalize(c);
      if (!title) continue;
      // Avoid duplicates
      if (out.some((e) => e.date === date && e.title.toLowerCase() === title.toLowerCase())) continue;
      const kind = /quiz/i.test(title) ? "Quiz" : /dossier/i.test(title) ? "Assignment" : /research\s*paper/i.test(title) ? "Project" : "Other";
      out.push({
        title,
        date,
        startTime: classStartTime,
        kind,
        confidence: 0.85,
        source: "course schedule table",
      });
    }
  }

  // Also catch explicit final due date lines (often outside the table).
  const final = text.match(/Research\s*Paper\s*:\s*\w+\s*,\s*(\w+)\s+(\d{1,2})\s*,\s*(\d{1,2}:\d{2})\s*(AM|PM)/i);
  if (final && seasonYear) {
    const monthName = final[1].toLowerCase();
    const day = parseInt(final[2], 10);
    const time = final[3];
    const ap = final[4].toUpperCase();
    const monthMap: any = { january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12 };
    const month = monthMap[monthName];
    if (month && day) {
      const year = inferYearForMonthDay(month, day, seasonYear);
      out.push({
        title: "Research Paper Due",
        date: mmddToIso(month, day, year),
        startTime: to24h(time, ap),
        kind: "Project",
        confidence: 0.9,
        source: "research paper due line",
      });
    }
  }

  return out;
}

function extractCourseScheduleLectures(
  text: string,
  seasonYear: {season: any, year: number} | null,
  classStartTime?: string,
  classEndTime?: string
): any[] {
  // Many syllabi include a "Course: Dates Topic Readings" style schedule that is flattened into
  // plain text. We want to import ALL lectures (dates + topics) while stripping readings/citations
  // so the calendar stays clean.
  const out: any[] = [];

  const monthRe = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b\s+(\d{1,2})\b/gi;
  const monthMap: Record<string, number> = {
    jan: 1,
    january: 1,
    feb: 2,
    february: 2,
    mar: 3,
    march: 3,
    apr: 4,
    april: 4,
    may: 5,
    jun: 6,
    june: 6,
    jul: 7,
    july: 7,
    aug: 8,
    august: 8,
    sep: 9,
    sept: 9,
    september: 9,
    oct: 10,
    october: 10,
    nov: 11,
    november: 11,
    dec: 12,
    december: 12,
  };

  // Only look at the portion that appears to be a *lecture/topic table* to avoid accidentally
  // turning "Important dates" into lectures.
  // NOTE: Do NOT anchor on generic words like "dates".
  const lower = text.toLowerCase();
  const anchors = [
    lower.indexOf("schedule table"),
    lower.indexOf("course schedule"),
    lower.indexOf("course calendar"),
    lower.indexOf("weekly schedule"),
    lower.indexOf("class schedule"),
  ].filter((i) => i >= 0);

  // Many syllabi simply label this section "Schedule". That's a risky anchor on its own,
  // so only accept it when "schedule" appears close to "topic"/"readings"/"week".
  let extraAnchor = -1;
  {
    const rx = /schedule[^\n\r]{0,120}(topic|readings|week|lecture|module)/i;
    const mm = lower.match(rx);
    if (mm && mm.index !== undefined) extraAnchor = mm.index;
  }

  const allAnchors = [...anchors, ...(extraAnchor >= 0 ? [extraAnchor] : [])];
  const anchorIdx = allAnchors.length ? Math.min(...allAnchors) : -1;

  // Fallback: if we can't confidently anchor, still attempt extraction but only when the
  // document contains many month/day tokens (dense schedule-like text).
  const scope = anchorIdx >= 0 ? text.slice(anchorIdx) : text;

  const matches: Array<{ idx: number; month: number; day: number; rawMonth: string }> = [];
  let m: RegExpExecArray | null;
  while (scope && (m = monthRe.exec(scope)) !== null) {
    const rawMonth = String(m[1] || "").toLowerCase();
    const month = monthMap[rawMonth];
    const day = parseInt(m[2] || "0", 10);
    if (!month || !day) continue;
    matches.push({ idx: m.index, month, day, rawMonth });
  }

  // If we couldn't find a reliable schedule anchor, only proceed when the text is clearly
  // schedule-dense (otherwise we risk importing "Important dates" as lectures).
  if (anchorIdx < 0 && matches.length < 12) {
    return out;
  }

  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    const next = matches[i + 1];
    const start = cur.idx;
    const end = next ? next.idx : scope.length;
    const segment = scope.slice(start, end);

    const year = inferYearForMonthDay(cur.month, cur.day, seasonYear);
    const date = mmddToIso(cur.month, cur.day, year);

    // Remove the date token itself.
    let rest = segment.replace(monthRe, "").trim();
    // Remove optional weekday markers like "(Friday)".
    rest = rest.replace(/^\(\s*[^)]+\)\s*/i, "").trim();

    // Cut off obvious reading/citation beginnings.
    const cutPatterns: RegExp[] = [
      /\bNo\s+readings\s+required\b/i,
      /\bDocumentary\s*:/i,
      /\bChapter\b/i,
      /\bpp\b\s*[:\d-]+/i,
      // Author citation patterns like "Kleinman, A." or "Gamlin, J"
      /\b[A-Z][a-z]+\s*,\s*[A-Z]\./,
      /\b[A-Z][a-z]+\s*,\s*[A-Z][a-z]?\b/,
    ];
    let cutAt = -1;
    for (const re of cutPatterns) {
      const mm = rest.match(re);
      if (mm && mm.index !== undefined) {
        const idx = mm.index;
        if (cutAt === -1 || idx < cutAt) cutAt = idx;
      }
    }
    if (cutAt > 0) rest = rest.slice(0, cutAt).trim();

    // Clean extra whitespace.
    rest = normalize(rest);

    // Skip extremely empty or header-like rows.
    if (!rest || rest.length < 2) continue;

    // If the row text looks like a graded item (exam, quiz, presentation, etc.), emit it
    // as a graded event rather than a lecture — it will be merged into the assignments
    // pipeline and deduped against the AI's output.
    // Previously these rows were silently dropped; now they contribute to the heuristic pool.
    if (/\b(midterm|final\s+exam|exam|quiz|assignment|project|paper|presentation|due|submit)\b/i.test(rest)) {
      out.push({
        title: rest,
        date,
        startTime: classStartTime,
        endTime: classEndTime,
        kind: /\b(midterm|final\s+exam|exam)\b/i.test(rest) ? "Exam"
             : /\bquiz\b/i.test(rest) ? "Quiz"
             : /\b(paper|essay)\b/i.test(rest) ? "Paper"
             : /\b(presentation)\b/i.test(rest) ? "Presentation"
             : "Assignment",
        confidence: 0.80,
        source: "course schedule (graded row)",
      });
      continue;
    }

    out.push({
      title: rest,
      date,
      startTime: classStartTime,
      endTime: classEndTime,
      kind: "Lecture",
      confidence: 0.86,
      source: "course schedule",
    });
  }

  return out;
}

// Infer meeting days by scanning the syllabus for two kinds of signals:
//
// SIGNAL 1 (high-weight ×5): lines that contain BOTH a named weekday AND a graded-event
//   keyword — e.g. "Quiz 1: Wednesday, February 18" or "Midterm: Wednesday March 11".
//   These are strong evidence that Wednesday is a class day.
//   Lines that look like office-hours are excluded to prevent contamination.
//
// ── NEW: inferMeetingDaysFromScheduleDates ─────────────────────────────────────────────────
// When a syllabus has an explicit dated-schedule table (rows like "Jan 29", "Feb 3", "Feb 5"
// listed as class meetings), this is the ground-truth signal for meeting days.
//
// Strategy:
//   1. Find a "schedule section" — a contiguous run of lines where most lines contain a
//      month-day date (at least 5 such lines within any 20-line window).
//   2. In that section, convert every date to its weekday and count frequency.
//   3. Return the weekday(s) whose count is ≥ 30 % of the max count AND appear ≥ 3 times.
//      One-off days (e.g. a single Friday makeup class) are filtered out.
//   4. If the schedule section is sparse or not found, return [] (fall through to other signals).
//
// This function is called BEFORE inferMeetingDaysFromEventWeekdays and takes precedence
// when it returns a non-empty result.
function inferMeetingDaysFromScheduleDates(
  text: string,
  seasonYear: { season: any; year: number } | null
): Array<"Mon"|"Tue"|"Wed"|"Thu"|"Fri"|"Sat"|"Sun"> {
  // Split into lines for a sliding-window density scan.
  const lines = text.split(/\r?\n/);

  // Regex that matches a month-day date at the START or ANYWHERE in a line.
  // Covers: "Jan 29", "February 3", "Mar. 12", "Feb 6 (Friday)"
  const dateLine = /\b(Jan(?:uary)?\.?|Feb(?:ruary)?\.?|Mar(?:ch)?\.?|Apr(?:il)?\.?|May|Jun(?:e)?\.?|Jul(?:y)?\.?|Aug(?:ust)?\.?|Sep(?:t(?:ember)?)?\.?|Oct(?:ober)?\.?|Nov(?:ember)?\.?|Dec(?:ember)?\.?)\s+(\d{1,2})\b/i;

  // Find the densest date-line window.
  // Pass 1: tight window (20 lines, ≥4 date-lines) — works for compact/tabular schedules.
  // Pass 2: wider window (50 lines, ≥6 date-lines) — fallback for verbose syllabi where each
  //         session takes 3-5 lines (topic + readings + blank lines between dates).
  const CONFIGS = [
    { WINDOW: 20, MIN_DATE_LINES: 4 },
    { WINDOW: 50, MIN_DATE_LINES: 6 },
  ];
  let bestStart = -1;
  let bestCount = 0;
  let bestWindow = 20;
  for (const { WINDOW, MIN_DATE_LINES } of CONFIGS) {
    let localBestStart = -1;
    let localBestCount = 0;
    for (let i = 0; i <= lines.length - WINDOW; i++) {
      let count = 0;
      for (let j = i; j < i + WINDOW; j++) {
        if (dateLine.test(lines[j])) count++;
      }
      if (count > localBestCount) { localBestCount = count; localBestStart = i; }
    }
    if (localBestCount >= MIN_DATE_LINES && localBestCount > bestCount) {
      bestCount = localBestCount;
      bestStart = localBestStart;
      bestWindow = WINDOW;
    }
  }
  if (bestStart === -1) return []; // No schedule section found

  // Expand the schedule section: keep going while date lines remain reasonably dense.
  let secStart = bestStart;
  let secEnd = bestStart + bestWindow;
  // Walk backward from bestStart to capture rows that precede the densest window
  for (let i = bestStart - 1; i >= 0; i--) {
    if (dateLine.test(lines[i])) secStart = i;
    else break;
  }
  // Walk forward past the initial window.
  // Allow up to 5 consecutive non-date lines before stopping — some syllabi have
  // verbose reading lists (2-4 lines per session) between dated schedule rows.
  let gap = 0;
  for (let i = bestStart + bestWindow; i < lines.length; i++) {
    if (dateLine.test(lines[i])) { secEnd = i; gap = 0; }
    else { gap++; if (gap > 5) break; }
  }

  // Collect weekdays from every date found in the section.
  const wdCount = new Map<string, number>();
  const monthExtract = /\b(Jan(?:uary)?\.?|Feb(?:ruary)?\.?|Mar(?:ch)?\.?|Apr(?:il)?\.?|May|Jun(?:e)?\.?|Jul(?:y)?\.?|Aug(?:ust)?\.?|Sep(?:t(?:ember)?)?\.?|Oct(?:ober)?\.?|Nov(?:ember)?\.?|Dec(?:ember)?\.?)\s+(\d{1,2})\b/gi;
  for (let i = secStart; i <= secEnd && i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    monthExtract.lastIndex = 0;
    while ((m = monthExtract.exec(line)) !== null) {
      // Strip trailing dot from abbreviated month name before passing to monthNameToNum
      const monthStr = m[1].replace(/\.$/, "");
      const mon = monthNameToNum(monthStr);
      const day = parseInt(m[2], 10);
      if (!mon || !day || day > 31) continue;
      const yr = inferYearForMonthDay(mon, day, seasonYear);
      const d = new Date(`${yr}-${String(mon).padStart(2,"0")}-${String(day).padStart(2,"0")}T12:00:00`);
      if (isNaN(d.getTime())) continue;
      const wd = weekdayShort(d);
      if (wd === "Sat" || wd === "Sun") continue;
      wdCount.set(wd, (wdCount.get(wd) ?? 0) + 1);
    }
  }

  if (wdCount.size === 0) return [];

  // Sort by frequency, filter out one-off / infrequent days.
  const sorted = Array.from(wdCount.entries()).sort((a, b) => b[1] - a[1]);
  const maxCount = sorted[0][1];
  // A day must appear at LEAST MIN_OCCURRENCES times AND at least MIN_RATIO of the
  // most-frequent day's count. This filters out:
  //   - One-off dates (e.g. a single Friday makeup class)
  //   - Presentation days that cluster on a different weekday (e.g. Mar 12/19 = Thu in ANTH)
  //
  // MIN_RATIO = 0.50 means the second meeting day must be at least half as common as the
  // primary one.  For a true Mon/Wed course: Mon≈8, Wed≈8 → ratio=1.0 ✓
  // For ANTH Mar 12/19 (Thu=3 vs Mon=8): 3/8=0.375 < 0.50 → filtered ✓
  const MIN_OCCURRENCES = 3;
  const MIN_RATIO = 0.50;
  const result = sorted
    .filter(([, count]) => count >= MIN_OCCURRENCES && count / maxCount >= MIN_RATIO)
    .map(([wd]) => wd as "Mon"|"Tue"|"Wed"|"Thu"|"Fri"|"Sat"|"Sun");

  return result;
}

// SIGNAL 2 (weight ×0.5): all month+day dates in the document converted to actual weekday.
//   Low weight because this signal is very noisy (citation dates, admin dates, holidays).
//
// Weekend days are never returned — university classes meet Mon-Fri.
function inferMeetingDaysFromEventWeekdays(
  text: string,
  seasonYear: { season: any; year: number } | null
): Array<"Mon"|"Tue"|"Wed"|"Thu"|"Fri"|"Sat"|"Sun"> {

  const wdayCount = new Map<string, number>();
  const wdayToShort: Record<string, "Mon"|"Tue"|"Wed"|"Thu"|"Fri"|"Sat"|"Sun"> = {
    monday: "Mon", tuesday: "Tue", wednesday: "Wed", thursday: "Thu",
    friday: "Fri", saturday: "Sat", sunday: "Sun",
  };

  const officeHoursRe = /\boffice\s+hours?\b/i;
  const HIGH_WEIGHT = 5;

  // ── SIGNAL 3: explicit meeting-schedule compact tokens anywhere in the text ──
  // These are the most reliable signals when the syllabus doesn't have dated events.
  // Examples: "MF", "M/F", "Mon/Fri", "Monday and Friday", "meets M & F", etc.
  // We scan the first 10k chars (header area) and award very high weight.
  // parseDaysToken handles all compact forms — if it returns 2 consistent days, treat
  // them as definitive (weight = HIGH_WEIGHT * 4) to beat other signals.
  const SIGNAL3_WEIGHT = HIGH_WEIGHT * 4; // = 20
  {
    const head = text.slice(0, 10000);
    const lines3 = head.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    // Patterns that EXPLICITLY express a recurring day schedule (not just any day mention).
    // We require one of these structural phrases:
    //   "meets ...", "class meets ...", "lecture: ...", "days: ...",
    //   "schedule: ...", or a compact token like MF/MWF/TTh on its own (possibly with time).
    const meetsPrefixRe = /\b(meets?|class(?:es)?|lecture|days?|schedule|held)\b.*?(?:on\s+|:\s*|,\s*)/i;
    const compactDayRe = /\b(MWF|MF|MW|WF|TTh|TR|MWF|Mon\/Fri|Mon\/Wed|Tue\/Thu|Mon\s*[&\/]\s*Fri|Mon\s*[&\/]\s*Wed|Tuesday\s+and\s+Thursday|Monday\s+and\s+(?:Wednesday|Friday)|Wednesday\s+and\s+Friday)\b/i;
    for (const line of lines3) {
      if (officeHoursRe.test(line)) continue;
      // Match lines like "Class meets Monday and Friday" or just "MF 10:00-11:00"
      if (meetsPrefixRe.test(line) || compactDayRe.test(line)) {
        const parsed = parseDaysToken(line);
        if (parsed.length >= 1) {
          for (const d of parsed) {
            if (d !== "Sat" && d !== "Sun") {
              wdayCount.set(d, (wdayCount.get(d) ?? 0) + SIGNAL3_WEIGHT);
            }
          }
          // If we matched a high-quality compact token (parseDaysToken returned 2+ days),
          // we can return early — this is definitive.
          if (parsed.length >= 2) {
            return parsed;
          }
        }
      }
    }
  }

  // ── SIGNAL 1: lines containing a graded-event keyword + named weekday — high weight ──
  // Exclude office-hours lines so "Office Hours: Monday 3-4pm" doesn't inflate Mon.
  // Also include lecture/topic-header lines (e.g. "Monday: Introduction to X")
  // Deliberately narrow: only match words that strongly indicate a graded/assessed item.
  // Removed: 'lecture', 'topic', 'class', 'week' — these appear in ordinary schedule rows
  // and cause false-positive day counts (e.g. "Week 3 – Tuesdays" in non-meeting contexts).
  const gradedLineRe = /\b(quiz|exam|midterm|final|presentation|assignment|due|submit|paper|project|journal|test|video|response|discussion|reflection|reading|homework|hw)\b/i;
  const namedWdRe = /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/gi;
  for (const line of text.split(/\r?\n/)) {
    // Skip office-hours lines — professor availability ≠ class meeting days.
    if (officeHoursRe.test(line)) continue;
    if (!gradedLineRe.test(line)) continue;
    let wm: RegExpExecArray | null;
    namedWdRe.lastIndex = 0;
    while ((wm = namedWdRe.exec(line)) !== null) {
      const wd = wdayToShort[wm[1].toLowerCase()];
      if (wd && wd !== "Sat" && wd !== "Sun") {
        wdayCount.set(wd, (wdayCount.get(wd) ?? 0) + HIGH_WEIGHT);
      }
    }
  }

  // ── SIGNAL 2: actual month+day dates converted to weekday — low weight (noisy signal) ──
  const SIGNAL2_WEIGHT = 0.5;
  const monthDayRe = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:,?\s*(20\d{2}))?\b/gi;
  let m: RegExpExecArray | null;
  while ((m = monthDayRe.exec(text)) !== null) {
    const mon = monthNameToNum(m[1]);
    const day = parseInt(m[2], 10);
    if (!mon || !day || day > 31) continue;
    const yr = m[3] ? parseInt(m[3], 10) : inferYearForMonthDay(mon, day, seasonYear);
    const d = new Date(`${yr}-${String(mon).padStart(2,"0")}-${String(day).padStart(2,"0")}T12:00:00`);
    if (isNaN(d.getTime())) continue;
    const wd = weekdayShort(d);
    if (wd === "Sat" || wd === "Sun") continue;
    wdayCount.set(wd, (wdayCount.get(wd) ?? 0) + SIGNAL2_WEIGHT);
  }

  if (wdayCount.size === 0) return [];

  // Sort by score descending.
  const sorted = Array.from(wdayCount.entries()).sort((a, b) => b[1] - a[1]);
  const top = sorted[0];

  // Take the top day. Include a second day only when it has a STRONG signal:
  // - Score ≥ 60% of the top day's score (strong relative presence)
  // - Absolute score ≥ HIGH_WEIGHT (= at least one graded-keyword line mentioning it,
  //   or any Signal 3 match for that day)
  // This prevents noisy Signal-2 data from adding phantom meeting days.
  const result: Array<"Mon"|"Tue"|"Wed"|"Thu"|"Fri"|"Sat"|"Sun"> = [top[0] as any];
  if (sorted.length >= 2) {
    const second = sorted[1];
    if (second[1] / top[1] >= 0.6 && second[1] >= HIGH_WEIGHT) {
      result.push(second[0] as any);
    }
  }
  return result;
}

function extractTermRangeFromImportantDates(
  text: string,
  seasonYear: { season: any; year: number } | null
): { termStart?: string; termEnd?: string; noClassRanges?: Array<{ start: string; end: string }> } {
  // Look for explicit term boundary lines often present in university templates.
  // Example: "January 28: First day of classes"; "Monday, May 11 – Last day of class".
  // Also extract "No Class" / "Spring Break" / "Holiday" ranges from the same section.
  const out: { termStart?: string; termEnd?: string; noClassRanges?: Array<{ start: string; end: string }> } = {};
  const lower = text.toLowerCase();
  const idx = lower.indexOf("important dates");
  // Search a wider scope — some syllabi put schedule notes later in the document.
  const scope = idx >= 0 ? text.slice(idx, idx + 8000) : text.slice(0, 10000);

  const monthRe = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b\s*(\d{1,2})(?:,?\s*(20\d{2}))?/gi;

  function parseMonthDay(line: string): string | null {
    const re = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b\s*(\d{1,2})(?:,?\s*(20\d{2}))?/i;
    const m = line.match(re);
    if (!m) return null;
    const mon = monthNameToNum(m[1]);
    const day = parseInt(m[2], 10);
    if (!mon || !day) return null;
    const explicitYear = m[3] ? parseInt(m[3], 10) : null;
    const year = explicitYear ?? inferYearForMonthDay(mon, day, seasonYear);
    return mmddToIso(mon, day, year);
  }

  // Parse a date range like "March 15-22" or "March 15 – March 22" or "March 15 to 22".
  // Returns [startIso, endIso] or null.
  function parseDateRange(line: string): [string, string] | null {
    // Pattern: Month Day – Month Day (full range, e.g. "March 15 – April 3")
    const fullRangRe = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b\s*(\d{1,2})(?:,?\s*(20\d{2}))?\s*[–\-–to]+\s*(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b\s*(\d{1,2})(?:,?\s*(20\d{2}))?/i;
    const fm = line.match(fullRangRe);
    if (fm) {
      const mon1 = monthNameToNum(fm[1]); const d1 = parseInt(fm[2], 10);
      const mon2 = monthNameToNum(fm[4]); const d2 = parseInt(fm[5], 10);
      if (mon1 && d1 && mon2 && d2) {
        const y1 = fm[3] ? parseInt(fm[3], 10) : inferYearForMonthDay(mon1, d1, seasonYear);
        const y2 = fm[6] ? parseInt(fm[6], 10) : inferYearForMonthDay(mon2, d2, seasonYear);
        return [mmddToIso(mon1, d1, y1), mmddToIso(mon2, d2, y2)];
      }
    }
    // Pattern: Month Day-Day (same month, e.g. "March 15-22")
    const sameMonthRe = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b\s*(\d{1,2})\s*[–\-–]\s*(\d{1,2})(?:,?\s*(20\d{2}))?/i;
    const sm = line.match(sameMonthRe);
    if (sm) {
      const mon = monthNameToNum(sm[1]); const d1 = parseInt(sm[2], 10); const d2 = parseInt(sm[3], 10);
      if (mon && d1 && d2 && d2 > d1) {
        const yr = sm[4] ? parseInt(sm[4], 10) : inferYearForMonthDay(mon, d1, seasonYear);
        return [mmddToIso(mon, d1, yr), mmddToIso(mon, d2, yr)];
      }
    }
    return null;
  }

  const noClassRanges: Array<{ start: string; end: string }> = [];

  const lines = scope.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const l = line.toLowerCase();
    if (!out.termStart && (l.includes("first day of classes") || l.includes("classes begin") || l.includes("start of classes") || l.includes("first day of class"))) {
      const iso = parseMonthDay(line);
      if (iso) out.termStart = iso;
    }
    if (!out.termEnd && (l.includes("last day of class") || l.includes("last day of classes") || l.includes("classes end"))) {
      const iso = parseMonthDay(line);
      if (iso) out.termEnd = iso;
    }

    // Detect "no class" ranges: spring break, holiday week, recess, reading week, etc.
    const isNoClass =
      l.includes("no class") || l.includes("no lecture") || l.includes("no session") ||
      l.includes("spring break") || l.includes("winter break") || l.includes("fall break") ||
      l.includes("reading week") || l.includes("reading period") ||
      l.includes("holiday") || l.includes("recess") ||
      l.includes("holy week") || l.includes("semana santa") ||
      l.includes("feria") || l.includes("april fair") ||
      l.includes("bank holiday") || l.includes("university holiday") ||
      l.includes("campus closed") || l.includes("thanksgiving");

    if (isNoClass) {
      const range = parseDateRange(line);
      if (range) {
        noClassRanges.push({ start: range[0], end: range[1] });
      } else {
        const single = parseMonthDay(line);
        if (single) noClassRanges.push({ start: single, end: single });
      }
    }
  }

  if (noClassRanges.length > 0) out.noClassRanges = noClassRanges;

  // If we didn't find an explicit end, prefer a final exam date as an upper bound.
  if (!out.termEnd) {
    for (const line of lines) {
      const l = line.toLowerCase();
      if (l.includes("final exam") || l.includes("finals")) {
        const iso = parseMonthDay(line);
        if (iso) {
          out.termEnd = iso;
          break;
        }
      }
    }
  }

  return out;
}

export async function POST(req: Request) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json({ error: "Missing OPENAI_API_KEY in environment variables." }, { status: 500 });
    }

    const form = await req.formData();
    const file = form.get("file");
    const instructions = String(form.get("instructions") || "").trim();
    const sectionPrefRaw = String(form.get("section") || "").trim();
    // Parse section early so we can inject it into the AI prompt
    const secFromFieldEarly = sectionPrefRaw.match(/^[A-Za-z]$/) ? sectionPrefRaw.toUpperCase() : "";
    const secFromInstrEarly = (
      instructions.match(/\b(?:section|group)\s*([A-Za-z])\b/i)?.[1] ||
      instructions.match(/\b(?:i\s*am|i'?m|im)\s+in\s+(?:the\s+)?(?:section|group)?\s*([A-Za-z])\b/i)?.[1] ||
      ""
    ).toUpperCase();
    const detectedSection = (secFromFieldEarly || secFromInstrEarly || "").toUpperCase();
    const yearOverrideRaw = String(form.get("yearOverride") || "").trim();
    if (!file || typeof file === "string") {
      return NextResponse.json({ error: "Missing file upload." }, { status: 400 });
    }

    // File is a Web File object in Next route handlers.
    const f = file as File;
    const name = f.name || "upload";
    const ab = await f.arrayBuffer();
    const buf = Buffer.from(ab);

    let text = "";
    const lower = name.toLowerCase();
    try {
      if (lower.endsWith(".pdf") || f.type === "application/pdf") {
        // pdf parsing can be slow; keep it bounded
        text = await withTimeout(extractTextFromPdf(buf), 20000);
      } else if (lower.endsWith(".docx") || f.type.includes("wordprocessingml")) {
        text = await withTimeout(extractTextFromDocx(buf), 15000);
      } else {
        // Best-effort: treat as plain text
        text = buf.toString("utf8");
      }
    } catch (extractErr: any) {
      // Return a clean JSON error — never let a pdf-parse/mammoth crash return HTML
      return NextResponse.json(
        { error: extractErr?.message ?? "Failed to read the file. Try uploading a DOCX instead, or paste the syllabus text directly." },
        { status: 400 }
      );
    }

    if (!text || text.trim().length < 50) {
      return NextResponse.json(
        {
          error:
            "This file doesn't contain readable text — it's likely a scanned PDF. " +
            "Try these options: (1) Copy the text from the PDF and paste it directly into the input box, " +
            "(2) Export or re-save the file as a DOCX from Word or Google Docs, or " +
            "(3) Ask your professor for a text-based version of the syllabus.",
        },
        { status: 400 }
      );
    }

    // ── FAST year detection (pre-AI, text-only) ──────────────────────────────────────
    // We do this BEFORE the expensive AI call so we can return early and ask the user
    // to confirm the year without burning tokens or time.
    {
      const filenameSeason = detectSeasonYearFromFilename(name);
      const fastSeasonHint = (filenameSeason?.season && filenameSeason?.year)
        ? { season: filenameSeason.season as any, year: filenameSeason.year as any }
        : detectSeasonYear(text);
      const fastDetectedYear = fastSeasonHint?.year ?? mostLikelyYear(text);
      const fastNowYear = new Date().getFullYear();
      const fastOverrideYear = (() => {
        const y = parseInt(yearOverrideRaw, 10);
        return Number.isFinite(y) && y >= 2000 && y <= 2100 ? y : null;
      })();
      const fastNeedsYearConfirm = !fastOverrideYear &&
        typeof fastDetectedYear === "number" &&
        fastDetectedYear !== fastNowYear &&
        Math.abs(fastDetectedYear - fastNowYear) >= 1;

      if (fastNeedsYearConfirm) {
        // Also do a fast pre-AI section check so the client can ask for both at once
        // instead of requiring a 3-step round-trip (year → section → import).
        const fastHeader = parseCourseHeader(text);
        const fastSectionKeys = fastHeader?.sectionTimes ? Object.keys(fastHeader.sectionTimes).sort() : [];
        const fastHasMultipleSections = fastSectionKeys.length >= 2 && !detectedSection;

        return NextResponse.json({
          needsYearConfirm: true,
          // Include section info if detected, so client can ask for both in one pass
          ...(fastHasMultipleSections ? {
            needsSectionPick: true,
            sections: fastSectionKeys,
            course: fastHeader?.course ?? "",
          } : {}),
          meta: {
            detectedYear: fastDetectedYear,
            nowYear: fastNowYear,
            needsYearConfirm: true,
          },
        });
      }
    }

    // Keep prompt size bounded and focused on date-bearing content.
    const clipped = condenseForDates(text);

    // Build section-aware instruction block for the AI prompt.
    // When a section is known (second call), force the AI to return ONLY that section's meetings.
    // When no section is known yet (first call), instruct the AI to label sections consistently
    // so our detection logic can reliably split them — this prevents mixed-section output that
    // confuses downstream filtering.
    const sectionInstruction = detectedSection
      ? `\n\nCRITICAL SECTION FILTER — READ THIS FIRST AND FOLLOW EXACTLY:\nThe student is enrolled in Section/Group ${detectedSection} ONLY. The syllabus may refer to this as "Section ${detectedSection}" or "Group ${detectedSection}" — treat them the same.\n\nFor the "meetings" array:\n- Return ONLY the recurring meeting pattern(s) that belong to Section/Group ${detectedSection}.\n- DO NOT include meeting patterns from any other section or group. If you include the wrong section's times, the student will show up to class at the wrong time.\n- Each meeting object MUST have: "section": "${detectedSection}"\n- If the syllabus lists multiple sections/groups with different times, include ONLY the time slot for Section/Group ${detectedSection}.\n\nFor the "events" array:\n- Keep ALL course-wide events (assignments, exams, quizzes, papers, projects, due dates, activities, presentations) — these apply to everyone regardless of section.\n- Remove any section-specific lecture events that are NOT for Section/Group ${detectedSection}.\n\nIMPORTANT: The "meetings" array must contain at most ONE unique meeting pattern for this course. If you are unsure which time belongs to Section/Group ${detectedSection}, include only the first meeting pattern you find and label it "section": "${detectedSection}".\n`
      : `\n\nMEETINGS EXTRACTION RULES:\n- If the syllabus lists multiple sections or groups (e.g., Section A at 10:00, Section B at 13:00; or Group D: Tue & Thu 13:30, Group E: Tue & Thu 16:00), include ALL of them in the "meetings" array and label each with a "section" field (e.g., "section": "A", "section": "D").\n- If the course has only ONE section or meeting pattern, return just that one and do NOT add a "section" field.\n- IMPORTANT: each entry in "meetings" must represent a DISTINCT recurring pattern. Do NOT include the same days+time twice.\n`;

    const system = `You are LifeOS, an academic calendar extraction engine. Extract EVERY graded item, deadline, and recurring meeting from this syllabus. Be exhaustive and consistent — a missed deadline could harm the student's grade.${sectionInstruction}

Return ONLY valid JSON matching the schema below. No markdown, no prose.

SCHEMA:
{
  "course": string,
  "termStart"?: "YYYY-MM-DD",
  "termEnd"?: "YYYY-MM-DD",
  "meetings"?: Array<{
    "days": Array<"Mon"|"Tue"|"Wed"|"Thu"|"Fri"|"Sat"|"Sun">,
    "startTime": "HH:MM",
    "endTime"?: "HH:MM",
    "kind"?: "Lecture"|"Lab"|"Discussion"|"OfficeHours"|"Seminar",
    "section"?: string
  }>,
  "events": Array<{
    "title": string,
    "date": "YYYY-MM-DD",
    "startTime"?: "HH:MM",
    "endTime"?: "HH:MM",
    "kind": "Exam"|"Assignment"|"Quiz"|"Project"|"Paper"|"Journal"|"Reading"|"Discussion"|"Presentation"|"Review"|"Other",
    "confidence": number,
    "source": string
  }>
}

━━━ EVENTS — WHAT TO EXTRACT ━━━

Extract EVERY item in any of these categories:
• Assessments: quizzes, exams, midterms, finals, tests
• Written work: papers, essays, drafts, outlines, proposals, bibliographies, revisions, abstracts
• Projects: projects, presentations, milestones, checkpoints, portfolios, dossiers
• Weekly work: journals, reading responses, reflections, annotations, discussion posts, critiques, field notes, case studies, lab reports, exercises, worksheets
• Any item with the words: due, submit, turn in, upload, post, complete by, deadline

━━━ NUMBERED SERIES — EXPAND EVERY ONE ━━━

For any numbered series, create ONE event per number:
• "Journal Entries 1–10 due Fridays" → 10 separate Journal events, each on the correct Friday
• "Reading Response 1, 2, 3" → 3 events
• "JE 4" → one event titled "Journal Entry 4"
DO NOT collapse a series into one event. DO NOT skip numbers.

━━━ DATES — EXTRACTION RULES ━━━

• Accept all formats: "Jan 15", "1/15/2025", "January 15th", "2025-01-15", "Week 3 Friday"
• Date ranges: use the specific event date when given, otherwise use the FIRST date of the range (not Monday of the week — use the actual first date listed)
• Tables with a Date column: extract EVERY row that contains a graded item. Use the exact date in that row.
• Parenthetical dates: "Quiz 1 (February 24th)" → Feb 24. Always extract dates inside parentheses.
• Grading section: scan the grade breakdown section too — it often has dates like "Final project (20%) — April 16th"
• termStart: date of first class session. termEnd: date of LAST class session (not final exam week unless that IS the last class date).

━━━ KIND VALUES — USE EXACTLY THESE ━━━

Always set "kind" to one of these exact values (case-sensitive):
  "Exam"          → for quizzes, tests, midterms, finals
  "Assignment"    → for homework, worksheets, problem sets, exercises, lab reports
  "Quiz"          → for explicitly labeled quizzes only
  "Project"       → for projects, milestones, portfolios, dossiers
  "Paper"         → for essays, papers, drafts, outlines, proposals, bibliographies
  "Journal"       → for journal entries, reading logs, field notes, annotations
  "Reading"       → for reading responses, reading reflections, response papers
  "Discussion"    → for discussion posts, forum responses, participation items
  "Presentation"  → for presentations, talks, demonstrations
  "Review"        → for peer reviews, critiques, feedback assignments
  "Other"         → only if none of the above fits

━━━ RECURRING MEETINGS ━━━

• Extract all patterns: "MWF 10:00–11:15", "Tue/Thu 2–3:15pm", "Mondays 18:00"
• Day abbreviations: M/Mo/Mon, T/Tu/Tue, W/We/Wed, Th/Thu/R, F/Fr/Fri
• If the syllabus shows multiple sections with different times, list all in "meetings" with a "section" label
• Include "days" extracted from the same line as the time whenever possible
• If no explicit days are listed but the Important Dates section names weekdays (e.g. "Quiz 1: Wednesday, February 18"), use those weekday names to fill in the meeting "days" array

━━━ CONFIDENCE SCORING ━━━

Use fixed values only — do NOT vary within a confidence tier:
  1.0 = Date explicitly stated next to a graded item (e.g. "Journal 4 due Jan 15")
  0.85 = Clear date, minor ambiguity in title
  0.7 = Date inferred from schedule table row
  0.5 = Date inferred from week number or relative reference

━━━ MANDATORY RULES ━━━

✓ Set "kind" on EVERY event — never omit it
✓ Set "confidence" on EVERY event — use the fixed values above
✓ Set "source" on EVERY event — quote the exact syllabus text that contains the date/title
✓ Use ISO date format: YYYY-MM-DD
✓ Do NOT invent dates. Only extract dates that are explicitly stated or directly calculable.
✓ SPRING BREAK / HOLY WEEK / NO CLASS: if the syllabus says "no class [dates]", do NOT create events on those dates
✓ FINAL EXAM RANGE: "Final exam: May 12–15" → one event on May 12 (first date), titled "Final Exam"
✓ Numbered series: create individual events for EVERY number in the range — never skip`;

    const user = `USER INSTRUCTIONS (optional):\n${instructions || "(none)"}\n\nSYLLABUS TEXT (clipped):\n\n${clipped}`;

    // Use AI (Claude preferred, GPT-4o fallback) for structured extraction.
    const rawText = await withTimeout(callAI(system, user, 8192));
    const raw = safeJsonParse(rawText);

    const events = Array.isArray(raw?.events) ? raw.events : [];
    const meetings = Array.isArray(raw?.meetings) ? raw.meetings : [];

    // Parse a few high-signal fields directly from the raw text to improve reliability
    // across messy exports (especially table-heavy DOCX syllabi).
    const header = parseCourseHeader(text);

    // Apply section-specific time window to header (uses detectedSection parsed earlier).
    // Also build a set of "other section" times for server-side lecture filtering.
    // IMPORTANT: Only apply section filtering when the user has ACTUALLY picked a section.
    // Defaulting to "A" when no section is chosen incorrectly excludes other sections' times.
    const otherSectionStartTimes = new Set<string>();
    {
      if (detectedSection && header?.sectionTimes && Object.keys(header.sectionTimes).length > 0) {
        // Apply user's section time
        if (header.sectionTimes[detectedSection]) {
          header.startTime = header.sectionTimes[detectedSection].startTime;
          header.endTime = header.sectionTimes[detectedSection].endTime;
          // Also apply meeting days if the section-specific regex captured them
          // (e.g. "Group D: Tue & Thu 13:30-14:50" → days = [Tue, Thu])
          const secDays = header.sectionTimes[detectedSection].meetingDays;
          if (secDays && secDays.length > 0 && (!header.meetingDays || header.meetingDays.length === 0)) {
            header.meetingDays = secDays;
          }
        }
        // Collect other sections' start times so we can filter out their lectures
        for (const [otherSec, times] of Object.entries(header.sectionTimes)) {
          if (otherSec !== detectedSection && times.startTime) {
            otherSectionStartTimes.add(times.startTime);
          }
        }
      }
    }

    // Improve year correctness: if the model guessed the wrong year, prefer
    // an explicit semester hint (e.g., "Spring 2025") or the most common year token.
    const filenameSeason = detectSeasonYearFromFilename(name);
    const seasonHintBase = (filenameSeason?.season && filenameSeason?.year)
      ? { season: filenameSeason.season as any, year: filenameSeason.year as any }
      : (header?.season && header?.year)
        ? { season: header.season as any, year: header.year as any }
        : detectSeasonYear(text);

    // Optional: allow the client to override the term year (used when a syllabus is mislabeled
    // or when a PDF template shows last year's term).
    const overrideYear = (() => {
      const y = parseInt(yearOverrideRaw, 10);
      return Number.isFinite(y) && y >= 2000 && y <= 2100 ? y : null;
    })();

    const seasonHint = seasonHintBase
      ? { ...seasonHintBase, year: overrideYear ?? seasonHintBase.year }
      : (overrideYear ? { season: (detectSeasonYear(text)?.season ?? "Spring") as any, year: overrideYear } : null);

    const detectedYear = seasonHintBase?.year ?? header?.year ?? mostLikelyYear(text);
    const usedYear = seasonHint?.year ?? detectedYear ?? null;

    const nowYear = new Date().getFullYear();
    const needsYearConfirm = !overrideYear && typeof detectedYear === "number" && detectedYear !== nowYear && Math.abs(detectedYear - nowYear) >= 1;

    const dominantYear = seasonHint?.year ?? header?.year ?? mostLikelyYear(text);

    // If we cannot confidently infer the syllabus year, do not import anything.
    // This prevents the "random 2023" problem.
    if (!dominantYear || !Number.isFinite(dominantYear)) {
      return NextResponse.json(
        { error: "Could not determine the syllabus year. Please rename the file to include the term (e.g., FALL2025) or ensure the syllabus text contains something like 'Fall 2025'." },
        { status: 400 }
      );
    }

    // Prefer explicit university-template boundaries ("First day of classes", "Last day of class")
    // when present. This prevents random ranges and enables reliable lecture auto-fill.
    const termRange = extractTermRangeFromImportantDates(text, seasonHint as any);
    if (termRange?.termStart && typeof raw?.termStart !== "string") {
      raw.termStart = termRange.termStart;
    }
    if (termRange?.termEnd && typeof raw?.termEnd !== "string") {
      raw.termEnd = termRange.termEnd;
    }

    // Build the set of "no class" dates for the lecture expansion loop.
    // This replaces the old hardcoded isUniversityHoliday() call with a dynamic,
    // syllabus-aware set: only skip dates that are explicitly stated in the syllabus
    // (Spring Break, Holy Week when mentioned, Feria when mentioned) plus Christmas/New Year.
    const noClassDates = buildNoClassDates(
      termRange?.noClassRanges ?? [],
      text,
      dominantYear as number
    );

    // If the syllabus doesn't explicitly list meeting days, infer them from
    // university-template boundary lines when present.
    //
    // Why: some syllabi don't say "Meets Mon/Wed" anywhere; instead they include
    // template lines like "January 28: First day of classes" and
    // "Monday, May 11 – Last day of class". In those cases, defaulting to only the
    // weekday of termStart incorrectly drops the other meeting day (your PSY case).
    //
    // Heuristic: collect weekday hints from BOTH termStart and termEnd; if we get
    // two distinct weekdays, we treat that as the likely meeting pattern.
    const boundaryWeekdays = new Set<"Sun"|"Mon"|"Tue"|"Wed"|"Thu"|"Fri"|"Sat">();
    if (termRange?.termStart) {
      const d = isoToDate(termRange.termStart);
      if (d) boundaryWeekdays.add(weekdayShort(d));
    }
    if (termRange?.termEnd) {
      const d = isoToDate(termRange.termEnd);
      if (d) boundaryWeekdays.add(weekdayShort(d));
    }

    // Only apply boundary inference when meeting days are missing or clearly incomplete.
    // We keep this conservative to avoid inventing extra days.
    const existing = Array.isArray(header?.meetingDays) ? header!.meetingDays : [];
    const boundary = Array.from(boundaryWeekdays);

    // SCHEDULE-DATE INFERENCE (highest priority): scan for a dense dated-schedule section
    // (table of class sessions with explicit dates) and compute weekday frequency from
    // actual dates. This beats all other inference because it reads ground-truth dates.
    // Example: ANTH 215E has "Jan 29, Feb 3, Feb 5, Feb 6(Fri makeup), Feb 10, Feb 12..."
    // → Mon=8 hits, Wed=8 hits, Fri=1 hit, Thu=1 hit → returns [Mon, Wed].
    const scheduleDateDays = inferMeetingDaysFromScheduleDates(text, seasonHint as any);

    // PRIMARY INFERENCE: scan the full syllabus for named weekday+date pairs to find the
    // most common meeting days. This is more reliable than boundary dates alone because
    // boundary weekdays only give us 2 data points (often different days for start/end),
    // while named event weekdays give us many consistent signals.
    // Example: "Quiz 1: Wednesday February 18" + "Midterm: Wednesday March 11" +
    // "Monday, May 11 – Last day" → strong signal for Mon & Wed.
    const inferredDays = scheduleDateDays.length > 0
      ? scheduleDateDays
      : inferMeetingDaysFromEventWeekdays(text, seasonHint as any);

    // PRIORITY 1: schedule-date frequency result is ground truth — always wins.
    // This handles syllabi where the explicit dated schedule is the only reliable day source
    // (e.g. ANTH 215E has no "Meets Mon/Wed" line, only a list of session dates).
    // It also overrides whatever parseCourseHeader may have guessed from compact tokens.
    if (scheduleDateDays.length > 0) {
      header.meetingDays = scheduleDateDays;
    } else if (existing.length === 0) {
      // No days from header regex or schedule dates: fall back to event-weekday inference.
      if (inferredDays.length > 0) {
        // If Signal 1/2 gave us exactly 1 day (e.g. Wednesday from quiz dates) and the
        // explicit term-boundary weekdays include an ADDITIONAL day not already covered,
        // add it. This handles PSY-style syllabi where quizzes all fall on Wednesday but
        // the course also meets Monday — "Monday, May 11 – Last day of class" tells us Mon
        // is a meeting day even though no graded item is explicitly named "Monday X".
        // We only merge boundary days that are different from all already-inferred days,
        // and only when boundary came from a NAMED weekday line (not just a bare date).
        // Special case: if we only found 1 meeting day from graded-event signals (e.g.
        // all quizzes are on Wednesday) but the explicit term boundary tells us a DIFFERENT
        // weekday is also a class day (e.g. "Monday, May 11 – Last day of class"), add it.
        // We limit this to exactly 1 inferred day so we don't inflate already-complete patterns.
        const inferredSet = new Set(inferredDays);
        const extraBoundaryDays = boundary.filter(d => !inferredSet.has(d) && d !== "Sat" && d !== "Sun");
        if (inferredDays.length === 1 && extraBoundaryDays.length > 0) {
          header.meetingDays = [...inferredDays, ...extraBoundaryDays];
        } else {
          header.meetingDays = inferredDays;
        }
      } else if (boundary.length > 0) {
        header.meetingDays = boundary;
      }
    } else if (existing.length === 1 && boundary.length >= 2) {
      // Had one explicit day from header; boundary showed another. Prefer inferred if strong.
      if (inferredDays.length >= 2) {
        header.meetingDays = inferredDays;
      } else {
        const merged = new Set(existing);
        for (const d of boundary) merged.add(d);
        header.meetingDays = Array.from(merged);
      }
    }

    // BOUNDARY SAFETY NET: uses termStart/termEnd weekdays to fill in missing meeting days.
    // Case 1: exactly 1 day assembled — termEnd is almost certainly the second meeting day
    //         (the last day of class is always a class day).
    // Case 2: 0 days assembled — fall back to the full boundary array (termStart + termEnd
    //         weekdays), which covers courses like PSY 260E where all other signals fail.
    {
      const currentDays = Array.isArray(header?.meetingDays) ? header!.meetingDays : [];
      if (currentDays.length === 1 && termRange?.termEnd) {
        const termEndDate = isoToDate(termRange.termEnd);
        if (termEndDate) {
          const termEndWd = weekdayShort(termEndDate);
          if (termEndWd !== "Sat" && termEndWd !== "Sun" && !currentDays.includes(termEndWd as any)) {
            header.meetingDays = [...currentDays, termEndWd as any];
          }
        }
      } else if (currentDays.length === 0 && boundary.length > 0) {
        // No days at all — use the boundary weekdays (termStart + termEnd) as a last resort.
        // Filter out weekends just in case.
        const boundaryDays = boundary.filter(d => d !== "Sat" && d !== "Sun");
        if (boundaryDays.length > 0) {
          header.meetingDays = boundaryDays as any;
        }
      }
    }

    // NOTE: The AI "last resort" day fallback was removed. The LLM frequently reads
    // office-hours lines (e.g. "Office Hours: Monday and Wednesday") and reports those
    // as meeting days, causing courses with no explicit day info (like PSY 260E) to get
    // wrong days. All day inference now uses deterministic signals only.

    // Course label used for lecture naming.
    // Priority: header regex > AI raw > text-based extraction > "Class" fallback
    const courseCode = normalize(String(header?.course ?? raw?.course ?? "")).trim();
    // courseName: try header first, then AI raw.courseName, then raw.title (AI sometimes puts name there)
    const rawCourseName = normalize(String(raw?.courseName ?? raw?.title ?? "")).trim();
    let courseName = normalize(String(header?.courseName ?? "")).trim();
    if (!courseName) courseName = rawCourseName;
    // Last resort: if we have a course code but no name, try to extract the course title
    // from the first few lines of the syllabus (often appears right after the code).
    if (!courseName && courseCode) {
      const codeEscaped = courseCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
      const titleAfterCode = text.match(
        new RegExp(`${codeEscaped}\\s*[:\\-–\\n]\\s*([^\\n\\r]{4,120}?)\\s*(?:\\n|$)`, "i")
      );
      if (titleAfterCode) courseName = normalize(titleAfterCode[1]).trim();
    }
    const lectureLabel = normalize(`${courseCode}${courseCode && courseName ? " " : ""}${courseName}` || "Class").trim();

    function desiredYearForMonth(month1to12: number): number | null {
      if (seasonHint) {
        const y = seasonHint.year;
        if (seasonHint.season === "Spring") return month1to12 <= 6 ? y : y; // Spring rarely spans years
        if (seasonHint.season === "Summer") return y;
        if (seasonHint.season === "Fall") return month1to12 >= 7 ? y : y + 1; // allow Jan–May finals/projects in academic year
        if (seasonHint.season === "Winter") return month1to12 === 12 ? y - 1 : y;
      }
      return dominantYear ?? null;
    }

    function maybeFixYear(iso: string): string {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
      const month = parseInt(iso.slice(5, 7), 10);
      const currentYear = parseInt(iso.slice(0, 4), 10);
      const want = desiredYearForMonth(month);
      if (!want) return iso;
      // We anchor the year to the detected term year to prevent "random" years.
      // If the syllabus line didn't include a year, the model may hallucinate one.
      // In A-mode (only graded items + meetings), correctness beats preservation.
      if (currentYear !== want) return rewriteYear(iso, want);
      return iso;
    }

    // Light validation / normalization
    const cleanedAi = events
      .filter((e: any) => e && typeof e === "object")
      .map((e: any) => ({
        title: typeof e.title === "string" ? e.title : "",
        date: typeof e.date === "string" ? maybeFixYear(e.date) : "",
        startTime: typeof e.startTime === "string" ? e.startTime : undefined,
        endTime: typeof e.endTime === "string" ? e.endTime : undefined,
        kind: typeof e.kind === "string" ? e.kind : undefined,
        confidence: typeof e.confidence === "number" ? e.confidence : undefined,
        source: typeof e.source === "string" ? e.source : undefined,
      }))
      .filter((e: any) => e.title && /^\d{4}-\d{2}-\d{2}$/.test(e.date))
      .filter((e: any) => looksGraded(e.title, e.kind));

    const includeLectures = (() => {
      const ins = String(instructions ?? "").toLowerCase();
      if (/\b(no|exclude|without)\s+lectures?\b/.test(ins)) return false;
      // Default behavior for syllabi: include lectures unless the user explicitly excludes them.
      return true;
    })();

    // Deterministic lecture + graded extraction from course schedule sections.
    // We ALWAYS run this extractor — even when a reliable recurring meeting pattern exists.
    // The two output types are handled separately:
    //   • Lecture rows: used only when there is NO reliable recurring meeting pattern
    //     (i.e. we don't know meeting days/time yet). When a recurring pattern exists,
    //     the expansion loop generates lectures; schedule-extracted lectures would duplicate them.
    //   • Graded rows (exam, quiz, paper, etc.): ALWAYS fed into the heuristic pool so they
    //     can fill gaps in the AI's extraction regardless of whether a meeting pattern exists.
    const hasReliableRecurringMeeting = !!(header?.meetingDays?.length && header?.startTime);
    const scheduleRaw = includeLectures
      ? extractCourseScheduleLectures(text, seasonHint as any, header?.startTime, header?.endTime)
      : [];

    // Graded rows from the schedule → merge into the heuristic pool.
    const scheduleGraded = scheduleRaw.filter((e: any) => e.kind !== "Lecture");
    const heuristicRawFull = [
      ...extractTableLikeDueItems(text, seasonHint as any, header?.startTime),
      ...extractJournalDueItems(text, seasonHint as any, header?.startTime),
      ...scheduleGraded,
    ];

    // Lecture rows from the schedule → only used when there is no recurring pattern.
    const scheduleLectures = scheduleRaw.filter((e: any) => e.kind === "Lecture");
    const lectureRaw = hasReliableRecurringMeeting ? [] : scheduleLectures;

    const cleanedLectures = lectureRaw
      .map((e: any) => ({
        // User preference: lectures should always be named "<Course> Lecture".
        // We do not use the extracted topic text as the title (it can be noisy).
        title: `${lectureLabel} Lecture`,
        date: typeof e.date === "string" ? maybeFixYear(e.date) : "",
        startTime: typeof e.startTime === "string" ? e.startTime : header?.startTime,
        endTime: typeof e.endTime === "string" ? e.endTime : header?.endTime,
        kind: "Lecture",
        confidence: typeof e.confidence === "number" ? e.confidence : 0.86,
        source: typeof e.source === "string" ? e.source : "course schedule",
      }))
      .filter((e: any) => e.title && /^\d{4}-\d{2}-\d{2}$/.test(e.date));

    // Heuristic graded items: table-heavy syllabi + journal extractor + schedule graded rows.
    const cleanedHeuristic = heuristicRawFull
      .map((e: any) => ({
        title: typeof e.title === "string" ? e.title : "",
        date: typeof e.date === "string" ? maybeFixYear(e.date) : "",
        startTime: typeof e.startTime === "string" ? e.startTime : undefined,
        endTime: typeof e.endTime === "string" ? e.endTime : undefined,
        kind: typeof e.kind === "string" ? e.kind : undefined,
        confidence: typeof e.confidence === "number" ? e.confidence : 0.85,
        source: typeof e.source === "string" ? e.source : "heuristic",
      }))
      .filter((e: any) => e.title && /^\d{4}-\d{2}-\d{2}$/.test(e.date))
      .filter((e: any) => looksGraded(e.title, e.kind));

    // Section filtering: drop any lecture event that belongs to a different section.
    // Strategy 1 (primary): check the "section" field the AI was instructed to label.
    // Strategy 2 (fallback): check if startTime matches another section's known time.
    // Graded items (assignments, exams, etc.) are never filtered — they apply to all sections.
    function isOtherSectionLecture(e: any): boolean {
      if (!detectedSection) return false;
      const kind = String(e.kind ?? "").toLowerCase();
      const isLectureLike = kind === "lecture" || kind === "lab" || kind === "discussion" || kind === "seminar" || kind === "officehours";
      if (!isLectureLike) return false;

      // Strategy 1: AI labelled the event with a section field
      const eventSection = String(e.section ?? "").trim().toUpperCase();
      if (eventSection && eventSection !== detectedSection) return true;  // wrong section
      if (eventSection && eventSection === detectedSection) return false; // correct section

      // Strategy 2: start-time matches a known OTHER section's time
      if (otherSectionStartTimes.size > 0) {
        const st = String(e.startTime ?? "");
        if (st && otherSectionStartTimes.has(st)) return true;
      }

      return false;
    }

    // Source trust priority: heuristic (deterministic regex) > AI (probabilistic).
    // Heuristic events arrive first in the merge array; the dedup logic below
    // uses this ordering so heuristic always wins on tie or close-confidence conflicts.
    function sourceRank(e: any): number {
      const s = String(e.source ?? "").toLowerCase();
      if (s.includes("heuristic") || s.includes("journal") || s.includes("table") || s.includes("schedule row")) return 2;
      if (s.includes("course schedule")) return 1; // deterministic lecture extractor
      return 0; // AI-sourced
    }

    // Merge AI + heuristic + lecture events.
    // Pass 1: dedupe by date+title (exact duplicate).
    // Heuristic results take priority over AI (more reliable for journals/tables).
    const key = (e: any) => `${e.date}::${String(e.title ?? "").toLowerCase()}`;
    const byKey = new Map<string, any>();
    for (const e of [...cleanedLectures, ...cleanedHeuristic, ...cleanedAi]) {
      if (!e?.title || !/^\d{4}-\d{2}-\d{2}$/.test(e.date)) continue;
      if (isOtherSectionLecture(e)) continue; // drop events from other sections
      const k = key(e);
      if (!byKey.has(k)) byKey.set(k, e);
    }
    const afterPass1 = Array.from(byKey.values());

    // Pass 2: for graded items, dedupe by TITLE ONLY.
    // This prevents "Submit Journal 3" appearing twice on different dates
    // when the AI and heuristic disagree on the exact due date.
    //
    // Priority rules (in order):
    // 1. Higher source rank (heuristic > schedule > AI) always wins.
    // 2. If same source rank, prefer higher confidence.
    // 3. If both equal, keep the first-inserted (heuristic comes first in merge array).
    const byTitle = new Map<string, any>();
    for (const e of afterPass1) {
      const tkey = String(e.title ?? "").toLowerCase();
      const isRepeatableItem = /lecture|class\s+meeting/i.test(tkey); // lectures CAN repeat across dates
      if (isRepeatableItem) {
        // Don't collapse lectures by title — each date is a distinct event
        byTitle.set(`${e.date}::${tkey}`, e);
        continue;
      }
      if (!byTitle.has(tkey)) {
        byTitle.set(tkey, e);
      } else {
        const existing = byTitle.get(tkey)!;
        const eRank = sourceRank(e);
        const exRank = sourceRank(existing);
        if (eRank > exRank) {
          // Higher-trust source always wins, regardless of confidence
          byTitle.set(tkey, e);
        } else if (eRank === exRank && (e.confidence ?? 0) > (existing.confidence ?? 0) + 0.1) {
          // Same source tier: only replace when confidence meaningfully higher (>0.1 gap)
          // to prevent small floating-point variations from flipping dates.
          byTitle.set(tkey, e);
        }
      }
    }
    const cleaned = Array.from(byTitle.values());

    // Expand recurring meetings into individual dated events so the client can add them easily.
    const termStartIso = typeof raw?.termStart === "string" ? maybeFixYear(raw.termStart) : undefined;
    const termEndIso = typeof raw?.termEnd === "string" ? maybeFixYear(raw.termEnd) : undefined;

    // Scan the full text for ALL month+day dates so we can use the latest one as an upper
    // bound for `end`. This prevents ANTH-style syllabi where the last class date (May 7) is
    // later than the last explicitly-graded item date (Apr 16), causing lectures to be cut off.
    // We restrict to months that fall within the known semester range to avoid inflating the
    // end date with citation dates or out-of-semester references.
    const allTextDateCandidates: string[] = [];
    {
      // Compute the plausible month range for this semester.
      const semMonths = new Set<number>();
      if (seasonHint) {
        if (seasonHint.season === "Spring") { [1,2,3,4,5,6].forEach(m => semMonths.add(m)); }
        else if (seasonHint.season === "Summer") { [5,6,7,8].forEach(m => semMonths.add(m)); }
        else if (seasonHint.season === "Fall") { [8,9,10,11,12].forEach(m => semMonths.add(m)); }
        else if (seasonHint.season === "Winter") { [12,1,2].forEach(m => semMonths.add(m)); }
      }

      const scanRe = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:,?\s*(20\d{2}))?\b/gi;
      let sm: RegExpExecArray | null;
      while ((sm = scanRe.exec(text)) !== null) {
        const mon = monthNameToNum(sm[1]);
        const day = parseInt(sm[2], 10);
        if (!mon || !day || day > 31) continue;
        // Skip months outside the semester range to avoid stray citation dates inflating `end`.
        if (semMonths.size > 0 && !semMonths.has(mon)) continue;
        const yr = sm[3] ? parseInt(sm[3], 10) : inferYearForMonthDay(mon, day, seasonHint as any);
        const iso = mmddToIso(mon, day, yr);
        allTextDateCandidates.push(iso);
      }
    }

    const startCandidates = [termStartIso, ...cleaned.map((e) => e.date)].filter(Boolean) as string[];
    const endCandidates = [termEndIso, ...cleaned.map((e) => e.date), ...allTextDateCandidates].filter(Boolean) as string[];

    let start = startCandidates.sort()[0];
    let end = endCandidates.sort().slice(-1)[0];

    // If an explicit "Last day of class" was found in the syllabus, use it as a hard cap
    // on `end`. This prevents allTextDateCandidates from inflating `end` with forward-looking
    // conference deadlines or "Looking ahead to Summer" references that appear in the text.
    const explicitTermEnd = termRange?.termEnd;
    if (explicitTermEnd && end && end > explicitTermEnd) {
      // Only cap if the explicit termEnd is plausible (within 2 weeks of the computed end).
      const diff = Math.abs(
        (isoToDate(end)?.getTime() ?? 0) - (isoToDate(explicitTermEnd)?.getTime() ?? 0)
      );
      const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;
      if (diff <= TWO_WEEKS_MS * 4) {
        // Explicit end is close enough — trust it as the hard cap.
        end = explicitTermEnd;
      }
    }

    // If the syllabus didn't have any graded items with dates, we still want recurring
    // lectures to span the whole term. Use a conservative, season-based default range.
    if ((!start || !end) && seasonHint?.season && seasonHint?.year) {
      const guessed = inferDefaultTermRange({ season: seasonHint.season, year: seasonHint.year });
      if (guessed) {
        if (!start) start = guessed.start;
        if (!end) end = guessed.end;
      }
    }

    // If we still don't have a range, pick a sane 16-week window starting today.
    if (!start) start = dateToIso(new Date());
    if (!end) {
      const d = isoToDate(start) ?? new Date();
      d.setDate(d.getDate() + 7 * 16);
      end = dateToIso(d);
    }

    const sd = isoToDate(start);
    const ed = isoToDate(end);
    const meetingEvents: any[] = [];

    // Optional correctness check: if the syllabus includes an explicit list of class meeting dates,
    // only create recurring meetings on those dates (prevents accidental Saturdays).
    const explicitMeetingDates = extractExplicitClassMeetingDates(text, seasonHint as any);
    const explicitMeetingDays = new Set<string>();
    for (const iso of explicitMeetingDates) {
      const d = isoToDate(iso);
      if (d) explicitMeetingDays.add(weekdayShort(d));
    }

    // Resolve the effective start time for the meeting expansion guard.
    // PSY-style syllabi have times only in sectionTimes (e.g. Group A 13:30-14:50)
    // but not in header.startTime. We need to check that path too so the expansion
    // block is entered and the fallback meeting gets the section time patched in.
    const anySectionStartTime = detectedSection
      ? header?.sectionTimes?.[detectedSection]?.startTime
      : Object.values(header?.sectionTimes ?? {}).find(s => s?.startTime)?.startTime;
    const effectiveStartTime = header?.startTime ?? anySectionStartTime;

    if (
      includeLectures &&
      sd &&
      ed &&
      (meetings.length || (header?.meetingDays?.length && effectiveStartTime) || (explicitMeetingDays.size > 0 && effectiveStartTime))
    ) {
      // Normalize range order
      const rangeStart = sd.getTime() <= ed.getTime() ? sd : ed;
      const rangeEnd = sd.getTime() <= ed.getTime() ? ed : sd;

      const MAX_MEETING_EVENTS = 450;
      const dayNames = new Set(["Mon","Tue","Wed","Thu","Fri","Sat","Sun"]);

      // When the user has specified a section, filter out meeting patterns from other sections.
      // Strategy 1 (primary): use the "section" label the AI attached to each meeting.
      // Strategy 2 (fallback): use start-time matching against other-section times.
      // Strategy 3 (last resort): if multiple distinct start times remain, keep only the first
      //   unique start time — the AI was instructed to return only one section's meetings,
      //   so extra patterns are likely the wrong section leaking through.
      let filteredMeetings = meetings;
      if (meetings.length && detectedSection) {
        // Step 1: filter by section label when present
        const labelFiltered = meetings.filter((m: any) => {
          const meetingSection = String(m?.section ?? "").trim().toUpperCase();
          if (meetingSection) {
            return meetingSection === detectedSection;
          }
          // No label: apply time-based fallback
          if (otherSectionStartTimes.size > 0) {
            const st = String(m?.startTime ?? "");
            return !st || !otherSectionStartTimes.has(st);
          }
          return true; // can't determine → keep
        });

        // Step 2: if we still have multiple distinct start times after label+time filtering,
        // use parseCourseHeader's section-time mapping to pick the right one.
        // If that's not available, fall back to matching by section letter in the AI output.
        // Last resort: keep all — the safety valve below handles zero-event scenarios.
        const distinctTimes = new Set(labelFiltered.map((m: any) => String(m?.startTime ?? "")));
        if (distinctTimes.size > 1) {
          // Priority 1: parseCourseHeader gave us the user's section time explicitly
          const userSectionTime = header?.sectionTimes?.[detectedSection]?.startTime;
          if (userSectionTime) {
            const sectionMatched = labelFiltered.filter((m: any) => String(m?.startTime ?? "") === userSectionTime);
            filteredMeetings = sectionMatched.length > 0 ? sectionMatched : labelFiltered;
          } else {
            // Priority 2: the AI labeled meetings with section letters — pick the matching one
            // (Now that we instruct the AI to always label sections, this should be reliable)
            const sectionLetterMatched = labelFiltered.filter((m: any) => {
              const sec = String(m?.section ?? "").trim().toUpperCase();
              return sec === detectedSection;
            });
            if (sectionLetterMatched.length > 0) {
              filteredMeetings = sectionLetterMatched;
            } else {
              // Priority 3: cannot determine — keep all meetings rather than guessing wrong.
              // The user will at minimum see all section times and can edit afterwards.
              // This is safer than arbitrarily picking the last time group (which was often wrong).
              filteredMeetings = labelFiltered;
            }
          }
        } else {
          filteredMeetings = labelFiltered;
        }
      }

      // Safety valve: if section filtering removed ALL meetings but unfiltered had some,
      // fall back to unfiltered set rather than generating zero lecture events.
      // This handles the case where the AI didn't label sections consistently.
      const effectiveMeetings = filteredMeetings.length > 0
        ? filteredMeetings
        : (meetings.length > 0 ? meetings : []);

      const allMeetings = effectiveMeetings.length
        ? effectiveMeetings
        : [{
            title: `${lectureLabel} Lecture`,
            days: header.meetingDays,
            startTime: header.startTime,
            endTime: header.endTime,
            kind: "Lecture",
          }];

      // Fix 1 (PSY-style): If the header inferred specific meeting days (e.g. Wed-only from
      // graded-event weekday signals) and the AI meeting has different/extra days, override with
      // the header's inferred days. This prevents the AI from injecting Mon+Wed when the course
      // is Wednesday-only.
      //
      // Fix 2 (BUS-style): If the user picked a section and parseCourseHeader captured an
      // explicit start/end time for that section (from "Group D: Tue & Thu 13:30-14:50"),
      // override the AI meeting's time with the header's value. The regex-parsed time is more
      // reliable than the AI's extraction for time strings.
      const headerInferredDays = header?.meetingDays;
      const headerSectionTime = detectedSection ? header?.sectionTimes?.[detectedSection] : undefined;

      const patchedMeetings = allMeetings.map((m: any) => {
        const patched = { ...m };

        // Fix 2: override time when header section time is known and reliable
        if (headerSectionTime?.startTime) {
          patched.startTime = headerSectionTime.startTime;
        }
        if (headerSectionTime?.endTime) {
          patched.endTime = headerSectionTime.endTime;
        }

        // Fix 1: override AI days with header-inferred days when we have a strong
        // deterministic signal. The AI frequently hallucinates days from office-hours
        // text or other context — our regex/frequency-based inference is more reliable.
        //
        // We ALWAYS override when `inferredDays` is non-empty (meaning we found a strong
        // signal from either the schedule-date frequency function or Signal 1 graded
        // keywords). We do NOT override if section-specific days were already set (Fix 2).
        if (
          headerInferredDays &&
          headerInferredDays.length > 0 &&
          inferredDays.length > 0 && // strong deterministic signal exists
          !(headerSectionTime?.meetingDays?.length) // don't clobber section-specific days
        ) {
          patched.days = headerInferredDays;
        }

        // Fix 2 (days from section): if the header section regex found explicit days
        // (e.g. "Group D: Tue & Thu 13:30-14:50"), use those days too.
        if (headerSectionTime?.meetingDays && headerSectionTime.meetingDays.length > 0) {
          patched.days = headerSectionTime.meetingDays;
        }

        return patched;
      });

      for (const m of patchedMeetings) {
        const days: string[] = Array.isArray(m?.days) ? m.days : [];
        let keepDays = days.filter((d: any) => typeof d === "string" && dayNames.has(d));
        // If the AI/header didn't give us days but we found explicit meeting dates in the syllabus,
        // use those weekdays as the recurrence pattern.
        if (keepDays.length === 0 && explicitMeetingDays.size > 0) {
          keepDays = Array.from(explicitMeetingDays);
        }
        // If we have an explicit meeting date list, intersect with its weekdays.
        if (explicitMeetingDays.size > 0) {
          const intersect = keepDays.filter((d) => explicitMeetingDays.has(d));
          keepDays = intersect.length ? intersect : Array.from(explicitMeetingDays);
        }
        const startTime = typeof m?.startTime === "string" ? m.startTime : null;
        if (!startTime) continue;
        const endTime = typeof m?.endTime === "string" ? m.endTime : undefined;
        const kind = typeof m?.kind === "string" ? m.kind : "Lecture";
        // User preference: lectures should always be named "<Course Name> Lecture".
        const title = `${lectureLabel} Lecture`;

        const cursor = new Date(rangeStart);
        cursor.setHours(12, 0, 0, 0);

        while (cursor.getTime() <= rangeEnd.getTime()) {
          if (keepDays.includes(weekdayShort(cursor))) {
            if (explicitMeetingDates.size > 0 && !explicitMeetingDates.has(dateToIso(cursor))) {
              cursor.setDate(cursor.getDate() + 1);
              continue;
            }
            // Skip lectures that fall on university holidays / no-class dates.
            // The no-class set is derived from the syllabus itself (Spring Break lines,
            // Holy Week only when mentioned, Feria only when mentioned, Christmas/NY).
            // Graded events (assignments, exams) are NOT subject to this filter — only
            // auto-generated recurring lecture blocks.
            if (isUniversityHoliday(dateToIso(cursor), noClassDates)) {
              cursor.setDate(cursor.getDate() + 1);
              continue;
            }
            meetingEvents.push({
              title,
              date: dateToIso(cursor),
              startTime,
              endTime,
              kind,
              confidence: 0.7,
              source: "recurring meeting pattern",
            });
            if (meetingEvents.length >= MAX_MEETING_EVENTS) break;
          }
          cursor.setDate(cursor.getDate() + 1);
        }
        if (meetingEvents.length >= MAX_MEETING_EVENTS) break;
      }
    }

    const merged = [...meetingEvents, ...cleaned].filter((e) => e && /^\d{4}-\d{2}-\d{2}$/.test(e.date));

    // If an extracted event doesn't specify a time, do NOT default to midnight.
    // For graded items (assignments, journals, due dates): use 23:59 (end of day deadline).
    // For lectures/meetings: use course meeting time if known.
    // If we don't know the meeting time, default to noon (less disruptive than 9am).
    const defaultStart = typeof header?.startTime === "string" ? header.startTime : "12:00";
    const defaultEnd = typeof header?.endTime === "string" ? header.endTime : undefined;
    const gradedKinds = new Set(["Assignment","Quiz","Exam","Project","Paper","Journal","Review","Presentation"]);
    const dueDateDefault = "23:59";

    function addMinutes(hhmm: string, mins: number): string {
      const m = hhmm.match(/^(\d{2}):(\d{2})$/);
      if (!m) return hhmm;
      const h = parseInt(m[1], 10);
      const mm = parseInt(m[2], 10);
      const total = h * 60 + mm + mins;
      const nh = Math.floor((total % (24 * 60)) / 60);
      const nmin = total % 60;
      return `${String(nh).padStart(2, "0")}:${String(nmin).padStart(2, "0")}`;
    }

    const finalized = merged.map((e) => {
      const out = { ...e };
      if (!out.startTime) {
        // Graded items (assignments, journals, etc.) default to end-of-day (11:59pm)
        // unless we know the course meeting time — only lectures use that.
        const isGraded = gradedKinds.has(String(out.kind ?? "")) || looksGraded(out.title ?? "", out.kind);
        const isLecture = String(out.kind ?? "").toLowerCase() === "lecture";
        if (isGraded && !isLecture) {
          out.startTime = dueDateDefault;
        } else if (isLecture && typeof header?.startTime === "string") {
          out.startTime = header.startTime;
        } else {
          out.startTime = defaultStart;
        }
      }
      if (!out.endTime) {
        if (out.startTime === dueDateDefault) {
          out.endTime = "24:00"; // represents midnight
        } else {
          out.endTime = defaultEnd ?? addMinutes(out.startTime, 50);
        }
      }
      return out;
    });

    // If multiple sections were detected and the user hasn't selected one yet,
    // return just the sections list so the client can prompt the user to pick.
    //
    // Detection strategy (in priority order):
    // 1. parseCourseHeader found sectionTimes (regex-based, most reliable for standard format)
    // 2. AI returned meetings with distinct "section" labels (e.g. [{"section":"A",...},{"section":"B",...}])
    // 3. AI returned multiple meetings with distinct start times (strong signal of multi-section course)
    const headerSectionKeys = header?.sectionTimes ? Object.keys(header.sectionTimes) : [];

    // Fallback: detect sections from AI-returned meetings
    let aiSectionKeys: string[] = [];
    if (headerSectionKeys.length < 2 && meetings.length >= 2) {
      // Check for explicit section labels in meetings
      const labeledSections: string[] = [...new Set<string>(
        meetings
          .map((m: any) => String(m?.section ?? "").trim().toUpperCase())
          .filter(Boolean)
      )];
      if (labeledSections.length >= 2) {
        aiSectionKeys = labeledSections.sort();
      } else {
        // Check for multiple distinct start times (strong multi-section signal when no labels)
        const distinctStartTimes: string[] = [...new Set<string>(
          meetings.map((m: any) => String(m?.startTime ?? "")).filter(Boolean)
        )];
        if (distinctStartTimes.length >= 2) {
          // Assign letter labels A, B, C... so the client shows "Section A", "Section B"
          // The client passes back the letter; on the second call the AI prompt forces
          // return of only that section's meetings.
          aiSectionKeys = distinctStartTimes.map((_, i) => String.fromCharCode(65 + i));
        }
      }
    }

    const sectionKeys = headerSectionKeys.length >= 2 ? headerSectionKeys : aiSectionKeys;
    const hasMultipleSections = sectionKeys.length >= 2;
    const userPickedSection = !!(secFromFieldEarly || secFromInstrEarly);

    if (hasMultipleSections && !userPickedSection) {
      return NextResponse.json({
        needsSectionPick: true,
        sections: sectionKeys.sort(),
        course: raw?.course ?? header?.course ?? "",
        meta: {
          detected: seasonHintBase ?? null,
          detectedYear: typeof detectedYear === "number" ? detectedYear : null,
          nowYear,
          needsYearConfirm: false,
        },
      });
    }

    return NextResponse.json({
      course: raw?.course ?? "",
      termStart: start,
      termEnd: end,
      events: finalized,
      meta: {
        detected: seasonHintBase ?? null,
        used: seasonHint ?? null,
        detectedYear: typeof detectedYear === "number" ? detectedYear : null,
        usedYear: typeof usedYear === "number" ? usedYear : null,
        yearOverride: typeof overrideYear === "number" ? overrideYear : null,
        needsYearConfirm,
        nowYear,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Unknown error" }, { status: 500 });
  }
}
