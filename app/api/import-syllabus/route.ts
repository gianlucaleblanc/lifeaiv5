import OpenAI from "openai";
import { NextResponse } from "next/server";

// Lazy imports so the app can still boot even if the user hasn't run `npm install` yet.
async function extractTextFromPdf(buf: Buffer): Promise<string> {
  const mod: any = await import("pdf-parse");
  const pdfParse = mod.default ?? mod;
  const out = await pdfParse(buf);
  return typeof out?.text === "string" ? out.text : "";
}

async function extractTextFromDocx(buf: Buffer): Promise<string> {
  const mod: any = await import("mammoth");
  const mammoth = mod.default ?? mod;
  const out = await mammoth.extractRawText({ buffer: buf });
  return typeof out?.value === "string" ? out.value : "";
}

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const rawModel = process.env.OPENAI_MODEL || "gpt-4o";
const DEFAULT_MODEL = rawModel.trim() || "gpt-4o";

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
function condenseForDates(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const dateish = /(\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b|\b\d{4}-\d{2}-\d{2}\b|\bmon\b|\btue\b|\bwed\b|\bthu\b|\bfri\b|\bsat\b|\bsun\b|\bdue\b|\bexam\b|\bquiz\b|\blecture\b|\bproject\b|\bassignment\b|\bjournal\b|\breading\b|\bsubmit\b|\bdeadline\b|\bhomework\b|\bpaper\b|\bdiscussion\b)/i;

  // Keep date-bearing lines *plus wider context* around them so the model
  // can capture full assignment names (often on the previous/next 2 lines).
  const keepIdx = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (dateish.test(lines[i])) {
      keepIdx.add(i);
      // Keep 2 lines before and 2 lines after for context
      if (i - 1 >= 0) keepIdx.add(i - 1);
      if (i - 2 >= 0) keepIdx.add(i - 2);
      if (i + 1 < lines.length) keepIdx.add(i + 1);
      if (i + 2 < lines.length) keepIdx.add(i + 2);
    }
    if (keepIdx.size >= 1400) break; // cap (indices, not lines)
  }

  const kept = Array.from(keepIdx)
    .sort((a, b) => a - b)
    .map((i) => lines[i])
    .slice(0, 1200);

  // Fallback to the first chunk if heuristics keep too little.
  if (kept.join("\n").length < 2000) {
    return text.slice(0, 30000);
  }
  return kept.join("\n").slice(0, 40000);
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

