"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  addSyllabusEventsToCalendar,
  addToHistory,
  loadCalendar,
  saveCalendar,
  loadCustomEventKeywords,
  addCustomEventKeyword,
  applyApprovedPlanBlocks,
  previewCalendarFromHistory,
  loadPreferences,
  savePreferences,
  loadFeedback,
  addFeedback,
  buildPreferenceContext,
  loadOnboardingProfile,
  type CalendarBlock,
  type CalendarMergePreview,
  type HistoryItem,
  type Plan,
  type SyllabusEvent,
  type FeedbackSignal,
  type FeedbackEntry,
  type UserPreferences,
} from "./lib/storage";

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────
type SuggestedBlock = {
  title: string;
  date: string;
  startMin: number;
  endMin: number;
  kind: string;
  reason?: string;
};

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

// generateId() is not available in all browsers (e.g. Firefox < 92, some Safari).
// Fall back to a Math.random-based UUID v4 when unavailable.
function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function minutesToTime(min: number) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const ampm = h < 12 ? "AM" : "PM";
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function clampMinutes(n: number) {
  return Math.max(1, Math.min(1440, Math.round(n)));
}

// ─────────────────────────────────────────────────────────────
// Full-screen loading overlay (Duolingo-style)
// ─────────────────────────────────────────────────────────────
const GENERATING_MESSAGES = [
  "Building your plan…",
  "Thinking about your day…",
  "Scheduling around your life…",
  "Finding the best slots…",
  "Almost there…",
];

const SUGGESTIONS_MESSAGES = [
  "Finding smart suggestions…",
  "Looking at what fits…",
  "Personalizing for you…",
  "One sec…",
];

const SYLLABUS_MESSAGES = [
  "Reading your syllabus…",
  "Extracting dates and deadlines…",
  "Finding your exams and assignments…",
  "Mapping out the semester…",
  "Almost there…",
];

const TIME_MESSAGES = [
  "Pick your time…",
  "When works best?",
  "Choose a slot…",
];

function AnimatedOrb({ color = "var(--lifeos-pink)", icon = "✦" }: { color?: string; icon?: string }) {
  return (
    <div className="relative flex items-center justify-center" style={{ width: 120, height: 120 }}>
      {/* Outer ripple rings */}
      {[0, 1, 2].map((i) => (
        <motion.div
          key={i}
          className="absolute rounded-full"
          style={{ border: `2px solid ${color}`, width: 120, height: 120, opacity: 0 }}
          animate={{ scale: [1, 2.2], opacity: [0.35, 0] }}
          transition={{ duration: 1.8, delay: i * 0.6, repeat: Infinity, ease: "easeOut" }}
        />
      ))}
      {/* Core orb */}
      <motion.div
        className="relative z-10 flex items-center justify-center rounded-full text-white text-3xl font-extrabold shadow-[0_8px_32px_rgba(255,107,107,0.45)]"
        style={{ width: 80, height: 80, background: color }}
        animate={{ scale: [1, 1.07, 1] }}
        transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
      >
        {icon}
      </motion.div>
    </div>
  );
}

function FullScreenLoader({ visible, messages, icon = "✦", color = "var(--lifeos-pink)" }: {
  visible: boolean;
  messages: string[];
  icon?: string;
  color?: string;
}) {
  const [msgIdx, setMsgIdx] = useState(0);

  useEffect(() => {
    if (!visible) { setMsgIdx(0); return; }
    const t = setInterval(() => setMsgIdx((i) => (i + 1) % messages.length), 1600);
    return () => clearInterval(t);
  }, [visible, messages.length]);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="fs-loader"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-[300] flex flex-col items-center justify-center bg-white"
        >
          <AnimatedOrb color={color} icon={icon} />

          <motion.div
            key={msgIdx}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.35 }}
            className="mt-8 text-lg font-extrabold text-black"
            style={{ letterSpacing: "-0.02em" }}
          >
            {messages[msgIdx]}
          </motion.div>

          {/* Bouncing dots */}
          <div className="mt-4 flex items-center gap-1.5">
            {[0, 1, 2].map((i) => (
              <motion.div
                key={i}
                className="h-2 w-2 rounded-full"
                style={{ background: color }}
                animate={{ y: [0, -8, 0] }}
                transition={{ duration: 0.7, delay: i * 0.15, repeat: Infinity, ease: "easeInOut" }}
              />
            ))}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// Generating overlay — external hold so React batching doesn't swallow the show+hide
function GeneratingOverlay({ visible }: { visible: boolean }) {
  return <FullScreenLoader visible={visible} messages={GENERATING_MESSAGES} icon="✦" />;
}

// Syllabus overlay — shows during PDF/DOCX parsing, minimum 600ms so it doesn't flash
function SyllabusLoadingOverlay({ visible }: { visible: boolean }) {
  const [held, setHeld] = useState(false);
  const shownAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const MIN_MS = 600;

  useEffect(() => {
    if (visible) {
      if (timer.current) clearTimeout(timer.current);
      shownAt.current = Date.now();
      setHeld(true);
    } else {
      const remaining = Math.max(0, MIN_MS - (Date.now() - shownAt.current));
      timer.current = setTimeout(() => setHeld(false), remaining);
    }
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [visible]);

  return <FullScreenLoader visible={held} messages={SYLLABUS_MESSAGES} icon="📎" color="var(--lifeos-pink)" />;
}

// Suggestions overlay — own 500ms minimum hold
function SuggestionsLoadingOverlay({ visible }: { visible: boolean }) {
  const [held, setHeld] = useState(false);
  const shownAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const MIN_MS = 500;

  useEffect(() => {
    if (visible) {
      if (timer.current) clearTimeout(timer.current);
      shownAt.current = Date.now();
      setHeld(true);
    } else {
      const remaining = Math.max(0, MIN_MS - (Date.now() - shownAt.current));
      timer.current = setTimeout(() => setHeld(false), remaining);
    }
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [visible]);

  return <FullScreenLoader visible={held} messages={SUGGESTIONS_MESSAGES} icon="✨" color="var(--lifeos-pink)" />;
}

// ─────────────────────────────────────────────────────────────
// Massive Event Keyword List
// ─────────────────────────────────────────────────────────────
const DEFAULT_EVENT_KEYWORDS = [
  // Transportation & Travel
  "flight","airport","boarding","takeoff","landing","plane","aircraft","airline","check-in","gate","terminal",
  "train","subway","metro","bus","taxi","uber","lyft","rideshare","car service","shuttle","ferry","boat","cruise","ship",
  "drive","pickup","drop-off","drop off","carpool","road trip","commute","transit",
  "depart","departure","arrive","arrival","layover","connection","passport","customs","baggage","luggage",

  // Lodging & Accommodation
  "hotel","hostel","airbnb","motel","inn","resort","lodge","check in","checkout","check-in","check-out",
  "reservation","booking","stay","accommodation","suite","rental","villa","cabin","campsite","camping",

  // Food & Dining
  "dinner","lunch","breakfast","brunch","snack","meal","coffee","tea","drinks","happy hour","cocktails",
  "restaurant","cafe","diner","bistro","bar","pub","brewery","food truck","takeout","delivery","catering",
  "date","table","dining","tasting","wine tasting","sushi","pizza","buffet",

  // Entertainment & Social
  "party","celebration","birthday","anniversary","wedding","reception","shower","bachelorette","bachelor","engagement",
  "concert","show","performance","play","theater","theatre","musical","opera","ballet","dance","comedy","standup",
  "movie","cinema","film","screening","premiere","streaming","watch party",
  "game","match","tournament","competition","race","sporting event","championship","playoff","finals",
  "festival","fair","carnival","expo","convention","conference","summit","symposium","seminar",
  "meetup","hangout","gathering","get-together","reunion","visit","catch up","coffee chat",
  "clubbing","nightlife","bar hop","karaoke","bowling","escape room","arcade","mini golf","go kart",

  // Health & Medical
  "appointment","doctor","dentist","dental","orthodontist","physician","checkup","check-up","physical","annual",
  "therapy","counseling","psychiatrist","psychologist","chiropractor","acupuncture","massage","reflexology",
  "physio","physical therapy","pt","ot","occupational therapy","speech therapy","nutritionist","dietitian",
  "hospital","clinic","urgent care","emergency room","er","surgery","procedure","test","scan","x-ray","mri","ct scan",
  "pharmacy","prescription","vaccine","vaccination","shot","immunization","blood work","lab","bloodwork",
  "eye doctor","optometrist","ophthalmologist","glasses","contacts","hearing test","audiologist",

  // Work & Professional
  "meeting","call","zoom","video call","phone call","conference call","standup","stand-up","sync","check-in",
  "interview","job interview","screening","onboarding","orientation","training","workshop",
  "presentation","pitch","demo","client meeting","team meeting","one-on-one","1:1","review","performance review",
  "office hours","consultation","networking","event","career fair","job fair",
  "deadline","submission","deliverable","milestone","sprint planning","retro","retrospective","sprint review",
  "work","shift","job","office","business","client","customer","vendor","contract","negotiation",
  "signing","notary","legal","lawyer","attorney","court","hearing","deposition",

  // Education & Learning
  "class","lecture","seminar","workshop","webinar","tutorial","lesson","session","course","module",
  "lab","discussion","recitation","office hours","study group","tutoring","tutoring session",
  "exam","test","midterm","final","quiz","assessment","evaluation","proctored","sat","act","gre","gmat","lsat","mcat",
  "assignment","homework","hw","problem set","pset","essay","paper","project","presentation","report",
  "research","thesis","dissertation","defense","proposal","study","review","cram","practice test",
  "graduation","ceremony","convocation","orientation","registration","enrollment","advising",
  "field trip","school trip","tour","campus tour","college visit","open house",

  // Fitness & Wellness
  "workout","exercise","training","gym","fitness","lift","lifting","weights","cardio","strength",
  "run","jog","running","jogging","marathon","5k","10k","half marathon","sprint","track",
  "walk","walking","hike","hiking","trail","backpacking","camping","trek",
  "swim","swimming","lap swim","pool","open water","triathlon",
  "bike","biking","cycling","ride","spin class","peloton","mountain bike",
  "yoga","pilates","barre","zumba","aerobics","crossfit","bootcamp","circuit training","hiit","tabata",
  "practice","rehearsal","drill","scrimmage","warmup","cooldown","stretch","stretching","foam roll",
  "sports","basketball","soccer","football","tennis","golf","volleyball","baseball","hockey","lacrosse",
  "rugby","cricket","badminton","squash","racquetball","handball","fencing","wrestling","judo","karate","bjj",
  "climbing","rock climbing","bouldering","surfing","snowboarding","skiing","ice skating","roller skating",

  // Creative & Production
  "shoot","photoshoot","photo shoot","video shoot","filming","recording","session","studio",
  "rehearsal","practice","soundcheck","performance","gig","set","show","concert","open mic",
  "edit","editing","post-production","mixing","mastering","color grading","voice over",
  "audition","casting","callback","headshot","portfolio","shoot",
  "draw","paint","sketch","design","create","make","build","craft","art","gallery","exhibit",
  "write","writing","draft","manuscript","book club","poetry","slam",

  // Errands & Chores
  "errand","chore","task","to-do","shopping","groceries","grocery shopping","market","farmer's market",
  "laundry","dry cleaning","cleaning","tidy","organize","declutter","deep clean","mop","vacuum",
  "bank","atm","post office","shipping","mail","package","ups","fedex","usps","dhl",
  "pharmacy","drugstore","hardware store","home depot","target","walmart","costco","trader joes","whole foods",
  "haircut","hair appointment","salon","barber","nails","manicure","pedicure","spa","facial","waxing","threading",
  "car wash","oil change","mechanic","repair","maintenance","service","inspection","dmv","registration","tire",
  "vet","veterinarian","groomer","pet sitting","dog walker","dog park","kennel","boarding",
  "plumber","electrician","handyman","contractor","install","delivery","furniture","movers","moving",

  // Tours & Activities
  "tour","guided tour","walking tour","museum","gallery","exhibit","exhibition","attraction","landmark",
  "sightseeing","visit","explore","excursion","outing","day trip","adventure","nature","wildlife",
  "zoo","aquarium","park","botanical garden","amusement park","theme park","water park",
  "escape room","axe throwing","pottery","cooking class","wine tasting","beer tasting","distillery tour",
  "ski","skiing","snowboard","ice skating","roller skating","skating rink","trampoline park","laser tag","paintball",
  "auschwitz","museum visit","historical site","monument","cathedral","church tour","art museum","science museum",

  // Personal & Lifestyle
  "birthday","anniversary","holiday","celebration","gather","family","friends","social","party",
  "meditation","mindfulness","breathwork","journaling","reading","book","library",
  "volunteer","volunteering","community service","charity","fundraiser","donation","nonprofit",
  "church","service","mass","prayer","religious service","temple","mosque","synagogue","worship",
  "vote","voting","election","poll","ballot","caucus",
  "move","moving","relocation","packing","unpacking","inspection","walkthrough","open house",
  "babysit","babysitting","childcare","daycare","pickup","drop-off","playdate","school pickup",
  "sleep","nap","rest","bedtime","wake up","alarm","recovery",
  "passport","visa","immigration","customs","renewal","application","appointment",
  "taxes","accountant","financial advisor","insurance","mortgage","closing","notary",
];

// ─────────────────────────────────────────────────────────────
// Parsing utilities
// ─────────────────────────────────────────────────────────────
// Keyword → default duration (minutes) when no explicit duration is given
const KEYWORD_DURATION_DEFAULTS: Record<string, number> = {
  // Short activities
  "call": 15, "phone call": 15, "quick call": 15,
  "coffee": 30, "coffee chat": 30, "coffee break": 15,
  "standup": 15, "stand-up": 15, "sync": 30, "check-in": 30,
  "errand": 30, "quick errand": 20,
  // Medium activities
  "meeting": 60, "team meeting": 60, "one-on-one": 30, "1:1": 30,
  "lunch": 60, "brunch": 90, "breakfast": 45,
  "interview": 60, "job interview": 60,
  "appointment": 60, "doctor": 60, "dentist": 60,
  "yoga": 60, "pilates": 60, "barre": 60,
  "class": 75, "lecture": 75, "seminar": 90,
  "workshop": 120, "session": 60, "tutorial": 60,
  "run": 45, "jog": 30, "jogging": 30, "running": 45,
  "walk": 30, "walking": 30, "hike": 120, "hiking": 120,
  "bike": 60, "biking": 60, "cycling": 60,
  "swim": 45, "swimming": 45,
  "gym": 60, "workout": 60, "exercise": 45, "cardio": 45,
  "lift": 60, "lifting": 60, "weights": 60,
  "crossfit": 60, "bootcamp": 60, "hiit": 30, "tabata": 30,
  // Longer activities
  "dinner": 90, "date": 120,
  "study": 90, "studying": 90, "homework": 60, "hw": 60,
  "work": 120, "shift": 480,
  "presentation": 30, "pitch": 60, "demo": 60,
  "therapy": 60, "counseling": 60,
  "flight": 180, "drive": 60, "commute": 30,
};

function parseDurationMinutes(text: string): number | null {
  const t = text.toLowerCase();

  // Combined: "1 hour 30 minutes", "2hrs 15min", "1h 45m"
  const combined = t.match(/(\d+)\s*(?:hours?|hrs?|h)\s+(?:and\s+)?(\d+)\s*(?:minutes?|mins?|min|m)\b/);
  if (combined) {
    return clampMinutes(parseInt(combined[1], 10) * 60 + parseInt(combined[2], 10));
  }

  // Hours: "for 2 hours", "2h", "1.5 hours", "2.5h", "2 1/2 hours"
  const h = t.match(/(?:for\s+)?(\d+(?:\.\d+)?|\d+\s*1\/2)\s*(?:hours?|hrs?|h)\b/);
  if (h) {
    const val = h[1].includes("1/2")
      ? parseFloat(h[1].replace(/\s*1\/2/, ".5"))
      : parseFloat(h[1]);
    return clampMinutes(val * 60);
  }

  // Minutes: "90 minutes", "for 30 mins", "45min", "30m"
  const m = t.match(/(?:for\s+)?(\d+)\s*(?:minutes?|mins?|min)\b/);
  if (m) return clampMinutes(parseInt(m[1], 10));

  // Bare numbers when preceded by "for/about/around": "run for 2" → 2 hours
  const bare = t.match(/\b(?:for|about|around|roughly)\s+(\d+(?:\.\d+)?)\b(?!\s*(?:days?|weeks?|months?))/);
  if (bare) {
    const val = parseFloat(bare[1]);
    if (val >= 1 && val <= 24) return clampMinutes(val * 60);
    if (val >= 25 && val <= 1440) return clampMinutes(val);
  }

  // Keyword-based smart defaults — longest match wins
  const sortedKws = Object.keys(KEYWORD_DURATION_DEFAULTS).sort((a, b) => b.length - a.length);
  for (const kw of sortedKws) {
    if (t.includes(kw)) return KEYWORD_DURATION_DEFAULTS[kw];
  }

  return null;
}

function normalizeTimeGuess(rawHour: number, rawMin: number, context: string) {
  const t = context.toLowerCase();
  const hasAM = /\bam\b/.test(t) || /\bmorning\b/.test(t) || /\b(early|wake|breakfast)\b/.test(t);
  const hasPM = /\bpm\b/.test(t) || /\bevening\b/.test(t) || /\bnight\b/.test(t) || /\bafternoon\b/.test(t) || /\b(dinner|late|tonight)\b/.test(t);

  let hour = rawHour;
  const minute = rawMin;

  if (hour === 24) hour = 0;

  // Handle explicit AM/PM
  if (hasAM && hour === 12) hour = 0;
  if (hasPM && hour < 12) hour += 12;
  if (hasAM && hour > 12) hour = hour % 12;

  // Smart heuristic for times without AM/PM
  if (!hasAM && !hasPM) {
    if (hour >= 1 && hour <= 6) {
      hour += 12; // 1-6 without AM/PM → PM (most common)
    } else if (hour >= 7 && hour <= 11) {
      // 7-11 → AM unless context suggests PM
      if (/\b(lunch|afternoon|class|work|office)\b/.test(t)) hour += 12;
    }
    // 12 = noon, 13-23 already 24h
  }

  return { hour, minute };
}

function parseTimeHM(text: string): { hour: number; minute: number } | null {
  const t = text.toLowerCase();

  // "10:30am", "2:30 PM", "10:30 am" — explicit AM/PM with colon
  const m1a = t.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)\b/);
  if (m1a) {
    let h = parseInt(m1a[1], 10);
    const mi = parseInt(m1a[2], 10);
    const ap = m1a[3];
    if (h === 12 && ap === "am") h = 0;
    else if (ap === "pm" && h < 12) h += 12;
    if (h >= 0 && h <= 24 && mi >= 0 && mi <= 59) return { hour: h, minute: mi };
  }

  // "10am", "2pm", "10 am", "2 pm" — bare hour with AM/PM
  const m1b = t.match(/\b(\d{1,2})\s*(am|pm)\b/);
  if (m1b) {
    let h = parseInt(m1b[1], 10);
    const ap = m1b[2];
    if (h === 12 && ap === "am") h = 0;
    else if (ap === "pm" && h < 12) h += 12;
    if (h >= 0 && h <= 24) return { hour: h, minute: 0 };
  }

  // "2:30", "10:30", "14:05", "2.30" — no AM/PM
  const m2 = t.match(/\b(\d{1,2})[:\.](\d{2})\b/);
  if (m2) {
    const h = parseInt(m2[1], 10);
    const mi = parseInt(m2[2], 10);
    if (h >= 0 && h <= 24 && mi >= 0 && mi <= 59) return normalizeTimeGuess(h, mi, t);
  }

  // "230pm", "1030am", "1430" — digits only
  // IMPORTANT: only parse bare 4-digit numbers as times if AM/PM is present,
  // or if they look like a valid 24h time (≤2359) AND are NOT a plausible year (1900–2199).
  const m3 = t.match(/\b(\d{3,4})\s*(am|pm)?\b/);
  if (m3 && !/\d{5}/.test(m3[0])) {
    const num = m3[1];
    const ap = m3[2] ?? "";
    // Skip 4-digit numbers that look like calendar years (e.g. 2027 in "May 15, 2027")
    if (num.length === 4 && !ap) {
      const asYear = parseInt(num, 10);
      if (asYear >= 1900 && asYear <= 2199) {
        // This is a year, not a time — skip
      } else {
        let h = parseInt(num.substring(0, 2), 10);
        const mi = parseInt(num.substring(2), 10);
        if (h >= 0 && h <= 24 && mi >= 0 && mi <= 59) {
          return normalizeTimeGuess(h, mi, t);
        }
      }
    } else if (num.length === 4 && ap) {
      let h = parseInt(num.substring(0, 2), 10);
      const mi = parseInt(num.substring(2), 10);
      if (ap === "pm" && h < 12) h += 12;
      if (ap === "am" && h === 12) h = 0;
      if (h >= 0 && h <= 24 && mi >= 0 && mi <= 59) return { hour: h, minute: mi };
    } else if (num.length === 3) {
      let h = parseInt(num[0], 10);
      const mi = parseInt(num.substring(1), 10);
      if (ap === "pm" && h < 12) h += 12;
      if (ap === "am" && h === 12) h = 0;
      if (h >= 0 && h <= 24 && mi >= 0 && mi <= 59) {
        if (!ap) return normalizeTimeGuess(h, mi, t);
        return { hour: h, minute: mi };
      }
    }
  }

  // "at 2", "at 10" (bare hours with "at")
  const m4 = t.match(/\bat\s+(\d{1,2})\b(?!\s*(?:am|pm|\.|:))/);
  if (m4) {
    const h = parseInt(m4[1], 10);
    if (h >= 0 && h <= 24) return normalizeTimeGuess(h, 0, t);
  }

  return null;
}