function looksGraded(title: string, kind?: string, source?: string): boolean {
  const t = `${title ?? ""} ${source ?? ""}`.toLowerCase();
  const k = String(kind ?? "").toLowerCase();
  if (["exam","quiz","assignment","project","paper","midterm","final"].some((x) => k.includes(x))) return true;
  // Keep this strict: A = only graded/required items + class meetings.
  return [
    "due",
    "submit",
    "assignment",
    "homework",
    "hw",
    "problem set",
    "pset",
    "lab report",
    "paper",
    "final paper",
    "quiz",
    "exam",
    "midterm",
    "final",
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
  sectionTimes?: Record<string, { startTime: string; endTime: string }>;
} {
  const out: any = {};
  const codeName = text.match(/\b([A-Z]{2,4}\s?\d{3}[A-Z]?)\s*:\s*([^\n\r]+?)\s*(?:\n|$)/);
  if (codeName) {
    out.course = normalize(codeName[1]);
    out.courseName = normalize(codeName[2]);
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
    const sectionTimes: Record<string, { startTime: string; endTime: string }> = {};
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
        // Compact/common tokens: MW, M/W, Mon/Wed, Monday & Wednesday, etc.
        if (!/(\bmwf\b|\btth\b|\btr\b|mon\b|monday|tue\b|tuesday|wed\b|wednesday|thu\b|thursday|fri\b|friday|sat\b|saturday|sun\b|sunday)/i.test(line)) continue;

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
    /\b(MWF|TTh|TR|Tue\/Thu|Tu\/Th|Mon\/Wed\/Fri|Mon\/Wed|Tue\/Thu|Mon|Tue|Wed|Thu|Fri|Sat|Sun|Mondays?|Tuesdays?|Wednesdays?|Thursdays?|Fridays?|Saturdays?|Sundays?)\b\s*(\d{1,2}:\d{2})\s*(AM|PM)?\s*[–-]\s*(\d{1,2}:\d{2})\s*(AM|PM)?\b[^\n\r]*?/i,
  ];

  const parseTimeGuess24 = (hhmm: string, ampm?: string | null) => {
    const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
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
    const timeRx = /(\d{1,2}:\d{2})\s*(AM|PM|am|pm)?\s*[–-]\s*(\d{1,2}:\d{2})\s*(AM|PM|am|pm)?/;
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
      if (!days || days.length < 2) continue;

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

  // Compact tokens
  if (/\bmwf\b/.test(t) || /mon\s*\/\s*wed\s*\/\s*fri/.test(t)) { add("Mon"); add("Wed"); add("Fri"); return days; }
  if (/\b(tth|tr)\b/.test(t) || /tue\s*\/\s*thu/.test(t) || /tu\s*\/\s*th/.test(t)) { add("Tue"); add("Thu"); return days; }

  // Full/word days (avoid single-letter matches that cause false positives)
  if (/\bmon(day)?s?\b/.test(t)) add("Mon");
  if (/\b(tue|tues|tuesday|tuesdays|tu)\b/.test(t)) add("Tue");
  if (/\bwed(nesday)?s?\b/.test(t)) add("Wed");
  if (/\bthu(rsday)?s?\b/.test(t) || /\bthurs\b/.test(t)) add("Thu");
  if (/\bfri(day)?s?\b/.test(t)) add("Fri");
  if (/\bsat(urday)?s?\b/.test(t)) add("Sat");
  if (/\bsun(day)?s?\b/.test(t)) add("Sun");

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

    // Avoid importing graded items twice: if the title looks like an exam/quiz/assignment,
    // the main extractor will already catch it.
    if (/\b(midterm|final\s+exam|exam|quiz|assignment|project|paper|presentation)\b/i.test(rest)) {
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

function extractTermRangeFromImportantDates(
  text: string,
  seasonYear: { season: any; year: number } | null
): { termStart?: string; termEnd?: string } {
  // Look for explicit term boundary lines often present in university templates.
  // Example: "January 28: First day of classes"; "Monday, May 11 – Last day of class".
  const out: { termStart?: string; termEnd?: string } = {};
  const lower = text.toLowerCase();
  const idx = lower.indexOf("important dates");
  const scope = idx >= 0 ? text.slice(idx, idx + 5000) : text.slice(0, 7000);

  const monthRe = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b\s*(\d{1,2})(?:,?\s*(20\d{2}))?/i;

  function parseMonthDay(line: string): string | null {
    const m = line.match(monthRe);
    if (!m) return null;
    const mon = monthNameToNum(m[1]);
    const day = parseInt(m[2], 10);
    if (!mon || !day) return null;
    const explicitYear = m[3] ? parseInt(m[3], 10) : null;
    const year = explicitYear ?? inferYearForMonthDay(mon, day, seasonYear);
    return mmddToIso(mon, day, year);
  }

  const lines = scope.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const l = line.toLowerCase();
    if (!out.termStart && (l.includes("first day of classes") || l.includes("classes begin") || l.includes("start of classes"))) {
      const iso = parseMonthDay(line);
      if (iso) out.termStart = iso;
    }
    if (!out.termEnd && (l.includes("last day of class") || l.includes("last day of classes") || l.includes("classes end"))) {
      const iso = parseMonthDay(line);
      if (iso) out.termEnd = iso;
    }
  }

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
    if (lower.endsWith(".pdf") || f.type === "application/pdf") {
      // pdf parsing can be slow; keep it bounded
      text = await withTimeout(extractTextFromPdf(buf), 20000);
    } else if (lower.endsWith(".docx") || f.type.includes("wordprocessingml")) {
      text = await withTimeout(extractTextFromDocx(buf), 15000);
    } else {
      // Best-effort: treat as plain text
      text = buf.toString("utf8");
    }

    if (!text || text.trim().length < 50) {
      return NextResponse.json(
        { error: "Could not read text from that file (it may be scanned or empty)." },
        { status: 400 }
      );
    }

    // Keep prompt size bounded and focused on date-bearing content.
    const clipped = condenseForDates(text);

    const system = `You are LifeOS, an advanced academic calendar extraction system. Your job is to extract EVERY meaningful event from this syllabus with maximum coverage and accuracy.

Return ONLY valid JSON. No markdown, no explanations.

Schema:
{
  "course": string,
  "termStart"?: "YYYY-MM-DD",
  "termEnd"?: "YYYY-MM-DD",
  "meetings"?: Array<{
    "title"?: string,
    "days": Array<"Mon"|"Tue"|"Wed"|"Thu"|"Fri"|"Sat"|"Sun">,
    "startTime": "HH:MM",
    "endTime"?: "HH:MM",
    "kind"?: "Lecture"|"Lab"|"Discussion"|"OfficeHours"|"Seminar"
  }>,
  "events": Array<{
    "title": string,
    "date": "YYYY-MM-DD",
    "startTime"?: "HH:MM",
    "endTime"?: "HH:MM",
    "kind"?: "Exam"|"Assignment"|"Quiz"|"Project"|"Paper"|"Journal"|"Reading"|"Discussion"|"Presentation"|"Review"|"Other",
    "confidence"?: number,
    "source"?: string
  }>
}

CRITICAL EXTRACTION RULES:

1. GRADED ITEMS - Extract EVERY deadline with maximum completeness:
   ✓ Journals, reflections, reading responses, annotations (EACH individually numbered entry)
   ✓ Homework, problem sets, worksheets, exercises
   ✓ Essays, papers, drafts, outlines, proposals, bibliographies, revisions
   ✓ Quizzes, exams, midterms, finals, tests
   ✓ Projects, presentations, proposals, milestones, checkpoints
   ✓ Peer reviews, critiques, feedback assignments
   ✓ Discussion posts, forum responses, contributions
   ✓ Lab reports, field notes, case studies
   ✓ Dossiers, portfolios, compilations
   ✓ ANYTHING with: "due", "submit", "turn in", "upload", "post", "complete by", "deadline"

2. JOURNAL/NUMBERED ENTRIES - Pay MAXIMUM attention:
   - Patterns like "Journal Entry 1", "JE1", "Reading Response 1-4", "Weekly Journal 1-10"
   - If text says "Journal Entries 1-10 due on Fridays", create 10 SEPARATE events
   - Extract EVERY numbered entry individually (Journal 1, Journal 2, Journal 3, ...)
   - Common formats: "Journal 1-10", "JE 1, 2, 3...", "Journals (weekly)"
   - Each numbered item = one calendar event

3. DATE EXTRACTION - Be maximally flexible:
   - Formats: "Jan 15", "1/15/2025", "January 15th", "15-Jan", "Week 3 Friday", "Fridays starting Jan 10"
   - Ranges: "Jan 15-20" → use END date (Jan 20)
   - Weekly patterns: "Every Friday" → extract individual dates
   - Relative: "Week 3" → calculate from term start
   - Tables: extract dates from schedule tables even if messy

4. TIME DETECTION - Extract when present:
   - Formats: "2:30pm", "14:30", "2:30 PM", "230pm", "2:30p", "14.30"
   - If clearly stated, include startTime
   - If missing, leave null (don't guess)

5. RECURRING MEETINGS - Critical for lectures:
   - Extract patterns: "MW 10:00-11:15", "MWF 9am", "Tuesdays & Thursdays 2-3:15pm"
   - Day abbreviations: M/Mo/Mon, T/Tu/Tue, W/We/Wed, Th/Thu/R, F/Fr/Fri, Sa/Sat, Su/Sun
   - Common: "MWF", "TTh", "TR", "MW", "TuTh"
   - Must extract meeting days AND time

6. TITLE EXTRACTION - Be literal and precise:
   - Use exact wording from syllabus: "Dossier 1", "Final Paper Part 2", "Quiz 3"
   - Preserve numbering: "Journal Entry 4", not just "Journal Entry"
   - Include descriptive details when clear

7. CONFIDENCE SCORING:
   - 1.0 = Explicit date + clear graded item ("Journal 4 due Jan 15")
   - 0.8-0.9 = Clear date, reasonable title inference
   - 0.6-0.7 = Extracted from schedule table with minor ambiguity
   - 0.4-0.5 = Weak signal (week-based, vague reference)

MANDATORY BEHAVIORS:
- Extract EVERYTHING that might be calendar-worthy (completeness > perfection)
- For numbered series (Journals 1-10), create separate events for EACH number
- Be extremely careful with journals - students often miss these
- Include source snippets so users can verify extraction
- Use ISO dates (YYYY-MM-DD format)
- Don't invent dates - only extract what's clearly stated or inferable

This is an academic calendar tool. Missing a deadline could harm a student's grade. Extract comprehensively.`;

    const user = `USER INSTRUCTIONS (optional):\n${instructions || "(none)"}\n\nSYLLABUS TEXT (clipped):\n\n${clipped}`;

    // Use Chat Completions API exclusively for reliability
    const cc = await withTimeout(
      client.chat.completions.create({
        model: DEFAULT_MODEL,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      })
    );
    const raw = safeJsonParse(cc.choices?.[0]?.message?.content ?? "{}");

    const events = Array.isArray(raw?.events) ? raw.events : [];
    const meetings = Array.isArray(raw?.meetings) ? raw.meetings : [];

    // Parse a few high-signal fields directly from the raw text to improve reliability
    // across messy exports (especially table-heavy DOCX syllabi).
    const header = parseCourseHeader(text);

    // If the user provided section/group preference (e.g., "Section B" or "Group A"), apply the correct time window.
    {
      const secFromField = sectionPrefRaw.match(/^[A-Za-z]$/) ? sectionPrefRaw.toUpperCase() : "";

      // Instructions can come from the big prompt box and commonly look like:
      //  - "I'm in Section B"
      //  - "Group A"
      //  - "im in group c"
      // Make this tolerant and prefer explicit mentions.
      const secFromInstr = (
        instructions.match(/\b(?:section|group)\s*([A-Za-z])\b/i)?.[1] ||
        instructions.match(/\b(?:i\s*am|i'?m|im)\s+in\s+(?:the\s+)?(?:section|group)?\s*([A-Za-z])\b/i)?.[1] ||
        ""
      ).toUpperCase();

      const sec = (secFromField || secFromInstr || "A").toUpperCase();
      if (header?.sectionTimes && header.sectionTimes[sec]) {
        header.startTime = header.sectionTimes[sec].startTime;
        header.endTime = header.sectionTimes[sec].endTime;
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

    // If no explicit meeting days, use boundary hints.
    if (existing.length === 0 && boundary.length > 0) {
      header.meetingDays = boundary;
    }

    // If we only have one explicit meeting day but boundary hints show another weekday,
    // add it (common for Mon/Wed or Tue/Thu courses).
    if (existing.length === 1 && boundary.length >= 2) {
      const merged = new Set(existing);
      for (const d of boundary) merged.add(d);
      header.meetingDays = Array.from(merged);
    }

    // Course label used for lecture naming.
    const courseCode = normalize(String(header?.course ?? raw?.course ?? "")).trim();
    const courseName = normalize(String(header?.courseName ?? "")).trim();
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
      .filter((e: any) => looksGraded(e.title, e.kind, e.source));

    // Deterministic heuristics for table-heavy syllabi:
    // - pull "Due Today" items from a course schedule table
    // - pull explicit final due date lines
    const heuristicRaw = [
      ...extractTableLikeDueItems(text, seasonHint as any, header?.startTime),
      ...extractJournalDueItems(text, seasonHint as any, header?.startTime),
    ];
    const cleanedHeuristic = heuristicRaw
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
      .filter((e: any) => looksGraded(e.title, e.kind, e.source));

    const includeLectures = (() => {
      const ins = String(instructions ?? "").toLowerCase();
      if (/\b(no|exclude|without)\s+lectures?\b/.test(ins)) return false;
      // Default behavior for syllabi: include lectures unless the user explicitly excludes them.
      return true;
    })();

    // Deterministic lecture extraction from course schedule sections.
    // This is crucial for syllabi where every lecture date/topic is listed.
    // IMPORTANT:
    // If we already have a clean recurring meeting pattern (days + time), we do NOT need
    // to also scrape a "course schedule" section for lecture dates. Doing both often causes
    // duplicate/incorrect lecture events on a handful of dates (e.g., extracting just a few
    // date tokens from a schedule table and treating them as lectures).
    // In that common case, we rely on the recurring meeting expansion instead.
    const hasReliableRecurringMeeting = !!(header?.meetingDays?.length && header?.startTime);
    const lectureRaw = includeLectures && !hasReliableRecurringMeeting
      ? extractCourseScheduleLectures(text, seasonHint as any, header?.startTime, header?.endTime)
      : [];
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

    // Merge AI + heuristic + lecture events.
    // Pass 1: dedupe by date+title (exact duplicate).
    // Heuristic results take priority over AI (more reliable for journals/tables).
    const key = (e: any) => `${e.date}::${String(e.title ?? "").toLowerCase()}`;
    const byKey = new Map<string, any>();
    for (const e of [...cleanedLectures, ...cleanedHeuristic, ...cleanedAi]) {
      if (!e?.title || !/^\d{4}-\d{2}-\d{2}$/.test(e.date)) continue;
      const k = key(e);
      if (!byKey.has(k)) byKey.set(k, e);
    }
    const afterPass1 = Array.from(byKey.values());

    // Pass 2: for graded items, dedupe by TITLE ONLY.
    // This prevents "Submit Journal 3" appearing twice on different dates
    // when the AI and heuristic disagree on the exact due date.
    // Prefer the higher-confidence entry; if tied, prefer heuristic (added first above).
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
        if ((e.confidence ?? 0) > (existing.confidence ?? 0)) {
          byTitle.set(tkey, e);
        }
      }
    }
    const cleaned = Array.from(byTitle.values());

    // Expand recurring meetings into individual dated events so the client can add them easily.
    const termStartIso = typeof raw?.termStart === "string" ? maybeFixYear(raw.termStart) : undefined;
    const termEndIso = typeof raw?.termEnd === "string" ? maybeFixYear(raw.termEnd) : undefined;

    const startCandidates = [termStartIso, ...cleaned.map((e) => e.date)].filter(Boolean) as string[];
    const endCandidates = [termEndIso, ...cleaned.map((e) => e.date)].filter(Boolean) as string[];

    let start = startCandidates.sort()[0];
    let end = endCandidates.sort().slice(-1)[0];

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

    if (
      includeLectures &&
      sd &&
      ed &&
      (meetings.length || (header?.meetingDays?.length && header?.startTime) || (explicitMeetingDays.size > 0 && header?.startTime))
    ) {
      // Normalize range order
      const rangeStart = sd.getTime() <= ed.getTime() ? sd : ed;
      const rangeEnd = sd.getTime() <= ed.getTime() ? ed : sd;

      const MAX_MEETING_EVENTS = 450;
      const dayNames = new Set(["Mon","Tue","Wed","Thu","Fri","Sat","Sun"]);

      const allMeetings = meetings.length
        ? meetings
        : [{
            title: `${lectureLabel} Lecture`,
            days: header.meetingDays,
            startTime: header.startTime,
            endTime: header.endTime,
            kind: "Lecture",
          }];

      for (const m of allMeetings) {
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
        const isGraded = gradedKinds.has(String(out.kind ?? "")) || looksGraded(out.title ?? "", out.kind, out.source);
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