function parseDateISOFromText(text: string): string | null {
  const t = text.toLowerCase();
  const now = new Date();

  // addLocalDays: always operates on local calendar days, returns YYYY-MM-DD string.
  function addLocalDays(base: Date, n: number): string {
    const x = new Date(base);
    x.setDate(x.getDate() + n);
    return localDateISO(x);
  }

  // ── Relative offsets — MUST come before bare today/tomorrow checks ──
  //
  // Helper: add calendar months without drifting (e.g. Jan 31 + 1 month → Feb 28, not Mar 3)
  function addLocalMonths(base: Date, n: number): string {
    const x = new Date(base);
    const targetMonth = x.getMonth() + n;
    x.setMonth(targetMonth);
    // If the day overflowed (e.g. Jan 31 → Mar 3), roll back to last day of target month
    const expectedMonth = ((targetMonth % 12) + 12) % 12;
    if (x.getMonth() !== expectedMonth) x.setDate(0); // setDate(0) = last day of prev month
    return localDateISO(x);
  }

  // Resolve an anchor keyword ("today", "tomorrow", or a weekday name/abbrev) to a Date object
  function resolveAnchor(word: string): Date {
    const w = word.toLowerCase();
    if (w === "today") return new Date(now);
    if (w === "tomorrow") { const d = new Date(now); d.setDate(d.getDate() + 1); return d; }
    // weekday
    const weekdaysFull = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
    const shortMap: Record<string,string> = {
      mon:"monday", tue:"tuesday", wed:"wednesday",
      thu:"thursday", fri:"friday", sat:"saturday", sun:"sunday",
    };
    const full     = weekdaysFull.includes(w) ? w : (shortMap[w] ?? w);
    const target   = weekdaysFull.indexOf(full);
    const curr     = now.getDay();
    let delta      = target - curr;
    if (delta <= 0) delta += 7; // always next occurrence
    const d = new Date(now);
    d.setDate(d.getDate() + delta);
    return d;
  }

  const ANCHOR_PAT = "today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun";

  // Pattern A: "X months/weeks/days from today/tomorrow/[weekday]"
  // e.g. "1 month from today", "2 months from now", "3 weeks from wednesday"
  const mFromAnchor = t.match(
    new RegExp(`\\b(\\d+)\\s+(month|week|day)s?\\s+from\\s+(${ANCHOR_PAT}|now)\\b`, "i")
  );
  if (mFromAnchor) {
    const n    = parseInt(mFromAnchor[1], 10);
    const unit = mFromAnchor[2].toLowerCase();
    const anchorWord = mFromAnchor[3].toLowerCase() === "now" ? "today" : mFromAnchor[3].toLowerCase();
    const anchor = resolveAnchor(anchorWord);
    if (unit === "month") return addLocalMonths(anchor, n);
    if (unit === "week")  return addLocalDays(anchor, n * 7);
    return addLocalDays(anchor, n);
  }

  // Pattern B: "in X months/weeks/days" (anchor is always today)
  // e.g. "in 2 months", "in 3 weeks", "in 10 days"
  const mIn = t.match(/\bin\s+(\d+)\s+(month|week|day)s?\b/i);
  if (mIn) {
    const n    = parseInt(mIn[1], 10);
    const unit = mIn[2].toLowerCase();
    if (unit === "month") return addLocalMonths(now, n);
    if (unit === "week")  return addLocalDays(now, n * 7);
    return addLocalDays(now, n);
  }

  // Pattern C: "next month" → same day next month
  if (/\bnext\s+month\b/i.test(t)) return addLocalMonths(now, 1);

  if (/\btoday\b/.test(t)) return localDateISO(now);
  if (/\btomorrow\b/.test(t)) return addLocalDays(now, 1);

  // "next week" (no specific day) → next Monday
  if (/\bnext\s+week\b/i.test(t) && !/\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(t)) {
    const dow = now.getDay(); // 0=Sun … 6=Sat
    const daysToNextMon = dow === 1 ? 7 : (8 - dow) % 7 || 7;
    return addLocalDays(now, daysToNextMon);
  }

  // ── Month-name dates: "May 15", "May 15 2027", "May 15, 2027", "15th May", "March 3rd" ──
  const MONTHS: Record<string, number> = {
    january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3,
    april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7,
    august: 8, aug: 8, september: 9, sep: 9, sept: 9, october: 10, oct: 10,
    november: 11, nov: 11, december: 12, dec: 12,
  };
  const monthNames = Object.keys(MONTHS).join("|");

  // "May 15", "May 15 2027", "May 15, 2027", "May 15th", "May 15th, 2027"
  const mMD = t.match(new RegExp(`\\b(${monthNames})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:[,\\s]+(\\d{4}))?\\b`, "i"));
  if (mMD) {
    const mon = MONTHS[mMD[1].toLowerCase()];
    const day = parseInt(mMD[2], 10);
    const yr = mMD[3] ? parseInt(mMD[3], 10) : now.getFullYear();
    // If no year given and the date has already passed this year, use next year
    const candidate = new Date(yr, mon - 1, day);
    const useYear = (!mMD[3] && candidate < now && candidate.toDateString() !== now.toDateString())
      ? yr + 1 : yr;
    if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31) {
      const iso = `${useYear}-${String(mon).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
      return iso;
    }
  }

  // "15th May", "3rd March", "15 May", "15 May 2027"
  const mDM = t.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthNames})(?:[,\\s]+(\\d{4}))?\\b`, "i"));
  if (mDM) {
    const day = parseInt(mDM[1], 10);
    const mon = MONTHS[mDM[2].toLowerCase()];
    const yr = mDM[3] ? parseInt(mDM[3], 10) : now.getFullYear();
    const candidate = new Date(yr, mon - 1, day);
    const useYear = (!mDM[3] && candidate < now && candidate.toDateString() !== now.toDateString())
      ? yr + 1 : yr;
    if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31) {
      const iso = `${useYear}-${String(mon).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
      return iso;
    }
  }

  // "next [weekday]" or bare "[weekday]"
  const hasNext = /\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(t);
  const currentDow = now.getDay(); // local day of week

  const weekdays = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
  for (let i = 0; i < weekdays.length; i++) {
    const name = weekdays[i];
    const short = name.slice(0, 3);
    const re = new RegExp(`\\b(${name}|${short}\\.?)\\b`, "i");
    if (re.test(t)) {
      const targetDow = i;
      let delta: number;
      if (targetDow > currentDow) {
        delta = targetDow - currentDow;           // e.g. Mon→Wed = 2
      } else if (targetDow < currentDow) {
        delta = 7 - (currentDow - targetDow);     // e.g. Wed→Mon = 5
      } else {
        delta = 0;                                // same day
      }
      if (hasNext) {
        // "next tuesday" always means the Tuesday of NEXT week
        delta = delta === 0 ? 7 : delta + 7;
      } else {
        // bare "tuesday" with delta=0 means TODAY — but without a time signal, assume next week
        if (delta === 0) {
          const hasTime = /\bat\s+\d{1,2}/.test(t) || /\d{1,2}:\d{2}/.test(t) || /\d{1,2}\s*(?:am|pm)/.test(t);
          if (!hasTime) delta = 7;
        }
      }
      return addLocalDays(now, delta);
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// Recurring event detection + expansion
// ─────────────────────────────────────────────────────────────

const WEEKDAY_MAP: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

// Detect patterns like "gym every Monday", "class on Mon/Wed/Fri", "workout every Tuesday and Thursday"
function looksLikeRecurring(text: string): boolean {
  const t = text.toLowerCase();
  if (/\b(?:every|each)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/i.test(t)) return true;
  if (/\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)s\b/i.test(t)) return true; // "Mondays", "Fridays"
  if (/\bm(?:on)?[\/,\s&]+(?:w(?:ed)?|f(?:ri)?)|\bt(?:ue)?[\/,\s&]+t(?:hu)?|\bmwf\b|\btr\b|\btth\b/i.test(t)) return true; // "MW", "MWF", "TTH", "TR"
  return false;
}

// Parse recurring event into multiple weekly events over ~4 weeks from today
function parseRecurringEvent(
  text: string,
  allEventKeywords: string[],
): { title: string; dates: string[]; timeHM: { hour: number; minute: number } | null; durationMin: number } | null {
  const t = text.toLowerCase();

  // Extract weekdays
  const days = new Set<number>();

  // "MWF", "MW", "TTH", "TR" compact forms
  if (/\bmwf\b/i.test(t)) { days.add(1); days.add(3); days.add(5); }
  else if (/\bmw\b/i.test(t)) { days.add(1); days.add(3); }
  if (/\b(tth|tr|tuth)\b/i.test(t)) { days.add(2); days.add(4); }

  // Explicit day names
  for (const [name, dow] of Object.entries(WEEKDAY_MAP)) {
    if (name.length < 3) continue; // skip ambiguous 2-letter keys
    const re = new RegExp(`\\b${name}s?\\b`, "i");
    if (re.test(t)) days.add(dow);
  }

  if (days.size === 0) return null;

  // Extract time + duration from the text
  const timeHM = parseTimeHM(text);
  const durationMin = parseDurationMinutes(text) ?? 60;

  // Get title using keywords
  const cleaned = text
    .replace(/\b(?:every|each|on)\b/gi, "")
    .replace(/\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)s?\b/gi, "")
    .replace(/\bm(?:on)?[\/,\s&]+(?:w(?:ed)?|f(?:ri)?)\b|\bt(?:ue)?[\/,\s&]+t(?:hu)?\b|\bmwf\b|\btr\b|\btth\b/gi, "")
    .replace(/\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/gi, "")
    .replace(/\bfor\s+\d+(?:\.\d+)?\s*(?:hours?|hrs?|minutes?|mins?)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  // Find best title from keywords
  let title = "";
  const kws = [...allEventKeywords].sort((a, b) => b.length - a.length);
  for (const kw of kws) {
    if (cleaned.toLowerCase().includes(kw)) {
      title = kw.charAt(0).toUpperCase() + kw.slice(1);
      break;
    }
  }
  if (!title && cleaned.length > 0) {
    title = cleaned.split(/\s+/).slice(0, 3).join(" ");
    title = title.charAt(0).toUpperCase() + title.slice(1);
  }
  if (!title) title = "Event";

  // Generate 4 weeks of occurrences starting from today
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const dates: string[] = [];
  const sortedDays = Array.from(days).sort();

  for (const dow of sortedDays) {
    // Find next occurrence of this weekday
    let d = new Date(today);
    const diff = (dow - d.getDay() + 7) % 7;
    d.setDate(d.getDate() + diff === 0 ? 0 : diff); // today if same day, else next
    // Generate 4 occurrences (4 weeks)
    for (let i = 0; i < 4; i++) {
      const candidate = new Date(d);
      candidate.setDate(d.getDate() + i * 7);
      dates.push(localDateISO(candidate));
    }
  }

  dates.sort();
  return { title, dates, timeHM, durationMin };
}

function capitalizeFirst(s: string) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Remove trailing time/date/duration noise from a phrase
function stripTimeSuffix(phrase: string) {
  return phrase
    .replace(/\s+(at|on|this|next|for|from|until|by)\s+.+$/i, "")
    .replace(/\s+\d{1,2}(:\d{2})?\s*(am|pm).*$/i, "")
    .replace(/\s+\d+\s*(hour|hr|minute|min|h|m)s?.*$/i, "")
    .trim();
}

// Given a phrase like "meeting with HR", find the best keyword match and return it
// (so "meeting with HR" → "Meeting", "flight to Paris" → "Flight")
// If no keyword match, return the full clean phrase (title-cased).
function pickBestTitle(phrase: string, allKeywords: string[]): string {
  const lower = phrase.toLowerCase();

  // Try to find the LONGEST keyword that appears at the START of the phrase (most specific match)
  const startMatches = allKeywords
    .filter((k) => lower.startsWith(k))
    .sort((a, b) => b.length - a.length);
  if (startMatches.length > 0) {
    return capitalizeFirst(startMatches[0]);
  }

  // Otherwise find any keyword contained in the phrase (longest first)
  const anyMatches = allKeywords
    .filter((k) => lower.includes(k))
    .sort((a, b) => b.length - a.length);
  if (anyMatches.length > 0) {
    return capitalizeFirst(anyMatches[0]);
  }

  // No keyword match — capitalize the full phrase
  return capitalizeFirst(phrase);
}

function extractTitle(text: string, allKeywords: string[]): { title: string | null; needsAsk: boolean } {
  const raw = text.trim();
  const t = raw.toLowerCase();

  // "tour of X" — keep the destination (it's a meaningful proper noun)
  const tour = raw.match(/\btour\s+of\s+([^\.,\n\r!?]+)/i);
  if (tour) {
    const dest = stripTimeSuffix(tour[1].trim());
    return { title: `Tour of ${capitalizeFirst(dest)}`, needsAsk: false };
  }

  // "visit to X"
  const visit = raw.match(/\bvisit\s+to\s+([^\.,\n\r!?]+)/i);
  if (visit) {
    const dest = stripTimeSuffix(visit[1].trim());
    return { title: `Visit to ${capitalizeFirst(dest)}`, needsAsk: false };
  }

  // "I have a/an X", "have a/an X", "got a/an X", "schedule a/an X", "booked a/an X"
  const haveA = raw.match(/\b(?:i\s+)?(?:have|got|schedule[d]?|set\s+up|booked)\s+(?:an?\s+)?(.+?)(?:\s+(at|on|this|next|for|from)\s+|\s+\d{1,2}[:\s]*(am|pm)|$)/i);
  if (haveA) {
    const phrase = stripTimeSuffix(haveA[1].trim());
    if (phrase.length > 1 && phrase.length < 80) {
      return { title: pickBestTitle(phrase, allKeywords), needsAsk: false };
    }
  }

  // "I have to X", "need to X", "going to X", "want to X", "gotta X"
  const haveTo = raw.match(/\b(?:i\s+)?(?:have|need|going|want|gotta)\s+to\s+([^\.,\n\r!?]+)/i);
  if (haveTo) {
    const phrase = stripTimeSuffix(haveTo[1].trim());
    if (phrase.length > 1 && phrase.length < 80) {
      // "run for 2 hours tomorrow" → pickBestTitle extracts "run" → "Run"
      return { title: pickBestTitle(phrase, allKeywords), needsAsk: false };
    }
  }

  // "I'm X-ing", "I am X-ing" — progressive form
  const progressive = raw.match(/\b(?:i'?m|i\s+am)\s+([^\.,\n\r!?]+)/i);
  if (progressive) {
    const phrase = stripTimeSuffix(progressive[1].trim());
    if (phrase.length > 1 && phrase.length < 80) {
      return { title: pickBestTitle(phrase, allKeywords), needsAsk: false };
    }
  }

  // Match against keyword list directly (longest match first)
  const sorted = [...allKeywords].sort((a, b) => b.length - a.length);
  for (const k of sorted) {
    if (t.includes(k)) {
      return { title: capitalizeFirst(k), needsAsk: false };
    }
  }

  return { title: null, needsAsk: true };
}

function overlaps(a: any, b: any) {
  if (a.date !== b.date) return false;
  return Math.max(a.startMin, b.startMin) < Math.min(a.endMin, b.endMin);
}

function localDateISO(d: Date): string {
  // Always use local year/month/day — never UTC — to avoid timezone date drift.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function findNextAvailableSlot(
  blocks: any[],
  durationMin: number,
  startDateISO: string,
  lookaheadDays = 14,
  constrainToDate = false  // when true, only searches startDateISO (respects "wednesday" anchor)
) {
  const dur = clampMinutes(durationMin);
  const dayStart = 8 * 60;
  const dayEnd = 22 * 60;
  const step = 5;

  // Parse as local midnight so date arithmetic stays in local time.
  const startDate = new Date(startDateISO + "T00:00:00");
  const maxDays = constrainToDate ? 1 : lookaheadDays;
  for (let d = 0; d < maxDays; d++) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + d);
    const iso = localDateISO(date); // local date — never UTC

    for (let start = dayStart; start + dur <= dayEnd; start += step) {
      const cand = { date: iso, startMin: start, endMin: start + dur };
      const collide = blocks.some((b) => overlaps(cand, b));
      if (!collide) return cand;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// Smart contextual suggestions generator
// Determines what prep/follow-up suggestions to offer based on event type
// ─────────────────────────────────────────────────────────────
function detectEventContext(text: string): string {
  const t = text.toLowerCase();
  if (/(flight|airport|plane|boarding|depart|departure|travel|airline)/.test(t)) return "flight";
  if (/(run|jog|running|jogging|marathon|5k|10k|sprint|track)/.test(t)) return "run";
  if (/(gym|workout|exercise|lift|lifting|weights|cardio|crossfit|hiit|bootcamp)/.test(t)) return "workout";
  if (/(swim|swimming|pool|lap swim)/.test(t)) return "swim";
  if (/(yoga|pilates|barre|stretch|meditation|mindfulness)/.test(t)) return "wellness";
  if (/(hike|hiking|trail|backpack|trek|outdoor|nature)/.test(t)) return "hike";
  if (/(bike|biking|cycling|spin|ride)/.test(t)) return "cycling";
  if (/(doctor|dentist|dental|physician|checkup|check-up|appointment|therapy|clinic|hospital|medical|physio)/.test(t)) return "medical";
  if (/(interview|job interview|screening)/.test(t)) return "interview";
  if (/(exam|test|midterm|final|quiz|assessment)/.test(t)) return "exam";
  if (/(meeting|call|zoom|video call|conference|standup|sync)/.test(t)) return "meeting";
  if (/(presentation|pitch|demo|speech|performance|present)/.test(t)) return "presentation";
  if (/(dinner|lunch|breakfast|restaurant|date|reservation)/.test(t)) return "dining";
  if (/(party|birthday|anniversary|wedding|celebration|gathering|social|event)/.test(t)) return "social";
  if (/(essay|paper|project|assignment|homework|deadline|submit|draft|thesis)/.test(t)) return "assignment";
  if (/(tour|museum|sightseeing|auschwitz|historical|exhibit|attraction|gallery)/.test(t)) return "tour";
  if (/(concert|show|gig|performance|festival)/.test(t)) return "concert";
  if (/(haircut|salon|barber|nails|spa|grooming)/.test(t)) return "grooming";
  if (/(shopping|groceries|errands|store|market)/.test(t)) return "errands";
  if (/(move|moving|relocation|pack|unpack)/.test(t)) return "moving";
  if (/(study|studying|revision|review|cram|learn)/.test(t)) return "study";
  return "general";
}

// Events where the exact departure/start time is critical — always ask even when the date is known.
// A flight at an unknown time should never be auto-slotted to 8am.
const TIME_CRITICAL_CONTEXTS = new Set([
  "flight",    // departure time is non-negotiable
  "medical",   // doctor/dentist appointments have fixed times
  "interview", // interviews are scheduled to the minute
  "exam",      // exams have official start times
  "meeting",   // work meetings are time-boxed
  "presentation", // presentations are scheduled
  "dining",    // restaurant reservations have a time
  "social",    // weddings, parties have start times
  "concert",   // shows have doors/set times
  "grooming",  // salon appointments are booked by time
]);

function requiresExactTime(text: string): boolean {
  const ctx = detectEventContext(text);
  return TIME_CRITICAL_CONTEXTS.has(ctx);
}

// ─────────────────────────────────────────────────────────────
// Human-readable date label for suggestions list (e.g. "Today", "Tomorrow", "Mon Jan 20")
function friendlyDate(iso: string): string {
  const today = new Date();
  const todayISO = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,"0")}-${String(today.getDate()).padStart(2,"0")}`;
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  const tomorrowISO = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth()+1).padStart(2,"0")}-${String(tomorrow.getDate()).padStart(2,"0")}`;
  if (iso === todayISO) return "Today";
  if (iso === tomorrowISO) return "Tomorrow";
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

// ─────────────────────────────────────────────────────────────
// Suggestions Modal
// ─────────────────────────────────────────────────────────────
function SuggestionsModal({
  open,
  eventTitle,
  eventContext,
  suggestions,
  keep,
  setKeep,
  onClose,
  onConfirm,
  onRate,
}: {
  open: boolean;
  eventTitle?: string;
  eventContext?: string;
  suggestions: SuggestedBlock[];
  keep: Record<number, boolean>;
  setKeep: (v: Record<number, boolean>) => void;
  onClose: () => void;
  onConfirm: () => void;
  onRate?: (s: SuggestedBlock) => void;
}) {
  if (!open) return null;

  const allOn = suggestions.length > 0 && suggestions.every((_, i) => keep[i]);
  const toggleAll = () => {
    const next: Record<number, boolean> = {};
    suggestions.forEach((_, i) => (next[i] = !allOn));
    setKeep(next);
  };

  // Context-aware heading
  const headings: Record<string, string> = {
    flight: "✈️ Travel prep suggestions",
    run: "🏃 Running prep & recovery",
    workout: "💪 Workout prep & recovery",
    swim: "🏊 Swim prep & recovery",
    wellness: "🧘 Wellness routine",
    hike: "🥾 Hike prep suggestions",
    cycling: "🚴 Cycling prep & recovery",
    medical: "🏥 Appointment reminders",
    interview: "💼 Interview prep suggestions",
    exam: "📚 Study & exam prep",
    meeting: "📋 Meeting prep suggestions",
    presentation: "🎤 Presentation prep",
    dining: "🍽️ Dining reminders",
    social: "🎉 Event prep suggestions",
    assignment: "📝 Assignment milestones",
    tour: "🗺️ Tour prep suggestions",
    concert: "🎵 Concert prep suggestions",
    grooming: "💈 Appointment reminders",
    errands: "🛒 Errand reminders",
    moving: "📦 Moving prep checklist",
    study: "📖 Study session planning",
    general: "✨ Helpful add-ons",
  };

  const heading = headings[eventContext ?? "general"] ?? "✨ Helpful add-ons";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-3xl p-6 w-full max-w-lg shadow-2xl border border-black/5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-extrabold text-black" style={{ letterSpacing: "-0.02em" }}>
              {heading}
            </h2>
            {eventTitle && (
              <p className="text-sm text-black/50 mt-0.5">Related to: {eventTitle}</p>
            )}
            <p className="text-sm text-black/60 mt-1">
              I thought of a few smart additions. Uncheck anything you don't want.
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-black/30 hover:text-black/60 transition-colors text-lg font-bold"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <button
          onClick={toggleAll}
          className="mt-4 text-sm px-3 py-1.5 rounded-full border border-black/10 hover:bg-black/5 transition-colors font-medium"
        >
          {allOn ? "Uncheck all" : "Check all"}
        </button>

        <div className="mt-4 max-h-[45vh] overflow-auto rounded-2xl border border-black/8">
          {suggestions.map((s, i) => (
            <div
              key={`${s.date}-${s.title}-${i}`}
              className="flex items-start gap-3 p-4 border-b border-black/5 last:border-b-0 hover:bg-black/[0.02] transition-colors"
            >
              <input
                type="checkbox"
                className="mt-1 accent-[var(--lifeos-pink,#ff6b6b)] cursor-pointer"
                checked={!!keep[i]}
                onChange={() => setKeep({ ...keep, [i]: !keep[i] })}
              />
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-sm text-black/90">{s.title}</div>
                <div className="text-xs text-black/50 mt-0.5">
                  {friendlyDate(s.date)} · {minutesToTime(s.startMin)}–{minutesToTime(s.endMin)}
                  {s.kind && s.kind !== "reminder" ? ` · ${s.kind}` : ""}
                </div>
                {s.reason ? (
                  <div className="text-xs text-black/40 mt-0.5 italic">{s.reason}</div>
                ) : null}
              </div>
              {onRate && (
                <button
                  onClick={() => onRate(s)}
                  className="shrink-0 mt-0.5 text-black/20 hover:text-[var(--lifeos-pink,#ff6b6b)] transition-colors text-base"
                  title="Rate this suggestion"
                >
                  ✦
                </button>
              )}
            </div>
          ))}
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-full border border-black/10 text-sm font-semibold text-black/70 hover:bg-black/5 transition-colors"
          >
            Skip
          </button>
          <button
            onClick={onConfirm}
            className="px-5 py-2 rounded-full bg-[var(--lifeos-pink,#ff6b6b)] text-white text-sm font-semibold hover:opacity-90 transition-opacity"
          >
            Add Selected
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Missing Info Modal — beautiful, themed
// ─────────────────────────────────────────────────────────────
function MissingInfoModal({ open, onClose, onPickNext, onPickExact, eventTitle, prefillDate, prefillTime, prefillDuration, hideNextAvailable, queueInfo }: any) {
  const [date, setDate] = useState(prefillDate ?? "");
  const [time, setTime] = useState(prefillTime ?? "12:00");
  const [durationHours, setDurationHours] = useState(() => {
    const d = prefillDuration ?? 60;
    return Math.floor(d / 60);
  });
  const [durationMins, setDurationMins] = useState(() => {
    const d = prefillDuration ?? 60;
    return d % 60;
  });
  const [inlineError, setInlineError] = useState("");

  const totalMinutes = clampMinutes(durationHours * 60 + durationMins);

  if (!open) return null;

  // queueInfo: { remaining: number } — how many events still in queue after this one
  const totalEvents = queueInfo ? queueInfo.remaining + 1 : null; // +1 for current
  const isMulti = !!queueInfo;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-3xl p-6 w-full max-w-md shadow-2xl border border-black/5">
        {/* Multi-event progress bar */}
        {isMulti && totalEvents && totalEvents > 1 && (
          <div className="mb-4">
            <div className="flex justify-between text-xs font-semibold text-black/40 mb-1.5">
              <span>Scheduling multiple events</span>
              <span>{totalEvents - queueInfo.remaining} of {totalEvents}</span>
            </div>
            <div className="h-1.5 rounded-full bg-black/[0.06] overflow-hidden">
              <div
                className="h-full rounded-full bg-[var(--lifeos-pink,#ff6b6b)] transition-all"
                style={{ width: `${((totalEvents - queueInfo.remaining) / totalEvents) * 100}%` }}
              />
            </div>
          </div>
        )}
        <h2 className="text-xl font-extrabold text-black mb-1" style={{ letterSpacing: "-0.02em" }}>
          {hideNextAvailable ? "What time should I schedule this?" : "When should I schedule this?"}
        </h2>
        {eventTitle && (
          <p className="text-sm text-[var(--lifeos-pink,#ff6b6b)] font-semibold mb-1">{eventTitle}</p>
        )}
        <p className="text-sm text-black/50 mb-5">
          {isMulti && queueInfo.remaining > 0
            ? `${queueInfo.remaining} more event${queueInfo.remaining > 1 ? "s" : ""} after this one.`
            : hideNextAvailable ? "Pick a date and time — I'll keep your duration." : "I'm missing a few details to add this to your calendar."}
        </p>

        <div className="space-y-3">
          {/* Option 1: Next available — hidden when an exact time is required */}
          {!hideNextAvailable && (
            <>
              <button
                onClick={() => onPickNext(totalMinutes)}
                className="w-full px-4 py-3.5 rounded-2xl bg-[var(--lifeos-pink,#ff6b6b)] text-white font-semibold text-sm hover:opacity-90 transition-opacity text-left flex items-center gap-3"
              >
                <span className="text-xl">⚡</span>
                <div>
                  <div className="font-bold">Schedule in my next available slot</div>
                  <div className="text-white/70 text-xs mt-0.5">I'll find the first open time for you</div>
                </div>
              </button>

              <div className="relative">
                <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 flex items-center">
                  <div className="flex-1 border-t border-black/10" />
                  <span className="px-3 text-xs text-black/30 font-medium">or pick a time</span>
                  <div className="flex-1 border-t border-black/10" />
                </div>
              </div>
            </>
          )}

          {/* Option 2: Exact time */}
          <div className="rounded-2xl border border-black/10 p-4 space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs font-semibold text-black/50 mb-1 block">Date</label>
                <input
                  type="date"
                  value={date}
                  onChange={(e) => { setDate(e.target.value); setInlineError(""); }}
                  className="w-full rounded-xl border border-black/10 px-3 py-2 text-sm bg-black/[0.02] outline-none focus:border-[var(--lifeos-pink,#ff6b6b)] transition-colors"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-black/50 mb-1 block">Time</label>
                <input
                  type="time"
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                  className="w-full rounded-xl border border-black/10 px-3 py-2 text-sm bg-black/[0.02] outline-none focus:border-[var(--lifeos-pink,#ff6b6b)] transition-colors"
                />
              </div>
            </div>

            <div>
              <label className="text-xs font-semibold text-black/50 mb-2 block">Duration</label>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <select
                    value={durationHours}
                    onChange={(e) => setDurationHours(parseInt(e.target.value, 10))}
                    className="w-full rounded-xl border border-black/10 px-3 py-2 text-sm bg-black/[0.02] outline-none focus:border-[var(--lifeos-pink,#ff6b6b)] transition-colors"
                  >
                    {Array.from({ length: 25 }, (_, i) => (
                      <option key={i} value={i}>{i} hr{i !== 1 ? "s" : ""}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <select
                    value={durationMins}
                    onChange={(e) => setDurationMins(parseInt(e.target.value, 10))}
                    className="w-full rounded-xl border border-black/10 px-3 py-2 text-sm bg-black/[0.02] outline-none focus:border-[var(--lifeos-pink,#ff6b6b)] transition-colors"
                  >
                    {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map((m) => (
                      <option key={m} value={m}>{m} min{m !== 1 ? "s" : ""}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="text-xs text-black/30 mt-1">
                Total: {durationHours > 0 ? `${durationHours}h ` : ""}{durationMins > 0 ? `${durationMins}min` : ""}{durationHours === 0 && durationMins === 0 ? "0min" : ""}
              </div>
            </div>

            {inlineError && (
              <p className="text-xs text-red-500 font-medium -mt-1">{inlineError}</p>
            )}
            <button
              onClick={() => {
                const resolvedDate = date || prefillDate || "";
                if (!resolvedDate) {
                  setInlineError("Please pick a date first.");
                  return;
                }
                setInlineError("");
                onPickExact(resolvedDate, time, totalMinutes);
              }}
              className="w-full px-4 py-2.5 rounded-2xl border border-black/10 text-sm font-semibold text-black hover:bg-black/[0.03] transition-colors"
            >
              Schedule at this time →
            </button>
          </div>
        </div>

        <div className="mt-4 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-full text-sm text-black/40 hover:text-black/70 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Ask Event Type Modal
// ─────────────────────────────────────────────────────────────
function AskEventTypeModal({ open, onClose, onSubmit }: any) {
  const [value, setValue] = useState("");
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-3xl p-6 w-full max-w-md shadow-2xl border border-black/5">
        <h2 className="text-xl font-extrabold text-black mb-1" style={{ letterSpacing: "-0.02em" }}>
          What type of event is this?
        </h2>
        <p className="text-sm text-black/50 mb-4">
          Tell me what to call it (e.g. "video shoot", "pottery class"). I'll remember it for next time.
        </p>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && value.trim()) onSubmit(value); }}
          placeholder="Event name…"
          autoFocus
          className="w-full rounded-2xl border border-black/10 px-4 py-3 text-sm bg-black/[0.02] outline-none focus:border-[var(--lifeos-pink,#ff6b6b)] transition-colors"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-full text-sm text-black/40 hover:text-black/70 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => onSubmit(value)}
            disabled={!value.trim()}
            className="px-5 py-2 rounded-full bg-[var(--lifeos-pink,#ff6b6b)] text-white text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-40"
          >
            Save & Continue
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Conflict Modal — shown when a new block overlaps existing ones
// ─────────────────────────────────────────────────────────────
function ConflictModal({
  open,
  newBlock,
  conflicts,
  onReplace,
  onSqueeze,
  onKeepBoth,
  onCancel,
}: {
  open: boolean;
  newBlock: { title: string; date: string; startMin: number; endMin: number } | null;
  conflicts: { title: string; startMin: number; endMin: number }[];
  onReplace: () => void;
  onSqueeze: () => void;
  onKeepBoth: () => void;
  onCancel: () => void;
}) {
  if (!open || !newBlock) return null;

  function fmtTime(m: number) {
    const h = Math.floor(m / 60);
    const min = m % 60;
    const ap = h < 12 ? "AM" : "PM";
    return `${h % 12 || 12}:${String(min).padStart(2, "0")} ${ap}`;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-3xl p-6 w-full max-w-md shadow-2xl border border-black/5">
        <div className="flex items-center gap-3 mb-3">
          <span className="text-2xl">⚠️</span>
          <h2 className="text-xl font-extrabold text-black" style={{ letterSpacing: "-0.02em" }}>
            Time conflict
          </h2>
        </div>

        <p className="text-sm text-black/60 mb-1">
          <span className="font-semibold text-black">{newBlock.title}</span>{" "}
          ({fmtTime(newBlock.startMin)}–{fmtTime(newBlock.endMin)}) overlaps with:
        </p>
        <ul className="mb-5 space-y-1">
          {conflicts.map((c, i) => (
            <li key={i} className="text-sm font-semibold text-[var(--lifeos-pink,#ff6b6b)] flex items-center gap-2">
              <span>•</span>
              <span>{c.title}</span>
              <span className="text-black/40 font-normal">({fmtTime(c.startMin)}–{fmtTime(c.endMin)})</span>
            </li>
          ))}
        </ul>

        <div className="space-y-2">
          <button
            onClick={onSqueeze}
            className="w-full px-4 py-3.5 rounded-2xl bg-[var(--lifeos-pink,#ff6b6b)] text-white font-semibold text-sm hover:opacity-90 transition-opacity text-left flex items-center gap-3"
          >
            <span className="text-xl">⚡</span>
            <div>
              <div className="font-bold">Move to next available slot</div>
              <div className="text-white/70 text-xs mt-0.5">Find the nearest open time after the conflict</div>
            </div>
          </button>

          <button
            onClick={onReplace}
            className="w-full px-4 py-3.5 rounded-2xl border border-black/10 text-sm font-semibold text-black hover:bg-black/[0.03] transition-colors text-left flex items-center gap-3"
          >
            <span className="text-xl">🔄</span>
            <div>
              <div className="font-bold">Replace conflicting event{conflicts.length > 1 ? "s" : ""}</div>
              <div className="text-black/40 text-xs mt-0.5">Delete the conflict and place this event instead</div>
            </div>
          </button>

          <button
            onClick={onKeepBoth}
            className="w-full px-4 py-3.5 rounded-2xl border border-black/10 text-sm font-semibold text-black hover:bg-black/[0.03] transition-colors text-left flex items-center gap-3"
          >
            <span className="text-xl">📋</span>
            <div>
              <div className="font-bold">Schedule anyway</div>
              <div className="text-black/40 text-xs mt-0.5">Keep both events — I'll manage the overlap</div>
            </div>
          </button>
        </div>

        <div className="mt-4 flex justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-full text-sm text-black/40 hover:text-black/70 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// FeedbackModal — rate a block, pick a signal, add optional note
// ─────────────────────────────────────────────────────────────
const SIGNAL_OPTIONS: { signal: FeedbackSignal; emoji: string; label: string }[] = [
  { signal: "thumbs_up",    emoji: "👍", label: "Loved it" },
  { signal: "thumbs_down",  emoji: "👎", label: "Didn't want this" },
  { signal: "too_early",    emoji: "🌅", label: "Too early" },
  { signal: "too_late",     emoji: "🌙", label: "Too late" },
  { signal: "too_long",     emoji: "⏱️", label: "Too long" },
  { signal: "too_short",    emoji: "⚡", label: "Too short" },
  { signal: "not_relevant", emoji: "🚫", label: "Not relevant" },
];

function FeedbackModal({
  open,
  block,
  onClose,
  onSubmit,
}: {
  open: boolean;
  block: CalendarBlock | null;
  onClose: () => void;
  onSubmit: (signal: FeedbackSignal, note: string) => void;
}) {
  const [selected, setSelected] = useState<FeedbackSignal | null>(null);
  const [note, setNote] = useState("");

  useEffect(() => {
    if (open) { setSelected(null); setNote(""); }
  }, [open]);

  if (!open || !block) return null;

  const hour = Math.floor(block.startMin / 60);
  const min = String(block.startMin % 60).padStart(2, "0");
  const dur = Math.round((block.endMin - block.startMin));

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-3xl p-6 w-full max-w-sm shadow-2xl border border-black/5">
        {/* Header */}
        <div className="flex items-start justify-between mb-4">
          <div>
            <div className="text-base font-extrabold text-black leading-tight" style={{ letterSpacing: "-0.02em" }}>
              Rate this block
            </div>
            <div className="text-xs text-[var(--lifeos-pink,#ff6b6b)] font-semibold mt-0.5 truncate max-w-[200px]">
              {block.title}
            </div>
            <div className="text-xs text-black/40 mt-0.5">
              {hour}:{min} · {dur}min
            </div>
          </div>
          <button onClick={onClose} className="text-black/30 hover:text-black/60 text-lg leading-none mt-0.5">✕</button>
        </div>

        {/* Signal grid */}
        <div className="grid grid-cols-2 gap-2 mb-4">
          {SIGNAL_OPTIONS.map(({ signal, emoji, label }) => (
            <button
              key={signal}
              onClick={() => setSelected(signal)}
              className={`flex items-center gap-2 px-3 py-2.5 rounded-2xl border text-sm font-semibold transition-all text-left ${
                selected === signal
                  ? "border-[var(--lifeos-pink,#ff6b6b)] bg-[var(--lifeos-pink,#ff6b6b)]/10 text-[var(--lifeos-pink,#ff6b6b)]"
                  : "border-black/10 text-black/70 hover:border-black/20 hover:bg-black/[0.02]"
              }`}
            >
              <span className="text-base">{emoji}</span>
              <span className="text-xs">{label}</span>
            </button>
          ))}
        </div>

        {/* Optional note */}
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Add a note (optional)…"
          className="w-full rounded-xl border border-black/10 px-3 py-2 text-sm bg-black/[0.02] outline-none focus:border-[var(--lifeos-pink,#ff6b6b)] mb-4 transition-colors"
        />

        {/* Actions */}
        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-2xl border border-black/10 text-sm font-semibold text-black/60 hover:bg-black/5 transition-colors"
          >
            Cancel
          </button>
          <button
            disabled={!selected}
            onClick={() => selected && onSubmit(selected, note)}
            className="flex-1 py-2.5 rounded-2xl bg-[var(--lifeos-pink,#ff6b6b)] text-white text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-40"
          >
            Submit
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// TodayStrip — compact "what's on today" strip on the homepage
// ─────────────────────────────────────────────────────────────
function TodayStrip() {
  const [blocks, setBlocks] = useState<CalendarBlock[]>([]);
  const [onboardingName, setOnboardingName] = useState<string>("");

  useEffect(() => {
    const today = localDateISO(new Date());
    const all = loadCalendar();
    const todayBlocks = all
      .filter((b) => b.date === today)
      .sort((a, b) => a.startMin - b.startMin)
      .slice(0, 4);
    setBlocks(todayBlocks);

    const profile = loadOnboardingProfile();
    if (profile?.name && profile.name !== "Friend") {
      setOnboardingName(profile.name.split(" ")[0]);
    }
  }, []);

  const kindColor: Record<string, string> = {
    syllabus: "#6C8EE8",
    plan: "#5BA85E",
    manual: "#d96c7d",
    prep: "#E8A83C",
    "follow-up": "#9B6CE8",
  };

  function minToTime(m: number) {
    const h = Math.floor(m / 60) % 24;
    const min = m % 60;
    const ampm = h < 12 ? "AM" : "PM";
    return `${h % 12 || 12}:${String(min).padStart(2, "0")} ${ampm}`;
  }

  return (
    <div className="mt-6 w-full max-w-2xl">
      <div className="rounded-2xl border border-[var(--lifeos-border-soft)] bg-white/70 px-4 py-3 backdrop-blur-sm">
        <div className="flex items-center justify-between mb-2.5">
          <span className="text-xs font-bold uppercase tracking-wider text-black/40">
            {onboardingName ? `Today, ${onboardingName}` : "Today"}
          </span>
          <a href="/calendar" className="text-[11px] font-semibold text-[var(--lifeos-pink)] hover:underline">
            View all →
          </a>
        </div>
        {blocks.length === 0 ? (
          <p className="text-xs text-black/30 italic">Nothing scheduled for today — add something above.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {blocks.map((b) => (
              <div key={b.id} className="flex items-center gap-2.5">
                <div
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: (b.meta as any)?.color ?? kindColor[b.meta?.kind ?? "manual"] ?? "#d96c7d" }}
                />
                <span className="flex-1 truncate text-sm font-semibold text-black/80">{b.title}</span>
                <span className="shrink-0 text-xs text-black/40">{minToTime(b.startMin)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// FeedbackBadge — small persistent pill showing training progress
// ─────────────────────────────────────────────────────────────
function FeedbackBadge({ sessions, pending, onReview }: { sessions: number; pending: number; onReview: () => void }) {
  if (sessions === 0 && pending === 0) return null;
  return (
    <button
      onClick={onReview}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-semibold hover:bg-emerald-100 transition-colors"
    >
      <span>🧠</span>
      {pending > 0
        ? <span>{pending} feedback pending</span>
        : <span>{sessions} session{sessions !== 1 ? "s" : ""} trained</span>
      }
    </button>
  );
}

// ─────────────────────────────────────────────────────────────
// Main Page
// ─────────────────────────────────────────────────────────────
export default function GeneratePage() {
  const router = useRouter();

  const [missingInfoOpen, setMissingInfoOpen] = useState(false);
  const [askTypeOpen, setAskTypeOpen] = useState(false);
  const [pendingQuickEvent, setPendingQuickEvent] = useState<any | null>(null);
  const [customKeywords, setCustomKeywords] = useState<string[]>([]);

  useMemo(() => {
    setCustomKeywords(loadCustomEventKeywords());
    return null;
  }, []);

  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<SuggestedBlock[]>([]);
  const [suggestionsKeep, setSuggestionsKeep] = useState<Record<number, boolean>>({});
  const [suggestionsContext, setSuggestionsContext] = useState<{ title?: string; context?: string }>({});

  const [syllabusLoading, setSyllabusLoading] = useState(false);
  const [syllabusError, setSyllabusError] = useState<string | null>(null);
  const [syllabusEvents, setSyllabusEvents] = useState<SyllabusEvent[] | null>(null);
  const [syllabusKeep, setSyllabusKeep] = useState<Record<number, boolean>>({});
  const [syllabusMeta, setSyllabusMeta] = useState<any | null>(null);
  const [syllabusFile, setSyllabusFile] = useState<File | null>(null);
  const [yearConfirm, setYearConfirm] = useState<{ detectedYear: number; nowYear: number } | null>(null);

  // Section picker — shown when syllabus has multiple sections and user hasn't chosen one
  const [sectionPick, setSectionPick] = useState<{ sections: string[]; course: string } | null>(null);

  // Ref for the chip "Syllabus import" hidden file input
  const chipSyllabusInputRef = useRef<HTMLInputElement | null>(null);

  // File attached to the chatbox — uploaded together with the prompt when user hits Generate
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  // Conflict detection
  const [conflictOpen, setConflictOpen] = useState(false);
  const [conflictNewBlock, setConflictNewBlock] = useState<CalendarBlock | null>(null);
  const [conflictConflicts, setConflictConflicts] = useState<CalendarBlock[]>([]);
  const [conflictInputText, setConflictInputText] = useState("");

  const [planPreview, setPlanPreview] = useState<CalendarMergePreview | null>(null);
  const [planKeep, setPlanKeep] = useState<Record<number, boolean>>({});
  const [planTitles, setPlanTitles] = useState<Record<number, string>>({});
  const [pendingHistory, setPendingHistory] = useState<HistoryItem | null>(null);

  // ── Multi-event queue state ──
  // When scheduling N events and some need the MissingInfo modal, we queue the rest here
  const [multiEventQueue, setMultiEventQueue] = useState<any[]>([]);
  const [multiEventScheduled, setMultiEventScheduled] = useState<CalendarBlock[]>([]);
  const [multiEventOriginalInput, setMultiEventOriginalInput] = useState<string>("");

  // ── Syllabus course color coding ──
  const [syllabusColor, setSyllabusColor] = useState<string>("#d96c7d");

  // ── Post-import: offer to import another course + study blocks ──
  const [showImportAnother, setShowImportAnother] = useState(false);
  const [studyBlockCandidates, setStudyBlockCandidates] = useState<SyllabusEvent[]>([]);
  const [studyBlocksScheduled, setStudyBlocksScheduled] = useState(false);

  // ── Confirmation chip state (shows parsed intent before scheduling) ──
  const [confirmChip, setConfirmChip] = useState<{
    summary: string;       // "Run · 2 hrs · Today at 9 AM"
    onConfirm: () => void;
    onEdit: () => void;
  } | null>(null);

  // ── Feedback & Learning state ──
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  // Block being rated: { block, prompt }
  const [feedbackTarget, setFeedbackTarget] = useState<{ block: CalendarBlock; prompt: string } | null>(null);
  // Pending feedback that hasn't been submitted yet this session
  const [pendingFeedback, setPendingFeedback] = useState<FeedbackEntry[]>([]);
  // Loaded preferences (refreshed after each submission)
  const [userPrefs, setUserPrefs] = useState<UserPreferences>(() => loadPreferences());
  // How many sessions have been trained
  const [feedbackSessions, setFeedbackSessions] = useState(() => loadPreferences().totalFeedbackSessions);

  // Helper: get preference context string to inject into API calls
  function getPreferenceContext(): string {
    const prefs = loadPreferences();
    const recent = loadFeedback().slice(0, 20);
    return buildPreferenceContext(prefs, recent);
  }

  // Submit a batch of feedback to the AI and update stored preferences
  async function submitFeedbackToAI(entries: FeedbackEntry[], sessionInputText: string) {
    if (entries.length === 0) return;
    try {
      const prefs = loadPreferences();
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          feedback: entries,
          currentPreferences: prefs,
          sessionInput: sessionInputText,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.preferences) {
          savePreferences(data.preferences);
          setUserPrefs(data.preferences);
          setFeedbackSessions(data.preferences.totalFeedbackSessions ?? 0);
        }
      }
    } catch (e) {
      console.error("Feedback submission failed:", e);
    }
  }

  // ── Generating overlay state (external setTimeout hold — fixes React batching) ──
  const [generatingVisible, setGeneratingVisible] = useState(false);
  const genShownAt = useRef<number>(0);
  const genHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const GEN_MIN_MS = 900;

  function showGeneratingOverlay() {
    if (genHideTimer.current) clearTimeout(genHideTimer.current);
    genShownAt.current = Date.now();
    setGeneratingVisible(true);
  }
  function hideGeneratingOverlay(immediate = false) {
    if (genHideTimer.current) clearTimeout(genHideTimer.current);
    if (immediate) {
      setGeneratingVisible(false);
      return;
    }
    const elapsed = Date.now() - genShownAt.current;
    const remaining = Math.max(0, GEN_MIN_MS - elapsed);
    genHideTimer.current = setTimeout(() => setGeneratingVisible(false), remaining);
  }

  // Can generate if: input has content, OR a file is attached (with any text)
  const canGenerate = useMemo(
    () => (!loading && !syllabusLoading) && (input.trim().length > 0 || pendingFile !== null),
    [input, loading, syllabusLoading, pendingFile]
  );

  const allEventKeywords = useMemo(
    () => [...DEFAULT_EVENT_KEYWORDS, ...customKeywords].map((k) => String(k).toLowerCase()),
    [customKeywords]
  );

  function addBlocksToCalendar(blocks: CalendarBlock[]) {
    const existing = loadCalendar();
    const key = (b: CalendarBlock) => `${b.date}::${b.title.toLowerCase()}::${b.startMin}::${b.endMin}`;
    const existingKeys = new Set(existing.map(key));
    const merged = [...blocks.filter((b) => !existingKeys.has(key(b))), ...existing];
    saveCalendar(merged);
  }

  // After scheduling, fetch suggestions then show modal. Only navigate to /plan after user
  // dismisses the suggestions modal (or if no suggestions come back).
  async function scheduleAndMaybeSuggest(
    block: CalendarBlock,
    inputText: string,
    skipConflictCheck = false,
  ) {
    // Conflict detection — check against existing calendar blocks on the same day
    if (!skipConflictCheck) {
      const existing = loadCalendar();
      const sameDayBlocks = existing.filter((b) => b.date === block.date);
      const conflicting = sameDayBlocks.filter(
        (b) => block.startMin < b.endMin && b.startMin < block.endMin
      );
      if (conflicting.length > 0) {
        // Store conflict info and show modal — the modal handlers will resolve and re-call
        setConflictNewBlock(block);
        setConflictConflicts(conflicting);
        setConflictInputText(inputText);
        setConflictOpen(true);
        return;
      }
    }

    addBlocksToCalendar([block]);

    const ctx = detectEventContext(inputText);
    const hasRichContext = ctx !== "general" || /(at|on|for|tomorrow|next)\b/i.test(inputText);

    if (!hasRichContext) {
      router.push("/plan");
      return;
    }

    setSuggestionsLoading(true);

    try {
      const sres = await fetch("/api/suggestions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: inputText,
          anchors: [{ date: block.date, startMin: block.startMin, endMin: block.endMin, title: block.title, kind: "event" }],
          preferenceContext: getPreferenceContext(),
        }),
      });
      const sdata = (await sres.json()) as { suggestions?: SuggestedBlock[] };
      let sug = Array.isArray(sdata?.suggestions) ? sdata.suggestions : [];

      sug = sug.sort((a, b) => {
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        return a.startMin - b.startMin;
      });

      setSuggestionsLoading(false);

      if (sug.length) {
        const keep2: Record<number, boolean> = {};
        sug.forEach((_, i) => (keep2[i] = true));
        setSuggestions(sug);
        setSuggestionsKeep(keep2);
        setSuggestionsContext({ title: block.title, context: ctx });
        setSuggestionsOpen(true);
        return;
      }
    } catch {
      setSuggestionsLoading(false);
    }

    router.push("/plan");
  }

  function scheduleQuickEvent(payload: {
    title: string;
    dateIso?: string | null;
    timeHM?: { hour: number; minute: number } | null;
    durationMin: number;
    capturedInput?: string; // explicit snapshot of the prompt — avoids reading stale `input` state
    constrainToDate?: boolean; // when true, only search for slots on dateIso (not beyond it)
  }) {
    const { title, dateIso, timeHM } = payload;
    const dur = clampMinutes(payload.durationMin || 60);
    const blocks = loadCalendar();

    // Use the explicitly captured input if provided (from modal handlers that clear `input` before calling),
    // otherwise fall back to the current `input` state (direct call from generate()).
    const promptText = payload.capturedInput ?? input.trim();
    const fullDetail = promptText || undefined;

    if (dateIso && timeHM) {
      const startMin = timeHM.hour * 60 + timeHM.minute;
      const endMin = Math.min(startMin + dur, 24 * 60);
      const b: CalendarBlock = {
        id: generateId(),
        date: dateIso,
        title,
        startMin,
        endMin,
        meta: { kind: "manual", fullDetail },
      };
      void scheduleAndMaybeSuggest(b, promptText);
      return true;
    }

    // Flexible scheduling — use dateIso as start date if available (respects "tomorrow", weekdays, etc.)
    // Use localDateISO() for today so timezone offsets don't push us to the wrong calendar day.
    let startDateISO = dateIso || localDateISO(new Date());
    const isNextWeek = /\bnext\s+week\b/i.test(promptText);
    // "next tuesday" etc. — dateIso already handles this via parseDateISOFromText,
    // but if dateIso is null (no date signal) we fall back to next Monday as the window start.
    const isNextWeekday = !dateIso && /\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(promptText);

    if (isNextWeek || isNextWeekday) {
      if (!dateIso) {
        // Re-parse the date from text so "next tuesday" still lands on the right day.
        const parsed = parseDateISOFromText(promptText);
        if (parsed) {
          startDateISO = parsed;
        } else {
          // Plain "next week" with no weekday — jump to next Monday.
          const d = new Date();
          const day = d.getDay();
          const delta = (8 - day) % 7 || 7;
          d.setDate(d.getDate() + delta);
          startDateISO = localDateISO(d);
        }
      }
    }

    // constrainToDate: only search slots on the exact day the user specified
    // (e.g. "I have a meeting wednesday" → slot button → find slot ON wednesday, not the following days)
    const constrain = payload.constrainToDate && !!dateIso;
    const slot = findNextAvailableSlot(blocks, dur, startDateISO, (isNextWeek || isNextWeekday) ? 7 : 14, constrain);
    if (!slot) return false;

    const b: CalendarBlock = {
      id: generateId(),
      date: slot.date,
      title,
      startMin: slot.startMin,
      endMin: slot.endMin,
      meta: { kind: "manual", fullDetail },
    };
    void scheduleAndMaybeSuggest(b, promptText);
    return true;
  }

  // ─────────────────────────────────────────────────────────────
  // Multi-event parser
  // Splits a prompt like:
  //   "run for 2 hours at 9am and workout at 6pm"
  //   "meeting wednesday at 11 and one thursday at 1"
  // into an array of per-event objects each with their own
  // title / dateIso / timeHM / durationMin.
  // ─────────────────────────────────────────────────────────────
  type ParsedEvent = {
    title: string;
    dateIso: string | null;
    timeHM: { hour: number; minute: number } | null;
    durationMin: number;
    rawSegment: string; // the slice of the original prompt for this event
  };

  function parseMultipleEvents(raw: string): ParsedEvent[] | null {
    // ── Step 1: extract a shared date prefix from the full prompt ──
    // e.g. "Today", "Tomorrow", "Wednesday" — so tail segments like
    // "workout at 6pm" inherit the right date even without "today" in them.
    const sharedDate = parseDateISOFromText(raw);

    // Extract a "date prefix" string to prepend to dateless segments so
    // parseDateISOFromText can find the shared anchor.
    const datePrefixMatch = raw.match(/^(today|tomorrow|next\s+\w+|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{4}-\d{2}-\d{2})/i);
    const datePrefix = datePrefixMatch ? datePrefixMatch[0] + " " : "";

    // ── Step 2: strip leading filler so segments parse cleanly ──
    // "Today I have to run..." → "run..."
    // This lets us split cleanly without the prefix polluting segment 2+
    const strippedRaw = raw
      .replace(/^(?:today|tomorrow)\s+i\s+(?:have|need|want)\s+to\s+/i, "")
      .replace(/^(?:today|tomorrow)\s+/i, "")
      .replace(/^i\s+(?:have|need|want)\s+to\s+/i, "");

    // ── Step 3: split on connectors ──
    const connRe = /\s+and\s+(?:also\s+)?(?:one\s+|a\s+)?|\s*,\s*(?:and\s+)?(?:also\s+)?(?:one\s+|a\s+)?|\s+then\s+|\s*;\s*/gi;
    const segments: string[] = [];
    let lastIdx = 0;
    let match: RegExpExecArray | null;

    while ((match = connRe.exec(strippedRaw)) !== null) {
      const before = strippedRaw.slice(lastIdx, match.index).trim();
      if (before.length > 0) segments.push(before);
      lastIdx = match.index + match[0].length;
    }
    const tail = strippedRaw.slice(lastIdx).trim();
    if (tail.length > 0) segments.push(tail);

    if (segments.length < 2) return null;

    // ── Step 4: parse each segment ──
    const results: ParsedEvent[] = [];

    for (const seg of segments) {
      // Give dateless segments the shared date prefix so parseDateISOFromText works
      const contextSeg = datePrefix ? `${datePrefix} ${seg}` : seg;

      const parsedSegDate = parseDateISOFromText(contextSeg) ?? sharedDate;
      // If this segment has a time but no date context, default to today
      const segTime = parseTimeHM(seg); // parse time from the raw segment only (no prefix pollution)
      const segDate = parsedSegDate ?? (segTime ? localDateISO(new Date()) : null);
      const segDur  = parseDurationMinutes(seg) ?? 60;

      // ── Title extraction ──
      // Try extractTitle on the full context segment first
      let title: string | null = null;
      const { title: extracted } = extractTitle(contextSeg, allEventKeywords);
      if (extracted) {
        title = extracted;
      } else {
        // Fallback: strip time/duration/date filler and use the first meaningful word(s)
        // e.g. "workout at 6pm" → "workout"
        // e.g. "run for 2 hours at 9am" → "Run"
        const cleaned = seg
          .replace(/\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/gi, "")
          .replace(/\bfor\s+\d+(?:\.\d+)?\s*(?:hours?|hrs?|minutes?|mins?)\b/gi, "")
          .replace(/\b(?:today|tomorrow|next\s+\w+|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, "")
          .replace(/^(?:i\s+)?(?:have|need|want)\s+(?:to\s+)?/i, "")
          .replace(/\s+/g, " ")
          .trim();

        // Match the cleaned text against keywords
        const kw = [...allEventKeywords].sort((a, b) => b.length - a.length);
        for (const k of kw) {
          if (cleaned.toLowerCase().includes(k)) {
            title = k.charAt(0).toUpperCase() + k.slice(1);
            break;
          }
        }
        // Last resort: use the first 1-3 words of the cleaned segment
        if (!title && cleaned.length > 0) {
          title = cleaned.split(/\s+/).slice(0, 3).join(" ");
          title = title.charAt(0).toUpperCase() + title.slice(1);
        }
      }

      if (!title || title.length < 2) continue;

      results.push({
        title: title.length > 60 ? title.slice(0, 60) : title,
        dateIso: segDate,
        timeHM: segTime,
        durationMin: segDur,
        rawSegment: seg,
      });
    }

    return results.length >= 2 ? results : null;
  }

  // Detect whether a prompt clearly contains multiple distinct events
  function looksLikeMultiEvent(text: string): boolean {
    const t = text.toLowerCase();

    // Must NOT be a planning request
    if (/\b(plan\s+my\s+(?:day|week)|make\s+(?:me\s+)?a\s+plan|build\s+(?:me\s+)?(?:a\s+)?schedule|create\s+(?:me\s+)?(?:a\s+)?schedule|organize\s+my\s+(?:day|week)|routine|agenda)\b/i.test(t)) return false;

    // Pattern 1: two or more distinct time signals anywhere in the prompt
    // e.g. "at 9am ... at 6pm", "at 11 ... at 1", "9am ... 6pm"
    const timeMatches = [...t.matchAll(/\b(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/g)];
    if (timeMatches.length >= 2) return true;

    // Pattern 2: two different weekday references
    const weekdayMatches = [...t.matchAll(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/gi)];
    const uniqueDays = new Set(weekdayMatches.map(m => m[1].toLowerCase().slice(0, 3)));
    if (uniqueDays.size >= 2) return true;

    // Pattern 3: two event keywords with a connector between them
    // Fixed: allow zero chars between "and"/"then" and the second keyword (e.g. "and workout")
    const EVENT_KW = "run|swim|gym|workout|walk|hike|bike|yoga|pilates|lift|weights|cardio|meeting|call|zoom|flight|dentist|doctor|lunch|dinner|breakfast|brunch|class|lecture|exam|study|appointment|interview|presentation|shift|session";
    const pat3 = new RegExp(`\\b(?:${EVENT_KW})\\b.{1,80}?\\b(?:and|then)\\b\\s*\\b(?:${EVENT_KW})\\b`, "i");
    if (pat3.test(t)) return true;

    // Pattern 4: "one [day] ... and one [day]"
    if (/\bone\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b.+\bone\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(t)) return true;

    return false;
  }

  // Schedule multiple events sequentially, collecting all suggestions at the end
  async function scheduleMultipleEvents(events: ParsedEvent[], originalInput: string) {
    const scheduledBlocks: CalendarBlock[] = [];
    const needsInfo: ParsedEvent[] = [];

    for (const ev of events) {
      if (ev.timeHM && ev.dateIso) {
        // Fully specified — schedule directly, no modal needed
        const startMin = ev.timeHM.hour * 60 + ev.timeHM.minute;
        const endMin = Math.min(startMin + ev.durationMin, 24 * 60);
        const b: CalendarBlock = {
          id: generateId(),
          date: ev.dateIso,
          title: ev.title,
          startMin,
          endMin,
          meta: { kind: "manual", fullDetail: originalInput },
        };
        scheduledBlocks.push(b);
      } else {
        // Missing time (and/or date) — always ask the user in multi-event mode
        // so they can pick their preferred time for each activity.
        // (Previously events with a date but no time were silently auto-slotted,
        //  which skipped the time picker entirely.)
        needsInfo.push(ev);
      }
    }

    // Commit all fully-resolved blocks to calendar at once
    if (scheduledBlocks.length > 0) {
      addBlocksToCalendar(scheduledBlocks);
    }

    // If any events still need info, open the modal for the first one
    // Store the remainder in a queue state so we can loop through them
    if (needsInfo.length > 0) {
      const first = needsInfo[0];
      setMultiEventQueue(needsInfo.slice(1));
      setMultiEventScheduled(scheduledBlocks);
      setMultiEventOriginalInput(originalInput);
      setPendingQuickEvent({
        title: first.title,
        dateIso: first.dateIso,
        timeHM: first.timeHM,
        durationMin: first.durationMin,
        rawInput: originalInput,
        requiresTime: false,
        isMultiEvent: true,
      });
      setMissingInfoOpen(true);
      return;
    }

    // All scheduled — fetch suggestions for all blocks combined
    await fetchSuggestionsForBlocks(scheduledBlocks, originalInput);
  }

  // Fetch suggestions across multiple anchor blocks at once
  async function fetchSuggestionsForBlocks(blocks: CalendarBlock[], originalInput: string) {
    if (blocks.length === 0) { router.push("/plan"); return; }

    const firstCtx = detectEventContext(originalInput);
    setSuggestionsLoading(true);
    try {
      const anchors = blocks.map(b => ({
        date: b.date,
        startMin: b.startMin,
        endMin: b.endMin,
        title: b.title,
        kind: b.meta?.kind ?? "event",
      }));
      const sres = await fetch("/api/suggestions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: originalInput, anchors, preferenceContext: getPreferenceContext() }),
      });
      const sdata = (await sres.json()) as { suggestions?: SuggestedBlock[] };
      let sug = Array.isArray(sdata?.suggestions) ? sdata.suggestions : [];
      sug = sug.sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin);
      setSuggestionsLoading(false);
      if (sug.length > 0) {
        const keep: Record<number, boolean> = {};
        sug.forEach((_, i) => (keep[i] = true));
        setSuggestions(sug);
        setSuggestionsKeep(keep);
        setSuggestionsContext({ title: blocks.map(b => b.title).join(" & "), context: firstCtx });
        setSuggestionsOpen(true);
        return;
      }
    } catch {
      setSuggestionsLoading(false);
    }
    router.push("/plan");
  }

  async function generate() {
    showGeneratingOverlay();
    setLoading(true);
    setError(null);

    // If a file is attached, route to syllabus upload with the current input as instructions
    if (pendingFile) {
      const fileToUpload = pendingFile;
      setPendingFile(null); // clear attachment immediately for UX
      setLoading(false);
      hideGeneratingOverlay();
      await onUploadSyllabus(fileToUpload);
      return;
    }

    try {
      // Detect explicit planning requests
      const looksLikePlanningRequest = /\b(plan\s+my\s+(?:day|week)|make\s+(?:me\s+)?a\s+plan|build\s+(?:me\s+)?(?:a\s+)?schedule|create\s+(?:me\s+)?(?:a\s+)?schedule|organize\s+my\s+(?:day|week)|routine|agenda|help\s+me\s+with\s+my\s+day)\b/i.test(input);

      // ── Recurring event detection ──
      // "gym every Monday and Wednesday", "class on MWF at 10am", "yoga every Tuesday"
      if (!looksLikePlanningRequest && looksLikeRecurring(input)) {
        const recurring = parseRecurringEvent(input, allEventKeywords);
        if (recurring && recurring.dates.length >= 2) {
          setLoading(false);
          hideGeneratingOverlay();
          // Convert recurring dates into ParsedEvent-like objects and schedule them
          const recEvents = recurring.dates.map((dateIso) => ({
            title: recurring.title,
            dateIso,
            timeHM: recurring.timeHM,
            durationMin: recurring.durationMin,
            rawSegment: input,
          }));
          await scheduleMultipleEvents(recEvents, input);
          return;
        }
      }

      // ── Multi-event detection ──
      // Try this BEFORE single-event quick path so "run at 9am and workout at 6pm" is split correctly
      if (!looksLikePlanningRequest && looksLikeMultiEvent(input)) {
        const multiEvents = parseMultipleEvents(input);
        if (multiEvents && multiEvents.length >= 2) {
          setLoading(false);
          await scheduleMultipleEvents(multiEvents, input);
          hideGeneratingOverlay();
          return;
        }
      }

      if (!looksLikePlanningRequest) {
        const durationMin = parseDurationMinutes(input) ?? 60;
        const dateIso = parseDateISOFromText(input);
        const timeHM = parseTimeHM(input);
        const { title, needsAsk } = extractTitle(input, allEventKeywords);

        const hasAnySignal = !!(
          dateIso ||
          timeHM ||
          parseDurationMinutes(input) ||
          /\bnext\s+week\b/i.test(input) ||
          /\bnext\s+available\b/i.test(input) ||
          /\bat\s+some\s+point\b/i.test(input) ||
          /\bsome\s+time\b/i.test(input)
        );

        if (hasAnySignal) {
          if (needsAsk || !title) {
            setPendingQuickEvent({ dateIso, timeHM, durationMin });
            setAskTypeOpen(true);
            setLoading(false);
            hideGeneratingOverlay(true); // immediate — no overlay hold for fast UI paths
            return;
          }

          // If the user gave a time but no date, assume today — no need to ask when.
          // e.g. "run at 9am" → today at 9am. If they meant a different day they'd say so.
          const effectiveDateIso = dateIso ?? (timeHM ? localDateISO(new Date()) : null);

          const needsWhen = !effectiveDateIso &&
            !/\bnext\s+week\b/i.test(input) &&
            !/\bnext\s+available\b/i.test(input) &&
            !/\bat\s+some\s+point\b/i.test(input) &&
            !/\bsome\s+time\b/i.test(input);

          // Detect truly flexible / vague scheduling phrases — these are fine to auto-slot
          // without asking for a time, because the user explicitly said "whenever".
          const isFlexible =
            /\bnext\s+available\b/i.test(input) ||
            /\bat\s+some\s+point\b/i.test(input) ||
            /\bsome\s+time\b/i.test(input) ||
            // "next week" without a specific weekday — vague window, auto-slot is fine
            (/\bnext\s+week\b/i.test(input) && !/\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(input));

          const needsTime = !timeHM &&
            !isFlexible &&
            (!!effectiveDateIso || requiresExactTime(input));

          if (needsWhen || needsTime) {
            const hideSlotButton = needsTime && !needsWhen && requiresExactTime(input) && !effectiveDateIso;
            setPendingQuickEvent({ title, dateIso: effectiveDateIso, timeHM, durationMin, rawInput: input, requiresTime: hideSlotButton });
            setMissingInfoOpen(true);
            setLoading(false);
            hideGeneratingOverlay(true);
            return;
          }

          // ── Show confirmation chip before committing ──
          // Fires for ALL fully-resolved quick events.
          const durationLabel = durationMin >= 60
            ? `${Math.floor(durationMin / 60)}${durationMin % 60 ? `:${String(durationMin % 60).padStart(2,"0")}` : ""} hr${Math.floor(durationMin / 60) !== 1 ? "s" : ""}`
            : `${durationMin} min`;

          const todayIso = localDateISO(new Date());
          const tomorrowIso = (() => { const t = new Date(); t.setDate(t.getDate() + 1); return localDateISO(t); })();
          const dateLabel = !effectiveDateIso
            ? (isFlexible ? "Next available slot" : "Today")
            : effectiveDateIso === todayIso ? "Today"
            : effectiveDateIso === tomorrowIso ? "Tomorrow"
            : new Date(`${effectiveDateIso}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

          const timeLabel = timeHM
            ? ` · ${timeHM.hour % 12 || 12}:${String(timeHM.minute).padStart(2,"0")} ${timeHM.hour < 12 ? "AM" : "PM"}`
            : "";

          const prefs = loadPreferences();
          const prefNote = prefs.styleNotes.length > 0 && timeHM
            ? prefs.styleNotes.find((n) => {
                const nl = n.toLowerCase();
                const isEvening = timeHM.hour >= 17;
                const isMorning = timeHM.hour < 12;
                return (isEvening && nl.includes("evening")) || (isMorning && nl.includes("morning"));
              })
            : null;

          const chipSummary = [title, durationLabel, dateLabel + timeLabel, prefNote].filter(Boolean).join(" · ");

          setLoading(false);
          hideGeneratingOverlay(true);

          setConfirmChip({
            summary: chipSummary,
            onConfirm: () => {
              const ok = scheduleQuickEvent({ title, dateIso: effectiveDateIso, timeHM, durationMin });
              if (!ok) {
                setError("I couldn't find an available time slot. Try a shorter duration or a specific day/time.");
              } else {
                setInput("");
                setConfirmChip(null);
              }
            },
            onEdit: () => { setConfirmChip(null); },
          });
          return;
        }
      }

      // Fall through to planning API
      const res = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input, preferenceContext: getPreferenceContext() }),
      });

      const data = (await res.json()) as Plan & { error?: string };

      if (!res.ok) {
        const errorMsg = (data as any)?.error ?? "Request failed";
        throw new Error(errorMsg);
      }

      const item: HistoryItem = {
        id: generateId(),
        createdAt: new Date().toISOString(),
        input,
        plan: data,
      };

      const preview = previewCalendarFromHistory(item);
      setPendingHistory(item);
      setPlanPreview(preview);
      const keep: Record<number, boolean> = {};
      const titles: Record<number, string> = {};
      preview.proposed.forEach((b, i) => {
        keep[i] = true;
        titles[i] = b.title;
      });
      setPlanKeep(keep);
      setPlanTitles(titles);

      // Smart suggestions for plan-based events too
      try {
        const anchors = preview.proposed.slice(0, 6).map((b) => ({
          date: b.date,
          startMin: b.startMin,
          endMin: b.endMin,
          title: b.title,
          kind: b.meta?.kind ?? "event",
        }));

        const sres = await fetch("/api/suggestions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input, anchors, preferenceContext: getPreferenceContext() }),
        });

        const sdata = (await sres.json()) as { suggestions?: SuggestedBlock[] };
        const sug = Array.isArray(sdata?.suggestions) ? sdata.suggestions : [];
        if (sug.length) {
          const keep2: Record<number, boolean> = {};
          sug.forEach((_, i) => (keep2[i] = true));
          setSuggestions(sug);
          setSuggestionsKeep(keep2);
          setSuggestionsContext({ context: detectEventContext(input) });
          setSuggestionsOpen(true);
        }
      } catch {
        // non-blocking
      }
    } catch (e: any) {
      setError(e?.message ?? "Something went wrong");
    } finally {
      setLoading(false);
      hideGeneratingOverlay();
    }
  }

  function confirmPlanImport() {
    if (!planPreview || !pendingHistory) return;

    const approved: CalendarBlock[] = planPreview.proposed
      .map((b, i) => {
        const title = (planTitles[i] ?? b.title).trim();
        return { ...b, title };
      })
      .filter((_, i) => !!planKeep[i])
      .filter((b) => b.title.trim().length > 0);

    addToHistory(pendingHistory, 30);
    applyApprovedPlanBlocks(planPreview, approved);

    setPlanPreview(null);
    setPendingHistory(null);
    setPlanKeep({});
    setPlanTitles({});

    router.push("/plan");
  }

  async function onUploadSyllabus(file: File, yearOverride?: number, sectionOverride?: string) {
    setSyllabusLoading(true);
    setSyllabusError(null);
    setSyllabusEvents(null);
    setSyllabusKeep({});
    setSyllabusMeta(null);
    setYearConfirm(null);
    setSectionPick(null);
    setSyllabusFile(file);

    try {
      const fd = new FormData();
      fd.append("file", file);
      if (typeof yearOverride === "number" && Number.isFinite(yearOverride)) {
        fd.append("yearOverride", String(yearOverride));
      }
      if (sectionOverride) fd.append("section", sectionOverride);
      if (input.trim()) fd.append("instructions", input.trim());

      const res = await fetch("/api/import-syllabus", {
        method: "POST",
        body: fd,
      });

      const data = (await res.json()) as { events?: SyllabusEvent[]; meta?: any; error?: string; needsSectionPick?: boolean; sections?: string[]; course?: string };
      if (!res.ok) throw new Error(data?.error ?? "Upload failed");

      // Multiple sections detected — ask the user to pick before extracting
      if (data?.needsSectionPick && Array.isArray(data.sections) && data.sections.length >= 2) {
        setSectionPick({ sections: data.sections, course: data.course ?? "" });
        return;
      }

      if (data?.meta?.needsYearConfirm && typeof data.meta.detectedYear === "number" && typeof data.meta.nowYear === "number") {
        setSyllabusMeta(data.meta);
        setYearConfirm({ detectedYear: data.meta.detectedYear, nowYear: data.meta.nowYear });
        return;
      }

      const events = Array.isArray(data?.events) ? data.events : [];
      setSyllabusEvents(events);
      const keep: Record<number, boolean> = {};
      events.forEach((_, i) => (keep[i] = true));
      setSyllabusKeep(keep);
      setSyllabusMeta(data?.meta ?? null);
    } catch (e: any) {
      setSyllabusError(e?.message ?? "Could not import syllabus");
    } finally {
      setSyllabusLoading(false);
    }
  }

  function importSelectedEvents() {
    if (!syllabusEvents) return;
    const selected = syllabusEvents.filter((_, i) => syllabusKeep[i]);
    const result = addSyllabusEventsToCalendar(selected, syllabusColor);
    if (!result.ok) {
      setSyllabusError(
        "Could not add events to your calendar (browser storage is full or unavailable). Try clearing some existing blocks, then try again."
      );
      return;
    }
    try {
      const first = selected
        .map((e) => e.date)
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort()[0];
      if (first) {
        window.localStorage.setItem("lifeos_calendar_cursor_v1", first);
        // Set the jump flag so the calendar actually navigates to this date
        window.sessionStorage.setItem("lifeos_calendar_jump_v1", "1");
      }
    } catch {
      // ignore
    }
    setSyllabusEvents(null);
    // Offer study block generation for graded items
    const gradedItems = selected.filter((e) =>
      /exam|quiz|assignment|project|paper|midterm|final|presentation|journal/i.test(e.kind ?? e.title)
    );
    setStudyBlockCandidates(gradedItems);
    setShowImportAnother(true);
  }

  // Schedule prep study blocks 2–4 days before each graded deadline
  function scheduleStudyBlocks(candidates: SyllabusEvent[]) {
    const existing = loadCalendar();
    const newBlocks: CalendarBlock[] = [];
    for (const item of candidates.slice(0, 8)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(item.date)) continue;
      const deadlineDate = new Date(`${item.date}T12:00:00`);
      // Schedule a 60-min study session 3 days before (or 2 days if 3 days is in the past)
      for (const daysBefore of [3, 2]) {
        const d = new Date(deadlineDate);
        d.setDate(d.getDate() - daysBefore);
        const studyDate = d.toISOString().slice(0, 10);
        // Find a slot in the late-morning/afternoon (9am–6pm)
        const slot = findNextAvailableSlot(existing, 60, studyDate, 1, true);
        if (slot) {
          const b: CalendarBlock = {
            id: generateId(),
            date: slot.date,
            title: `Study · ${item.title.replace(/^submit\s+/i, "")}`,
            startMin: slot.startMin,
            endMin: slot.endMin,
            meta: { kind: "syllabus", source: "auto-generated study block" },
          };
          newBlocks.push(b);
          existing.push(b); // prevent slot overlap between study blocks
          break;
        }
      }
    }
    if (newBlocks.length > 0) {
      saveCalendar([...newBlocks, ...loadCalendar()]);
    }
    setStudyBlocksScheduled(true);
    router.push("/calendar");
  }

  return (
    <>
    {/* ── Full-screen loading overlays ── */}
    <GeneratingOverlay visible={generatingVisible} />
    <SuggestionsLoadingOverlay visible={suggestionsLoading} />
    <SyllabusLoadingOverlay visible={syllabusLoading} />

    {/* ── Subtle radial glow behind hero ── */}
    <div
      className="relative min-h-[calc(100vh-80px)] flex flex-col items-center justify-center text-center px-4"
      style={{
        background: "radial-gradient(ellipse 70% 55% at 50% 30%, rgba(255,107,107,0.07) 0%, transparent 70%)",
      }}
    >

      {/* ── Eyebrow tag ── */}
      <div className="inline-flex items-center gap-1.5 rounded-full border border-[var(--lifeos-pink)]/25 bg-[var(--lifeos-pink)]/8 px-3.5 py-1 mb-5">
        <span className="text-sm">✦</span>
        <span className="text-xs font-bold tracking-widest uppercase text-[var(--lifeos-pink)]">Your AI day planner</span>
      </div>

      {/* ── Hero headline ── */}
      <h1
        className="text-5xl sm:text-[64px] font-extrabold text-black leading-[1.05] max-w-2xl"
        style={{ letterSpacing: "-0.035em" }}
      >
        Tell me your day.{" "}
        <span style={{ color: "var(--lifeos-pink)" }}>I'll plan it.</span>
      </h1>

      <p className="mt-4 text-base text-black/40 font-medium max-w-sm">
        Describe what you want to do — the AI handles timing, conflicts, and scheduling.
      </p>

      {/* ── Training badge — shows when user has given feedback ── */}
      {(feedbackSessions > 0 || pendingFeedback.length > 0) && (
        <div className="mt-3">
          <FeedbackBadge
            sessions={feedbackSessions}
            pending={pendingFeedback.length}
            onReview={() => {
              if (pendingFeedback.length > 0) {
                void submitFeedbackToAI(pendingFeedback, input);
                setPendingFeedback([]);
              }
            }}
          />
        </div>
      )}

      {/* ── Input card ── */}
      <div className="mt-10 w-full max-w-2xl">

        {/* File chip (shown above card when attached) */}
        {pendingFile && (
          <div className="mb-3 flex justify-center">
            <div className="inline-flex items-center gap-2 rounded-full bg-white border border-[var(--lifeos-border)] px-4 py-2 shadow-sm text-sm font-semibold text-black/80">
              <span>📎</span>
              <span className="max-w-[240px] truncate">{pendingFile.name}</span>
              <button
                onClick={() => setPendingFile(null)}
                className="ml-1 text-black/30 hover:text-black/70 transition-colors leading-none"
                aria-label="Remove attachment"
              >✕</button>
            </div>
          </div>
        )}

        {/* Card container — focus ring turns pink */}
        <div className="rounded-2xl bg-white border border-black/8 shadow-[0_4px_24px_rgba(0,0,0,0.07)] overflow-hidden focus-within:border-[var(--lifeos-pink)] focus-within:shadow-[0_4px_32px_rgba(255,107,107,0.12)] transition-all duration-200">

          {/* Textarea */}
          <textarea
            className="w-full resize-none bg-transparent px-5 pt-5 pb-3 text-base font-semibold text-black placeholder:text-black/25 outline-none leading-relaxed"
            rows={3}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && canGenerate) {
                e.preventDefault();
                generate();
              }
            }}
            placeholder={
              pendingFile
                ? `Instructions for ${pendingFile.name}… (optional)`
                : "Today I want to run 5km, study for 2 hours, and cook dinner…"
            }
          />

          {/* Card bottom bar — attach + generate */}
          <div className="flex items-center justify-between gap-3 border-t border-black/[0.05] px-4 py-3">

            {/* Attach file button */}
            <label
              className="flex cursor-pointer items-center gap-2 rounded-xl px-3 py-1.5 text-xs font-bold text-black/40 hover:bg-black/[0.04] hover:text-black/70 transition-colors"
              title="Attach a syllabus, PDF or DOCX"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66L9.41 17.41a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
              Attach syllabus
              <input
                type="file"
                accept="application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx,application/msword"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) { setPendingFile(f); setSyllabusError(null); }
                  e.currentTarget.value = "";
                }}
                disabled={syllabusLoading}
              />
            </label>

            {/* Generate button — inside card */}
            <button
              onClick={generate}
              disabled={!canGenerate}
              className="flex items-center gap-2 rounded-xl bg-[var(--lifeos-pink)] px-5 py-2 text-sm font-bold text-white shadow-[0_2px_10px_rgba(255,107,107,0.35)] transition hover:shadow-[0_4px_18px_rgba(255,107,107,0.45)] hover:scale-[1.03] active:scale-[0.97] disabled:opacity-40 disabled:shadow-none disabled:scale-100"
            >
              <span className="text-base leading-none">✦</span>
              {syllabusLoading ? "Reading…" : loading ? "Generating…" : pendingFile ? "Import file" : "Generate plan"}
            </button>
          </div>
        </div>

        {/* Keyboard hint */}
        <p className="mt-2.5 text-center text-[11px] text-black/30 font-medium">
          Press <kbd className="rounded-md border border-black/10 bg-black/[0.04] px-1.5 py-0.5 font-mono text-[10px]">↵ Enter</kbd> to generate &nbsp;·&nbsp; <kbd className="rounded-md border border-black/10 bg-black/[0.04] px-1.5 py-0.5 font-mono text-[10px]">⇧ Shift+Enter</kbd> for new line
        </p>

        {/* ── Confirmation chip — appears after parsing, before committing ── */}
        {confirmChip && (
          <div className="mt-4 flex items-center gap-3 rounded-2xl border border-[var(--lifeos-pink)]/30 bg-[var(--lifeos-pink)]/5 px-4 py-3 text-left">
            <span className="text-lg shrink-0">✦</span>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-bold text-[var(--lifeos-pink)] uppercase tracking-wider mb-0.5">I heard</p>
              <p className="text-sm font-semibold text-black/80 truncate">{confirmChip.summary}</p>
            </div>
            <div className="flex gap-2 shrink-0">
              <button
                onClick={() => { setConfirmChip(null); }}
                className="rounded-xl border border-black/10 bg-white px-3 py-1.5 text-xs font-semibold text-black/60 hover:border-black/20 transition-colors"
              >
                Edit
              </button>
              <button
                onClick={() => { const fn = confirmChip.onConfirm; setConfirmChip(null); fn(); }}
                className="rounded-xl bg-[var(--lifeos-pink)] px-3 py-1.5 text-xs font-bold text-white hover:opacity-90 transition-opacity"
              >
                Looks right ✓
              </button>
            </div>
          </div>
        )}

        {/* Feature hint chips — interactive */}
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">

          {/* 🔁 Recurring events — pre-fills the textarea with a template */}
          <button
            className="inline-flex items-center gap-1.5 rounded-full bg-black/[0.04] px-3 py-1.5 text-xs font-semibold text-black/50 hover:bg-[var(--lifeos-pink)]/10 hover:text-[var(--lifeos-pink)] transition-colors cursor-pointer"
            onClick={() => {
              setInput((prev) => prev.trim() ? prev : "gym every Monday, Wednesday, Friday at 7am");
            }}
            title="Try recurring events — pre-fills an example"
          >
            <span>🔁</span>
            <span>Recurring events</span>
          </button>

          {/* 📎 Syllabus import — triggers file picker */}
          <label
            className="inline-flex items-center gap-1.5 rounded-full bg-black/[0.04] px-3 py-1.5 text-xs font-semibold text-black/50 hover:bg-[var(--lifeos-pink)]/10 hover:text-[var(--lifeos-pink)] transition-colors cursor-pointer"
            title="Import your syllabus PDF or DOCX"
          >
            <span>📎</span>
            <span>Syllabus import</span>
            <input
              ref={chipSyllabusInputRef}
              type="file"
              accept="application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx,application/msword"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) { setPendingFile(f); setSyllabusError(null); }
                e.currentTarget.value = "";
              }}
              disabled={syllabusLoading}
            />
          </label>

          {/* ⏰ Smart scheduling — pre-fills a time-based example */}
          <button
            className="inline-flex items-center gap-1.5 rounded-full bg-black/[0.04] px-3 py-1.5 text-xs font-semibold text-black/50 hover:bg-[var(--lifeos-pink)]/10 hover:text-[var(--lifeos-pink)] transition-colors cursor-pointer"
            onClick={() => {
              setInput((prev) => prev.trim() ? prev : "dentist appointment tomorrow at 2pm, then pick up groceries");
            }}
            title="Smart scheduling finds the best available slot"
          >
            <span>⏰</span>
            <span>Smart scheduling</span>
          </button>

          {/* ✨ AI suggestions — pre-fills a prompt that gets suggestions */}
          <button
            className="inline-flex items-center gap-1.5 rounded-full bg-black/[0.04] px-3 py-1.5 text-xs font-semibold text-black/50 hover:bg-[var(--lifeos-pink)]/10 hover:text-[var(--lifeos-pink)] transition-colors cursor-pointer"
            onClick={() => {
              setInput((prev) => prev.trim() ? prev : "flight to New York next Friday at 8am");
            }}
            title="AI suggests prep, travel, and recovery blocks around your event"
          >
            <span>✨</span>
            <span>AI suggestions</span>
          </button>
        </div>

        {/* Error banners */}
        {error && (
          <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 text-left">
            {error}
          </div>
        )}
        {syllabusError && (
          <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 text-left">
            {syllabusError}
          </div>
        )}
        {/* suggestions loading handled by SuggestionsLoadingOverlay */}
      </div>

      {/* ── Today strip — upcoming blocks for today (below input) ── */}
      <TodayStrip />

      {/* Suggestions Modal */}
      <SuggestionsModal
        open={suggestionsOpen}
        eventTitle={suggestionsContext.title}
        eventContext={suggestionsContext.context}
        suggestions={suggestions}
        keep={suggestionsKeep}
        setKeep={setSuggestionsKeep}
        onClose={() => {
          setSuggestionsOpen(false);
          setSuggestions([]);
          setSuggestionsKeep({});
          router.push("/plan");
        }}
        onConfirm={() => {
          const selected = suggestions.filter((_, i) => !!suggestionsKeep[i]);
          const blocks: CalendarBlock[] = selected.map((s) => ({
            id: generateId(),
            date: s.date,
            title: s.title,
            startMin: s.startMin,
            endMin: s.endMin,
            meta: { kind: "manual" },
          }));
          addBlocksToCalendar(blocks);
          setSuggestionsOpen(false);
          setSuggestions([]);
          setSuggestionsKeep({});
          router.push("/plan");
        }}
        onRate={(s: SuggestedBlock) => {
          // Convert suggestion to a pseudo CalendarBlock for feedback
          const pseudoBlock: CalendarBlock = {
            id: generateId(),
            date: s.date,
            title: s.title,
            startMin: s.startMin,
            endMin: s.endMin,
            meta: { kind: "manual" },
          };
          setFeedbackTarget({ block: pseudoBlock, prompt: input });
          setFeedbackOpen(true);
        }}
      />

      {/* Missing Info Modal */}
      <MissingInfoModal
        key={missingInfoOpen ? `open-${pendingQuickEvent?.dateIso ?? ""}-${pendingQuickEvent?.timeHM?.hour ?? ""}-${pendingQuickEvent?.title ?? ""}` : "closed"}
        open={missingInfoOpen}
        eventTitle={pendingQuickEvent?.title}
        prefillDate={pendingQuickEvent?.dateIso ?? ""}
        prefillTime={
          pendingQuickEvent?.timeHM
            ? `${String(pendingQuickEvent.timeHM.hour).padStart(2, "0")}:${String(pendingQuickEvent.timeHM.minute).padStart(2, "0")}`
            : ""
        }
        prefillDuration={pendingQuickEvent?.durationMin ?? 60}
        hideNextAvailable={!!pendingQuickEvent?.requiresTime}
        // Show progress indicator when processing a multi-event queue
        queueInfo={pendingQuickEvent?.isMultiEvent ? { remaining: multiEventQueue.length } : undefined}
        onClose={() => {
          setMissingInfoOpen(false);
          setPendingQuickEvent(null);
          // If closing mid-queue, still fire suggestions for whatever was already scheduled
          if (pendingQuickEvent?.isMultiEvent && multiEventScheduled.length > 0) {
            void fetchSuggestionsForBlocks(multiEventScheduled, multiEventOriginalInput);
            setMultiEventQueue([]);
            setMultiEventScheduled([]);
            setMultiEventOriginalInput("");
          }
        }}
        onPickNext={(dur: number) => {
          const pe = pendingQuickEvent;
          if (!pe?.title) return;
          const capturedInput = pe.rawInput || pe.title;
          const hasDate = !!pe.dateIso;

          // Schedule this event
          const existing = loadCalendar();
          const startISO = pe.dateIso ?? localDateISO(new Date());
          const slot = hasDate
            ? (findNextAvailableSlot(existing, dur, startISO, 1, true) ?? findNextAvailableSlot(existing, dur, startISO, 14, false))
            : findNextAvailableSlot(existing, dur, startISO, 14, false);

          let newScheduled = [...multiEventScheduled];
          if (slot) {
            const b: CalendarBlock = {
              id: generateId(),
              date: slot.date,
              title: pe.title,
              startMin: slot.startMin,
              endMin: slot.endMin,
              meta: { kind: "manual", fullDetail: capturedInput },
            };
            addBlocksToCalendar([b]);
            newScheduled = [...newScheduled, b];
            setMultiEventScheduled(newScheduled);
          } else {
            setError(`Couldn't find a slot for "${pe.title}". Try a shorter duration.`);
          }

          setMissingInfoOpen(false);
          setPendingQuickEvent(null);

          // Advance the queue or finish
          if (pe.isMultiEvent && multiEventQueue.length > 0) {
            const [next, ...rest] = multiEventQueue;
            setMultiEventQueue(rest);
            setTimeout(() => {
              setPendingQuickEvent({ ...next, rawInput: multiEventOriginalInput, isMultiEvent: true });
              setMissingInfoOpen(true);
            }, 200);
          } else {
            // Done — clear queue and show suggestions
            setInput("");
            setMultiEventQueue([]);
            setMultiEventOriginalInput("");
            void fetchSuggestionsForBlocks(newScheduled, capturedInput);
          }
        }}
        onPickExact={(date: string, time: string, dur: number) => {
          const pe = pendingQuickEvent;
          if (!pe?.title) return;
          const resolvedDate = date || pe?.dateIso || "";
          if (!resolvedDate) { setError("Please pick a date."); return; }
          const capturedInput = pe.rawInput || pe.title;
          const [hh, mm] = String(time || "12:00").split(":").map((x) => parseInt(x, 10));
          const startMin = (hh || 12) * 60 + (mm || 0);
          const endMin = Math.min(startMin + clampMinutes(dur), 24 * 60);
          const block: CalendarBlock = {
            id: generateId(),
            date: resolvedDate,
            title: pe.title,
            startMin,
            endMin,
            meta: { kind: "manual", fullDetail: capturedInput },
          };

          addBlocksToCalendar([block]);
          const newScheduled = [...multiEventScheduled, block];
          setMultiEventScheduled(newScheduled);
          setMissingInfoOpen(false);
          setPendingQuickEvent(null);

          // Advance queue or finish
          if (pe.isMultiEvent && multiEventQueue.length > 0) {
            const [next, ...rest] = multiEventQueue;
            setMultiEventQueue(rest);
            setTimeout(() => {
              setPendingQuickEvent({ ...next, rawInput: multiEventOriginalInput, isMultiEvent: true });
              setMissingInfoOpen(true);
            }, 200);
          } else {
            setInput("");
            setMultiEventQueue([]);
            setMultiEventOriginalInput("");
            void fetchSuggestionsForBlocks(newScheduled, capturedInput);
          }
        }}
      />

      {/* Ask Event Type Modal */}
      <AskEventTypeModal
        open={askTypeOpen}
        onClose={() => {
          setAskTypeOpen(false);
          setPendingQuickEvent(null);
        }}
        onSubmit={(val: string) => {
          const v = String(val || "").trim();
          if (!v) return;
          addCustomEventKeyword(v);
          setCustomKeywords(loadCustomEventKeywords());

          const pe = pendingQuickEvent ?? {};
          const payload = { title: v, dateIso: pe.dateIso ?? null, timeHM: pe.timeHM ?? null, durationMin: pe.durationMin ?? 60 };
          setAskTypeOpen(false);

          const needsWhen = !payload.dateIso &&
            !/\bnext\s+week\b/i.test(input) &&
            !/\bnext\s+available\b/i.test(input) &&
            !/\bat\s+some\s+point\b/i.test(input);
          const needsTime = !payload.timeHM &&
            !/\bnext\s+available\b/i.test(input) &&
            !/\bat\s+some\s+point\b/i.test(input) &&
            !/\bnext\s+week\b/i.test(input);

          if (needsWhen || needsTime) {
            setPendingQuickEvent({ ...pe, title: v });
            setMissingInfoOpen(true);
            return;
          }

          const ok = scheduleQuickEvent(payload);
          if (!ok) setError("I couldn't find an available time slot. Try a shorter duration or a specific day/time.");
          setPendingQuickEvent(null);
          setInput("");
        }}
      />

      {/* Conflict Modal */}
      <ConflictModal
        open={conflictOpen}
        newBlock={conflictNewBlock}
        conflicts={conflictConflicts}
        onCancel={() => {
          setConflictOpen(false);
          setConflictNewBlock(null);
          setConflictConflicts([]);
          setConflictInputText("");
        }}
        onReplace={() => {
          if (!conflictNewBlock) return;
          // Remove conflicting blocks from calendar, then add new block (skip conflict check)
          const existing = loadCalendar();
          const conflictIds = new Set(conflictConflicts.map((c) => c.id));
          saveCalendar(existing.filter((b) => !conflictIds.has(b.id)));
          setConflictOpen(false);
          const block = conflictNewBlock;
          const txt = conflictInputText;
          setConflictNewBlock(null);
          setConflictConflicts([]);
          setConflictInputText("");
          void scheduleAndMaybeSuggest(block, txt, true);
        }}
        onSqueeze={() => {
          if (!conflictNewBlock) return;
          const block = conflictNewBlock;
          const txt = conflictInputText;
          const dur = block.endMin - block.startMin;
          setConflictOpen(false);
          setConflictNewBlock(null);
          setConflictConflicts([]);
          setConflictInputText("");
          // Find next free slot on the same date starting from the originally requested time
          const allBlocks = loadCalendar().filter((b) => b.date === block.date);
          const slot = findNextAvailableSlot(allBlocks, dur, block.date, 14);
          if (!slot) {
            setError("No available slot found nearby. Try a different day or shorter duration.");
            return;
          }
          const newB: CalendarBlock = { ...block, date: slot.date, startMin: slot.startMin, endMin: slot.endMin };
          void scheduleAndMaybeSuggest(newB, txt, true);
        }}
        onKeepBoth={() => {
          if (!conflictNewBlock) return;
          const block = conflictNewBlock;
          const txt = conflictInputText;
          setConflictOpen(false);
          setConflictNewBlock(null);
          setConflictConflicts([]);
          setConflictInputText("");
          void scheduleAndMaybeSuggest(block, txt, true);
        }}
      />

      {/* ── Section picker modal — shown when syllabus has multiple sections ── */}
      {sectionPick && syllabusFile ? (() => {
        const COURSE_COLORS = ["#d96c7d","#6C8EE8","#5BA85E","#E8A83C","#9B6CE8","#E86C6C","#3CB8E8"];
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
            <div className="w-full max-w-md rounded-3xl border border-[var(--lifeos-border-soft)] bg-white p-6 text-left">
              <div className="mb-1 text-2xl">🎓</div>

              {/* Header + color picker side by side */}
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <div className="text-lg font-extrabold text-black" style={{ letterSpacing: "-0.02em" }}>
                    Which section are you in?
                  </div>
                  <p className="mt-1.5 text-sm text-black/60 leading-relaxed">
                    {sectionPick.course
                      ? <><span className="font-semibold text-black/80">{sectionPick.course}</span> has multiple sections.</>
                      : "This syllabus has multiple sections."}{" "}
                    Pick yours and we'll only import your lectures.
                  </p>
                </div>
                {/* Course color picker */}
                <div className="flex flex-col items-end gap-1.5 shrink-0">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-black/40">Course color</span>
                  <div className="flex gap-1.5">
                    {COURSE_COLORS.map((c) => (
                      <button
                        key={c}
                        onClick={() => setSyllabusColor(c)}
                        className="h-5 w-5 rounded-full transition-transform hover:scale-110"
                        style={{
                          backgroundColor: c,
                          outline: syllabusColor === c ? `2px solid ${c}` : "2px solid transparent",
                          outlineOffset: "2px",
                        }}
                        title={c}
                      />
                    ))}
                  </div>
                  {/* Swatch preview */}
                  <div
                    className="mt-1 rounded-lg px-2 py-1 text-[10px] font-bold"
                    style={{ backgroundColor: `${syllabusColor}22`, color: syllabusColor, border: `1px solid ${syllabusColor}55` }}
                  >
                    Preview
                  </div>
                </div>
              </div>

              <div className="mt-5 flex flex-wrap gap-3">
                {sectionPick.sections.map((sec) => (
                  <button
                    key={sec}
                    className="flex-1 min-w-[80px] rounded-2xl px-5 py-3 text-sm font-bold text-white shadow-sm hover:opacity-90 transition-opacity"
                    style={{ backgroundColor: syllabusColor }}
                    onClick={() => {
                      const f = syllabusFile;
                      setSectionPick(null);
                      void onUploadSyllabus(f, undefined, sec);
                    }}
                  >
                    Section {sec}
                  </button>
                ))}
              </div>
              <button
                className="mt-3 w-full text-center text-xs text-black/30 hover:text-black/60 transition-colors"
                onClick={() => { setSectionPick(null); setSyllabusLoading(false); }}
              >
                Cancel
              </button>
            </div>
          </div>
        );
      })() : null}

      {/* ── Year confirm modal for syllabus (improved framing) ── */}
      {yearConfirm && syllabusFile ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="w-full max-w-md rounded-3xl border border-[var(--lifeos-border-soft)] bg-white p-6 text-left">
            <div className="mb-1 text-2xl">📅</div>
            <div className="text-lg font-extrabold text-black" style={{ letterSpacing: "-0.02em" }}>
              This looks like {yearConfirm.detectedYear === yearConfirm.nowYear + 1 ? "a future" : "a past"} syllabus
            </div>
            <p className="mt-2 text-sm text-black/60 leading-relaxed">
              The dates in this file appear to be for{" "}
              <span className="font-bold text-black/80">{yearConfirm.detectedYear}</span>.{" "}
              {yearConfirm.detectedYear > yearConfirm.nowYear
                ? "That's correct for an upcoming semester — use that year."
                : `If this is for the current year (${yearConfirm.nowYear}), choose that instead.`}
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <button
                className="flex-1 rounded-2xl bg-[var(--lifeos-pink)] px-5 py-3 text-sm font-bold text-white shadow-sm"
                onClick={() => {
                  setYearConfirm(null);
                  void onUploadSyllabus(syllabusFile, yearConfirm.detectedYear);
                }}
              >
                ✓ Yes, use {yearConfirm.detectedYear}
              </button>
              <button
                className="flex-1 rounded-2xl border border-[var(--lifeos-border)] bg-white px-5 py-3 text-sm font-semibold text-black/70"
                onClick={() => {
                  setYearConfirm(null);
                  void onUploadSyllabus(syllabusFile, yearConfirm.nowYear);
                }}
              >
                Use {yearConfirm.nowYear} instead
              </button>
            </div>
            <button
              className="mt-3 w-full text-center text-xs text-black/30 hover:text-black/60 transition-colors"
              onClick={() => { setYearConfirm(null); setSyllabusLoading(false); }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {/* ── Syllabus import review modal (grouped by kind + confidence + color) ── */}
      {syllabusEvents ? (() => {
        // Group events by kind
        const kindOrder = ["exam", "quiz", "assignment", "project", "paper", "journal", "lecture", "lab", "discussion", "other"];
        const kindLabel: Record<string, { label: string; icon: string }> = {
          exam:       { label: "Exams & Tests",    icon: "📝" },
          quiz:       { label: "Quizzes",           icon: "🧪" },
          assignment: { label: "Assignments",       icon: "📋" },
          project:    { label: "Projects & Papers", icon: "📁" },
          paper:      { label: "Projects & Papers", icon: "📁" },
          journal:    { label: "Journals",          icon: "📓" },
          lecture:    { label: "Lectures",          icon: "🎓" },
          lab:        { label: "Labs",              icon: "🔬" },
          discussion: { label: "Discussions",       icon: "💬" },
          other:      { label: "Other",             icon: "📌" },
        };

        // Deduplicate groups so "project" and "paper" both show as "Projects & Papers"
        const grouped: Record<string, { events: { e: SyllabusEvent; i: number }[]; icon: string; label: string }> = {};
        syllabusEvents.forEach((e, i) => {
          const rawKind = (e.kind ?? "other").toLowerCase();
          const canonKey = kindOrder.find((k) => rawKind.includes(k)) ?? "other";
          const canon = kindLabel[canonKey] ?? { label: canonKey, icon: "📌" };
          const groupKey = canon.label;
          if (!grouped[groupKey]) grouped[groupKey] = { events: [], icon: canon.icon, label: canon.label };
          grouped[groupKey].events.push({ e, i });
        });

        const selectedCount = Object.values(syllabusKeep).filter(Boolean).length;
        const totalCount = syllabusEvents.length;

        const COURSE_COLORS = ["#d96c7d","#6C8EE8","#5BA85E","#E8A83C","#9B6CE8","#E86C6C","#3CB8E8"];

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
            <div className="w-full max-w-2xl rounded-3xl border border-[var(--lifeos-border-soft)] bg-white p-6">

              {/* Header */}
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-lg font-extrabold text-black" style={{ letterSpacing: "-0.02em" }}>
                    Import to calendar
                  </div>
                  <div className="mt-1 text-sm text-black/50">
                    {selectedCount} of {totalCount} items selected
                  </div>
                </div>
                {/* Course color picker */}
                <div className="flex flex-col items-end gap-1.5 shrink-0">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-black/40">Course color</span>
                  <div className="flex gap-1.5">
                    {COURSE_COLORS.map((c) => (
                      <button
                        key={c}
                        onClick={() => setSyllabusColor(c)}
                        className="h-5 w-5 rounded-full transition-transform hover:scale-110"
                        style={{
                          backgroundColor: c,
                          outline: syllabusColor === c ? `2px solid ${c}` : "2px solid transparent",
                          outlineOffset: "2px",
                        }}
                        title={c}
                      />
                    ))}
                  </div>
                </div>
              </div>

              {/* Select all / none row */}
              <div className="mt-3 flex items-center gap-3 text-xs font-semibold">
                <button
                  onClick={() => { const k: Record<number,boolean> = {}; syllabusEvents.forEach((_,i) => k[i]=true); setSyllabusKeep(k); }}
                  className="text-[var(--lifeos-pink)] hover:underline"
                >Select all</button>
                <span className="text-black/20">·</span>
                <button
                  onClick={() => setSyllabusKeep({})}
                  className="text-black/40 hover:underline"
                >Deselect all</button>
                {Object.keys(grouped).map((groupLabel) => (
                  <span key={groupLabel} className="contents">
                    <span className="text-black/20">·</span>
                    <button
                      onClick={() => {
                        const k = { ...syllabusKeep };
                        const groupItems = grouped[groupLabel].events;
                        const allOn = groupItems.every(({ i }) => k[i]);
                        groupItems.forEach(({ i }) => { k[i] = !allOn; });
                        setSyllabusKeep(k);
                      }}
                      className="text-black/40 hover:underline"
                    >
                      {grouped[groupLabel].icon} {grouped[groupLabel].label}
                    </button>
                  </span>
                ))}
              </div>

              {/* Grouped list */}
              <div className="mt-4 max-h-[50vh] overflow-auto rounded-2xl border border-[var(--lifeos-border-soft)]">
                {syllabusEvents.length === 0 ? (
                  <div className="p-4 text-sm text-black/70">No dated items found.</div>
                ) : (
                  <div>
                    {Object.entries(grouped).map(([groupLabel, group]) => (
                      <div key={groupLabel}>
                        {/* Group header */}
                        <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-[var(--lifeos-border-soft)] bg-black/[0.02] px-4 py-2">
                          <span className="text-sm">{group.icon}</span>
                          <span className="text-xs font-bold uppercase tracking-wider text-black/50">{group.label}</span>
                          <span className="ml-auto text-xs text-black/30">{group.events.filter(({ i }) => syllabusKeep[i]).length}/{group.events.length}</span>
                        </div>
                        {/* Group items */}
                        <div className="divide-y divide-black/[0.04]">
                          {group.events.map(({ e, i }) => {
                            const lowConf = typeof e.confidence === "number" && e.confidence < 0.75;
                            return (
                              <label key={i} className="flex gap-3 px-4 py-3 text-left cursor-pointer hover:bg-black/[0.02] transition-colors">
                                <input
                                  type="checkbox"
                                  className="mt-0.5 h-4 w-4 shrink-0"
                                  checked={!!syllabusKeep[i]}
                                  onChange={() => setSyllabusKeep((prev) => ({ ...prev, [i]: !prev[i] }))}
                                />
                                {/* Color dot */}
                                <div
                                  className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                                  style={{ backgroundColor: syllabusColor, opacity: syllabusKeep[i] ? 1 : 0.3 }}
                                />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2">
                                    <span className="text-sm font-semibold text-black/90 truncate">{e.title || "Untitled"}</span>
                                    {lowConf && (
                                      <span title="Low confidence — please verify this date" className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">
                                        ⚠ verify
                                      </span>
                                    )}
                                  </div>
                                  <div className="mt-0.5 text-xs text-black/50">
                                    {new Date(`${e.date}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" })}
                                    {e.startTime ? ` · ${e.startTime}` : ""}
                                    {e.endTime ? `–${e.endTime}` : ""}
                                  </div>
                                  {e.source ? <div className="mt-0.5 text-[11px] text-black/35 truncate">{e.source}</div> : null}
                                </div>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
                <button
                  onClick={() => setSyllabusEvents(null)}
                  className="rounded-full border border-[var(--lifeos-border)] bg-white px-5 py-2 text-sm font-semibold text-black/70"
                >
                  Cancel
                </button>
                <button
                  onClick={importSelectedEvents}
                  disabled={selectedCount === 0}
                  className="rounded-full bg-[var(--lifeos-pink)] px-5 py-2 text-sm font-semibold text-white disabled:opacity-40"
                >
                  Add {selectedCount > 0 ? selectedCount : ""} to Calendar
                </button>
              </div>
            </div>
          </div>
        );
      })() : null}

      {/* ── Post-import panel: study blocks + import another course ── */}
      {showImportAnother && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="w-full max-w-md rounded-3xl border border-[var(--lifeos-border-soft)] bg-white p-6 text-center">
            <div className="text-3xl mb-3">🎉</div>
            <div className="text-lg font-extrabold text-black mb-1" style={{ letterSpacing: "-0.02em" }}>
              Events added to your calendar!
            </div>
            <p className="text-sm text-black/50 mb-6">
              What would you like to do next?
            </p>

            <div className="flex flex-col gap-3">
              {/* Study blocks offer — only if there are graded items */}
              {studyBlockCandidates.length > 0 && !studyBlocksScheduled && (
                <button
                  onClick={() => {
                    setShowImportAnother(false);
                    scheduleStudyBlocks(studyBlockCandidates);
                  }}
                  className="w-full rounded-2xl bg-[var(--lifeos-pink)] px-5 py-4 text-left shadow-sm hover:opacity-90 transition-opacity"
                >
                  <div className="text-sm font-bold text-white">📚 Schedule study sessions</div>
                  <div className="text-xs text-white/70 mt-0.5">
                    Auto-schedule prep sessions before your {studyBlockCandidates.length} graded deadline{studyBlockCandidates.length !== 1 ? "s" : ""}
                  </div>
                </button>
              )}

              {/* Import another course */}
              <label className="w-full cursor-pointer rounded-2xl border-2 border-dashed border-[var(--lifeos-border)] px-5 py-4 text-left hover:border-[var(--lifeos-pink)]/50 hover:bg-black/[0.02] transition-colors">
                <div className="text-sm font-bold text-black/80">📎 Import another course</div>
                <div className="text-xs text-black/40 mt-0.5">Drop in your next syllabus PDF or DOCX</div>
                <input
                  type="file"
                  accept="application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx,application/msword"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) {
                      setShowImportAnother(false);
                      setStudyBlocksScheduled(false);
                      setStudyBlockCandidates([]);
                      void onUploadSyllabus(f);
                    }
                    e.currentTarget.value = "";
                  }}
                />
              </label>

              {/* Go to calendar */}
              <button
                onClick={() => { setShowImportAnother(false); router.push("/calendar"); }}
                className="w-full rounded-2xl border border-[var(--lifeos-border)] bg-white px-5 py-3 text-sm font-semibold text-black/70 hover:bg-black/[0.02] transition-colors"
              >
                View calendar →
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Plan confirmation modal */}
      {planPreview ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="w-full max-w-2xl rounded-3xl border border-[var(--lifeos-border-soft)] bg-white p-6">
            <div className="text-lg font-extrabold text-black" style={{ letterSpacing: "-0.02em" }}>
              Review plan
            </div>
            <div className="mt-1 text-sm text-black/60">
              Confirm what we should add to your calendar. Uncheck anything you don't want.
            </div>

            <div className="mt-5 max-h-[55vh] overflow-auto rounded-2xl border border-[var(--lifeos-border-soft)]">
              {planPreview.proposed.length === 0 ? (
                <div className="p-4 text-sm text-black/70">No calendar items detected.</div>
              ) : (
                <div className="divide-y divide-black/5">
                  {planPreview.proposed.map((b, i) => {
                    const startH = String(Math.floor(b.startMin / 60)).padStart(2, "0");
                    const startM = String(b.startMin % 60).padStart(2, "0");
                    const endH = String(Math.floor(b.endMin / 60)).padStart(2, "0");
                    const endM = String(b.endMin % 60).padStart(2, "0");
                    return (
                      <div key={b.id} className="flex gap-3 p-4 text-left">
                        <input
                          type="checkbox"
                          className="mt-1 h-4 w-4"
                          checked={!!planKeep[i]}
                          onChange={() => setPlanKeep((prev) => ({ ...prev, [i]: !prev[i] }))}
                        />
                        <div className="flex-1 min-w-0">
                          <input
                            value={planTitles[i] ?? b.title}
                            onChange={(e) => setPlanTitles((prev) => ({ ...prev, [i]: e.target.value }))}
                            className="w-full rounded-xl border border-[var(--lifeos-border-soft)] px-3 py-2 text-sm font-semibold text-black/90 outline-none"
                          />
                          <div className="mt-1 text-xs text-black/60">
                            {b.date} · {startH}:{startM}–{endH}:{endM}
                          </div>
                        </div>
                        {/* Rate button */}
                        <button
                          onClick={() => { setFeedbackTarget({ block: b, prompt: input }); setFeedbackOpen(true); }}
                          className="shrink-0 self-start mt-2 text-black/20 hover:text-[var(--lifeos-pink,#ff6b6b)] transition-colors text-base"
                          title="Rate this block"
                        >
                          ✦
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
              <button
                onClick={() => {
                  setPlanPreview(null);
                  setPendingHistory(null);
                }}
                className="rounded-full border border-[var(--lifeos-border)] bg-white px-5 py-2 text-sm font-semibold text-black/70"
              >
                Cancel
              </button>
              <button
                onClick={confirmPlanImport}
                className="rounded-full bg-[var(--lifeos-pink)] px-5 py-2 text-sm font-semibold text-white"
              >
                Add to Calendar
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── Feedback Modal ── */}
      <FeedbackModal
        open={feedbackOpen}
        block={feedbackTarget?.block ?? null}
        onClose={() => { setFeedbackOpen(false); setFeedbackTarget(null); }}
        onSubmit={(signal, note) => {
          const target = feedbackTarget;
          if (!target) return;
          const entry = addFeedback({
            blockTitle: target.block.title,
            blockKind: target.block.meta?.kind ?? "manual",
            blockDate: target.block.date,
            startMin: target.block.startMin,
            endMin: target.block.endMin,
            signal,
            note: note || undefined,
            prompt: target.prompt || input,
          });
          setPendingFeedback((prev) => [...prev, entry]);
          setFeedbackOpen(false);
          setFeedbackTarget(null);

          // Auto-submit to AI after every 3 feedback items, or immediately on thumbs_down
          const updated = [...pendingFeedback, entry];
          if (updated.length >= 3 || signal === "thumbs_down" || signal === "not_relevant") {
            void submitFeedbackToAI(updated, input);
            setPendingFeedback([]);
          }
        }}
      />
    </div>
    </>
  );
}
