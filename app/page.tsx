"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import posthog from "posthog-js";
import { useToast } from "./components/Toast";
import {
  addSyllabusEventsToCalendar,
  addToHistory,
  loadCalendar,
  loadHistory,
  saveCalendar,
  loadCustomEventKeywords,
  addCustomEventKeyword,
  applyApprovedPlanBlocks,
  previewCalendarFromHistory,
  loadPreferences,
  savePreferences,
  updatePreferences,
  loadFeedback,
  addFeedback,
  buildPreferenceContext,
  loadOnboardingProfile,
  saveOnboardingProfile,
  type OnboardingProfile,
  type CalendarBlock,
  type CalendarMergePreview,
  type HistoryItem,
  type Plan,
  type SyllabusEvent,
  type FeedbackSignal,
  type FeedbackEntry,
  type UserPreferences,
} from "./lib/storage-sync";
import { fullyPreprocess } from "./lib/nlp-preprocess";
import {
  loadSmartProfile,
  rebuildAndSaveSmartProfile,
  formatSmartProfileForPrompt,
} from "./lib/user-learning-profile";

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

// ── Waveform bars — replaces the orb ─────────────────────────
function WaveformBars({ color = "var(--lifeos-pink)" }: { color?: string }) {
  // 7 bars with staggered heights and speeds for an organic waveform feel
  const bars = [
    { height: [18, 48, 22], duration: 0.9 },
    { height: [32, 56, 28], duration: 0.75 },
    { height: [44, 64, 38], duration: 0.85 },
    { height: [28, 72, 32], duration: 0.7  },
    { height: [44, 64, 38], duration: 0.85 },
    { height: [32, 56, 28], duration: 0.75 },
    { height: [18, 48, 22], duration: 0.9  },
  ];
  return (
    <div className="flex items-center justify-center gap-[5px]" style={{ height: 80 }}>
      {bars.map((bar, i) => (
        <motion.div
          key={i}
          className="rounded-full"
          style={{ width: 5, background: color, originY: 1 }}
          animate={{ height: bar.height }}
          transition={{
            duration: bar.duration,
            delay: i * 0.06,
            repeat: Infinity,
            repeatType: "mirror",
            ease: "easeInOut",
          }}
        />
      ))}
    </div>
  );
}

// ── Rotating placeholder hook ─────────────────────────────────
const PLACEHOLDER_EXAMPLES = [
  "Essay due at midnight, gym at 7am, lunch and dinner…",
  "Study for exam Friday, dentist Tuesday at 2pm…",
  "Team meeting at 10, gym after work, make dinner…",
  "3 assignments due this week, need to sleep by 11…",
  "Flight Friday at 6am, pack tonight, dinner tomorrow…",
];

function useRotatingPlaceholder(interval = 3200) {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setIdx((i) => (i + 1) % PLACEHOLDER_EXAMPLES.length), interval);
    return () => clearInterval(t);
  }, [interval]);
  return PLACEHOLDER_EXAMPLES[idx];
}

// ── Streak display ─────────────────────────────────────────────
function StreakBadge() {
  const [streak, setStreak] = useState(0);
  useEffect(() => {
    try {
      const raw = localStorage.getItem("openhour_streak_v1");
      if (!raw) return;
      const { count, lastDate } = JSON.parse(raw);
      const today = new Date().toISOString().slice(0, 10);
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      if (lastDate === today || lastDate === yesterday) setStreak(count ?? 0);
    } catch { /* ignore */ }
  }, []);
  if (streak < 2) return null;
  return (
    <div className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 border border-amber-200 px-3 py-1 text-xs font-bold text-amber-600">
      <span>🔥</span>
      <span>{streak} day streak</span>
    </div>
  );
}

// ── Typewriter text ───────────────────────────────────────────
function TypewriterText({ text, color = "var(--lifeos-pink)" }: { text: string; color?: string }) {
  const [displayed, setDisplayed] = useState("");
  const [showCursor, setShowCursor] = useState(true);

  useEffect(() => {
    setDisplayed("");
    let i = 0;
    const t = setInterval(() => {
      i++;
      setDisplayed(text.slice(0, i));
      if (i >= text.length) clearInterval(t);
    }, 28);
    return () => clearInterval(t);
  }, [text]);

  // Blink cursor
  useEffect(() => {
    const t = setInterval(() => setShowCursor((v) => !v), 530);
    return () => clearInterval(t);
  }, []);

  return (
    <span>
      {displayed}
      <span style={{ color, opacity: showCursor ? 1 : 0, marginLeft: 1 }}>|</span>
    </span>
  );
}

// ── Indeterminate top progress bar ───────────────────────────
function TopProgressBar({ color = "var(--lifeos-pink)" }: { color?: string }) {
  return (
    <div className="absolute top-0 left-0 right-0 h-[3px] overflow-hidden">
      <motion.div
        className="absolute top-0 left-0 h-full rounded-full"
        style={{ background: `linear-gradient(90deg, transparent, ${color}, transparent)`, width: "45%" }}
        animate={{ left: ["-45%", "100%"] }}
        transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
      />
    </div>
  );
}

function FullScreenLoader({ visible, messages, color = "var(--lifeos-pink)", streamingText }: {
  visible: boolean;
  messages: string[];
  icon?: string; // kept for API compat, unused
  color?: string;
  streamingText?: string; // optional live-streamed coach text to show instead of cycling messages
}) {
  const [msgIdx, setMsgIdx] = useState(0);

  useEffect(() => {
    if (!visible) { setMsgIdx(0); return; }
    // Don't cycle messages when streaming text is being shown
    if (streamingText) return;
    const t = setInterval(() => setMsgIdx((i) => (i + 1) % messages.length), 2200);
    return () => clearInterval(t);
  }, [visible, messages.length, streamingText]);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="fs-loader"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
          className="fixed inset-0 z-[300] flex flex-col items-center justify-center overflow-hidden"
          style={{
            backdropFilter: "blur(20px) saturate(1.4)",
            WebkitBackdropFilter: "blur(20px) saturate(1.4)",
            backgroundColor: "rgba(255,255,255,0.82)",
          }}
        >
          {/* Top progress bar */}
          <TopProgressBar color={color} />

          {/* Ambient gradient blobs */}
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            <motion.div
              className="absolute rounded-full"
              style={{
                width: 480, height: 480,
                background: `radial-gradient(circle, ${color}14 0%, transparent 70%)`,
                top: "10%", left: "50%", x: "-50%",
              }}
              animate={{ scale: [1, 1.15, 1], opacity: [0.7, 1, 0.7] }}
              transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
            />
            <motion.div
              className="absolute rounded-full"
              style={{
                width: 320, height: 320,
                background: `radial-gradient(circle, rgba(108,142,232,0.08) 0%, transparent 70%)`,
                bottom: "15%", right: "15%",
              }}
              animate={{ scale: [1, 1.2, 1], opacity: [0.5, 0.9, 0.5] }}
              transition={{ duration: 5, delay: 1, repeat: Infinity, ease: "easeInOut" }}
            />
          </div>

          {/* Waveform */}
          <WaveformBars color={color} />

          {/* Typewriter message — shows streaming coach text if available, else cycles */}
          <div
            className="mt-7 text-[17px] font-bold text-black/80 min-h-[28px] text-center px-8 max-w-sm"
            style={{ letterSpacing: "-0.025em" }}
          >
            {streamingText ? (
              <motion.span
                key="streaming"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3 }}
                className="text-[15px] font-semibold text-black/70 leading-snug"
              >
                {streamingText}
                <span style={{ color, opacity: 0.7 }}>|</span>
              </motion.span>
            ) : (
            <AnimatePresence mode="wait">
              <motion.span
                key={msgIdx}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.3 }}
              >
                <TypewriterText key={`tw-${msgIdx}`} text={messages[msgIdx]} color={color} />
              </motion.span>
            </AnimatePresence>
            )}
          </div>

          {/* Subtle status dots strip */}
          <div className="mt-5 flex items-center gap-1.5">
            {[0, 1, 2, 3, 4].map((i) => (
              <motion.div
                key={i}
                className="rounded-full"
                style={{ background: color }}
                animate={{ opacity: [0.15, 1, 0.15], scale: [0.8, 1.1, 0.8] }}
                transition={{
                  duration: 1.2,
                  delay: i * 0.18,
                  repeat: Infinity,
                  ease: "easeInOut",
                }}
                // smaller dots, staggered pulse rather than bounce
                initial={{ width: 5, height: 5 }}
              />
            ))}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// Generating overlay — external hold so React batching doesn't swallow the show+hide
function GeneratingOverlay({ visible, streamingCoach }: { visible: boolean; streamingCoach?: string }) {
  return <FullScreenLoader visible={visible} messages={GENERATING_MESSAGES} icon="✦" streamingText={streamingCoach || undefined} />;
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
  "lab","discussion","recitation","office hours","study group","study session","study block","tutoring","tutoring session",
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
  "dinner": 120, "date": 120, "sushi": 120, "restaurant": 120,
  "bar": 120, "pub": 90, "drinks": 90, "happy hour": 90,
  "party": 180, "birthday party": 180, "wedding": 360,
  "study": 90, "studying": 90, "homework": 60, "hw": 60,
  "work": 120, "shift": 480,
  "presentation": 30, "pitch": 60, "demo": 60,
  "therapy": 60, "counseling": 60,
  "flight": 180, "drive": 60, "commute": 30,
  // Sports games (typically 90min–2hrs)
  "soccer": 90, "soccer game": 90, "football": 120, "football game": 120,
  "basketball": 90, "basketball game": 90, "hockey": 90, "hockey game": 90,
  "baseball": 150, "baseball game": 150, "rugby": 90, "rugby game": 90,
  "tennis": 90, "tennis match": 90, "volleyball": 90, "golf": 240,
};

// ─────────────────────────────────────────────────────────────
// Input normalizer — converts casual/abbreviated/messy speech into
// clean language that the regex parsers and AI can reliably handle.
// Run this ONCE on user input before anything else touches it.
// ─────────────────────────────────────────────────────────────
function normalizeInput(raw: string): string {
  let s = raw.trim();

  // ── Punctuation / dots in AM/PM ──
  s = s.replace(/\ba\.m\.\b/gi, "am").replace(/\bp\.m\.\b/gi, "pm");

  // ── Common time abbreviations ──
  // "tmrw" / "tmr" → "tomorrow", "tonite" → "tonight", "2nite" → "tonight"
  s = s.replace(/\btmrw\b/gi, "tomorrow").replace(/\btmr\b/gi, "tomorrow");
  s = s.replace(/\btonite\b/gi, "tonight").replace(/\b2nite\b/gi, "tonight");
  s = s.replace(/\btons\b/gi, "tonight"); // rare but seen

  // ── Casual "gonna", "wanna", "gotta" ──
  s = s.replace(/\bgonna\b/gi, "going to")
       .replace(/\bwanna\b/gi, "want to")
       .replace(/\bgotta\b/gi, "need to")
       .replace(/\bhafta\b/gi, "have to")
       .replace(/\btryna\b/gi, "trying to");

  // ── "2" as "to/too", "4" as "for", "b4" as "before", "w/" as "with", "w/o" as "without" ──
  // Only when clearly used as words (surrounded by spaces or punctuation)
  s = s.replace(/\bw\/o\b/gi, "without").replace(/\bw\//gi, "with ");
  s = s.replace(/\bb4\b/gi, "before");
  // "4" as "for" only when between words, not in times like "4pm" or "at 4"
  // Never convert when followed by a duration/time unit (e.g. "for 4 hours" → must not become "for for hours")
  s = s.replace(/(?<=\s)4(?=\s+(?!(?:hours?|hrs?|h\b|minutes?|mins?|min\b|seconds?|secs?|days?|weeks?|months?))[a-z])/gi, "for");
  // "2" as "to" only between words, not in times or durations like "for 2 hours"
  s = s.replace(/(?<=\s)2(?=\s+(?!(?:hours?|hrs?|h\b|minutes?|mins?|min\b|seconds?|secs?|days?|weeks?|months?))[a-z])/gi, "to");

  // ── Number words for small numbers in duration context ──
  // "for a couple hours" → "for 2 hours", "a few hours" → "a few hours" (keep)
  s = s.replace(/\ba\s+couple\s+(hours?|hrs?)\b/gi, "2 hours")
       .replace(/\ba\s+couple\s+(minutes?|mins?)\b/gi, "2 minutes")
       .replace(/\bhalf\s+an?\s+hour\b/gi, "30 minutes")
       .replace(/\ban?\s+hour\s+and\s+a\s+half\b/gi, "90 minutes")
       .replace(/\bquarter\s+(?:of\s+an?\s+)?hour\b/gi, "15 minutes");

  // ── Casual time references ──
  s = s.replace(/\bright\s+now\b/gi, "now")
       .replace(/\bthis\s+morning\b/gi, "this morning")
       .replace(/\bthis\s+aft(?:ernoon)?\b/gi, "this afternoon")
       .replace(/\bthis\s+eve(?:ning)?\b/gi, "this evening")
       .replace(/\beod\b/gi, "end of day")
       .replace(/\beow\b/gi, "end of week")
       .replace(/\basap\b/gi, "as soon as possible")
       .replace(/\batm\b/gi, "right now");

  // ── Casual day/date shorthands ──
  s = s.replace(/\bmon\b(?!\s*day)/gi, "Monday")
       .replace(/\btue(?:s)?\b(?!\s*sday)/gi, "Tuesday")
       .replace(/\bwed\b(?!\s*nesday)/gi, "Wednesday")
       .replace(/\bthu(?:rs?)?\b(?!\s*rsday)/gi, "Thursday")
       .replace(/\bfri\b(?!\s*day)/gi, "Friday")
       .replace(/\bsat\b(?!\s*urday)/gi, "Saturday")
       .replace(/\bsun\b(?!\s*day)/gi, "Sunday");

  // ── Typo-tolerant AM/PM: "7pm" written as "7 p m" or "7pm." ──
  s = s.replace(/(\d)\s*p\s*m\b\.?/gi, "$1pm").replace(/(\d)\s*a\s*m\b\.?/gi, "$1am");

  // ── Normalize multiple spaces ──
  s = s.replace(/\s{2,}/g, " ").trim();

  return s;
}

function parseDurationMinutes(text: string): number | null {
  // Strip travel-time clauses so "it takes 2 hours to get there" doesn't become event duration.
  // These phrases describe transit, not the event itself.
  const t = text.toLowerCase()
    .replace(/it\s+takes?\s+(?:me\s+)?\d+(?:\.\d+)?\s*(?:hours?|hrs?|h|minutes?|mins?|m)\s+(?:to\s+get\s+there|to\s+travel|to\s+drive|to\s+arrive|to\s+commute|to\s+walk\s+there|to\s+reach\s+there)/g, "")
    .replace(/\d+(?:\.\d+)?\s*(?:hours?|hrs?|h|minutes?|mins?|m)\s+(?:drive|commute|walk|travel|transit)\b/g, "")
    .replace(/(?:drive|commute|travel|transit|walk)\s+(?:time|of)\s+\d+(?:\.\d+)?\s*(?:hours?|hrs?|h|minutes?|mins?|m)/g, "")
    // Convert written-out number words to digits in duration context.
    // e.g. "two hours" → "2 hours", "thirty minutes" → "30 minutes"
    // Also handles autocorrect: "for to hours" → "for 2 hours" (iOS autocorrects "2" → "to")
    .replace(/\bfor\s+to\b(?=\s*(?:hours?|hrs?|h\b))/g, "for 2")
    .replace(/\bone\b(?=\s*(?:hours?|hrs?|h\b))/g, "1")
    .replace(/\btwo\b(?=\s*(?:hours?|hrs?|h\b))/g, "2")
    .replace(/\bthree\b(?=\s*(?:hours?|hrs?|h\b))/g, "3")
    .replace(/\bfour\b(?=\s*(?:hours?|hrs?|h\b))/g, "4")
    .replace(/\bfive\b(?=\s*(?:hours?|hrs?|h\b))/g, "5")
    .replace(/\bsix\b(?=\s*(?:hours?|hrs?|h\b))/g, "6")
    .replace(/\bten\b(?=\s*(?:minutes?|mins?|min\b))/g, "10")
    .replace(/\bfifteen\b(?=\s*(?:minutes?|mins?|min\b))/g, "15")
    .replace(/\btwenty\b(?=\s*(?:minutes?|mins?|min\b))/g, "20")
    .replace(/\bthirty\b(?=\s*(?:minutes?|mins?|min\b))/g, "30")
    .replace(/\bforty[\s-]five\b(?=\s*(?:minutes?|mins?|min\b))/g, "45")
    .replace(/\bforty\b(?=\s*(?:minutes?|mins?|min\b))/g, "40")
    .replace(/\bninety\b(?=\s*(?:minutes?|mins?|min\b))/g, "90");

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

  // ── Explicit-only boundary ────────────────────────────────────────────────
  // Everything above this point requires the user to have typed an explicit
  // duration ("2 hours", "30 min", "for 2", "two hours", etc.).
  // Everything below is keyword-based inference (e.g. "run" → 45 min).
  // hasExplicitDuration() stops here so keyword defaults don't count as a
  // scheduling "signal" (which would suppress the time-clarification prompt).
  // ─────────────────────────────────────────────────────────────────────────

  // Keyword-based smart defaults — longest match wins
  const sortedKws = Object.keys(KEYWORD_DURATION_DEFAULTS).sort((a, b) => b.length - a.length);
  for (const kw of sortedKws) {
    if (t.includes(kw)) return KEYWORD_DURATION_DEFAULTS[kw];
  }

  return null;
}

// Returns true only when the user explicitly stated a duration ("2 hours", "30 min",
// "for two hours", "ninety minutes", etc.).
// Keyword-based defaults like "run" → 45 min do NOT count — those should not suppress
// the time-clarification prompt.
function hasExplicitDuration(text: string): boolean {
  const t = text.toLowerCase()
    .replace(/\bone\b(?=\s*(?:hours?|hrs?|h\b))/g, "1")
    .replace(/\btwo\b(?=\s*(?:hours?|hrs?|h\b))/g, "2")
    .replace(/\bthree\b(?=\s*(?:hours?|hrs?|h\b))/g, "3")
    .replace(/\bfour\b(?=\s*(?:hours?|hrs?|h\b))/g, "4")
    .replace(/\bfive\b(?=\s*(?:hours?|hrs?|h\b))/g, "5")
    .replace(/\bsix\b(?=\s*(?:hours?|hrs?|h\b))/g, "6")
    .replace(/\bten\b(?=\s*(?:minutes?|mins?|min\b))/g, "10")
    .replace(/\bfifteen\b(?=\s*(?:minutes?|mins?|min\b))/g, "15")
    .replace(/\btwenty\b(?=\s*(?:minutes?|mins?|min\b))/g, "20")
    .replace(/\bthirty\b(?=\s*(?:minutes?|mins?|min\b))/g, "30")
    .replace(/\bforty[\s-]five\b(?=\s*(?:minutes?|mins?|min\b))/g, "45")
    .replace(/\bforty\b(?=\s*(?:minutes?|mins?|min\b))/g, "40")
    .replace(/\bninety\b(?=\s*(?:minutes?|mins?|min\b))/g, "90");
  return (
    /\d+\s*(?:hours?|hrs?|h)\s+(?:and\s+)?\d+\s*(?:minutes?|mins?|min|m)\b/.test(t) ||
    /(?:for\s+)?(?:\d+(?:\.\d+)?|\d+\s*1\/2)\s*(?:hours?|hrs?|h)\b/.test(t) ||
    /(?:for\s+)?\d+\s*(?:minutes?|mins?|min)\b/.test(t) ||
    /\b(?:for|about|around|roughly)\s+\d+(?:\.\d+)?\b(?!\s*(?:days?|weeks?|months?))/.test(t)
  );
}

function normalizeTimeGuess(rawHour: number, rawMin: number, context: string) {
  const t = context.toLowerCase().replace(/\bp\.m\.\b/g, "pm").replace(/\ba\.m\.\b/g, "am");
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
  // Normalise "p.m." → "pm", "a.m." → "am" so all patterns below work uniformly
  const t = text.toLowerCase().replace(/\bp\.m\.\b/g, "pm").replace(/\ba\.m\.\b/g, "am");

  // "noon" → 12:00, "midnight" → 0:00
  if (/\bnoon\b/.test(t)) return { hour: 12, minute: 0 };
  if (/\bmidnight\b/.test(t)) return { hour: 0, minute: 0 };

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
  // "tonight", "this morning", "this afternoon", "this evening" → today
  if (/\btonight\b/.test(t) || /\bthis\s+(?:morning|afternoon|evening|eve)\b/.test(t)) return localDateISO(now);

  // "next week" (no specific day) → next Monday
  if (/\bnext\s+week\b/i.test(t) && !/\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(t)) {
    const dow = now.getDay(); // 0=Sun … 6=Sat
    const daysToNextMon = dow === 1 ? 7 : (8 - dow) % 7 || 7;
    return addLocalDays(now, daysToNextMon);
  }
  // "this week" (no specific day) → next weekday from today (or today if it's a weekday)
  if (/\bthis\s+week\b/i.test(t) && !/\bthis\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(t)) {
    const dow = now.getDay();
    // If today is a weekday (Mon–Fri), use today; otherwise next Monday
    if (dow >= 1 && dow <= 5) return localDateISO(now);
    const daysToNextMon = (8 - dow) % 7 || 7;
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

  // "next [weekday]" or "this [weekday]" or bare "[weekday]"
  const hasNext = /\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(t);
  // "this Friday" / "this Monday" → the coming occurrence within the current week
  const hasThis = /\bthis\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(t);
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
      } else if (hasThis) {
        // "this friday" means the Friday of the CURRENT week — never push to next week
        // delta is already the soonest occurrence; if it's already past this week, keep as-is
        // (delta >= 0 always since we computed forward-only above)
      } else {
        // bare "tuesday" with delta=0 means TODAY — but without a time signal, assume next week
        if (delta === 0) {
          const hasTime = /\bat\s+\d{1,2}/.test(t) || /\d{1,2}:\d{2}/.test(t) || /\d{1,2}\s*(?:am|pm)/.test(t) || /\bnoon\b/.test(t) || /\bmidnight\b/.test(t);
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
// Also detects "every day", "daily", "everyday for the next week"
function looksLikeRecurring(text: string): boolean {
  const t = text.toLowerCase();
  if (/\b(?:every|each)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/i.test(t)) return true;
  if (/\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)s\b/i.test(t)) return true; // "Mondays", "Fridays"
  if (/\bm(?:on)?[\/,\s&]+(?:w(?:ed)?|f(?:ri)?)|\bt(?:ue)?[\/,\s&]+t(?:hu)?|\bmwf\b|\btr\b|\btth\b/i.test(t)) return true; // "MW", "MWF", "TTH", "TR"
  // Daily patterns: "every day", "everyday", "daily", "each day"
  if (/\b(?:every\s+day|everyday|daily|each\s+day)\b/i.test(t)) return true;
  // "3x this week", "3 times this week", "twice a week", "3x a week", "gym 3 times"
  if (/\b\d+\s*(?:x|times?)\s+(?:this\s+week|a\s+week|per\s+week|this\s+month|a\s+month|per\s+month)\b/i.test(t)) return true;
  if (/\b(?:twice|three\s+times|four\s+times)\s+(?:a\s+week|this\s+week|per\s+week)\b/i.test(t)) return true;
  return false;
}

// Parse recurring event into multiple events over a window from today
function parseRecurringEvent(
  text: string,
  allEventKeywords: string[],
): { title: string; dates: string[]; timeHM: { hour: number; minute: number } | null; durationMin: number } | null {
  const t = text.toLowerCase();

  // ── Check for "N times this week/month" pattern ──
  // e.g. "gym 3x this week", "run 3 times a week", "yoga twice this week"
  const nTimesMatch = t.match(/\b(\d+)\s*(?:x|times?)\s+(?:this\s+week|a\s+week|per\s+week)\b/i)
    ?? t.match(/\b(twice)\s+(?:a\s+week|this\s+week|per\s+week)\b/i)
    ?? t.match(/\b(three|four)\s+times\s+(?:a\s+week|this\s+week|per\s+week)\b/i);
  if (nTimesMatch) {
    const wordToN: Record<string, number> = { twice: 2, three: 3, four: 4 };
    const n = wordToN[nTimesMatch[1]] ?? parseInt(nTimesMatch[1], 10);
    const timeHM = parseTimeHM(text);
    const durationMin = parseDurationMinutes(text) ?? 60;
    // Pick title
    const cleanedForTitle = text
      .replace(/\b\d+\s*(?:x|times?)\s+(?:this\s+week|a\s+week|per\s+week)\b/gi, "")
      .replace(/\b(?:twice|three\s+times|four\s+times)\s+(?:a\s+week|this\s+week|per\s+week)\b/gi, "")
      .replace(/\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/gi, "")
      .replace(/\bfor\s+\d+(?:\.\d+)?\s*(?:hours?|hrs?|minutes?|mins?)\b/gi, "")
      .replace(/\s+/g, " ").trim();
    const kws = [...allEventKeywords].sort((a, b) => b.length - a.length);
    let title = "";
    for (const kw of kws) {
      if (cleanedForTitle.toLowerCase().includes(kw)) { title = kw.charAt(0).toUpperCase() + kw.slice(1); break; }
    }
    if (!title) title = cleanedForTitle.split(/\s+/).slice(0, 3).join(" ");
    if (!title) title = "Event";
    // Distribute N sessions evenly across Mon–Fri this week
    const today = new Date();
    const dow = today.getDay(); // 0=Sun…6=Sat
    const weekdayOffsets = [1, 2, 3, 4, 5].map((d) => {
      let diff = d - dow;
      if (diff < 0) diff += 7;
      return diff;
    }); // offsets to Mon, Tue, Wed, Thu, Fri of this/next week
    const step = Math.max(1, Math.floor(5 / n));
    const dates: string[] = [];
    for (let i = 0; i < n && i * step < weekdayOffsets.length; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + weekdayOffsets[i * step]);
      const y = d.getFullYear();
      const mo = String(d.getMonth() + 1).padStart(2, "0");
      const da = String(d.getDate()).padStart(2, "0");
      dates.push(`${y}-${mo}-${da}`);
    }
    if (dates.length >= 1) return { title, dates, timeHM, durationMin };
  }

  // ── Check for daily recurrence first ──
  const isDaily = /\b(?:every\s+day|everyday|daily|each\s+day)\b/i.test(t);

  // How many days/weeks to expand?
  // "for the next week" → 7 days; "for 2 weeks" → 14 days; default → 4 weeks
  let windowDays = 28; // default 4 weeks
  const nextWeekMatch = t.match(/\bfor\s+the\s+next\s+week\b/i);
  const nextNWeeksMatch = t.match(/\bfor\s+(?:the\s+next\s+)?(\d+)\s+weeks?\b/i);
  const nextNDaysMatch = t.match(/\bfor\s+(?:the\s+next\s+)?(\d+)\s+days?\b/i);
  const nextNMonthsMatch = t.match(/\bfor\s+(?:the\s+next\s+)?(\d+)\s+months?\b/i);
  if (nextWeekMatch) windowDays = 7;
  else if (nextNDaysMatch) windowDays = Math.min(parseInt(nextNDaysMatch[1], 10), 90);
  else if (nextNWeeksMatch) windowDays = Math.min(parseInt(nextNWeeksMatch[1], 10) * 7, 90);
  else if (nextNMonthsMatch) windowDays = Math.min(parseInt(nextNMonthsMatch[1], 10) * 30, 180);

  // Extract time + duration from the text
  const timeHM = parseTimeHM(text);
  const durationMin = parseDurationMinutes(text) ?? 60;

  // Get title using keywords (strip noise words first)
  const cleaned = text
    .replace(/\b(?:every|each|on|for\s+the\s+next\s+\w+|for\s+\d+\s+(?:days?|weeks?|months?))\b/gi, "")
    .replace(/\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)s?\b/gi, "")
    .replace(/\b(?:every\s+day|everyday|daily|each\s+day)\b/gi, "")
    .replace(/\bm(?:on)?[\/,\s&]+(?:w(?:ed)?|f(?:ri)?)\b|\bt(?:ue)?[\/,\s&]+t(?:hu)?\b|\bmwf\b|\btr\b|\btth\b/gi, "")
    .replace(/\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/gi, "")
    .replace(/\bfor\s+\d+(?:\.\d+)?\s*(?:hours?|hrs?|minutes?|mins?)\b/gi, "")
    .replace(/\bwant\s+to\s+/gi, "")
    .replace(/\bi\s+/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  // Find best title from keywords
  let title = "";

  // Check activity-sport patterns first (so "play rugby every day" → "Rugby")
  for (const word of cleaned.toLowerCase().split(/\s+/)) {
    if (ACTIVITY_SPORTS[word]) {
      title = ACTIVITY_SPORTS[word];
      break;
    }
  }

  if (!title) {
    const kws = [...allEventKeywords].sort((a, b) => b.length - a.length);
    for (const kw of kws) {
      if (cleaned.toLowerCase().includes(kw)) {
        title = kw.charAt(0).toUpperCase() + kw.slice(1);
        break;
      }
    }
  }
  if (!title && cleaned.length > 0) {
    title = cleaned.split(/\s+/).slice(0, 3).join(" ");
    title = title.charAt(0).toUpperCase() + title.slice(1);
  }
  if (!title) title = "Event";

  // ── Generate dates ──
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const dates: string[] = [];

  if (isDaily) {
    // Every day for the window
    for (let i = 0; i < windowDays; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      dates.push(localDateISO(d));
    }
  } else {
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

    // How many weekly occurrences to generate per day
    const weeksToGenerate = Math.ceil(windowDays / 7);

    for (const dow of Array.from(days).sort()) {
      // Find the first occurrence of this weekday on or after today
      const diff = (dow - today.getDay() + 7) % 7;
      const firstOccurrence = new Date(today);
      firstOccurrence.setDate(today.getDate() + diff);

      for (let i = 0; i < weeksToGenerate; i++) {
        const candidate = new Date(firstOccurrence);
        candidate.setDate(firstOccurrence.getDate() + i * 7);
        // Only include dates within the window
        const dayOffset = Math.round((candidate.getTime() - today.getTime()) / 86400000);
        if (dayOffset < windowDays) {
          dates.push(localDateISO(candidate));
        }
      }
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
    // Strip "with [person/group]" — e.g. "coffee with Sarah" → "coffee"
    .replace(/\s+with\s+\S+(\s+\S+)?$/i, "")
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

// Sports that follow activity verbs ("play soccer", "go swimming", "do yoga")
// We want "Soccer Game" not "Play" when someone says "play a soccer game"
const ACTIVITY_SPORTS: Record<string, string> = {
  soccer: "Soccer", football: "Football", basketball: "Basketball", tennis: "Tennis",
  volleyball: "Volleyball", baseball: "Baseball", hockey: "Hockey", lacrosse: "Lacrosse",
  rugby: "Rugby", cricket: "Cricket", badminton: "Badminton", squash: "Squash",
  golf: "Golf", handball: "Handball", fencing: "Fencing", wrestling: "Wrestling",
  swimming: "Swim", surfing: "Surf", skiing: "Ski", snowboarding: "Snowboard",
  climbing: "Climbing", cycling: "Cycling", running: "Run", jogging: "Run",
  yoga: "Yoga", pilates: "Pilates", crossfit: "CrossFit", hiking: "Hike",
  boxing: "Boxing", judo: "Judo", karate: "Karate", bjj: "BJJ",
};

function extractTitle(text: string, allKeywords: string[]): { title: string | null; needsAsk: boolean } {
  const raw = text.trim();
  const t = raw.toLowerCase();

  // "play a soccer game", "go swimming", "play rugby", "do yoga" — verb + sport/activity
  // Pick the sport/activity noun as the title, not the generic verb
  {
    const verbSportRe = /\b(?:play(?:ing)?|go(?:ing)?|do(?:ing)?|have)\s+(?:a\s+|an\s+|some\s+)?([a-z]+(?:\s+[a-z]+)?)\b/;
    const vs = t.match(verbSportRe);
    if (vs) {
      const noun = vs[1].trim();
      // Check each word of the noun phrase for a sport match
      for (const word of noun.split(/\s+/)) {
        if (ACTIVITY_SPORTS[word]) {
          // Use "Soccer Game" if "game" appears nearby, otherwise just "Soccer"
          const hasGame = /\bgame\b|\bmatch\b/.test(t);
          return { title: `${ACTIVITY_SPORTS[word]}${hasGame ? " Game" : ""}`, needsAsk: false };
        }
      }
    }
  }

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
// Which event contexts are worth showing suggestions for
// ─────────────────────────────────────────────────────────────
const HIGH_VALUE_SUGGESTION_CONTEXTS = new Set([
  "flight", "run", "workout", "swim", "wellness",
  "hike", "cycling", "medical", "interview", "exam", "presentation",
]);

// ─────────────────────────────────────────────────────────────
// Inline Suggestion Cards — replaces the blocking modal
// ─────────────────────────────────────────────────────────────
function SuggestionInlineCards({
  suggestions,
  eventContext,
  onAdd,
  onSavePref,
  onDismiss,
}: {
  suggestions: SuggestedBlock[];
  eventContext: string;
  onAdd: (s: SuggestedBlock) => void;
  onSavePref: (context: string, value: boolean) => void;
  onDismiss: () => void;
}) {
  const [added, setAdded] = useState<Set<number>>(new Set());

  const contextLabel: Record<string, string> = {
    flight: "travel", run: "runs", workout: "workouts", swim: "swims",
    wellness: "wellness sessions", hike: "hikes", cycling: "rides",
    medical: "appointments", interview: "interviews", exam: "exams",
    presentation: "presentations",
  };
  const label = contextLabel[eventContext] ?? eventContext;

  function handleAdd(s: SuggestedBlock, i: number) {
    onAdd(s);
    setAdded((prev) => new Set(prev).add(i));
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 6, scale: 0.97 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      className="mt-3 rounded-2xl overflow-hidden"
      style={{ boxShadow: "var(--shadow-md)", border: "1px solid var(--divider)" }}
    >
      <div className="h-0.5 w-full bg-gradient-to-r from-[var(--lifeos-pink)] via-[var(--lifeos-pink)]/50 to-transparent" />
      <div className="px-4 pt-3.5 pb-3.5 space-y-2" style={{ background: "var(--surface-raised)" }}>
        {/* Header */}
        <div className="flex items-center justify-between mb-0.5">
          <div className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--lifeos-pink)]" />
            <p className="text-[10px] font-bold text-[var(--lifeos-pink)] uppercase tracking-widest">Prep tips</p>
          </div>
          <button onClick={onDismiss} className="transition-colors text-xs" style={{ color: "var(--text-faint)" }} aria-label="Dismiss">✕</button>
        </div>

        {/* Cards */}
        {suggestions.map((s, i) => (
          <div key={`${s.date}-${s.title}-${i}`} className="flex items-start gap-3 rounded-xl px-3 py-2.5" style={{ border: "1px solid var(--divider)", background: "var(--surface-subtle)" }}>
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-sm leading-snug" style={{ color: "var(--text-secondary)" }}>{s.title}</div>
              <div className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
                {friendlyDate(s.date)} · {minutesToTime(s.startMin)}–{minutesToTime(s.endMin)}
              </div>
              {s.reason && <div className="text-xs mt-0.5 italic" style={{ color: "var(--text-faint)" }}>{s.reason}</div>}
            </div>
            <button
              onClick={() => handleAdd(s, i)}
              disabled={added.has(i)}
              className={[
                "shrink-0 mt-0.5 flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold transition-all",
                added.has(i)
                  ? "bg-emerald-100 text-emerald-600 border border-emerald-200 cursor-default"
                  : "bg-[var(--lifeos-pink)] text-white hover:scale-110 active:scale-95",
              ].join(" ")}
              style={!added.has(i) ? { boxShadow: "var(--shadow-accent)" } : undefined}
              aria-label={added.has(i) ? "Added" : "Add to calendar"}
            >
              {added.has(i) ? "✓" : "+"}
            </button>
          </div>
        ))}

        {/* Save preference row */}
        <div className="flex items-center gap-2 pt-1.5" style={{ borderTop: "1px solid var(--divider)" }}>
          <p className="text-xs flex-1" style={{ color: "var(--text-faint)" }}>Always suggest for {label}?</p>
          <button onClick={() => { onSavePref(eventContext, true); onDismiss(); }} className="text-xs font-bold text-[var(--lifeos-pink)] hover:underline transition-colors">Save</button>
          <span className="text-xs" style={{ color: "var(--divider)" }}>·</span>
          <button onClick={() => { onSavePref(eventContext, false); onDismiss(); }} className="text-xs font-semibold transition-colors" style={{ color: "var(--text-faint)" }}>Never</button>
        </div>
      </div>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────
// Missing Info Modal — beautiful, themed
// ─────────────────────────────────────────────────────────────
function MissingInfoModal({ open, onClose, onPickNext, onPickExact, eventTitle, prefillDate, prefillTime, prefillDuration, hideNextAvailable, queueInfo }: any) {
  const [date, setDate] = useState(prefillDate ?? "");
  const [time, setTime] = useState(prefillTime ?? "12:00");
  const [durationHours, setDurationHours] = useState(() => Math.floor((prefillDuration ?? 60) / 60));
  const [durationMins, setDurationMins] = useState(() => (prefillDuration ?? 60) % 60);
  const [inlineError, setInlineError] = useState("");

  const totalMinutes = clampMinutes(durationHours * 60 + durationMins);
  const totalEvents = queueInfo ? queueInfo.remaining + 1 : null;
  const isMulti = !!queueInfo;

  if (!open) return null;

  const durLabel = [
    durationHours > 0 ? `${durationHours}h` : "",
    durationMins > 0 ? `${durationMins}m` : "",
  ].filter(Boolean).join(" ") || "0m";

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm p-0 sm:p-4">
      <div className="w-full sm:max-w-md rounded-t-3xl sm:rounded-3xl overflow-hidden" style={{ background: "var(--surface-raised)", boxShadow: "var(--shadow-xl)" }}>

        {/* Header */}
        <div className="px-6 pt-6 pb-5">
          {/* Multi-event progress */}
          {isMulti && totalEvents && totalEvents > 1 && (
            <div className="mb-4">
              <div className="flex justify-between text-[10px] font-bold uppercase tracking-widest mb-2" style={{ color: "var(--text-faint)" }}>
                <span>Scheduling {totalEvents} events</span>
                <span>{totalEvents - queueInfo.remaining} / {totalEvents}</span>
              </div>
              <div className="h-1 rounded-full overflow-hidden" style={{ background: "var(--surface-subtle)" }}>
                <div
                  className="h-full rounded-full bg-[var(--lifeos-pink)] transition-all duration-500"
                  style={{ width: `${((totalEvents - queueInfo.remaining) / totalEvents) * 100}%` }}
                />
              </div>
            </div>
          )}

          {/* Event name pill */}
          {eventTitle && (
            <div className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 mb-3" style={{ background: "rgba(var(--lifeos-pink-rgb),0.08)", border: "1px solid rgba(var(--lifeos-pink-rgb),0.15)" }}>
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--lifeos-pink)]" />
              <span className="text-xs font-bold text-[var(--lifeos-pink)]">{eventTitle}</span>
            </div>
          )}

          <h2 className="text-[22px] font-extrabold leading-tight text-[var(--text-primary)]" style={{ letterSpacing: "-0.03em" }}>
            {hideNextAvailable ? "Pick a time" : "When is this?"}
          </h2>
          <p className="mt-1 text-sm font-medium" style={{ color: "var(--text-muted)" }}>
            {isMulti && queueInfo.remaining > 0
              ? `${queueInfo.remaining} more to go after this.`
              : hideNextAvailable
              ? "Choose the date and time — I'll keep your duration."
              : "Just need a few details to lock this in."}
          </p>
        </div>

        <div className="px-6 pb-6 space-y-3">
          {/* Next available slot button */}
          {!hideNextAvailable && (
            <>
              <button
                onClick={() => onPickNext(totalMinutes)}
                className="group w-full flex items-center gap-4 rounded-2xl bg-[var(--lifeos-pink)] px-5 py-4 text-left shadow-[0_4px_20px_rgba(217,108,125,0.3)] hover:shadow-[0_6px_28px_rgba(217,108,125,0.4)] hover:scale-[1.01] active:scale-[0.99] transition-all"
              >
                <div className="h-10 w-10 rounded-xl bg-white/20 flex items-center justify-center flex-shrink-0">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5 text-white">
                    <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
                  </svg>
                </div>
                <div className="flex-1">
                  <div className="text-sm font-bold text-white">Next available slot</div>
                  <div className="text-[11px] text-white/65 mt-0.5">I'll find the first open time · {durLabel}</div>
                </div>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 text-white/60 flex-shrink-0">
                  <path d="M9 18l6-6-6-6"/>
                </svg>
              </button>

              {/* Divider */}
              <div className="flex items-center gap-3 py-1">
                <div className="flex-1 h-px bg-black/[0.07]" />
                <span className="text-[11px] font-semibold text-black/30">or choose manually</span>
                <div className="flex-1 h-px bg-black/[0.07]" />
              </div>
            </>
          )}

          {/* Manual date + time + duration */}
          <div className="rounded-2xl border border-black/[0.08] bg-black/[0.015] p-4 space-y-3">
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="text-[10px] font-bold uppercase tracking-widest text-black/35 block mb-1.5">Date</label>
                <input
                  type="date"
                  value={date}
                  onChange={(e) => { setDate(e.target.value); setInlineError(""); }}
                  className="w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2.5 text-sm font-medium text-black outline-none focus:border-[var(--lifeos-pink)] transition-colors"
                />
              </div>
              <div>
                <label className="text-[10px] font-bold uppercase tracking-widest text-black/35 block mb-1.5">Time</label>
                <input
                  type="time"
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                  className="w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2.5 text-sm font-medium text-black outline-none focus:border-[var(--lifeos-pink)] transition-colors"
                />
              </div>
            </div>

            <div>
              <label className="text-[10px] font-bold uppercase tracking-widest text-black/35 block mb-1.5">
                Duration <span className="text-black/25 normal-case font-medium tracking-normal">· {durLabel}</span>
              </label>
              <div className="grid grid-cols-2 gap-2.5">
                <select
                  value={durationHours}
                  onChange={(e) => setDurationHours(parseInt(e.target.value, 10))}
                  className="w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2.5 text-sm font-medium text-black outline-none focus:border-[var(--lifeos-pink)] transition-colors"
                >
                  {Array.from({ length: 25 }, (_, i) => (
                    <option key={i} value={i}>{i} hr{i !== 1 ? "s" : ""}</option>
                  ))}
                </select>
                <select
                  value={durationMins}
                  onChange={(e) => setDurationMins(parseInt(e.target.value, 10))}
                  className="w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2.5 text-sm font-medium text-black outline-none focus:border-[var(--lifeos-pink)] transition-colors"
                >
                  {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map((m) => (
                    <option key={m} value={m}>{m} min</option>
                  ))}
                </select>
              </div>
            </div>

            {inlineError && (
              <p className="text-xs text-red-500 font-semibold">{inlineError}</p>
            )}

            <button
              onClick={() => {
                const resolvedDate = date || prefillDate || "";
                if (!resolvedDate) { setInlineError("Please pick a date."); return; }
                setInlineError("");
                onPickExact(resolvedDate, time, totalMinutes);
              }}
              className="w-full rounded-xl bg-black/[0.06] hover:bg-black/[0.09] px-4 py-2.5 text-sm font-bold text-black/70 hover:text-black/90 transition-all active:scale-[0.98]"
            >
              Schedule at this time →
            </button>
          </div>

          {/* Cancel */}
          <button
            onClick={onClose}
            className="w-full py-2 text-sm font-medium text-black/30 hover:text-black/55 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Multi-Event All-At-Once Modal
// Shows all events that need time/date info in one scrollable sheet.
// User edits each row, then hits "Schedule All" to commit everything.
// ─────────────────────────────────────────────────────────────
type MultiEventRow = {
  title: string;
  date: string;
  time: string;
  durationHours: number;
  durationMins: number;
  useNextSlot: boolean; // true = auto-find next available
};

function MultiEventModal({
  open,
  events,
  onClose,
  onScheduleAll,
}: {
  open: boolean;
  events: Array<{ title: string; dateIso: string | null; timeHM: { hour: number; minute: number } | null; durationMin: number }>;
  onClose: () => void;
  onScheduleAll: (rows: MultiEventRow[]) => void;
}) {
  const [rows, setRows] = useState<MultiEventRow[]>([]);

  // Initialise rows whenever the modal opens with new events
  useEffect(() => {
    if (!open) return;
    setRows(events.map((ev) => ({
      title: ev.title,
      date: ev.dateIso ?? "",
      time: ev.timeHM
        ? `${String(ev.timeHM.hour).padStart(2, "0")}:${String(ev.timeHM.minute).padStart(2, "0")}`
        : "",
      durationHours: Math.floor((ev.durationMin ?? 60) / 60),
      durationMins: (ev.durationMin ?? 60) % 60,
      useNextSlot: false, // always default to manual so user can see and edit pickers
    })));
  }, [open, events]);

  if (!open) return null;

  function updateRow(i: number, patch: Partial<MultiEventRow>) {
    setRows((prev) => prev.map((r, idx) => idx === i ? { ...r, ...patch } : r));
  }

  const durLabel = (r: MultiEventRow) => {
    const parts = [];
    if (r.durationHours > 0) parts.push(`${r.durationHours}h`);
    if (r.durationMins > 0) parts.push(`${r.durationMins}m`);
    return parts.join(" ") || "0m";
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm p-0 sm:p-4">
      <div className="w-full sm:max-w-lg rounded-t-3xl sm:rounded-3xl bg-white shadow-[0_24px_64px_rgba(0,0,0,0.18)] overflow-hidden flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="px-6 pt-6 pb-4 flex-shrink-0">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-[22px] font-extrabold text-black leading-tight" style={{ letterSpacing: "-0.03em" }}>
              When are these?
            </h2>
            <button onClick={onClose} className="text-black/30 hover:text-black/60 transition-colors text-sm font-medium">Cancel</button>
          </div>
          <p className="text-sm text-black/40 font-medium">Set a time for each event, or auto-slot them.</p>
        </div>

        {/* Scrollable event list */}
        <div className="overflow-y-auto flex-1 px-6 pb-2 space-y-3">
          {rows.map((row, i) => (
            <div key={i} className="rounded-2xl border border-black/[0.08] bg-black/[0.015] p-4">
              {/* Event title pill */}
              <div className="flex items-center gap-2 mb-3">
                <span className="h-2 w-2 rounded-full bg-[var(--lifeos-pink)] flex-shrink-0" />
                <span className="text-sm font-bold text-black">{row.title}</span>
                {/* Next-slot toggle */}
                <button
                  onClick={() => updateRow(i, { useNextSlot: !row.useNextSlot })}
                  className={
                    "ml-auto text-[11px] font-bold px-2.5 py-1 rounded-full transition-all " +
                    (row.useNextSlot
                      ? "bg-[var(--lifeos-pink)] text-white"
                      : "bg-black/[0.06] text-black/50 hover:bg-black/[0.10]")
                  }
                >
                  {row.useNextSlot ? "⚡ Auto" : "Auto"}
                </button>
              </div>

              {!row.useNextSlot && (
                <div className="space-y-2.5">
                  {/* Date + Time row */}
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[10px] font-bold uppercase tracking-widest text-black/35 block mb-1">Date</label>
                      <input
                        type="date"
                        value={row.date}
                        onChange={(e) => updateRow(i, { date: e.target.value })}
                        className="w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-sm font-medium text-black outline-none focus:border-[var(--lifeos-pink)] transition-colors"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-bold uppercase tracking-widest text-black/35 block mb-1">Time</label>
                      <input
                        type="time"
                        value={row.time}
                        onChange={(e) => updateRow(i, { time: e.target.value })}
                        className="w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-sm font-medium text-black outline-none focus:border-[var(--lifeos-pink)] transition-colors"
                      />
                    </div>
                  </div>
                  {/* Duration row */}
                  <div>
                    <label className="text-[10px] font-bold uppercase tracking-widest text-black/35 block mb-1">
                      Duration <span className="text-black/25 normal-case font-medium tracking-normal">· {durLabel(row)}</span>
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <select
                        value={row.durationHours}
                        onChange={(e) => updateRow(i, { durationHours: parseInt(e.target.value, 10) })}
                        className="w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-sm font-medium text-black outline-none focus:border-[var(--lifeos-pink)] transition-colors"
                      >
                        {Array.from({ length: 25 }, (_, n) => (
                          <option key={n} value={n}>{n} hr{n !== 1 ? "s" : ""}</option>
                        ))}
                      </select>
                      <select
                        value={row.durationMins}
                        onChange={(e) => updateRow(i, { durationMins: parseInt(e.target.value, 10) })}
                        className="w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-sm font-medium text-black outline-none focus:border-[var(--lifeos-pink)] transition-colors"
                      >
                        {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map((m) => (
                          <option key={m} value={m}>{m} min</option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              )}

              {row.useNextSlot && (
                <p className="text-xs text-black/40 font-medium">
                  OpenHour will find the next available slot · {durLabel(row)}
                </p>
              )}
            </div>
          ))}
        </div>

        {/* Footer CTA */}
        <div className="px-6 pt-3 pb-6 flex-shrink-0">
          <button
            onClick={() => onScheduleAll(rows)}
            className="w-full rounded-2xl bg-[var(--lifeos-pink)] px-5 py-4 text-base font-bold text-white shadow-[0_4px_20px_rgba(217,108,125,0.3)] hover:shadow-[0_6px_28px_rgba(217,108,125,0.4)] hover:scale-[1.01] active:scale-[0.99] transition-all"
          >
            Schedule {rows.length} event{rows.length !== 1 ? "s" : ""} →
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Settings Modal — edit onboarding preferences + schedule/clear
// wake & sleep blocks on all weekdays.
// ─────────────────────────────────────────────────────────────
function SettingsModal({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [profile, setProfile] = useState<OnboardingProfile | null>(null);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [wakeHour, setWakeHour] = useState(7);
  const [sleepHour, setSleepHour] = useState(23);
  const [saved, setSaved] = useState(false);
  const [schedulingDone, setSchedulingDone] = useState<string | null>(null);

  // Load current profile whenever modal opens
  useEffect(() => {
    if (!open) return;
    const p = loadOnboardingProfile();
    setProfile(p);
    setName(p?.name ?? "");
    setRole(p?.role ?? "");
    setWakeHour(p?.wakeHour ?? 7);
    setSleepHour(p?.sleepHour ?? 23);
    setSaved(false);
    setSchedulingDone(null);
  }, [open]);

  if (!open) return null;

  function hourLabel(h: number) {
    const hMod = ((h % 24) + 24) % 24;
    const ampm = hMod < 12 ? "AM" : "PM";
    const h12 = hMod % 12 || 12;
    return `${h12}:00 ${ampm}`;
  }

  function handleSave() {
    const updated: OnboardingProfile = {
      name: name.trim() || "Friend",
      role,
      wakeHour,
      sleepHour,
      completedAt: profile?.completedAt ?? new Date().toISOString(),
    };
    saveOnboardingProfile(updated);
    setSaved(true);
    setTimeout(() => {
      onSaved();
      onClose();
    }, 700);
  }

  // Returns ISO strings for all weekdays (Mon–Fri) within the next 4 weeks
  function upcomingWeekdays(): string[] {
    const dates: string[] = [];
    const today = new Date();
    for (let i = 0; i < 28; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      const dow = d.getDay(); // 0=Sun, 6=Sat
      if (dow >= 1 && dow <= 5) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        dates.push(`${y}-${m}-${day}`);
      }
    }
    return dates;
  }

  function handleScheduleWeekdays() {
    const dates = upcomingWeekdays();
    const all = loadCalendar();
    const newBlocks: CalendarBlock[] = [];

    for (const dateIso of dates) {
      // Skip if wake block already exists on this date
      const hasWake = all.some(
        (b) => b.date === dateIso && /^(wake up|wake|morning alarm)$/i.test(b.title)
      );
      const hasSleep = all.some(
        (b) => b.date === dateIso && /^(sleep|sleeping|bedtime|bed)$/i.test(b.title)
      );

      if (!hasWake) {
        const wStart = wakeHour * 60;
        newBlocks.push({
          id: generateId(),
          date: dateIso,
          title: "Wake Up",
          startMin: wStart,
          endMin: Math.min(wStart + 30, 24 * 60),
          meta: { kind: "manual", source: "settings-weekday" },
        });
      }
      if (!hasSleep) {
        const sHour = ((sleepHour % 24) + 24) % 24;
        const sStart = sHour * 60;
        newBlocks.push({
          id: generateId(),
          date: dateIso,
          title: "Sleep",
          startMin: sStart,
          endMin: Math.min(sStart + 30, 24 * 60),
          meta: { kind: "manual", source: "settings-weekday" },
        });
      }
    }

    if (newBlocks.length > 0) {
      saveCalendar([...all, ...newBlocks]);
    }
    setSchedulingDone(`Added ${newBlocks.length} blocks across ${dates.length} weekdays.`);
  }

  function handleClearWeekdays() {
    const all = loadCalendar();
    const filtered = all.filter(
      (b) =>
        b.meta?.source !== "settings-weekday" &&
        !/^(wake up|wake|sleep|sleeping|bedtime|bed|morning alarm)$/i.test(b.title)
    );
    saveCalendar(filtered);
    setSchedulingDone(`Cleared wake & sleep blocks from weekdays.`);
  }

  const ROLES = [
    { value: "student", label: "Student", emoji: "🎓" },
    { value: "professional", label: "Professional", emoji: "💼" },
    { value: "entrepreneur", label: "Entrepreneur", emoji: "🚀" },
    { value: "other", label: "Other", emoji: "✨" },
  ];

  return (
    <div className="fixed inset-0 z-[200] flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm p-0 sm:p-4">
      <div className="w-full sm:max-w-md rounded-t-3xl sm:rounded-3xl overflow-hidden flex flex-col max-h-[92vh]" style={{ background: "var(--surface-raised)", boxShadow: "var(--shadow-xl)" }}>

        {/* Header */}
        <div className="px-6 pt-6 pb-4 flex-shrink-0 flex items-center justify-between" style={{ borderBottom: "1px solid var(--divider)" }}>
          <div>
            <h2 className="text-[20px] font-extrabold leading-tight text-[var(--text-primary)]" style={{ letterSpacing: "-0.03em" }}>
              Preferences
            </h2>
            <p className="text-xs mt-0.5" style={{ color: "var(--text-faint)" }}>Update your profile &amp; schedule defaults</p>
          </div>
          <button onClick={onClose} className="h-8 w-8 rounded-xl flex items-center justify-center transition-all" style={{ color: "var(--text-faint)" }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Scrollable body */}
        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-6">

          {/* Name */}
          <div>
            <label className="text-[10px] font-extrabold uppercase tracking-[0.1em] text-black/40 block mb-2">
              Your name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your first name…"
              className="w-full rounded-2xl border-2 border-black/10 px-4 py-3 text-sm font-semibold text-black outline-none focus:border-[var(--lifeos-pink)] transition-colors"
            />
          </div>

          {/* Role */}
          <div>
            <label className="text-[10px] font-extrabold uppercase tracking-[0.1em] text-black/40 block mb-2">
              Role
            </label>
            <div className="grid grid-cols-2 gap-2">
              {ROLES.map((r) => (
                <button
                  key={r.value}
                  onClick={() => setRole(r.value)}
                  className={
                    "flex items-center gap-2.5 rounded-xl border-2 px-3 py-2.5 text-left transition-all " +
                    (role === r.value
                      ? "border-[var(--lifeos-pink)] bg-[var(--lifeos-pink)]/5"
                      : "border-black/10 hover:border-black/20")
                  }
                >
                  <span className="text-lg">{r.emoji}</span>
                  <span className="text-sm font-bold text-black">{r.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Wake time */}
          <div>
            <label className="text-[10px] font-extrabold uppercase tracking-[0.1em] text-black/40 block mb-2">
              Wake time
            </label>
            <div className="flex flex-col items-center gap-3">
              <div className="text-3xl font-extrabold text-[var(--lifeos-pink)]" style={{ letterSpacing: "-0.02em" }}>
                {hourLabel(wakeHour)}
              </div>
              <input
                type="range"
                min={4}
                max={12}
                step={1}
                value={wakeHour}
                onChange={(e) => setWakeHour(parseInt(e.target.value, 10))}
                className="w-full accent-[var(--lifeos-pink)]"
              />
              <div className="flex justify-between w-full text-xs text-black/40 font-semibold">
                <span>4 AM</span>
                <span>8 AM</span>
                <span>12 PM</span>
              </div>
            </div>
          </div>

          {/* Sleep time */}
          <div>
            <label className="text-[10px] font-extrabold uppercase tracking-[0.1em] text-black/40 block mb-2">
              Bedtime
            </label>
            <div className="flex flex-col items-center gap-3">
              <div className="text-3xl font-extrabold text-[var(--lifeos-pink)]" style={{ letterSpacing: "-0.02em" }}>
                {hourLabel(sleepHour % 24)}
              </div>
              <input
                type="range"
                min={19}
                max={26}
                step={1}
                value={sleepHour >= 0 && sleepHour <= 2 ? sleepHour + 24 : sleepHour}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  setSleepHour(v > 23 ? v - 24 : v);
                }}
                className="w-full accent-[var(--lifeos-pink)]"
              />
              <div className="flex justify-between w-full text-xs text-black/40 font-semibold">
                <span>7 PM</span>
                <span>10 PM</span>
                <span>2 AM</span>
              </div>
            </div>
          </div>

          {/* Weekday wake/sleep scheduling */}
          <div className="rounded-2xl border border-black/[0.07] bg-black/[0.015] p-4">
            <p className="text-[11px] font-extrabold uppercase tracking-[0.08em] text-black/40 mb-1">
              Weekday routine
            </p>
            <p className="text-xs text-black/50 mb-3 leading-relaxed">
              Auto-add Wake Up &amp; Sleep blocks on every weekday (Mon–Fri) for the next 4 weeks based on your times above.
            </p>
            <div className="flex gap-2">
              <button
                onClick={handleScheduleWeekdays}
                className="flex-1 rounded-xl bg-[var(--lifeos-pink)] px-3 py-2.5 text-xs font-bold text-white hover:opacity-90 transition-opacity"
              >
                📅 Schedule all weekdays
              </button>
              <button
                onClick={handleClearWeekdays}
                className="flex-1 rounded-xl border border-black/[0.1] bg-white px-3 py-2.5 text-xs font-bold text-black/60 hover:bg-black/[0.04] transition-colors"
              >
                🗑 Clear wake &amp; sleep
              </button>
            </div>
            {schedulingDone && (
              <p className="mt-2.5 text-xs text-[var(--lifeos-pink)] font-semibold">{schedulingDone}</p>
            )}
          </div>

        </div>

        {/* Footer */}
        <div className="px-6 pt-3 pb-6 flex-shrink-0" style={{ borderTop: "1px solid var(--divider)" }}>
          <button
            onClick={handleSave}
            disabled={saved}
            className="w-full rounded-2xl px-5 py-3.5 text-base font-bold text-white hover:scale-[1.01] active:scale-[0.99] transition-all disabled:opacity-60 bg-[var(--lifeos-pink)]"
            style={{ boxShadow: "var(--shadow-accent)" }}
          >
            {saved ? "Saved ✓" : "Save preferences"}
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
// WeekMiniStrip — 7 day dot strip showing block counts per day
// ─────────────────────────────────────────────────────────────
function WeekMiniStrip() {
  const [counts, setCounts] = useState<number[]>([]);
  const [dateLabels, setDateLabels] = useState<string[]>([]);

  useEffect(() => {
    const blocks = loadCalendar();
    const today = new Date();
    // Monday-Sunday of the current week
    const mon = new Date(today);
    mon.setDate(today.getDate() - ((today.getDay() + 6) % 7));
    mon.setHours(0, 0, 0, 0);

    const strip = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(mon);
      d.setDate(mon.getDate() + i);
      const iso = localDateISO(d);
      return blocks.filter((b) => b.date === iso).length;
    });
    setCounts(strip);

    const labels = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(mon);
      d.setDate(mon.getDate() + i);
      return localDateISO(d);
    });
    setDateLabels(labels);
  }, []);

  const dayNames = ["M", "T", "W", "T", "F", "S", "S"];
  const todayISO = localDateISO(new Date());

  if (counts.every((c) => c === 0)) return null; // hide if nothing scheduled this week

  return (
    <div className="mt-4 w-full max-w-2xl">
      <a href="/calendar" className="block rounded-2xl px-4 py-3 hover:shadow-[var(--shadow-sm)] transition-shadow" style={{ border: "1px solid var(--divider)", background: "var(--surface-raised)" }}>
        <div className="ui-eyebrow mb-2.5">This week</div>
        <div className="flex justify-between gap-1">
          {dayNames.map((d, i) => {
            const isToday = dateLabels[i] === todayISO;
            const hasBlocks = counts[i] > 0;
            return (
              <div key={i} className="flex flex-col items-center gap-1 flex-1">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-all
                  ${isToday && hasBlocks ? "bg-[var(--lifeos-pink)] text-white" :
                    isToday ? "border-2 border-[var(--lifeos-pink)] text-[var(--lifeos-pink)]" :
                    hasBlocks ? "text-[var(--lifeos-pink)]" :
                    "text-[var(--text-faint)]"}`}
                  style={isToday && hasBlocks ? { boxShadow: "var(--shadow-accent)" } : hasBlocks ? { background: "rgba(var(--lifeos-pink-rgb),0.1)" } : undefined}>
                  {hasBlocks ? counts[i] : "·"}
                </div>
                <span className={`text-[9px] font-bold ${isToday ? "text-[var(--lifeos-pink)]" : "text-[var(--text-faint)]"}`}>{d}</span>
              </div>
            );
          })}
        </div>
      </a>
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
      <div className="ui-card px-4 py-3">
        <div className="flex items-center justify-between mb-2.5">
          <span className="ui-eyebrow">
            {onboardingName ? `Today, ${onboardingName}` : "Today"}
          </span>
          <a href="/calendar" className="text-[11px] font-semibold text-[var(--lifeos-pink)] hover:underline">
            View all →
          </a>
        </div>
        {blocks.length === 0 ? (
          <p className="text-xs italic" style={{ color: "var(--text-faint)" }}>Nothing scheduled for today — add something above.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {blocks.map((b) => (
              <div key={b.id} className="flex items-center gap-2.5">
                <div
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: (b.meta as any)?.color ?? kindColor[b.meta?.kind ?? "manual"] ?? "#d96c7d" }}
                />
                <span className="flex-1 truncate text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>{b.title}</span>
                <span className="shrink-0 text-xs" style={{ color: "var(--text-faint)" }}>{minToTime(b.startMin)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// SidebarTodayPanel — right sidebar: today's schedule (desktop only)
// ─────────────────────────────────────────────────────────────
function SidebarTodayPanel() {
  const [blocks, setBlocks] = useState<CalendarBlock[]>([]);
  const [name, setName] = useState<string>("");

  useEffect(() => {
    const today = localDateISO(new Date());
    const all = loadCalendar();
    const todayBlocks = all
      .filter((b) => b.date === today)
      .sort((a, b) => a.startMin - b.startMin)
      .slice(0, 6);
    setBlocks(todayBlocks);
    const profile = loadOnboardingProfile();
    if (profile?.name && profile.name !== "Friend") setName(profile.name.split(" ")[0]);
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
    <div className="ui-card overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: "1px solid var(--divider)" }}>
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--lifeos-pink)]" />
          <span className="ui-eyebrow">{name ? `Today, ${name}` : "Today"}</span>
        </div>
        <a href="/calendar" className="text-[11px] font-semibold text-[var(--lifeos-pink)] hover:underline">
          View all →
        </a>
      </div>
      {/* Body */}
      <div className="px-3 py-2.5 space-y-0.5">
        {blocks.length === 0 ? (
          <p className="text-[12px] italic px-1 py-1" style={{ color: "var(--text-faint)" }}>Nothing scheduled yet — add something from the input.</p>
        ) : (
          blocks.map((b) => {
            const color = (b.meta as any)?.color ?? kindColor[b.meta?.kind ?? "manual"] ?? "#d96c7d";
            return (
              <div key={b.id} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-black/[0.025] transition-colors group">
                <div className="h-6 w-1 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                <div className="flex-1 min-w-0">
                  <div className="text-[12.5px] font-semibold truncate leading-tight" style={{ color: "var(--text-secondary)" }}>{b.title}</div>
                  <div className="text-[10.5px] mt-0.5" style={{ color: "var(--text-faint)" }}>{minToTime(b.startMin)}</div>
                </div>
              </div>
            );
          })
        )}
      </div>
      {blocks.length > 0 && (
        <div className="px-4 py-2.5" style={{ borderTop: "1px solid var(--divider)" }}>
          <a href="/calendar" className="flex items-center gap-1.5 text-[11.5px] font-semibold text-[var(--text-faint)] hover:text-[var(--lifeos-pink)] transition-colors">
            <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
            Open full calendar
          </a>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// SidebarWeekPanel — right sidebar: week overview (desktop only)
// ─────────────────────────────────────────────────────────────
function SidebarWeekPanel() {
  const [counts, setCounts] = useState<number[]>([]);
  const [dateLabels, setDateLabels] = useState<string[]>([]);

  useEffect(() => {
    const blocks = loadCalendar();
    const today = new Date();
    const mon = new Date(today);
    mon.setDate(today.getDate() - ((today.getDay() + 6) % 7));
    mon.setHours(0, 0, 0, 0);

    const strip = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(mon);
      d.setDate(mon.getDate() + i);
      return blocks.filter((b) => b.date === localDateISO(d)).length;
    });
    setCounts(strip);

    const labels = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(mon);
      d.setDate(mon.getDate() + i);
      return localDateISO(d);
    });
    setDateLabels(labels);
  }, []);

  const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const todayISO = localDateISO(new Date());

  if (counts.every((c) => c === 0)) return null;

  return (
    <div className="ui-card overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: "1px solid var(--divider)" }}>
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--text-faint)" }} />
          <span className="ui-eyebrow">This Week</span>
        </div>
        <a href="/calendar" className="text-[11px] font-semibold text-[var(--text-faint)] hover:text-[var(--lifeos-pink)] transition-colors">
          Calendar →
        </a>
      </div>
      {/* Day grid */}
      <div className="px-3 py-3 grid grid-cols-7 gap-1">
        {dayNames.map((d, i) => {
          const isToday = dateLabels[i] === todayISO;
          const hasBlocks = counts[i] > 0;
          return (
            <div key={i} className="flex flex-col items-center gap-1">
              <span className={`text-[9px] font-bold uppercase tracking-wide ${isToday ? "text-[var(--lifeos-pink)]" : "text-[var(--text-faint)]"}`}>
                {d[0]}
              </span>
              <div className={`w-7 h-7 rounded-lg flex items-center justify-center text-[11px] font-bold transition-all
                ${isToday && hasBlocks ? "bg-[var(--lifeos-pink)] text-white" :
                  isToday ? "border-2 border-[var(--lifeos-pink)] text-[var(--lifeos-pink)]" :
                  hasBlocks ? "text-[var(--lifeos-pink)]" :
                  "text-[var(--text-faint)]"}`}
                style={isToday && hasBlocks ? { boxShadow: "var(--shadow-accent)" } : hasBlocks ? { background: "rgba(var(--lifeos-pink-rgb),0.1)" } : undefined}
              >
                {hasBlocks ? counts[i] : "·"}
              </div>
            </div>
          );
        })}
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
// DayPlanModal — full-screen "Plan My Whole Day" preferences flow
// ─────────────────────────────────────────────────────────────
type DayPlanPrefs = {
  wakeTime: "early" | "morning" | "late";
  sleepTime: "early" | "normal" | "night";
  energy: "low" | "normal" | "high";
  mustDo: string;
  niceToHave: string;
  savePrefs: boolean;
};

function DayPlanModal({
  open,
  prefs,
  onPrefsChange,
  onBuildMyDay,
  onClose,
}: {
  open: boolean;
  prefs: DayPlanPrefs;
  onPrefsChange: (partial: Partial<DayPlanPrefs>) => void;
  onBuildMyDay: () => void;
  onClose: () => void;
}) {
  const mustDoRef = useRef<HTMLTextAreaElement>(null);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="day-plan-modal"
          initial={{ opacity: 0, y: "100%" }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: "100%" }}
          transition={{ type: "spring", damping: 30, stiffness: 300 }}
          className="fixed inset-0 z-[200] flex flex-col bg-white"
          style={{ overscrollBehavior: "contain" }}
        >
          {/* Pink accent bar */}
          <div className="h-[3px] w-full shrink-0 bg-gradient-to-r from-[var(--lifeos-pink)] via-[var(--lifeos-pink)]/60 to-transparent" />

          {/* Header */}
          <div className="flex items-start justify-between px-5 pt-5 pb-4 shrink-0">
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.06 }}
            >
              <div className="text-[10px] font-extrabold uppercase tracking-[0.12em] text-[var(--lifeos-pink)] mb-1.5">
                Plan My Day
              </div>
              <h2
                className="text-[24px] font-extrabold text-black leading-tight"
                style={{ letterSpacing: "-0.035em" }}
              >
                How's your day looking?
              </h2>
              <p className="mt-1 text-[13px] text-black/40 font-medium">
                Answer a few quick questions and I'll build your schedule.
              </p>
            </motion.div>
            <button
              onClick={onClose}
              className="mt-0.5 ml-3 h-8 w-8 shrink-0 rounded-full bg-black/[0.06] flex items-center justify-center text-black/40 hover:bg-black/[0.1] hover:text-black/70 transition-all"
              aria-label="Close"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Scrollable form body */}
          <div className="flex-1 overflow-y-auto px-5 pb-3 space-y-6">

            {/* ── Wake time ── */}
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08 }}>
              <label className="text-[10px] font-extrabold uppercase tracking-[0.1em] text-black/35 block mb-2.5">
                Wake time
              </label>
              <div className="grid grid-cols-3 gap-2">
                {([
                  { value: "early", emoji: "🌅", label: "Early bird", sub: "5 – 7 am" },
                  { value: "morning", emoji: "☀️", label: "Morning", sub: "7 – 9 am" },
                  { value: "late", emoji: "🛌", label: "Late start", sub: "9 am +" },
                ] as { value: DayPlanPrefs["wakeTime"]; emoji: string; label: string; sub: string }[]).map(({ value, emoji, label, sub }) => (
                  <button
                    key={value}
                    onClick={() => onPrefsChange({ wakeTime: value })}
                    className={`rounded-2xl border p-3 text-left transition-all duration-150 ${
                      prefs.wakeTime === value
                        ? "border-[var(--lifeos-pink)] bg-[var(--lifeos-pink)]/[0.07] shadow-[0_2px_10px_rgba(217,108,125,0.18)]"
                        : "border-black/[0.08] hover:border-black/[0.16] hover:bg-black/[0.025] active:scale-[0.98]"
                    }`}
                  >
                    <div className="text-xl mb-1">{emoji}</div>
                    <div className="text-[12px] font-extrabold text-black/80 leading-tight">{label}</div>
                    <div className="text-[10px] text-black/35 mt-0.5 font-medium">{sub}</div>
                  </button>
                ))}
              </div>
            </motion.div>

            {/* ── Bedtime ── */}
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.11 }}>
              <label className="text-[10px] font-extrabold uppercase tracking-[0.1em] text-black/35 block mb-2.5">
                Bedtime
              </label>
              <div className="grid grid-cols-3 gap-2">
                {([
                  { value: "early", emoji: "🌙", label: "Early", sub: "9 – 10 pm" },
                  { value: "normal", emoji: "🌜", label: "Normal", sub: "10 pm – 12 am" },
                  { value: "night", emoji: "🦉", label: "Night owl", sub: "12 am +" },
                ] as { value: DayPlanPrefs["sleepTime"]; emoji: string; label: string; sub: string }[]).map(({ value, emoji, label, sub }) => (
                  <button
                    key={value}
                    onClick={() => onPrefsChange({ sleepTime: value })}
                    className={`rounded-2xl border p-3 text-left transition-all duration-150 ${
                      prefs.sleepTime === value
                        ? "border-[var(--lifeos-pink)] bg-[var(--lifeos-pink)]/[0.07] shadow-[0_2px_10px_rgba(217,108,125,0.18)]"
                        : "border-black/[0.08] hover:border-black/[0.16] hover:bg-black/[0.025] active:scale-[0.98]"
                    }`}
                  >
                    <div className="text-xl mb-1">{emoji}</div>
                    <div className="text-[12px] font-extrabold text-black/80 leading-tight">{label}</div>
                    <div className="text-[10px] text-black/35 mt-0.5 font-medium">{sub}</div>
                  </button>
                ))}
              </div>
            </motion.div>

            {/* ── Energy level ── */}
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.14 }}>
              <label className="text-[10px] font-extrabold uppercase tracking-[0.1em] text-black/35 block mb-2.5">
                Today&apos;s energy
              </label>
              <div className="grid grid-cols-3 gap-2">
                {([
                  { value: "low", emoji: "😴", label: "Low", sub: "Easy day" },
                  { value: "normal", emoji: "😊", label: "Normal", sub: "Balanced" },
                  { value: "high", emoji: "⚡", label: "High", sub: "Full send" },
                ] as { value: DayPlanPrefs["energy"]; emoji: string; label: string; sub: string }[]).map(({ value, emoji, label, sub }) => (
                  <button
                    key={value}
                    onClick={() => onPrefsChange({ energy: value })}
                    className={`rounded-2xl border p-3 text-left transition-all duration-150 ${
                      prefs.energy === value
                        ? "border-[var(--lifeos-pink)] bg-[var(--lifeos-pink)]/[0.07] shadow-[0_2px_10px_rgba(217,108,125,0.18)]"
                        : "border-black/[0.08] hover:border-black/[0.16] hover:bg-black/[0.025] active:scale-[0.98]"
                    }`}
                  >
                    <div className="text-xl mb-1">{emoji}</div>
                    <div className="text-[12px] font-extrabold text-black/80 leading-tight">{label}</div>
                    <div className="text-[10px] text-black/35 mt-0.5 font-medium">{sub}</div>
                  </button>
                ))}
              </div>
            </motion.div>

            {/* ── Must-do ── */}
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.17 }}>
              <label className="text-[10px] font-extrabold uppercase tracking-[0.1em] text-black/35 block mb-2.5">
                What do you <span className="text-black/60">HAVE</span> to do today?
              </label>
              <textarea
                ref={mustDoRef}
                value={prefs.mustDo}
                onChange={(e) => onPrefsChange({ mustDo: e.target.value })}
                placeholder="meeting at 2pm, gym, call doctor, pick up groceries…"
                rows={3}
                className="w-full rounded-2xl border border-black/[0.08] bg-black/[0.025] px-4 py-3 text-[14px] text-black/80 placeholder:text-black/25 outline-none focus:border-[var(--lifeos-pink)] transition-colors resize-none font-medium"
              />
            </motion.div>

            {/* ── Nice-to-have ── */}
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
              <label className="text-[10px] font-extrabold uppercase tracking-[0.1em] text-black/35 block mb-2.5">
                What would you <span className="text-black/60">LIKE</span> to do?{" "}
                <span className="text-black/25 normal-case font-medium tracking-normal">· optional</span>
              </label>
              <textarea
                value={prefs.niceToHave}
                onChange={(e) => onPrefsChange({ niceToHave: e.target.value })}
                placeholder="read for 30 min, take a walk, call a friend…"
                rows={2}
                className="w-full rounded-2xl border border-black/[0.08] bg-black/[0.025] px-4 py-3 text-[14px] text-black/80 placeholder:text-black/25 outline-none focus:border-[var(--lifeos-pink)] transition-colors resize-none font-medium"
              />
            </motion.div>

            {/* ── Save prefs checkbox ── */}
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.23 }}>
              <label className="flex items-center gap-2.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={prefs.savePrefs}
                  onChange={(e) => onPrefsChange({ savePrefs: e.target.checked })}
                  className="h-4 w-4 accent-[var(--lifeos-pink)] cursor-pointer shrink-0"
                />
                <span className="text-[13px] text-black/50 font-medium">
                  Remember my wake &amp; sleep times for next time
                </span>
              </label>
            </motion.div>

            {/* Bottom padding so footer doesn't overlap content */}
            <div className="h-4" />
          </div>

          {/* ── Sticky footer ── */}
          <div className="shrink-0 px-5 pb-6 pt-3 border-t border-black/[0.05] bg-white">
            <motion.button
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.25 }}
              onClick={onBuildMyDay}
              className="w-full flex items-center justify-center gap-2.5 rounded-2xl bg-[var(--lifeos-pink)] px-5 py-4 text-[15px] font-extrabold text-white shadow-[0_4px_20px_rgba(217,108,125,0.35)] hover:shadow-[0_6px_28px_rgba(217,108,125,0.45)] hover:scale-[1.01] active:scale-[0.99] transition-all duration-150"
              style={{ letterSpacing: "-0.01em" }}
            >
              <span>Build My Day</span>
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </motion.button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ─────────────────────────────────────────────────────────────
// Main Page
// ─────────────────────────────────────────────────────────────
export default function GeneratePage() {
  const router = useRouter();
  const { toast } = useToast();
  const rotatingPlaceholder = useRotatingPlaceholder();

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

  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<SuggestedBlock[]>([]);
  const [suggestionsInlineOpen, setSuggestionsInlineOpen] = useState(false);
  const [suggestionsContext, setSuggestionsContext] = useState<{ title?: string; context?: string }>({});
  const [askFirstChip, setAskFirstChip] = useState<{
    text: string;
    context: string;
    onFetch: () => void;
  } | null>(null);
  const [pendingSuggestionBlocks, setPendingSuggestionBlocks] = useState<{
    blocks: CalendarBlock[];
    inputText: string;
  } | null>(null);

  const [syllabusLoading, setSyllabusLoading] = useState(false);
  const [syllabusError, setSyllabusError] = useState<string | null>(null);
  const [syllabusEvents, setSyllabusEvents] = useState<SyllabusEvent[] | null>(null);
  const [syllabusKeep, setSyllabusKeep] = useState<Record<number, boolean>>({});
  const [syllabusMeta, setSyllabusMeta] = useState<any | null>(null);
  const [syllabusFile, setSyllabusFile] = useState<File | null>(null);
  const [yearConfirm, setYearConfirm] = useState<{ detectedYear: number; nowYear: number; pendingSections?: { sections: string[]; course: string } } | null>(null);

  // Section picker — shown when syllabus has multiple sections and user hasn't chosen one
  const [sectionPick, setSectionPick] = useState<{ sections: string[]; course: string } | null>(null);

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
  // Per-block date/time overrides the user can edit in the review modal
  const [planDates, setPlanDates] = useState<Record<number, string>>({});
  const [planStarts, setPlanStarts] = useState<Record<number, number>>({});
  const [planEnds, setPlanEnds] = useState<Record<number, number>>({});
  const [planExpandedRow, setPlanExpandedRow] = useState<number | null>(null);
  const [pendingHistory, setPendingHistory] = useState<HistoryItem | null>(null);

  // ── Multi-event queue state ──
  // When scheduling N events and some need the MissingInfo modal, we queue the rest here
  const [multiEventQueue, setMultiEventQueue] = useState<any[]>([]);
  const [multiEventScheduled, setMultiEventScheduled] = useState<CalendarBlock[]>([]);
  // Ref kept in sync so modal callbacks always read the latest accumulated blocks
  // without stale-closure issues across multiple sequential modal opens.
  const multiEventScheduledRef = useRef<CalendarBlock[]>([]);
  const [multiEventOriginalInput, setMultiEventOriginalInput] = useState<string>("");
  const [multiEventMealDate, setMultiEventMealDate] = useState<string>("");

  // ── Multi-event all-at-once modal state ──
  const [multiEventModalOpen, setMultiEventModalOpen] = useState(false);
  const [multiEventModalEvents, setMultiEventModalEvents] = useState<Array<{ title: string; dateIso: string | null; timeHM: { hour: number; minute: number } | null; durationMin: number }>>([]);
  const [multiEventModalPreScheduled, setMultiEventModalPreScheduled] = useState<CalendarBlock[]>([]);

  // ── Syllabus course color coding ──
  const [syllabusColor, setSyllabusColor] = useState<string>("#d96c7d");

  // ── Post-import: offer to import another course + study blocks ──
  const [showImportAnother, setShowImportAnother] = useState(false);
  const [studyBlockCandidates, setStudyBlockCandidates] = useState<SyllabusEvent[]>([]);
  const [studyBlocksScheduled, setStudyBlocksScheduled] = useState(false);

  // ── Multi-syllabus bulk import ──
  type MultiSyllabusItem = {
    file: File;
    color: string;
    status: "pending" | "processing" | "done" | "error";
    eventCount?: number;
    errorMsg?: string;
    courseName?: string;
    /** Set when the server detected multiple sections — user must pick one before import runs */
    needsSection?: { sections: string[]; course: string };
    /** The section the user picked (letter, e.g. "A") */
    pickedSection?: string;
    /** Set when detected year doesn't match current year — user must confirm before import runs */
    needsYearConfirm?: { detectedYear: number; nowYear: number };
    /** The year the user confirmed (either detectedYear or nowYear) */
    pickedYear?: number;
  };
  const BULK_COLORS = ["#d96c7d","#6C8EE8","#5BA85E","#E8A83C","#9B6CE8","#E86C6C","#3CB8E8"];
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [bulkQueue, setBulkQueue] = useState<MultiSyllabusItem[]>([]);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkDone, setBulkDone] = useState(false);
  const [bulkScanning, setBulkScanning] = useState(false);
  const bulkDropRef = useRef<HTMLDivElement | null>(null);

  // Auto-scan newly added bulk files for multi-section detection
  useEffect(() => {
    // Only scan when the modal is open and there are pending unscanned files
    if (!showBulkImport || bulkRunning || bulkScanning) return;
    const hasUnscanned = bulkQueue.some(
      (it: MultiSyllabusItem) => it.status === "pending" && !it.needsSection && !it.pickedSection && it.needsYearConfirm === undefined
    );
    if (!hasUnscanned) return;
    void scanBulkForSections();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bulkQueue.length, showBulkImport]);

  // ── Confirmation chip state (shows parsed intent before scheduling) ──
  const [confirmChip, setConfirmChip] = useState<{
    summary: string;       // "Run · 2 hrs · Today at 9 AM"
    onConfirm: () => void;
    onEdit: () => void;
  } | null>(null);

  // ── AI task breakdown card (shown after confirm chip for assignments/projects) ──
  const [breakdownCard, setBreakdownCard] = useState<{
    title: string;   // e.g. "History Essay"
    dueDate: string; // ISO date
  } | null>(null);
  const [breakdownLoading, setBreakdownLoading] = useState(false);

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

  // ── Settings Modal state ──────────────────────────────────────
  const [settingsOpen, setSettingsOpen] = useState(false);

  // ── Day Plan Modal state ──────────────────────────────────────
  const [dayPlanModalOpen, setDayPlanModalOpen] = useState(false);
  const [dayPlanPrefs, setDayPlanPrefs] = useState<{
    wakeTime: "early" | "morning" | "late";
    sleepTime: "early" | "normal" | "night";
    energy: "low" | "normal" | "high";
    mustDo: string;
    niceToHave: string;
    savePrefs: boolean;
  }>({
    wakeTime: "morning",
    sleepTime: "normal",
    energy: "normal",
    mustDo: "",
    niceToHave: "",
    savePrefs: true,
  });

  // Re-read preferences + calendar after cloud merge on sign-in
  useEffect(() => {
    function onCloudSync() {
      setUserPrefs(loadPreferences());
      setFeedbackSessions(loadPreferences().totalFeedbackSessions);
    }
    window.addEventListener("openhour:cloud-sync", onCloudSync);
    return () => window.removeEventListener("openhour:cloud-sync", onCloudSync);
  }, []);

  // Helper: get preference context string to inject into API calls
  function getPreferenceContext(): string {
    const prefs = loadPreferences();
    const recent = loadFeedback().slice(0, 20);
    return buildPreferenceContext(prefs, recent);
  }

  function getUserTimezone(): string {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return "America/New_York";
    }
  }

  function getRecentHistoryContext(): string {
    try {
      const history = loadHistory().slice(0, 5);
      if (!history.length) return "";
      return history.map((h: HistoryItem) => `- "${h.input}" (${h.createdAt?.slice(0, 10) ?? "recent"})`).join("\n");
    } catch {
      return "";
    }
  }

  function getSmartProfileString(): string {
    try {
      const profile = loadSmartProfile();
      return formatSmartProfileForPrompt(profile);
    } catch {
      return "";
    }
  }

  /** After each successful plan, rebuild the smart profile from full history */
  function maybeRebuildSmartProfile() {
    try {
      const history = loadHistory();
      const onboarding = loadOnboardingProfile();
      rebuildAndSaveSmartProfile(
        history,
        onboarding?.wakeHour ?? null,
        onboarding?.sleepHour ?? null,
      );
    } catch { /* non-blocking */ }
  }

  // ── Day Plan: builds a rich natural language input from modal prefs ──
  function buildDayPlanInput(p: typeof dayPlanPrefs): string {
    const wakeMap: Record<string, string> = { early: "6am", morning: "8am", late: "10am" };
    const sleepMap: Record<string, string> = { early: "10pm", normal: "11:30pm", night: "1am" };
    const energyMap: Record<string, string> = {
      low: "low energy — keep it light and manageable",
      normal: "normal energy",
      high: "high energy — I can handle a full productive day",
    };
    const parts: string[] = [
      `Plan my whole day today.`,
      `I wake up around ${wakeMap[p.wakeTime]} and go to bed around ${sleepMap[p.sleepTime]}.`,
      `My energy level is ${energyMap[p.energy]}.`,
    ];
    if (p.mustDo.trim()) parts.push(`Things I must do today: ${p.mustDo.trim()}.`);
    if (p.niceToHave.trim()) parts.push(`Things I'd like to do if possible: ${p.niceToHave.trim()}.`);
    return parts.join(" ");
  }

  // ── Day Plan: save prefs, call API, wire into planPreview flow ──
  async function handleBuildMyDay() {
    if (loading || syllabusLoading) return;
    // Save wake/sleep preferences if requested
    if (dayPlanPrefs.savePrefs) {
      const wakeHourMap: Record<string, number> = { early: 6, morning: 8, late: 10 };
      const sleepHourMap: Record<string, number> = { early: 22, normal: 23, night: 1 };
      updatePreferences({
        preferredStartHour: wakeHourMap[dayPlanPrefs.wakeTime],
        preferredEndHour: sleepHourMap[dayPlanPrefs.sleepTime],
      });
    }
    const richInput = buildDayPlanInput(dayPlanPrefs);
    setDayPlanModalOpen(false);
    showGeneratingOverlay();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: richInput, preferenceContext: getPreferenceContext(), timezone: getUserTimezone(), recentHistory: getRecentHistoryContext(), smartProfile: getSmartProfileString(), calendarContext: loadCalendar().slice(0, 50) }),
      });
      const data = (await res.json()) as Plan & { error?: string };
      if (!res.ok) throw new Error((data as any)?.error ?? "Request failed");
      maybeRebuildSmartProfile();
      const item: HistoryItem = {
        id: generateId(),
        createdAt: new Date().toISOString(),
        input: richInput,
        plan: data,
      };
      const preview = previewCalendarFromHistory(item);
      setPendingHistory(item);
      setPlanPreview(preview);
      const keep: Record<number, boolean> = {};
      const titles: Record<number, string> = {};
      const dates: Record<number, string> = {};
      const starts: Record<number, number> = {};
      const ends: Record<number, number> = {};
      preview.proposed.forEach((b, i) => {
        keep[i] = true;
        titles[i] = b.title;
        dates[i] = b.date;
        starts[i] = b.startMin;
        ends[i] = b.endMin;
      });
      setPlanKeep(keep);
      setPlanTitles(titles);
      setPlanDates(dates);
      setPlanStarts(starts);
      setPlanEnds(ends);
      setPlanExpandedRow(null);
    } catch (e: any) {
      setError(e?.message ?? "Something went wrong building your day plan.");
    } finally {
      setLoading(false);
      hideGeneratingOverlay();
    }
  }

  function getAskFirstText(ctx: string, eventTitle?: string): string {
    const map: Record<string, string> = {
      flight: `Want travel prep tips for your ${eventTitle ?? "flight"}?`,
      run: `Want prep tips for your ${eventTitle ?? "run"}?`,
      workout: `Want prep tips for your ${eventTitle ?? "workout"}?`,
      swim: `Want swim prep suggestions?`,
      wellness: `Want reminders around your ${eventTitle ?? "session"}?`,
      hike: `Want hike prep suggestions?`,
      cycling: `Want cycling prep suggestions?`,
      medical: `Want appointment reminders for your ${eventTitle ?? "appointment"}?`,
      interview: `Want interview prep suggestions?`,
      exam: `Want study prep suggestions for your ${eventTitle ?? "exam"}?`,
      presentation: `Want presentation prep tips?`,
    };
    return (map[ctx] ?? "Want smart prep suggestions?") + " →";
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
  const [streamingCoach, setStreamingCoach] = useState(""); // live-streamed coach text shown in overlay
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

    // Only suggest for high-value contexts
    if (!HIGH_VALUE_SUGGESTION_CONTEXTS.has(ctx)) {
      router.push("/plan");
      return;
    }

    const prefs = loadPreferences();
    const savedPref = (prefs.suggestPrefs ?? {})[ctx];

    // User opted out permanently for this context
    if (savedPref === false) {
      router.push("/plan");
      return;
    }

    setPendingSuggestionBlocks({ blocks: [block], inputText });
    setSuggestionsContext({ title: block.title, context: ctx });

    if (savedPref === true) {
      // Opted in — fetch and show immediately
      void fetchAndShowInlineSuggestions([block], inputText, ctx);
      return;
    }

    // No preference saved — show ask-first chip
    setAskFirstChip({
      text: getAskFirstText(ctx, block.title),
      context: ctx,
      onFetch: () => {
        setAskFirstChip(null);
        void fetchAndShowInlineSuggestions([block], inputText, ctx);
      },
    });
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
    autoScheduled?: boolean; // true = smart auto-time, no modal needed
  };

  // ── Activities that should NOT go on the calendar as timed blocks ──────────
  // These are habitual/routine activities without a meaningful fixed time.
  // We silently skip them rather than opening the time-picker modal.
  const NON_CALENDAR_ACTIVITIES = new Set([
    "read", "reading", "work", "working",
    "relax", "relaxing", "rest", "resting", "chill", "chilling",
    "meditate", "meditating", "journal", "journaling",
    "cook", "cooking", "clean", "cleaning", "laundry",
  ]);

  function isNonCalendarActivity(title: string): boolean {
    const t = title.toLowerCase().trim();
    if (NON_CALENDAR_ACTIVITIES.has(t)) return true;
    // Also match plural/variant forms
    for (const kw of NON_CALENDAR_ACTIVITIES) {
      if (t.startsWith(kw)) return true;
    }
    return false;
  }

  // ── Smart meal scheduling ────────────────────────────────────────────────
  // Detects "3 meals", "breakfast lunch dinner", "eat breakfast", etc.
  // Returns auto-scheduled meal blocks placed intelligently around confirmed activity blocks.
  // If scheduledBlocks is empty (e.g. "3 meals" alone), falls back to cascade-from-now.
  function buildSmartMealBlocks(
    input: string,
    dateIso: string,
    scheduledBlocks: CalendarBlock[] = [],
  ): CalendarBlock[] {
    const t = input.toLowerCase();
    const nowTotalMin = new Date().getHours() * 60 + new Date().getMinutes();

    // Detect which meals were mentioned (or "3 meals" / "all meals" implies all three)
    const allMeals = /\b(\d+\s+meals?|three\s+meals?|all\s+meals?|every\s+meal)\b/i.test(input);
    const wantsBreakfast = allMeals || /\bbreakfast\b/i.test(t);
    const wantsLunch     = allMeals || /\blunch\b/i.test(t);
    const wantsDinner    = allMeals || /\bdinner\b/i.test(t) || /\bsupper\b/i.test(t);

    if (!wantsBreakfast && !wantsLunch && !wantsDinner) return [];

    const MEAL_DUR = 30;
    const MIN_GAP  = 90;
    const MEAL_TITLES = new Set(["Breakfast", "Lunch", "Dinner", "Brunch", "Supper"]);

    // Activity blocks on the same date, excluding meals themselves
    const activities = scheduledBlocks
      .filter(b => b.date === dateIso && !MEAL_TITLES.has(b.title))
      .sort((a, b) => a.startMin - b.startMin);

    const morningBlocks   = activities.filter(b => b.endMin   <= 12 * 60);
    const afternoonBlocks = activities.filter(b => b.startMin >= 12 * 60 && b.startMin < 18 * 60);

    const lastEnd = (arr: CalendarBlock[]) =>
      arr.length > 0 ? Math.max(...arr.map(b => b.endMin)) : 0;

    const hasActivities = activities.length > 0;

    // When activity blocks exist, place meals purely relative to those blocks —
    // never check nowTotalMin, because the user just placed these events and
    // wants meals to flow naturally around them regardless of current time.
    // When no activities exist (e.g. "3 meals" alone), cascade forward from now.
    const nextSlot = Math.ceil((nowTotalMin + 1) / 30) * 30 + 15;

    const cascadeRelative = (candidate: number, prevMealEnd: number): number => {
      // Pure activity-relative: just enforce min gap from previous meal
      const afterPrev = prevMealEnd > 0 ? prevMealEnd + MIN_GAP : 0;
      return Math.max(candidate, afterPrev);
    };

    const cascadeFromNow = (candidate: number, prevMealEnd: number): number => {
      // No activities: never place in the past
      const afterPrev = prevMealEnd > 0 ? prevMealEnd + MIN_GAP : 0;
      const resolved  = Math.max(candidate, afterPrev);
      if (resolved > nowTotalMin + 15) return resolved;
      return Math.max(nextSlot, afterPrev);
    };

    const cascade = hasActivities ? cascadeRelative : cascadeFromNow;

    const blocks: CalendarBlock[] = [];
    let lastMealEnd = 0;

    // Breakfast: right after last morning activity ends, else default 8am
    if (wantsBreakfast) {
      const bStart = morningBlocks.length > 0
        ? cascade(lastEnd(morningBlocks) + 5, lastMealEnd)
        : cascade(8 * 60, lastMealEnd);
      blocks.push({ id: generateId(), date: dateIso, title: "Breakfast",
        startMin: bStart, endMin: Math.min(bStart + MEAL_DUR, 24 * 60), meta: { kind: "manual" } });
      lastMealEnd = bStart + MEAL_DUR;
    }

    // Lunch: in the gap midpoint between morning and afternoon blocks,
    //        else after morning activities, else default 12pm
    if (wantsLunch) {
      let lStart: number;
      if (morningBlocks.length > 0 && afternoonBlocks.length > 0) {
        const gapMid = Math.round(
          (lastEnd(morningBlocks) + Math.min(...afternoonBlocks.map(b => b.startMin))) / 2
        );
        lStart = cascade(gapMid, lastMealEnd);
      } else if (morningBlocks.length > 0) {
        lStart = cascade(lastEnd(morningBlocks) + MEAL_DUR + 5, lastMealEnd);
      } else {
        lStart = cascade(12 * 60, lastMealEnd);
      }
      blocks.push({ id: generateId(), date: dateIso, title: "Lunch",
        startMin: lStart, endMin: Math.min(lStart + MEAL_DUR, 24 * 60), meta: { kind: "manual" } });
      lastMealEnd = lStart + MEAL_DUR;
    }

    // Dinner: after the very last activity of the day (any time) + 15min, else default 7pm
    if (wantsDinner) {
      const allEnds = activities.map(b => b.endMin);
      const dStart = allEnds.length > 0
        ? cascade(Math.max(...allEnds) + 15, lastMealEnd)
        : cascade(19 * 60, lastMealEnd);
      blocks.push({ id: generateId(), date: dateIso, title: "Dinner",
        startMin: dStart, endMin: Math.min(dStart + MEAL_DUR, 24 * 60), meta: { kind: "manual" } });
    }

    return blocks;
  }

  // ── Detect if input mentions meals (to trigger smart meal scheduling) ──────
  function inputMentionsMeals(text: string): boolean {
    return /\b(breakfast|lunch|dinner|supper|meal|meals|brunch|eat\s+(breakfast|lunch|dinner)|\d+\s+meals?|three\s+meals?|all\s+meals?)\b/i.test(text);
  }

  // ── Deferred meal placement ───────────────────────────────────────────────
  // Called AFTER all queued modal picks are complete so meals can be placed
  // with full knowledge of where activities actually landed.
  function placeMealsIfNeeded(
    scheduledBlocks: CalendarBlock[],
    originalInput: string,
    mealDate: string,
  ) {
    if (!inputMentionsMeals(originalInput) || !mealDate) return;
    const mealBlocks = buildSmartMealBlocks(originalInput, mealDate, scheduledBlocks);
    if (mealBlocks.length > 0) addBlocksToCalendar(mealBlocks);
  }

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
    const connRe = /\s+and\s+(?:also\s+)?(?:one\s+|a\s+)?|\s*,\s*(?:and\s+)?(?:also\s+)?(?:one\s+|a\s+)?|\s+then\s+|\s*;\s*|\s*\+\s*/gi;
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

      // ── Skip non-calendar activities (study, homework, sleep, etc.) ──
      // These are routine activities without a meaningful fixed time — don't
      // prompt the user to pick a time for them, just ignore them.
      if (isNonCalendarActivity(title)) continue;

      // ── Skip meal segments — meals are handled by buildSmartMealBlocks ──
      // Must catch: "breakfast", "lunch", "dinner", "3 meals", "eat meals", etc.
      if (/\b(breakfast|lunch|dinner|brunch|supper|meals?)\b/i.test(seg) || /\beat\s+(breakfast|lunch|dinner|brunch|supper)\b/i.test(seg)) continue;

      results.push({
        title: title.length > 60 ? title.slice(0, 60) : title,
        dateIso: segDate,
        timeHM: segTime,
        durationMin: segDur,
        rawSegment: seg,
      });
    }

    // Return whatever was parsed (even just 1 real event) — the caller will
    // supplement with meal blocks from buildSmartMealBlocks.
    return results.length >= 1 ? results : null;
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

    // Pattern 3: two schedulable event keywords with a connector (and/then/comma) between them
    const EVENT_KW = "run|swim|gym|workout|walk|hike|bike|yoga|pilates|lift|weights|cardio|meeting|call|zoom|flight|dentist|doctor|lunch|dinner|breakfast|brunch|class|lecture|exam|appointment|interview|presentation|shift|session|sleep|nap|bedtime|wake|study|homework|hw";
    const pat3 = new RegExp(`\\b(?:${EVENT_KW})\\b.{0,80}?(?:,|\\+|\\band\\b|\\bthen\\b).{0,80}?\\b(?:${EVENT_KW})\\b`, "i");
    if (pat3.test(t)) return true;

    // Pattern 5: mentions multiple meals OR "X meals" — smart auto-schedule them
    if (inputMentionsMeals(t) && /\b(run|gym|workout|swim|yoga|hike|flight|meeting|class|exam|appointment)\b/i.test(t)) return true;

    // Pattern 4: "one [day] ... and one [day]"
    if (/\bone\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b.+\bone\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(t)) return true;

    return false;
  }

  // Schedule multiple events, showing ALL events that need time info at once
  // in a single modal sheet. Meals are placed AFTER the user confirms all times.
  async function scheduleMultipleEvents(events: ParsedEvent[], originalInput: string, seriesId?: string) {
    const scheduledBlocks: CalendarBlock[] = [];
    const needsInfo: ParsedEvent[] = [];

    // ── Determine a shared date for this batch (for deferred meal placement) ──
    const sharedDateForMeals = events.find((e) => e.dateIso)?.dateIso ?? localDateISO(new Date());

    for (const ev of events) {
      // Skip non-calendar activities
      if (isNonCalendarActivity(ev.title)) continue;

      // Skip meal segments — handled by placeMealsIfNeeded at the end
      if (/\b(breakfast|lunch|dinner|brunch|supper|meals?)\b/i.test(ev.title)) continue;

      // ── Auto-assign sleep/bedtime from onboarding preference ──
      let resolvedEv = ev;
      if (!resolvedEv.timeHM && /^(sleep|sleeping|bedtime|bed)$/i.test(resolvedEv.title)) {
        const onboardingProfile = loadOnboardingProfile();
        // Use onboarding sleepHour, falling back to 11pm if not set
        const h = onboardingProfile?.sleepHour ?? 23;
        resolvedEv = {
          ...resolvedEv,
          timeHM: { hour: h, minute: 0 },
          dateIso: resolvedEv.dateIso ?? localDateISO(new Date()),
        };
      }

      if (resolvedEv.timeHM && resolvedEv.dateIso) {
        // Fully specified — schedule directly, no modal needed
        const startMin = resolvedEv.timeHM.hour * 60 + resolvedEv.timeHM.minute;
        const endMin = Math.min(startMin + resolvedEv.durationMin, 24 * 60);
        const b: CalendarBlock = {
          id: generateId(),
          date: resolvedEv.dateIso,
          title: resolvedEv.title,
          startMin,
          endMin,
          meta: { kind: "manual", fullDetail: originalInput, ...(seriesId ? { seriesId } : {}) },
        };
        scheduledBlocks.push(b);
      } else {
        // Missing time/date — collect for all-at-once modal
        needsInfo.push(resolvedEv);
      }
    }

    // If any events need time info, show them ALL at once in one modal
    if (needsInfo.length > 0) {
      setMultiEventOriginalInput(originalInput);
      setMultiEventMealDate(sharedDateForMeals);
      setMultiEventModalPreScheduled(scheduledBlocks);
      setMultiEventModalEvents(needsInfo.map((ev) => ({
        title: ev.title,
        dateIso: ev.dateIso,
        timeHM: ev.timeHM,
        durationMin: ev.durationMin,
      })));
      setMultiEventModalOpen(true);
      return;
    }

    // All resolved immediately — commit and place meals
    if (scheduledBlocks.length > 0) addBlocksToCalendar(scheduledBlocks);
    placeMealsIfNeeded(scheduledBlocks, originalInput, sharedDateForMeals);
    setInput("");
    await fetchSuggestionsForBlocks(scheduledBlocks, originalInput);
  }

  // Fetch suggestions across multiple anchor blocks at once
  async function fetchSuggestionsForBlocks(blocks: CalendarBlock[], originalInput: string) {
    if (blocks.length === 0) { router.push("/plan"); return; }

    const ctx = detectEventContext(originalInput);

    if (!HIGH_VALUE_SUGGESTION_CONTEXTS.has(ctx)) {
      router.push("/plan");
      return;
    }

    const prefs = loadPreferences();
    const savedPref = (prefs.suggestPrefs ?? {})[ctx];

    if (savedPref === false) {
      router.push("/plan");
      return;
    }

    setPendingSuggestionBlocks({ blocks, inputText: originalInput });
    setSuggestionsContext({ title: blocks.map(b => b.title).join(" & "), context: ctx });

    if (savedPref === true) {
      void fetchAndShowInlineSuggestions(blocks, originalInput, ctx);
      return;
    }

    setAskFirstChip({
      text: getAskFirstText(ctx, blocks[0]?.title),
      context: ctx,
      onFetch: () => {
        setAskFirstChip(null);
        void fetchAndShowInlineSuggestions(blocks, originalInput, ctx);
      },
    });
  }

  // Fetches suggestions and shows inline cards (called after ask-first chip tap or auto if opted-in)
  async function fetchAndShowInlineSuggestions(
    blocks: CalendarBlock[],
    originalInput: string,
    ctx: string,
  ) {
    setSuggestionsLoading(true);
    setSuggestionsInlineOpen(false);
    setSuggestions([]);
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
      sug = sug.sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin).slice(0, 3);
      setSuggestionsLoading(false);
      if (sug.length > 0) {
        setSuggestions(sug);
        setSuggestionsInlineOpen(true);
      } else {
        router.push("/plan");
      }
    } catch {
      setSuggestionsLoading(false);
      router.push("/plan");
    }
  }

  // Save per-context suggestion preference
  function handleSaveSuggestionPref(context: string, value: boolean) {
    const prefs = loadPreferences();
    savePreferences({
      ...prefs,
      suggestPrefs: { ...(prefs.suggestPrefs ?? {}), [context]: value },
      lastUpdated: new Date().toISOString(),
    });
  }

  // Generate AI study milestones for an assignment/project
  async function generateBreakdown(title: string, dueDate: string) {
    setBreakdownLoading(true);
    try {
      const res = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: `Break down "${title}" due ${dueDate} into study milestones`, breakdown: true }),
      });
      if (!res.ok) throw new Error("Breakdown failed");
      const data = await res.json();
      // data.blocks: Array<CalendarBlock-like objects>
      const milestones: CalendarBlock[] = (data.blocks ?? []).map((b: Partial<CalendarBlock>) => ({
        id: generateId(),
        date: b.date ?? dueDate,
        title: b.title ?? "Study",
        startMin: b.startMin ?? 9 * 60,
        endMin: b.endMin ?? 10 * 60,
        meta: { kind: "plan" as const, fullDetail: `Study milestone for: ${title}` },
      }));
      if (milestones.length > 0) {
        const existing = loadCalendar();
        saveCalendar([...milestones, ...existing]);
        toast(`Added ${milestones.length} study milestone${milestones.length !== 1 ? "s" : ""} to your calendar`, "success");
      } else {
        toast("Couldn't generate milestones. Try again.", "error");
      }
    } catch {
      toast("Breakdown failed. Try again.", "error");
    } finally {
      setBreakdownLoading(false);
      setBreakdownCard(null);
    }
  }

  // Handle natural-language calendar mutations: "move my 3pm to 4pm", "cancel yoga tomorrow"
  async function handleMutationCommand(text: string, calendar: CalendarBlock[]) {
    try {
      setLoading(true);
      const res = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: text, mutation: true, calendar }),
      });
      if (!res.ok) throw new Error("Mutation failed");
      const data = await res.json();
      // data.operations: Array<{ action: "update"|"delete", id: string, patch?: Partial<CalendarBlock> }>
      const ops: Array<{ action: "update" | "delete"; id: string; patch?: Partial<CalendarBlock> }> = data.operations ?? [];
      if (!ops.length) {
        toast("Couldn't find a matching event to edit. Try being more specific.", "error");
        return;
      }
      let current = loadCalendar();
      let changeCount = 0;
      for (const op of ops) {
        if (op.action === "delete") {
          current = current.filter((b) => b.id !== op.id);
          changeCount++;
        } else if (op.action === "update" && op.patch) {
          current = current.map((b) => b.id === op.id ? { ...b, ...op.patch } : b);
          changeCount++;
        }
      }
      saveCalendar(current);
      toast(`Updated ${changeCount} event${changeCount !== 1 ? "s" : ""}`, "success");
    } catch {
      toast("Couldn't process that edit. Try rephrasing.", "error");
    } finally {
      setLoading(false);
    }
  }

  async function generate() {
    showGeneratingOverlay();
    setLoading(true);
    setError(null);
    posthog.capture("Generate", { inputLength: input.length });

    // Normalize casual/abbreviated input BEFORE any parsing or API call.
    // This converts "tmrw", "gonna", "p.m.", "w/" etc. into clean equivalents.
    const normalizedInput = normalizeInput(input);
    // Deep-clean slang/abbreviations before routing or sending to API
    const preprocessedInput = fullyPreprocess(normalizedInput);
    if (normalizedInput !== input) setInput(normalizedInput);

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
      // Use preprocessed input for all parsing — slang has been expanded
      const ni = preprocessedInput;

      // ── Natural language mutation detection ──
      // "move my 3pm meeting to 4pm", "cancel yoga tomorrow", "push my run back 30 minutes"
      const MUTATION_RE = /\b(move|reschedule|change|cancel|delete|remove|extend|shorten|push|shift|rename)\b.{1,60}?\b(to|by|from|until|back|forward)\b/i;
      const existingCalendar = loadCalendar();
      if (MUTATION_RE.test(ni) && existingCalendar.length > 0) {
        setLoading(false);
        hideGeneratingOverlay();
        await handleMutationCommand(ni, existingCalendar);
        return;
      }

      // Detect explicit planning requests
      const looksLikePlanningRequest = /\b(plan\s+my\s+(?:day|week)|make\s+(?:me\s+)?a\s+plan|build\s+(?:me\s+)?(?:a\s+)?schedule|create\s+(?:me\s+)?(?:a\s+)?schedule|organize\s+my\s+(?:day|week)|routine|agenda|help\s+me\s+with\s+my\s+day)\b/i.test(ni)
        // Deadline inputs ("due at midnight", "due tonight", "due by X") should go to the AI
        // planner, not the manual event path — "midnight" is a cutoff, not a start time.
        || /\b(due\s+(?:at|by|tonight|at\s+midnight)|deadline\s+(?:at|by)|assignment\s+due|essay\s+due|homework\s+due|paper\s+due|project\s+due)\b/i.test(ni)
        // Multi-day travel inputs — "flight X + pack Y" span multiple days and need AI to coordinate
        || /\b(flight|flights|flying|fly)\b.{1,80}\b(pack|packing|hotel|airport|boarding|takeoff|land)\b/i.test(ni)
        || /\b(pack|packing)\b.{1,80}\b(flight|flights|flying|fly|airport|hotel)\b/i.test(ni)
        // Any input that explicitly spans multiple days needs the AI planner
        || /\b(tomorrow|tonight)\b.{1,80}\b(friday|saturday|sunday|monday|tuesday|wednesday|thursday)\b/i.test(ni)
        || /\b(friday|saturday|sunday|monday|tuesday|wednesday|thursday)\b.{1,80}\b(tomorrow|tonight)\b/i.test(ni);

      // ── Recurring event detection ──
      // "gym every Monday and Wednesday", "class on MWF at 10am", "yoga every Tuesday"
      if (!looksLikePlanningRequest && looksLikeRecurring(ni)) {
        const recurring = parseRecurringEvent(ni, allEventKeywords);
        if (recurring && recurring.dates.length >= 2) {
          setLoading(false);
          hideGeneratingOverlay();
          // Generate a shared seriesId for all blocks in this recurring series
          const recSeriesId = generateId();
          // Convert recurring dates into ParsedEvent-like objects and schedule them
          const recEvents = recurring.dates.map((dateIso) => ({
            title: recurring.title,
            dateIso,
            timeHM: recurring.timeHM,
            durationMin: recurring.durationMin,
            rawSegment: ni,
          }));
          await scheduleMultipleEvents(recEvents, ni, recSeriesId);
          return;
        }
      }

      // ── Multi-event detection ──
      // Try this BEFORE single-event quick path so "run at 9am and workout at 6pm" is split correctly
      if (!looksLikePlanningRequest && looksLikeMultiEvent(ni)) {
        const multiEvents = parseMultipleEvents(ni);
        // Use multi-event path if we have ≥1 real event (the input looked like multi-event,
        // so even if only 1 schedulable event remains after filtering, use this path to avoid
        // double-scheduling via the single-event fallback below).
        const hasMeals = inputMentionsMeals(ni);
        if (multiEvents && multiEvents.length >= 1) {
          setLoading(false);
          await scheduleMultipleEvents(multiEvents, ni);
          hideGeneratingOverlay();
          return;
        }
        // Pure meals-only input (no real events parsed) — schedule meals directly
        if (hasMeals && (!multiEvents || multiEvents.length === 0)) {
          setLoading(false);
          hideGeneratingOverlay();
          const todayIso = localDateISO(new Date());
          const mealBlocks = buildSmartMealBlocks(ni, todayIso);
          if (mealBlocks.length > 0) {
            addBlocksToCalendar(mealBlocks);
            setInput("");
            toast(`Added ${mealBlocks.map((b) => b.title).join(", ")} to your calendar`, "success");
          }
          return;
        }
      }

      // ── Standalone meal input (no other events) ──
      // e.g. "eat 3 meals today", "breakfast lunch and dinner"
      if (!looksLikePlanningRequest && inputMentionsMeals(ni) && !looksLikeMultiEvent(ni)) {
        setLoading(false);
        hideGeneratingOverlay();
        const todayIso = localDateISO(new Date());
        const mealBlocks = buildSmartMealBlocks(ni, todayIso);
        if (mealBlocks.length > 0) {
          addBlocksToCalendar(mealBlocks);
          setInput("");
          toast(`Added ${mealBlocks.map((b) => b.title).join(", ")} to your calendar`, "success");
          return;
        }
      }

      if (!looksLikePlanningRequest) {
        const durationMin = parseDurationMinutes(ni) ?? 60;
        const dateIso = parseDateISOFromText(ni);
        const timeHM = parseTimeHM(ni);
        const { title, needsAsk } = extractTitle(ni, allEventKeywords);

        // ── Skip non-calendar activities even in the single-event path ──
        // e.g. "study for 2 hours" should NOT open the time-picker modal.
        // Fall through to the API (which will handle it as a planning request).
        if (!title || !isNonCalendarActivity(title)) {

        // parseDurationMinutes (not hasExplicitDuration) here: keyword defaults like
        // "run"→45 or "soccer"→90 count as a signal that the user wants to schedule
        // a specific event, so we enter the quick path and ask for time/date if missing.
        // hasExplicitDuration is only used below inside needsTime so that "at some point"
        // + an explicit duration skips asking for a time (user said "whenever").
        const hasAnySignal = !!(
          dateIso ||
          timeHM ||
          parseDurationMinutes(ni) ||
          /\bnext\s+week\b/i.test(ni) ||
          /\bnext\s+available\b/i.test(ni) ||
          /\bat\s+some\s+point\b/i.test(ni) ||
          /\bsome\s+time\b/i.test(ni)
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
            !/\bnext\s+week\b/i.test(ni) &&
            !/\bnext\s+available\b/i.test(ni) &&
            !/\bat\s+some\s+point\b/i.test(ni) &&
            !/\bsome\s+time\b/i.test(ni);

          // Detect truly flexible / vague scheduling phrases — these are fine to auto-slot
          // without asking for a time, because the user explicitly said "whenever".
          const isFlexible =
            /\bnext\s+available\b/i.test(ni) ||
            /\bat\s+some\s+point\b/i.test(ni) ||
            /\bsome\s+time\b/i.test(ni) ||
            // "next week" without a specific weekday — vague window, auto-slot is fine
            (/\bnext\s+week\b/i.test(ni) && !/\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(ni));

          const needsTime = !timeHM &&
            !isFlexible &&
            (!!effectiveDateIso || requiresExactTime(ni));

          if (needsWhen || needsTime) {
            const hideSlotButton = needsTime && !needsWhen && requiresExactTime(ni) && !effectiveDateIso;
            setPendingQuickEvent({ title, dateIso: effectiveDateIso, timeHM, durationMin, rawInput: ni, requiresTime: hideSlotButton });
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

          // Detect assignment/project context for AI breakdown card
          const looksLikeAssignment = /\b(assignment|essay|project|paper|homework|exam|quiz|midterm|final)\b/i.test(ni);

          setConfirmChip({
            summary: chipSummary,
            onConfirm: () => {
              const ok = scheduleQuickEvent({ title, dateIso: effectiveDateIso, timeHM, durationMin });
              if (!ok) {
                setError("I couldn't find an available time slot. Try a shorter duration or a specific day/time.");
              } else {
                setInput("");
                setConfirmChip(null);
                // Show breakdown card for assignments/projects
                if (looksLikeAssignment && effectiveDateIso) {
                  setBreakdownCard({ title, dueDate: effectiveDateIso });
                }
              }
            },
            onEdit: () => { setConfirmChip(null); },
          });
          return;
        }
        } // end !isNonCalendarActivity guard
      }

      // Fall through to planning API — use streaming endpoint for progressive coach display
      setStreamingCoach(""); // reset
      const streamRes = await fetch("/api/plan/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: ni,
          preferenceContext: getPreferenceContext(),
          timezone: getUserTimezone(),
          recentHistory: getRecentHistoryContext(),
          smartProfile: getSmartProfileString(),
          calendarContext: loadCalendar().slice(0, 50),
        }),
      });

      if (!streamRes.ok || !streamRes.body) {
        // Fallback to non-streaming if stream endpoint fails
        const errText = await streamRes.text().catch(() => "Request failed");
        throw new Error(errText);
      }

      // Read SSE stream
      let data: Plan & { error?: string; confidence?: number; ambiguities?: string[] } | null = null;
      {
        const reader = streamRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // Process complete SSE lines
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? ""; // keep incomplete line in buffer

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const jsonStr = line.slice(6).trim();
            if (!jsonStr) continue;
            let evt: any;
            try { evt = JSON.parse(jsonStr); } catch { continue; } // skip malformed SSE line
            if (evt.type === "coach") {
              // Accumulate coach text and show it in the overlay
              setStreamingCoach((prev) => prev + (evt.delta ?? ""));
            } else if (evt.type === "plan") {
              data = evt.plan as Plan & { error?: string; confidence?: number; ambiguities?: string[] };
            } else if (evt.type === "error") {
              throw new Error(evt.message ?? "Streaming error");
            }
          }
        }
      }

      if (!data) {
        throw new Error("No plan received from AI");
      }

      // Clear streaming coach text (plan is loaded)
      setStreamingCoach("");

      // Rebuild smart profile in background after each successful plan
      maybeRebuildSmartProfile();

      const item: HistoryItem = {
        id: generateId(),
        createdAt: new Date().toISOString(),
        input: ni,
        plan: data,
      };

      const preview = previewCalendarFromHistory(item);
      setPendingHistory(item);
      setPlanPreview(preview);
      const keep: Record<number, boolean> = {};
      const titles: Record<number, string> = {};
      const dates: Record<number, string> = {};
      const starts: Record<number, number> = {};
      const ends: Record<number, number> = {};
      preview.proposed.forEach((b, i) => {
        keep[i] = true;
        titles[i] = b.title;
        dates[i] = b.date;
        starts[i] = b.startMin;
        ends[i] = b.endMin;
      });
      setPlanKeep(keep);
      setPlanTitles(titles);
      setPlanDates(dates);
      setPlanStarts(starts);
      setPlanEnds(ends);
      setPlanExpandedRow(null);

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
          body: JSON.stringify({ input: ni, anchors, preferenceContext: getPreferenceContext() }),
        });

        const sdata = (await sres.json()) as { suggestions?: SuggestedBlock[] };
        const planSug = (Array.isArray(sdata?.suggestions) ? sdata.suggestions : []).slice(0, 3);
        const planCtx = detectEventContext(input);
        if (planSug.length && HIGH_VALUE_SUGGESTION_CONTEXTS.has(planCtx)) {
          const planPrefs = loadPreferences();
          const planPref = (planPrefs.suggestPrefs ?? {})[planCtx];
          if (planPref !== false) {
            setSuggestions(planSug);
            setSuggestionsContext({ context: planCtx });
            if (planPref === true) {
              setSuggestionsInlineOpen(true);
            } else {
              setAskFirstChip({
                text: getAskFirstText(planCtx),
                context: planCtx,
                onFetch: () => { setAskFirstChip(null); setSuggestionsInlineOpen(true); },
              });
            }
          }
        }
      } catch {
        // non-blocking
      }
    } catch (e: any) {
      setError(e?.message ?? "Something went wrong");
      setStreamingCoach(""); // clear on error
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
        const date = planDates[i] ?? b.date;
        const startMin = planStarts[i] ?? b.startMin;
        const endMin = planEnds[i] ?? b.endMin;
        // Ensure end is always after start
        const safeEnd = endMin <= startMin ? startMin + 30 : endMin;
        return { ...b, title, date, startMin, endMin: safeEnd };
      })
      .filter((_, i) => !!planKeep[i])
      .filter((b) => b.title.trim().length > 0);

    addToHistory(pendingHistory, 30);
    applyApprovedPlanBlocks(planPreview, approved);
    posthog.capture("AddToCalendar", { blocksAdded: approved.length });

    // ── Update streak ──
    try {
      const today = new Date().toISOString().slice(0, 10);
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const raw = localStorage.getItem("openhour_streak_v1");
      const prev = raw ? JSON.parse(raw) : { count: 0, lastDate: "" };
      const newCount = prev.lastDate === yesterday ? prev.count + 1 : prev.lastDate === today ? prev.count : 1;
      localStorage.setItem("openhour_streak_v1", JSON.stringify({ count: newCount, lastDate: today }));
    } catch { /* ignore */ }

    toast(`✓ ${approved.length} block${approved.length !== 1 ? "s" : ""} added to your calendar`, "success");

    setPlanPreview(null);
    setPendingHistory(null);
    setPlanKeep({});
    setPlanTitles({});
    setPlanDates({});
    setPlanStarts({});
    setPlanEnds({});
    setPlanExpandedRow(null);

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

      const data = (await res.json()) as { events?: SyllabusEvent[]; meta?: any; error?: string; needsSectionPick?: boolean; needsYearConfirm?: boolean; sections?: string[]; course?: string };
      if (!res.ok) throw new Error(data?.error ?? "Upload failed");

      // Year mismatch detected — top-level flag (fast pre-AI check) or meta flag (post-AI)
      // Check year FIRST (pre-AI fast check) since it comes before section detection
      const yearMeta = data?.meta ?? {};
      if (
        (data?.needsYearConfirm || yearMeta?.needsYearConfirm) &&
        typeof yearMeta?.detectedYear === "number" &&
        typeof yearMeta?.nowYear === "number"
      ) {
        setSyllabusMeta(yearMeta);
        // If section pick was also detected in the same pass, carry it forward
        const pendingSections = (data?.needsSectionPick && Array.isArray(data.sections) && data.sections.length >= 2)
          ? { sections: data.sections, course: data.course ?? "" }
          : undefined;
        setYearConfirm({ detectedYear: yearMeta.detectedYear, nowYear: yearMeta.nowYear, pendingSections });
        return;
      }

      // Multiple sections detected (no year mismatch) — ask the user to pick before extracting
      if (data?.needsSectionPick && Array.isArray(data.sections) && data.sections.length >= 2) {
        setSectionPick({ sections: data.sections, course: data.course ?? "" });
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
        window.localStorage.setItem("openhour_calendar_cursor_v1", first);
        // Set the jump flag so the calendar actually navigates to this date
        window.sessionStorage.setItem("openhour_calendar_jump_v1", "1");
      }
    } catch {
      // ignore
    }
    setSyllabusEvents(null);
    toast(`✓ ${selected.length} event${selected.length !== 1 ? "s" : ""} added to your calendar`, "success");
    // Offer study block generation for graded items
    const gradedItems = selected.filter((e) =>
      /exam|quiz|assignment|project|paper|midterm|final|presentation|journal/i.test(e.kind ?? e.title)
    );
    setStudyBlockCandidates(gradedItems);
    setShowImportAnother(true);
  }

  // ── Bulk import: phase 1 — scan files to detect multi-section courses ──
  async function scanBulkForSections() {
    if (bulkScanning || bulkRunning || bulkQueue.length === 0) return;
    setBulkScanning(true);

    // Only scan items that are still pending and haven't been scanned yet
    const toScan = bulkQueue
      .map((it, idx) => ({ it, idx }))
      .filter(({ it }) => it.status === "pending" && !it.needsSection && !it.pickedSection && it.needsYearConfirm === undefined);

    for (const { it, idx } of toScan) {
      try {
        const fd = new FormData();
        fd.append("file", it.file);
        const res = await fetch("/api/import-syllabus", { method: "POST", body: fd });
        const data = (await res.json()) as {
          needsSectionPick?: boolean;
          needsYearConfirm?: boolean;
          sections?: string[];
          course?: string;
          events?: SyllabusEvent[];
          meta?: any;
          error?: string;
        };

        const hasYearIssue = (data?.needsYearConfirm || data?.meta?.needsYearConfirm) &&
          typeof data?.meta?.detectedYear === "number" &&
          typeof data?.meta?.nowYear === "number";
        const hasSectionIssue = data?.needsSectionPick && Array.isArray(data.sections) && data.sections.length >= 2;

        if (hasYearIssue) {
          // Mark as needing year confirmation — may also need section (both can come together)
          setBulkQueue((prev) =>
            prev.map((item, i) =>
              i === idx
                ? {
                    ...item,
                    needsYearConfirm: { detectedYear: data.meta.detectedYear, nowYear: data.meta.nowYear },
                    // If section pick also needed, store it so UI shows both
                    ...(hasSectionIssue ? { needsSection: { sections: data.sections!, course: data.course ?? "" } } : {}),
                  }
                : item
            )
          );
        } else if (hasSectionIssue) {
          // Only section pick needed (year is fine)
          setBulkQueue((prev) =>
            prev.map((item, i) =>
              i === idx
                ? { ...item, needsSection: { sections: data.sections!, course: data.course ?? "" } }
                : item
            )
          );
        }
        // If no section/year pick needed, we already have data — but we'll re-fetch during runBulkImport
        // to keep the logic clean and consistent (single code path).
      } catch {
        // Ignore scan errors — runBulkImport will surface them properly
      }
    }

    setBulkScanning(false);
  }

  // ── Bulk import: phase 2 — process each file sequentially with sections known ──
  async function runBulkImport() {
    if (bulkRunning || bulkQueue.length === 0) return;

    // Check if any item still needs a section or year picked
    const needsPick = bulkQueue.some((it) => it.needsSection && !it.pickedSection);
    const needsYearPick = bulkQueue.some((it) => it.needsYearConfirm && it.pickedYear === undefined);
    if (needsPick || needsYearPick) return; // UI will prevent this, but guard defensively

    setBulkRunning(true);
    setBulkDone(false);

    for (let i = 0; i < bulkQueue.length; i++) {
      const item = bulkQueue[i];
      // Mark as processing
      setBulkQueue((prev) =>
        prev.map((it, idx) => idx === i ? { ...it, status: "processing" } : it)
      );

      try {
        const fd = new FormData();
        fd.append("file", item.file);
        // If user picked a section (either from scan or inline picker), send it
        if (item.pickedSection) {
          fd.append("section", item.pickedSection);
        }
        // If user confirmed a year, send it as override
        if (typeof item.pickedYear === "number") {
          fd.append("yearOverride", String(item.pickedYear));
        }

        const res = await fetch("/api/import-syllabus", {
          method: "POST",
          body: fd,
        });
        const data = (await res.json()) as {
          events?: SyllabusEvent[];
          meta?: any;
          error?: string;
          needsSectionPick?: boolean;
          sections?: string[];
          course?: string;
        };

        if (!res.ok) throw new Error(data?.error ?? "Upload failed");

        // If year confirmation needed and user already picked (should always be true here),
        // re-call with the confirmed year. This path is a safety fallback — normally pickedYear
        // is already appended to fd above, so this block rarely triggers.
        let events: SyllabusEvent[] = [];
        if (data?.meta?.needsYearConfirm && data?.meta?.detectedYear && typeof item.pickedYear !== "number") {
          const fd2 = new FormData();
          fd2.append("file", item.file);
          fd2.append("yearOverride", String(data.meta.detectedYear));
          if (item.pickedSection) fd2.append("section", item.pickedSection);
          const res2 = await fetch("/api/import-syllabus", { method: "POST", body: fd2 });
          const data2 = await res2.json() as { events?: SyllabusEvent[]; error?: string };
          if (!res2.ok) throw new Error(data2?.error ?? "Upload failed");
          events = Array.isArray(data2?.events) ? data2.events : [];
        } else if (data?.needsSectionPick && Array.isArray(data.sections) && data.sections.length >= 2) {
          // This shouldn't happen if scan ran first — but handle gracefully:
          // pick first section and retry (never silently drop events)
          const fallbackSection = data.sections[0];
          const fd3 = new FormData();
          fd3.append("file", item.file);
          fd3.append("section", fallbackSection);
          const res3 = await fetch("/api/import-syllabus", { method: "POST", body: fd3 });
          const data3 = await res3.json() as { events?: SyllabusEvent[]; error?: string };
          if (!res3.ok) throw new Error(data3?.error ?? "Upload failed");
          events = Array.isArray(data3?.events) ? data3.events : [];
          // Update the queue item to reflect which section was used
          setBulkQueue((prev) =>
            prev.map((it, idx) =>
              idx === i
                ? { ...it, needsSection: { sections: data.sections!, course: data.course ?? "" }, pickedSection: fallbackSection }
                : it
            )
          );
        } else {
          events = Array.isArray(data?.events) ? data.events : [];
        }

        // Auto-import all events with this course's color
        if (events.length > 0) {
          addSyllabusEventsToCalendar(events, item.color);
        }

        const courseName = data?.course ?? data?.meta?.course ?? item.file.name.replace(/\.[^.]+$/, "");
        setBulkQueue((prev) =>
          prev.map((it, idx) =>
            idx === i ? { ...it, status: "done", eventCount: events.length, courseName } : it
          )
        );
      } catch (e: any) {
        setBulkQueue((prev) =>
          prev.map((it, idx) =>
            idx === i ? { ...it, status: "error", errorMsg: e?.message ?? "Failed" } : it
          )
        );
      }
    }

    setBulkRunning(false);
    setBulkDone(true);
    toast("🎉 Semester planned! All classes imported.", "success", 4000);
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
    <GeneratingOverlay visible={generatingVisible} streamingCoach={streamingCoach} />
    <SuggestionsLoadingOverlay visible={suggestionsLoading} />
    <SyllabusLoadingOverlay visible={syllabusLoading} />

    {/* ── Radial glow behind hero ── */}
    <div
      className="relative min-h-[calc(100vh-80px)] px-4 lg:px-8 xl:px-12 py-12 lg:py-0 lg:flex lg:items-center"
      style={{
        background: "radial-gradient(ellipse 70% 45% at 50% 20%, rgba(217,108,125,0.14) 0%, transparent 60%)",
      }}
    >
      {/* ── 3-column grid (lg+) / single column (mobile) ── */}
      <div className="w-full max-w-[1400px] mx-auto lg:grid lg:grid-cols-[260px_1fr_300px] lg:gap-10 xl:gap-16 lg:items-start lg:py-16">

      {/* ════════════════════════════════════
          LEFT SIDEBAR — action cards
          ════════════════════════════════════ */}
      <div className="hidden lg:flex flex-col gap-3 pt-2">
        {/* ── Plan My Whole Day — primary action card ── */}
        <motion.button
          initial={{ opacity: 0, x: -12 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.35, ease: "easeOut", delay: 0.2 }}
          onClick={() => {
            const storedPrefs = loadPreferences();
            const profile = loadOnboardingProfile();
            const wakeHour = storedPrefs.preferredStartHour ?? profile?.wakeHour ?? 8;
            const sleepHour = storedPrefs.preferredEndHour ?? profile?.sleepHour ?? 23;
            const wakeTime: DayPlanPrefs["wakeTime"] =
              wakeHour <= 7 ? "early" : wakeHour <= 9 ? "morning" : "late";
            const sleepTime: DayPlanPrefs["sleepTime"] =
              sleepHour <= 22 ? "early" : sleepHour <= 24 ? "normal" : "night";
            setDayPlanPrefs((prev) => ({ ...prev, wakeTime, sleepTime, mustDo: "", niceToHave: "" }));
            setDayPlanModalOpen(true);
          }}
          className="w-full text-left rounded-2xl border border-[var(--lifeos-pink)]/25 bg-gradient-to-br from-[var(--lifeos-pink)]/[0.07] to-[var(--lifeos-pink)]/[0.02] px-4 py-4 hover:border-[var(--lifeos-pink)]/40 hover:from-[var(--lifeos-pink)]/[0.1] hover:to-[var(--lifeos-pink)]/[0.05] hover:scale-[1.02] active:scale-[0.98] transition-all duration-200 shadow-[0_2px_14px_rgba(217,108,125,0.1)]"
        >
          <div className="flex items-start gap-3">
            <div className="h-9 w-9 rounded-xl bg-[var(--lifeos-pink)]/12 flex items-center justify-center shrink-0 shadow-[inset_0_1px_2px_rgba(217,108,125,0.15)] mt-0.5">
              <span className="text-lg">📅</span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-extrabold text-black/85 leading-tight" style={{ letterSpacing: "-0.015em" }}>
                Plan My Whole Day
              </div>
              <div className="text-[11px] text-black/40 font-medium mt-0.5 leading-snug">
                Personalized daily schedule
              </div>
              <div className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg bg-[var(--lifeos-pink)] px-3 py-1 text-[11px] font-extrabold text-white shadow-[0_2px_8px_rgba(217,108,125,0.35)]">
                <span>Let&apos;s go</span>
                <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </div>
            </div>
          </div>
        </motion.button>

        {/* ── Plan My Semester — secondary action card (bulk import) ── */}
        <motion.button
          initial={{ opacity: 0, x: -12 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.35, ease: "easeOut", delay: 0.27 }}
          onClick={() => { setBulkQueue([]); setBulkDone(false); setShowBulkImport(true); }}
          className="w-full text-left rounded-2xl border border-violet-200/60 bg-gradient-to-br from-violet-50/80 to-violet-50/20 px-4 py-4 hover:border-violet-300/70 hover:from-violet-50 hover:to-violet-50/40 hover:scale-[1.02] active:scale-[0.98] transition-all duration-200 shadow-[0_2px_14px_rgba(139,92,246,0.08)]"
        >
          <div className="flex items-start gap-3">
            <div className="h-9 w-9 rounded-xl bg-violet-100/70 flex items-center justify-center shrink-0 shadow-[inset_0_1px_2px_rgba(139,92,246,0.12)] mt-0.5">
              <span className="text-lg">📚</span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-extrabold text-black/85 leading-tight" style={{ letterSpacing: "-0.015em" }}>
                Plan My Semester
              </div>
              <div className="text-[11px] text-black/40 font-medium mt-0.5 leading-snug">
                Import all your syllabi at once
              </div>
              <div className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg bg-violet-500 px-3 py-1 text-[11px] font-extrabold text-white shadow-[0_2px_8px_rgba(139,92,246,0.35)]">
                <span>Let&apos;s go</span>
                <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </div>
            </div>
          </div>
        </motion.button>

        {/* ── Divider ── */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3, delay: 0.35 }}
          className="flex items-center gap-2 my-1"
        >
          <div className="flex-1 h-px bg-black/[0.07]" />
          <span className="text-[9px] font-bold tracking-[0.12em] uppercase text-black/20">examples</span>
          <div className="flex-1 h-px bg-black/[0.07]" />
        </motion.div>

        {/* ── Quick example items ── */}
        {[
          { icon: "🏃", label: "Run 5km", sub: "Tomorrow morning", input: "Run 5km tomorrow morning", color: "text-green-600", bg: "bg-green-50", border: "border-green-100" },
          { icon: "✈️", label: "Flight to NYC", sub: "Friday at 10am", input: "Flight Friday at 10am", color: "text-blue-600", bg: "bg-blue-50", border: "border-blue-100" },
          { icon: "💪", label: "Gym 3× this week", sub: "Mon, Wed, Fri 7am", input: "Gym every Mon, Wed, Fri at 7am", color: "text-pink-600", bg: "bg-pink-50", border: "border-pink-100" },
          { icon: "📚", label: "Study + gym", sub: "This week", input: "Study session + gym this week", color: "text-amber-600", bg: "bg-amber-50", border: "border-amber-100" },
        ].map(({ icon, label, sub, input: exInput, color, bg, border }, i) => (
          <motion.button
            key={label}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.25, delay: 0.38 + i * 0.05 }}
            onClick={() => setInput(exInput)}
            className={`flex items-center gap-3 rounded-xl border ${border} ${bg} px-3 py-2.5 text-left hover:scale-[1.02] active:scale-[0.98] transition-all duration-150`}
          >
            <span className="text-base leading-none shrink-0">{icon}</span>
            <div className="min-w-0">
              <div className={`text-[12px] font-bold ${color} leading-tight`}>{label}</div>
              <div className="text-[10px] text-black/35 mt-0.5">{sub}</div>
            </div>
          </motion.button>
        ))}
      </div>

      {/* ════════════════════════════════════
          CENTER — headline + input
          ════════════════════════════════════ */}
      <div className="flex flex-col items-center justify-center text-center lg:pt-2">

      {/* ── Hero headline ── */}
      <motion.h1
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: "easeOut" }}
        className="text-5xl sm:text-[62px] xl:text-[72px] font-black text-black leading-[0.97] max-w-[640px]"
        style={{ letterSpacing: "-0.05em" }}
      >
        Type your day.
        <br />
        <span style={{
          background: "linear-gradient(135deg, #e8758a 0%, #d96c7d 50%, #c45870 100%)",
          WebkitBackgroundClip: "text",
          WebkitTextFillColor: "transparent",
          backgroundClip: "text",
        }}>We schedule it.</span>
      </motion.h1>

      <motion.p
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: "easeOut", delay: 0.08 }}
        className="mt-3 text-[15px] font-medium max-w-[360px] leading-relaxed"
        style={{ color: "rgba(0,0,0,0.40)" }}
      >
        Describe your day — assignments, gym, meetings — and get a full schedule instantly.
      </motion.p>

      {/* ── Streak + feedback badges (self-hide when empty) ── */}
      <div className="mt-3 flex items-center gap-2 flex-wrap justify-center">
        <StreakBadge />
        {(feedbackSessions > 0 || pendingFeedback.length > 0) && (
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
        )}
      </div>

      {/* ── Input card ── */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: "easeOut", delay: 0.12 }}
        className="mt-5 w-full max-w-xl"
      >

        {/* File chip (shown above card when attached) */}
        <AnimatePresence>
        {pendingFile && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            className="mb-2.5 flex justify-center"
          >
            <div className="inline-flex items-center gap-2 rounded-full bg-white border border-[var(--lifeos-border)] px-4 py-2 shadow-sm text-sm font-semibold text-black/80">
              <span>📎</span>
              <span className="max-w-[240px] truncate">{pendingFile.name}</span>
              <button
                onClick={() => setPendingFile(null)}
                className="ml-1 text-black/30 hover:text-black/70 transition-colors leading-none"
                aria-label="Remove attachment"
              >✕</button>
            </div>
          </motion.div>
        )}
        </AnimatePresence>

        {/* Card container — gradient border + deep shadow, glows pink on focus */}
        <div className="rounded-2xl overflow-hidden transition-all duration-250" style={{ background: "#ffffff", border: "1.5px solid rgba(0,0,0,0.09)", boxShadow: "0 4px 24px rgba(0,0,0,0.10), 0 16px 48px rgba(0,0,0,0.07)" }} onFocus={(e) => { (e.currentTarget as HTMLDivElement).style.boxShadow = "0 4px 24px rgba(217,108,125,0.15), 0 16px 48px rgba(217,108,125,0.14)"; (e.currentTarget as HTMLDivElement).style.borderColor = "rgba(217,108,125,0.45)"; }} onBlur={(e) => { (e.currentTarget as HTMLDivElement).style.boxShadow = "0 4px 24px rgba(0,0,0,0.10), 0 16px 48px rgba(0,0,0,0.07)"; (e.currentTarget as HTMLDivElement).style.borderColor = "rgba(0,0,0,0.09)"; }}>

          {/* Textarea */}
          <textarea
            className="w-full resize-none bg-transparent px-5 pt-5 pb-3 text-[16px] font-semibold text-black placeholder:text-black/[0.30] outline-none leading-relaxed"
            rows={4}
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
                : rotatingPlaceholder
            }
          />

          {/* Inline example chips — shown inside the card when empty */}
          {!input && !pendingFile && (
            <div className="flex items-center gap-1.5 px-4 pb-3 flex-wrap">
              {[
                { label: "Essay due midnight + gym", v: "Essay due at midnight, gym this morning, lunch and dinner" },
                { label: "Plan my whole week", v: "Plan my week: study Monday, gym Tuesday Thursday, dentist Wednesday 2pm" },
                { label: "Flight Friday 6am", v: "Flight Friday at 6am, need to pack tomorrow night" },
              ].map(({ label, v }) => (
                <button
                  key={label}
                  onClick={() => setInput(v)}
                  className="rounded-full px-3 py-1 text-[11px] font-semibold transition-all hover:scale-[1.02] active:scale-[0.98]"
                  style={{ background: "rgba(0,0,0,0.04)", border: "1px solid rgba(0,0,0,0.07)", color: "rgba(0,0,0,0.45)" }}
                  onMouseOver={(e) => { const el = e.currentTarget as HTMLButtonElement; el.style.background = "rgba(217,108,125,0.08)"; el.style.borderColor = "rgba(217,108,125,0.3)"; el.style.color = "var(--lifeos-pink)"; }}
                  onMouseOut={(e) => { const el = e.currentTarget as HTMLButtonElement; el.style.background = "rgba(0,0,0,0.04)"; el.style.borderColor = "rgba(0,0,0,0.07)"; el.style.color = "rgba(0,0,0,0.45)"; }}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

          {/* Card bottom bar */}
          <div className="flex items-center justify-between gap-2 px-3 pb-3 pt-1">

            {/* Left — quick action buttons */}
            <div className="flex items-center gap-1">
              {/* Bulk import */}
              <button
                className="flex items-center justify-center h-8 w-8 rounded-lg text-black/30 hover:text-black/60 hover:bg-black/[0.05] transition-all"
                title="Import all syllabi at once"
                onClick={() => { setBulkQueue([]); setBulkDone(false); setShowBulkImport(true); }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                  <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                  <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                  <path d="M12 8v8M9 11l3-3 3 3" />
                </svg>
              </button>

              {/* Divider */}
              <div className="h-4 w-px bg-black/[0.07] mx-1" />

              {/* char count hint */}
              {input.length > 0 && (
                <span className="text-[10px] text-black/20 font-medium select-none tabular-nums">
                  {input.length}
                </span>
              )}
            </div>

            {/* Right — generate button */}
            <button
              onClick={generate}
              disabled={!canGenerate}
              className="flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-bold text-white transition-all hover:scale-[1.03] active:scale-[0.97] disabled:opacity-35 disabled:scale-100"
              style={{ background: "linear-gradient(135deg, #e8758a 0%, #d96c7d 50%, #c45870 100%)", boxShadow: "0 2px 12px rgba(217,108,125,0.38), 0 6px 24px rgba(217,108,125,0.22)", transition: "all 150ms ease" }}
              onMouseEnter={(e) => { if (!(e.currentTarget as HTMLButtonElement).disabled) (e.currentTarget as HTMLButtonElement).style.boxShadow = "0 4px 20px rgba(217,108,125,0.52), 0 10px 36px rgba(217,108,125,0.28)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.boxShadow = "0 2px 12px rgba(217,108,125,0.38), 0 6px 24px rgba(217,108,125,0.22)"; }}
            >
              {syllabusLoading || loading ? (
                <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor">
                  <path d="M12 2l2.09 6.26L21 10l-6.91 1.74L12 18l-2.09-5.74L3 10l6.91-1.74z" />
                </svg>
              )}
              <span>{syllabusLoading ? "Reading…" : loading ? "Generating…" : pendingFile ? "Import" : "Generate"}</span>
            </button>
          </div>
        </div>

        {/* ── Mobile-only: Plan My Day card + quick example chips ── */}
        <AnimatePresence>
        {!input && !loading && !syllabusLoading && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.22 }}
            className="mt-4 space-y-3 lg:hidden"
          >
            {/* Plan My Whole Day */}
            <motion.button
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.22, delay: 0.04 }}
              onClick={() => {
                const storedPrefs = loadPreferences();
                const profile = loadOnboardingProfile();
                const wakeHour = storedPrefs.preferredStartHour ?? profile?.wakeHour ?? 8;
                const sleepHour = storedPrefs.preferredEndHour ?? profile?.sleepHour ?? 23;
                const wakeTime: DayPlanPrefs["wakeTime"] =
                  wakeHour <= 7 ? "early" : wakeHour <= 9 ? "morning" : "late";
                const sleepTime: DayPlanPrefs["sleepTime"] =
                  sleepHour <= 22 ? "early" : sleepHour <= 24 ? "normal" : "night";
                setDayPlanPrefs((prev) => ({ ...prev, wakeTime, sleepTime, mustDo: "", niceToHave: "" }));
                setDayPlanModalOpen(true);
              }}
              className="w-full text-left rounded-2xl border border-[var(--lifeos-pink)]/25 bg-gradient-to-br from-[var(--lifeos-pink)]/[0.06] to-[var(--lifeos-pink)]/[0.02] px-4 py-3.5 hover:border-[var(--lifeos-pink)]/40 hover:scale-[1.005] active:scale-[0.998] transition-all duration-150 shadow-[0_2px_14px_rgba(217,108,125,0.1)]"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-xl bg-[var(--lifeos-pink)]/12 flex items-center justify-center shrink-0">
                    <span className="text-xl">📅</span>
                  </div>
                  <div>
                    <div className="text-[13px] font-extrabold text-black/85 leading-tight" style={{ letterSpacing: "-0.015em" }}>Plan My Whole Day</div>
                    <div className="text-[11px] text-black/40 font-medium mt-0.5">I&apos;ll build your personalized daily schedule</div>
                  </div>
                </div>
                <div className="shrink-0 flex items-center gap-1.5 rounded-xl bg-[var(--lifeos-pink)] px-3 py-1.5 text-[11px] font-extrabold text-white shadow-[0_2px_8px_rgba(217,108,125,0.35)]">
                  <span>Let&apos;s go</span>
                  <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
                </div>
              </div>
            </motion.button>

            {/* Import Syllabus — single file */}
            <motion.label
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.22, delay: 0.07 }}
              className="w-full text-left rounded-2xl border border-violet-200/60 bg-gradient-to-br from-violet-50/80 to-violet-50/20 px-4 py-3.5 hover:border-violet-300/70 hover:scale-[1.005] active:scale-[0.998] transition-all duration-150 shadow-[0_2px_14px_rgba(139,92,246,0.08)] cursor-pointer block"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-xl bg-violet-100/70 flex items-center justify-center shrink-0">
                    <span className="text-xl">🎓</span>
                  </div>
                  <div>
                    <div className="text-[13px] font-extrabold text-black/85 leading-tight" style={{ letterSpacing: "-0.015em" }}>Import a Syllabus</div>
                    <div className="text-[11px] text-black/40 font-medium mt-0.5">Upload one PDF or DOCX to add deadlines</div>
                  </div>
                </div>
                <div className="shrink-0 flex items-center gap-1.5 rounded-xl bg-violet-500 px-3 py-1.5 text-[11px] font-extrabold text-white shadow-[0_2px_8px_rgba(139,92,246,0.35)]">
                  <span>Upload</span>
                  <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
                </div>
              </div>
              <input type="file" accept="application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx,application/msword" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) { setPendingFile(f); setSyllabusError(null); } e.currentTarget.value = ""; }}
                disabled={syllabusLoading}
              />
            </motion.label>

            {/* Quick examples */}
            <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, delay: 0.13 }}>
              <div className="flex items-center gap-3 mb-3">
                <div className="flex-1 h-px bg-gradient-to-r from-transparent via-black/[0.08] to-transparent" />
                <span className="text-[10px] font-bold tracking-[0.1em] uppercase text-black/20">or try an example</span>
                <div className="flex-1 h-px bg-gradient-to-r from-transparent via-black/[0.08] to-transparent" />
              </div>
              <div className="grid grid-cols-2 gap-2 mb-2">
                {([
                  { icon: "🏃", cat: "FITNESS", title: "Run 5km", sub: "Tomorrow morning", bar: "from-green-300 to-green-500", catColor: "text-green-600", text: "Run 5km tomorrow morning" },
                  { icon: "✈️", cat: "TRAVEL", title: "Flight to NYC", sub: "Friday at 10am", bar: "from-blue-300 to-blue-500", catColor: "text-blue-600", text: "Flight Friday at 10am" },
                ] as { icon: string; cat: string; title: string; sub: string; bar: string; catColor: string; text: string }[]).map(({ icon, cat, title, sub, bar, catColor, text }) => (
                  <button key={text} onClick={() => setInput(text)} className="relative overflow-hidden rounded-2xl border border-black/[0.06] bg-white px-4 pt-5 pb-4 text-left shadow-[0_2px_16px_rgba(0,0,0,0.07)] hover:shadow-[0_4px_24px_rgba(0,0,0,0.11)] hover:scale-[1.02] active:scale-[0.99] transition-all duration-150">
                    <div className={`absolute top-0 left-0 right-0 h-[3px] bg-gradient-to-r ${bar}`} />
                    <div className={`text-[10px] font-extrabold tracking-[0.1em] uppercase mb-2 ${catColor}`}>{cat}</div>
                    <div className="text-[22px] mb-2 leading-none">{icon}</div>
                    <div className="text-[13.5px] font-extrabold text-black/85 tracking-tight leading-snug">{title}</div>
                    <div className="text-[11px] text-black/35 mt-1">{sub}</div>
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-3 gap-2">
                {([
                  { icon: "💪", text: "Gym 3× this week", bg: "bg-pink-50", border: "border-pink-200", color: "text-pink-700", input: "Gym every Mon, Wed, Fri at 7am" },
                  { icon: "📚", text: "Study + gym", bg: "bg-amber-50", border: "border-amber-200", color: "text-amber-700", input: "Study session + gym this week" },
                  { icon: "🍕", text: "Dinner Saturday", bg: "bg-violet-50", border: "border-violet-200", color: "text-violet-700", input: "Dinner with friends Saturday 7pm" },
                ] as { icon: string; text: string; bg: string; border: string; color: string; input: string }[]).map(({ icon, text, bg, border, color, input }) => (
                  <button key={text} onClick={() => setInput(input)} className={`flex items-center gap-2 rounded-xl border ${border} ${bg} px-3 py-2.5 hover:scale-[1.03] active:scale-[0.98] transition-all duration-150`}>
                    <span className="text-[15px] leading-none shrink-0">{icon}</span>
                    <span className={`text-[11.5px] font-bold ${color} leading-tight`}>{text}</span>
                  </button>
                ))}
              </div>
            </motion.div>

            {/* Preferences button — mobile */}
            <motion.button
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, delay: 0.18 }}
              onClick={() => setSettingsOpen(true)}
              className="flex items-center justify-center gap-2 w-full rounded-xl border border-black/[0.07] bg-white/60 px-4 py-2.5 text-[12px] font-semibold text-black/40 hover:text-black/70 hover:bg-white/90 transition-all"
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              Preferences
            </motion.button>
          </motion.div>
        )}
        </AnimatePresence>

        {/* ── Confirmation chip — appears after parsing, before committing ── */}
        <AnimatePresence>
        {confirmChip && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.97 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="mt-3 rounded-2xl overflow-hidden shadow-[0_4px_24px_rgba(217,108,125,0.12)] border border-[var(--lifeos-pink)]/15"
          >
            {/* Accent bar */}
            <div className="h-0.5 w-full bg-gradient-to-r from-[var(--lifeos-pink)] via-[var(--lifeos-pink)]/50 to-transparent" />
            <div className="bg-white px-4 pt-3.5 pb-3.5">
              {/* Label */}
              <div className="flex items-center gap-1.5 mb-2">
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--lifeos-pink)]" />
                <p className="text-[10px] font-bold text-[var(--lifeos-pink)] uppercase tracking-widest">Looks like</p>
              </div>
              {/* Parsed event summary */}
              <p className="text-[15px] font-bold text-black/90 leading-snug" style={{ letterSpacing: "-0.02em" }}>
                {confirmChip.summary}
              </p>
              {/* Actions */}
              <div className="flex items-center gap-2 mt-3.5">
                <button
                  onClick={() => { const fn = confirmChip.onConfirm; setConfirmChip(null); fn(); }}
                  className="flex items-center gap-1.5 rounded-xl bg-[var(--lifeos-pink)] px-4 py-2 text-xs font-bold text-white shadow-[0_2px_8px_rgba(217,108,125,0.3)] hover:shadow-[0_4px_14px_rgba(217,108,125,0.4)] hover:scale-[1.02] active:scale-[0.98] transition-all"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3"><path d="M20 6L9 17l-5-5"/></svg>
                  Add to calendar
                </button>
                <button
                  onClick={() => setConfirmChip(null)}
                  className="rounded-xl border border-black/[0.08] px-4 py-2 text-xs font-semibold text-black/45 hover:bg-black/[0.04] hover:text-black/70 transition-all"
                >
                  Edit
                </button>
              </div>
            </div>
          </motion.div>
        )}
        </AnimatePresence>

        {/* ── AI breakdown card — appears after scheduling an assignment/project ── */}
        <AnimatePresence>
          {breakdownCard && (
            <motion.div
              initial={{ opacity: 0, y: 8, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.97 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="mt-3 rounded-2xl overflow-hidden shadow-[0_4px_24px_rgba(108,142,232,0.12)] border border-blue-200/60"
            >
              <div className="h-0.5 w-full bg-gradient-to-r from-blue-400 via-blue-300/50 to-transparent" />
              <div className="bg-white px-4 pt-3.5 pb-3.5">
                <div className="flex items-center gap-1.5 mb-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-blue-400" />
                  <p className="text-[10px] font-bold text-blue-500 uppercase tracking-widest">Study plan</p>
                </div>
                <p className="text-[14px] font-bold text-black/85 leading-snug mb-0.5" style={{ letterSpacing: "-0.02em" }}>
                  Want me to break <span className="text-blue-500">{breakdownCard.title}</span> into study milestones?
                </p>
                <p className="text-xs text-black/40 mb-3">I&apos;ll add research, draft, and review blocks leading up to the due date.</p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => generateBreakdown(breakdownCard.title, breakdownCard.dueDate)}
                    disabled={breakdownLoading}
                    className="flex items-center gap-1.5 rounded-xl bg-blue-500 px-4 py-2 text-xs font-bold text-white shadow-[0_2px_8px_rgba(108,142,232,0.3)] hover:bg-blue-600 hover:scale-[1.02] active:scale-[0.98] transition-all disabled:opacity-60"
                  >
                    {breakdownLoading ? (
                      <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
                    ) : (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3"><path d="M12 2l3 9h9l-7 5 3 9-8-6-8 6 3-9-7-5h9z"/></svg>
                    )}
                    {breakdownLoading ? "Generating…" : "Generate study plan"}
                  </button>
                  <button
                    onClick={() => setBreakdownCard(null)}
                    className="rounded-xl border border-black/[0.08] px-4 py-2 text-xs font-semibold text-black/45 hover:bg-black/[0.04] hover:text-black/70 transition-all"
                  >
                    No thanks
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

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
        {/* ── Ask-first suggestions chip ── */}
        <AnimatePresence>
          {askFirstChip && !suggestionsInlineOpen && (
            <motion.div
              initial={{ opacity: 0, y: 8, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.97 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="mt-3"
            >
              <button
                onClick={() => { askFirstChip.onFetch(); }}
                disabled={suggestionsLoading}
                className="w-full flex items-center gap-2 rounded-2xl border border-[var(--lifeos-pink)]/20 bg-[var(--lifeos-pink)]/[0.04] px-4 py-3 text-sm font-semibold text-[var(--lifeos-pink)] hover:bg-[var(--lifeos-pink)]/[0.08] hover:border-[var(--lifeos-pink)]/30 active:scale-[0.99] transition-all text-left"
              >
                {suggestionsLoading ? (
                  <svg className="w-3.5 h-3.5 animate-spin shrink-0" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                  </svg>
                ) : (
                  <span className="text-base shrink-0">✨</span>
                )}
                <span className="flex-1">{suggestionsLoading ? "Finding prep tips…" : askFirstChip.text}</span>
                {!suggestionsLoading && (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5 shrink-0 opacity-50">
                    <path d="M9 18l6-6-6-6"/>
                  </svg>
                )}
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Inline suggestion cards ── */}
        <AnimatePresence>
          {suggestionsInlineOpen && suggestions.length > 0 && (
            <SuggestionInlineCards
              suggestions={suggestions}
              eventContext={suggestionsContext.context ?? "general"}
              onAdd={(s) => {
                addBlocksToCalendar([{
                  id: generateId(),
                  date: s.date,
                  title: s.title,
                  startMin: s.startMin,
                  endMin: s.endMin,
                  meta: { kind: "manual" },
                }]);
              }}
              onSavePref={handleSaveSuggestionPref}
              onDismiss={() => {
                setSuggestionsInlineOpen(false);
                setSuggestions([]);
                setPendingSuggestionBlocks(null);
                setAskFirstChip(null);
                router.push("/plan");
              }}
            />
          )}
        </AnimatePresence>
      </motion.div>

      {/* Mobile-only: week strip + today strip below input */}
      <div className="lg:hidden w-full">
        <WeekMiniStrip />
        <TodayStrip />
      </div>

      </div>{/* end center column */}

      {/* ════════════════════════════════════
          RIGHT SIDEBAR — today + this week
          ════════════════════════════════════ */}
      <motion.div
        initial={{ opacity: 0, x: 12 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.35, ease: "easeOut", delay: 0.3 }}
        className="hidden lg:flex flex-col gap-4 pt-2"
      >
        {/* Today's Schedule panel */}
        <SidebarTodayPanel />

        {/* This Week panel */}
        <SidebarWeekPanel />

        {/* Quick nav links */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3, delay: 0.55 }}
          className="flex flex-col gap-1.5 pt-1"
        >
          {[
            { href: "/calendar", icon: "📅", label: "Full calendar" },
            { href: "/plan", icon: "🎯", label: "Focus & plan" },
          ].map(({ href, icon, label }) => (
            <a
              key={href}
              href={href}
              className="flex items-center gap-2.5 rounded-xl px-3 py-2 text-[12.5px] font-semibold text-black/45 hover:text-black/70 hover:bg-black/[0.04] transition-all duration-150"
            >
              <span className="text-sm">{icon}</span>
              <span>{label}</span>
              <svg viewBox="0 0 24 24" className="ml-auto h-3 w-3 opacity-40" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 18l6-6-6-6" />
              </svg>
            </a>
          ))}
          {/* Settings button */}
          <button
            onClick={() => setSettingsOpen(true)}
            className="flex items-center gap-2.5 rounded-xl px-3 py-2 text-[12.5px] font-semibold text-black/45 hover:text-black/70 hover:bg-black/[0.04] transition-all duration-150 w-full text-left"
          >
            <span className="text-sm">⚙️</span>
            <span>Preferences</span>
            <svg viewBox="0 0 24 24" className="ml-auto h-3 w-3 opacity-40" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>
        </motion.div>
      </motion.div>

      </div>{/* end 3-col grid */}

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
          if (pendingQuickEvent?.isMultiEvent && multiEventScheduledRef.current.length > 0) {
            void fetchSuggestionsForBlocks(multiEventScheduledRef.current, multiEventOriginalInput);
            setMultiEventQueue([]);
            multiEventScheduledRef.current = [];
            setMultiEventScheduled([]);
            setMultiEventOriginalInput("");
            setMultiEventMealDate("");
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

          // Read from ref to avoid stale closure across sequential modal opens
          let newScheduled = [...multiEventScheduledRef.current];
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
            multiEventScheduledRef.current = newScheduled;
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
            // Done — place meals with full confirmed activity context, then show suggestions
            setInput("");
            setMultiEventQueue([]);
            multiEventScheduledRef.current = [];
            placeMealsIfNeeded(newScheduled, multiEventOriginalInput, multiEventMealDate);
            setMultiEventOriginalInput("");
            setMultiEventMealDate("");
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
          // Read from ref to avoid stale closure across sequential modal opens
          const newScheduled = [...multiEventScheduledRef.current, block];
          multiEventScheduledRef.current = newScheduled;
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
            // Done — place meals with full confirmed activity context, then show suggestions
            setInput("");
            setMultiEventQueue([]);
            multiEventScheduledRef.current = [];
            placeMealsIfNeeded(newScheduled, multiEventOriginalInput, multiEventMealDate);
            setMultiEventOriginalInput("");
            setMultiEventMealDate("");
            void fetchSuggestionsForBlocks(newScheduled, capturedInput);
          }
        }}
      />

      {/* Multi-Event All-At-Once Modal */}
      <MultiEventModal
        open={multiEventModalOpen}
        events={multiEventModalEvents}
        onClose={() => {
          setMultiEventModalOpen(false);
          // If pre-scheduled blocks exist, still fire suggestions
          if (multiEventModalPreScheduled.length > 0) {
            void fetchSuggestionsForBlocks(multiEventModalPreScheduled, multiEventOriginalInput);
          }
          setMultiEventOriginalInput("");
          setMultiEventMealDate("");
          setMultiEventModalPreScheduled([]);
          setMultiEventModalEvents([]);
        }}
        onScheduleAll={(rows) => {
          setMultiEventModalOpen(false);
          const capturedInput = multiEventOriginalInput;
          const mealDate = multiEventMealDate;
          const existing = loadCalendar();
          const newBlocks: CalendarBlock[] = [...multiEventModalPreScheduled];

          for (const row of rows) {
            const totalMin = clampMinutes(row.durationHours * 60 + row.durationMins);
            if (row.useNextSlot) {
              // Find next available slot, constraining to the specified date if given
              const startISO = row.date || localDateISO(new Date());
              const slot = row.date
                ? (findNextAvailableSlot([...existing, ...newBlocks], totalMin, startISO, 1, true)
                  ?? findNextAvailableSlot([...existing, ...newBlocks], totalMin, startISO, 14, false))
                : findNextAvailableSlot([...existing, ...newBlocks], totalMin, startISO, 14, false);
              if (slot) {
                newBlocks.push({
                  id: generateId(),
                  date: slot.date,
                  title: row.title,
                  startMin: slot.startMin,
                  endMin: slot.endMin,
                  meta: { kind: "manual", fullDetail: capturedInput },
                });
              }
            } else {
              const resolvedDate = row.date || localDateISO(new Date());
              const [hh, mm] = String(row.time || "09:00").split(":").map((x) => parseInt(x, 10));
              const startMin = (isNaN(hh) ? 9 : hh) * 60 + (isNaN(mm) ? 0 : mm);
              const endMin = Math.min(startMin + totalMin, 24 * 60);
              newBlocks.push({
                id: generateId(),
                date: resolvedDate,
                title: row.title,
                startMin,
                endMin,
                meta: { kind: "manual", fullDetail: capturedInput },
              });
            }
          }

          // Commit all blocks to the calendar (pre-scheduled + newly resolved together)
          if (newBlocks.length > 0) addBlocksToCalendar(newBlocks);

          setMultiEventOriginalInput("");
          setMultiEventMealDate("");
          setMultiEventModalPreScheduled([]);
          setMultiEventModalEvents([]);

          placeMealsIfNeeded(newBlocks, capturedInput, mealDate);
          setInput("");
          void fetchSuggestionsForBlocks(newBlocks, capturedInput);
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
                      // Pass through any year that was confirmed in the previous step
                      const confirmedYear = typeof syllabusMeta?.confirmedYear === "number" ? syllabusMeta.confirmedYear : undefined;
                      setSectionPick(null);
                      void onUploadSyllabus(f, confirmedYear, sec);
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
            {yearConfirm.pendingSections && (
              <p className="mt-2 text-xs text-amber-600 font-medium">
                ⚠ This course also has multiple sections — you'll pick yours next.
              </p>
            )}
            <div className="mt-5 flex flex-wrap gap-3">
              <button
                className="flex-1 rounded-2xl bg-[var(--lifeos-pink)] px-5 py-3 text-sm font-bold text-white shadow-sm"
                onClick={() => {
                  const pending = yearConfirm.pendingSections;
                  setYearConfirm(null);
                  if (pending) {
                    // Show section picker next — onUploadSyllabus will be called after section is chosen
                    setSectionPick(pending);
                    // Store the confirmed year so it gets passed through when section is picked
                    setSyllabusMeta((prev: any) => ({ ...prev, confirmedYear: yearConfirm.detectedYear }));
                  } else {
                    void onUploadSyllabus(syllabusFile, yearConfirm.detectedYear);
                  }
                }}
              >
                ✓ Yes, use {yearConfirm.detectedYear}
              </button>
              <button
                className="flex-1 rounded-2xl border border-[var(--lifeos-border)] bg-white px-5 py-3 text-sm font-semibold text-black/70"
                onClick={() => {
                  const pending = yearConfirm.pendingSections;
                  setYearConfirm(null);
                  if (pending) {
                    setSectionPick(pending);
                    setSyllabusMeta((prev: any) => ({ ...prev, confirmedYear: yearConfirm.nowYear }));
                  } else {
                    void onUploadSyllabus(syllabusFile, yearConfirm.nowYear);
                  }
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

      {/* ── Bulk import modal ── */}
      {showBulkImport && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/30 p-0 sm:p-4">
          <div className="w-full sm:max-w-lg rounded-t-3xl sm:rounded-3xl border border-[var(--lifeos-border-soft)] bg-white flex flex-col max-h-[92vh]">

            {/* Header */}
            <div className="px-6 pt-6 pb-4 border-b border-black/[0.05] shrink-0">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-xl font-extrabold text-black" style={{ letterSpacing: "-0.02em" }}>
                    📚 Import all your classes
                  </div>
                  <p className="mt-1 text-sm text-black/50 leading-relaxed">
                    Drop all your syllabus files. We'll plan your entire semester in one shot.
                  </p>
                </div>
                <button
                  onClick={() => setShowBulkImport(false)}
                  className="shrink-0 rounded-full p-2 text-black/30 hover:text-black/60 hover:bg-black/[0.05] transition-colors"
                  aria-label="Close"
                >
                  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Scrollable body */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">

              {/* Done summary screen */}
              {bulkDone ? (
                <div className="text-center py-6">
                  <div className="text-4xl mb-3">🎉</div>
                  <div className="text-lg font-extrabold text-black mb-1" style={{ letterSpacing: "-0.02em" }}>
                    Semester planned!
                  </div>
                  <p className="text-sm text-black/50 mb-5">
                    {bulkQueue.filter((it) => it.status === "done").reduce((sum, it) => sum + (it.eventCount ?? 0), 0)} events imported across {bulkQueue.filter((it) => it.status === "done").length} course{bulkQueue.filter((it) => it.status === "done").length !== 1 ? "s" : ""}
                  </p>
                  <div className="space-y-2 text-left mb-6">
                    {bulkQueue.map((item, idx) => (
                      <div key={idx} className="flex items-center gap-3 rounded-2xl border border-black/[0.06] bg-black/[0.02] px-4 py-3">
                        <div className="h-3 w-3 rounded-full shrink-0" style={{ backgroundColor: item.color }} />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-semibold text-black/80 truncate">{item.courseName ?? item.file.name}</div>
                          {item.status === "done" && (
                            <div className="text-xs text-black/40">{item.eventCount} event{item.eventCount !== 1 ? "s" : ""} added</div>
                          )}
                          {item.status === "error" && (
                            <div className="text-xs text-red-500">{item.errorMsg ?? "Failed to import"}</div>
                          )}
                        </div>
                        {item.status === "done" && <span className="text-green-500 font-bold text-sm shrink-0">✓</span>}
                        {item.status === "error" && <span className="text-red-400 font-bold text-sm shrink-0">✕</span>}
                      </div>
                    ))}
                  </div>
                  <div className="flex flex-col gap-2">
                    <button
                      onClick={() => { setShowBulkImport(false); router.push("/calendar"); }}
                      className="w-full rounded-2xl bg-[var(--lifeos-pink)] px-5 py-3 text-sm font-bold text-white shadow-sm hover:opacity-90 transition-opacity"
                    >
                      View calendar →
                    </button>
                    <button
                      onClick={() => { setBulkQueue([]); setBulkDone(false); }}
                      className="w-full rounded-2xl border border-[var(--lifeos-border)] bg-white px-5 py-3 text-sm font-semibold text-black/60 hover:bg-black/[0.02] transition-colors"
                    >
                      Import more classes
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {/* Drop zone */}
                  <div
                    ref={bulkDropRef}
                    onDragOver={(e) => { e.preventDefault(); (e.currentTarget as HTMLDivElement).setAttribute("data-drag", "1"); }}
                    onDragLeave={(e) => { (e.currentTarget as HTMLDivElement).removeAttribute("data-drag"); }}
                    onDrop={(e) => {
                      e.preventDefault();
                      (e.currentTarget as HTMLDivElement).removeAttribute("data-drag");
                      const files = Array.from(e.dataTransfer.files).filter((f) =>
                        f.type === "application/pdf" ||
                        f.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
                        f.name.endsWith(".docx") || f.name.endsWith(".pdf")
                      );
                      if (files.length === 0) return;
                      setBulkQueue((prev) => {
                        const existing = new Set(prev.map((it) => it.file.name));
                        const newItems = files
                          .filter((f) => !existing.has(f.name))
                          .map((f, i) => ({
                            file: f,
                            color: BULK_COLORS[(prev.length + i) % BULK_COLORS.length],
                            status: "pending" as const,
                          }));
                        return [...prev, ...newItems];
                      });
                    }}
                    className="relative flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-black/15 bg-black/[0.02] p-8 text-center transition-colors
                      data-[drag]:border-[var(--lifeos-pink)] data-[drag]:bg-[var(--lifeos-pink)]/5 cursor-pointer"
                  >
                    <span className="text-3xl">🗂️</span>
                    <div className="text-sm font-semibold text-black/50">Drop all your syllabi here</div>
                    <div className="text-xs text-black/35">PDF or DOCX · Multiple files at once</div>
                    <label className="mt-2 cursor-pointer rounded-full bg-black/[0.05] px-4 py-2 text-xs font-bold text-black/50 hover:bg-[var(--lifeos-pink)]/10 hover:text-[var(--lifeos-pink)] transition-colors">
                      Or browse files
                      <input
                        type="file"
                        multiple
                        accept="application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx,application/msword"
                        className="hidden"
                        onChange={(e) => {
                          const files = Array.from(e.target.files ?? []);
                          if (files.length === 0) return;
                          setBulkQueue((prev) => {
                            const existing = new Set(prev.map((it) => it.file.name));
                            const newItems = files
                              .filter((f) => !existing.has(f.name))
                              .map((f, i) => ({
                                file: f,
                                color: BULK_COLORS[(prev.length + i) % BULK_COLORS.length],
                                status: "pending" as const,
                              }));
                            return [...prev, ...newItems];
                          });
                          e.currentTarget.value = "";
                        }}
                      />
                    </label>
                  </div>

                  {/* Queue list */}
                  {bulkQueue.length > 0 && (
                    <div className="space-y-2">
                      <div className="text-xs font-bold uppercase tracking-wider text-black/35 px-1">
                        {bulkQueue.length} file{bulkQueue.length !== 1 ? "s" : ""} queued
                      </div>
                      {bulkQueue.map((item, idx) => (
                        <div key={idx} className="rounded-2xl border border-black/[0.06] bg-white shadow-sm overflow-hidden">
                          <div className="flex items-center gap-3 px-4 py-3">
                            {/* Status indicator */}
                            <div className="shrink-0 w-6 h-6 flex items-center justify-center">
                              {item.status === "pending" && !item.needsSection && (
                                <div className="h-2.5 w-2.5 rounded-full bg-black/20" />
                              )}
                              {item.status === "pending" && item.needsSection && !item.pickedSection && (
                                <span className="text-amber-400 font-bold text-sm">!</span>
                              )}
                              {item.status === "pending" && item.needsSection && item.pickedSection && (
                                <div className="h-2.5 w-2.5 rounded-full bg-[var(--lifeos-pink)]" />
                              )}
                              {item.status === "processing" && (
                                <motion.div
                                  className="h-2.5 w-2.5 rounded-full"
                                  style={{ backgroundColor: item.color }}
                                  animate={{ scale: [1, 1.4, 1], opacity: [1, 0.6, 1] }}
                                  transition={{ duration: 1, repeat: Infinity }}
                                />
                              )}
                              {item.status === "done" && (
                                <span className="text-green-500 font-bold text-sm">✓</span>
                              )}
                              {item.status === "error" && (
                                <span className="text-red-400 font-bold text-sm">✕</span>
                              )}
                            </div>

                            {/* File info */}
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-semibold text-black/80 truncate">
                                {item.courseName ?? item.file.name.replace(/\.[^.]+$/, "")}
                              </div>
                              <div className="text-xs text-black/35">
                                {item.status === "pending" && !item.needsSection && "Ready to import"}
                                {item.status === "pending" && item.needsSection && !item.pickedSection && (
                                  <span className="text-amber-500 font-medium">Pick your section below</span>
                                )}
                                {item.status === "pending" && item.needsSection && item.pickedSection && (
                                  <span className="text-[var(--lifeos-pink)] font-medium">Section {item.pickedSection} selected</span>
                                )}
                                {item.status === "processing" && "Importing…"}
                                {item.status === "done" && `${item.eventCount} event${item.eventCount !== 1 ? "s" : ""} added`}
                                {item.status === "error" && (item.errorMsg ?? "Failed")}
                              </div>
                            </div>

                            {/* Color picker */}
                            {item.status === "pending" && (
                              <div className="flex items-center gap-1 shrink-0">
                                {BULK_COLORS.map((c) => (
                                  <button
                                    key={c}
                                    onClick={() => setBulkQueue((prev) =>
                                      prev.map((it, i) => i === idx ? { ...it, color: c } : it)
                                    )}
                                    className="h-4 w-4 rounded-full transition-transform hover:scale-125"
                                    style={{
                                      backgroundColor: c,
                                      outline: item.color === c ? `2px solid ${c}` : "2px solid transparent",
                                      outlineOffset: "2px",
                                    }}
                                    title={c}
                                  />
                                ))}
                              </div>
                            )}
                            {/* Color swatch for in-progress / done */}
                            {item.status !== "pending" && (
                              <div
                                className="shrink-0 h-4 w-4 rounded-full"
                                style={{ backgroundColor: item.color }}
                              />
                            )}

                            {/* Remove button (only when pending) */}
                            {item.status === "pending" && !bulkRunning && (
                              <button
                                onClick={() => setBulkQueue((prev) => prev.filter((_, i) => i !== idx))}
                                className="shrink-0 ml-1 text-black/25 hover:text-black/60 transition-colors"
                                aria-label="Remove"
                              >
                                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                                  <path d="M18 6L6 18M6 6l12 12" />
                                </svg>
                              </button>
                            )}
                          </div>

                          {/* Inline section picker — shown when server detected multiple sections */}
                          {item.status === "pending" && item.needsSection && !item.pickedSection && (
                            <div className="px-4 pb-3 border-t border-amber-100 bg-amber-50/60">
                              <p className="text-xs text-amber-700 font-medium mt-2 mb-2">
                                {item.needsSection.course
                                  ? <><span className="font-bold">{item.needsSection.course}</span> has multiple sections. Which one are you in?</>
                                  : "Multiple sections found. Which one are you in?"}
                              </p>
                              <div className="flex flex-wrap gap-2">
                                {item.needsSection.sections.map((sec) => (
                                  <button
                                    key={sec}
                                    onClick={() => setBulkQueue((prev) =>
                                      prev.map((it, i) => i === idx ? { ...it, pickedSection: sec } : it)
                                    )}
                                    className="rounded-xl border border-amber-300 bg-white px-3 py-1.5 text-xs font-bold text-amber-700 hover:bg-[var(--lifeos-pink)] hover:border-[var(--lifeos-pink)] hover:text-white transition-colors"
                                  >
                                    Section {sec}
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Inline year confirmation — shown when syllabus dates don't match current year */}
                          {item.status === "pending" && item.needsYearConfirm && item.pickedYear === undefined && (
                            <div className="px-4 pb-3 border-t border-blue-100 bg-blue-50/60">
                              <p className="text-xs text-blue-700 font-medium mt-2 mb-2">
                                📅 Dates in this syllabus appear to be for{" "}
                                <span className="font-bold">{item.needsYearConfirm.detectedYear}</span>,
                                not {item.needsYearConfirm.nowYear}. Which year is correct?
                              </p>
                              <div className="flex flex-wrap gap-2">
                                <button
                                  onClick={() => setBulkQueue((prev) =>
                                    prev.map((it, i) => i === idx ? { ...it, pickedYear: item.needsYearConfirm!.detectedYear } : it)
                                  )}
                                  className="rounded-xl border border-blue-300 bg-white px-3 py-1.5 text-xs font-bold text-blue-700 hover:bg-[var(--lifeos-pink)] hover:border-[var(--lifeos-pink)] hover:text-white transition-colors"
                                >
                                  ✓ {item.needsYearConfirm.detectedYear}
                                </button>
                                <button
                                  onClick={() => setBulkQueue((prev) =>
                                    prev.map((it, i) => i === idx ? { ...it, pickedYear: item.needsYearConfirm!.nowYear } : it)
                                  )}
                                  className="rounded-xl border border-blue-200 bg-white px-3 py-1.5 text-xs font-bold text-blue-600 hover:bg-black/[0.05] transition-colors"
                                >
                                  Use {item.needsYearConfirm.nowYear}
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Footer */}
            {!bulkDone && (() => {
              const pendingSectionPicks = bulkQueue.filter((it) => it.needsSection && !it.pickedSection);
              const pendingYearPicks = bulkQueue.filter((it) => it.needsYearConfirm && it.pickedYear === undefined);
              const allReady = pendingSectionPicks.length === 0 && pendingYearPicks.length === 0;
              return (
              <div className="px-6 py-4 border-t border-black/[0.05] shrink-0 space-y-2">
                {pendingSectionPicks.length > 0 && (
                  <p className="text-xs text-amber-600 font-medium text-center">
                    ⚠ Pick a section for {pendingSectionPicks.length} course{pendingSectionPicks.length !== 1 ? "s" : ""} above before importing
                  </p>
                )}
                {pendingYearPicks.length > 0 && (
                  <p className="text-xs text-blue-600 font-medium text-center">
                    📅 Confirm the year for {pendingYearPicks.length} syllab{pendingYearPicks.length !== 1 ? "i" : "us"} above before importing
                  </p>
                )}
                <button
                  onClick={() => void runBulkImport()}
                  disabled={bulkQueue.length === 0 || bulkRunning || bulkScanning || !allReady}
                  className="w-full rounded-2xl bg-[var(--lifeos-pink)] px-5 py-3.5 text-sm font-bold text-white shadow-[0_2px_10px_rgba(255,107,107,0.3)] hover:shadow-[0_4px_18px_rgba(255,107,107,0.4)] hover:scale-[1.01] active:scale-[0.99] transition-all disabled:opacity-40 disabled:shadow-none disabled:scale-100"
                >
                  {bulkRunning
                    ? `Importing ${bulkQueue.findIndex((it) => it.status === "processing") + 1} of ${bulkQueue.length}…`
                    : bulkScanning
                    ? "Scanning files…"
                    : `Import ${bulkQueue.length > 0 ? `all ${bulkQueue.length} ` : ""}syllab${bulkQueue.length === 1 ? "us" : "i"}`}
                </button>
              </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* Plan confirmation modal */}
      {planPreview ? (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm p-0 sm:p-4">
          <div className="w-full sm:max-w-xl rounded-t-3xl sm:rounded-3xl bg-white shadow-[0_24px_64px_rgba(0,0,0,0.18)] overflow-hidden">
            {/* Accent bar */}
            <div className="h-0.5 w-full bg-gradient-to-r from-[var(--lifeos-pink)] via-[var(--lifeos-pink)]/50 to-transparent" />
            {/* Header */}
            {(() => {
              const isDayPlan = (pendingHistory?.input ?? "").startsWith("Plan my whole day today.");
              return (
                <div className="px-6 pt-5 pb-4 border-b border-black/[0.05]">
                  <div className="flex items-center gap-2">
                    <div className="h-7 w-7 rounded-lg bg-[var(--lifeos-pink)]/10 flex items-center justify-center flex-shrink-0">
                      <svg viewBox="0 0 24 24" fill="none" stroke="var(--lifeos-pink)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                        <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
                      </svg>
                    </div>
                    <div className="text-[17px] font-extrabold text-black" style={{ letterSpacing: "-0.025em" }}>
                      {isDayPlan ? "Your day, planned ✨" : "Review plan"}
                    </div>
                  </div>
                  <div className="mt-1.5 text-[13px] text-black/40 font-medium">
                    {isDayPlan
                      ? "Here's your full day — adjust any block before adding to your calendar."
                      : "Tap the pencil to adjust any date or time before adding."}
                  </div>
                </div>
              );
            })()}

            {/* Block list */}
            <div className="max-h-[52vh] overflow-y-auto divide-y divide-black/[0.05]">
              {planPreview.proposed.length === 0 ? (
                <div className="p-6 text-sm text-black/50 text-center">No calendar items detected in this plan.</div>
              ) : (
                planPreview.proposed.map((b, i) => {
                  const isExpanded = planExpandedRow === i;
                  const isKept = !!planKeep[i];
                  const title = planTitles[i] ?? b.title;
                  const date = planDates[i] ?? b.date;
                  const startMin = planStarts[i] ?? b.startMin;
                  const endMin = planEnds[i] ?? b.endMin;

                  // Format helpers
                  const toHHMM = (m: number) =>
                    `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
                  const from12h = (m: number) => {
                    const h = Math.floor(m / 60); const min = m % 60;
                    const ampm = h < 12 ? "AM" : "PM";
                    const h12 = h % 12 || 12;
                    return `${h12}:${String(min).padStart(2, "0")} ${ampm}`;
                  };
                  const parseHHMM = (s: string) => {
                    const [h, m] = s.split(":").map(Number);
                    return (h || 0) * 60 + (m || 0);
                  };

                  const dateLabel = (() => {
                    const today = localDateISO(new Date());
                    const tom = (() => { const t = new Date(); t.setDate(t.getDate() + 1); return localDateISO(t); })();
                    if (date === today) return "Today";
                    if (date === tom) return "Tomorrow";
                    return new Date(`${date}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
                  })();

                  return (
                    <div key={b.id} className={`transition-colors ${!isKept ? "opacity-40" : ""}`}>
                      {/* Main row */}
                      <div className="flex items-start gap-3 px-4 py-3.5">
                        {/* Checkbox */}
                        <input
                          type="checkbox"
                          className="mt-1 h-4 w-4 accent-[var(--lifeos-pink)] cursor-pointer flex-shrink-0"
                          checked={isKept}
                          onChange={() => setPlanKeep((prev) => ({ ...prev, [i]: !prev[i] }))}
                        />

                        {/* Title + meta */}
                        <div className="flex-1 min-w-0">
                          <input
                            value={title}
                            onChange={(e) => setPlanTitles((prev) => ({ ...prev, [i]: e.target.value }))}
                            disabled={!isKept}
                            className="w-full bg-transparent text-sm font-semibold text-black/90 outline-none placeholder:text-black/25 border-b border-transparent focus:border-black/10 transition-colors pb-0.5"
                            placeholder="Event title"
                          />
                          <div className="mt-1 text-[11px] text-black/40 font-medium">
                            {dateLabel} · {from12h(startMin)}–{from12h(endMin)}
                          </div>
                        </div>

                        {/* Edit toggle */}
                        <button
                          onClick={() => setPlanExpandedRow(isExpanded ? null : i)}
                          disabled={!isKept}
                          className={`flex-shrink-0 mt-0.5 h-7 w-7 rounded-lg flex items-center justify-center transition-all ${isExpanded ? "bg-[var(--lifeos-pink)]/10 text-[var(--lifeos-pink)]" : "text-black/25 hover:text-black/50 hover:bg-black/[0.04]"}`}
                          title="Edit date & time"
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                          </svg>
                        </button>

                        {/* Rate */}
                        <button
                          onClick={() => { setFeedbackTarget({ block: b, prompt: input }); setFeedbackOpen(true); }}
                          className="flex-shrink-0 mt-0.5 h-7 w-7 rounded-lg flex items-center justify-center text-black/20 hover:text-[var(--lifeos-pink)] hover:bg-[var(--lifeos-pink)]/5 transition-all"
                          title="Rate this block"
                        >
                          <span className="text-xs">✦</span>
                        </button>
                      </div>

                      {/* Expanded editor — animated */}
                      <AnimatePresence>
                      {isExpanded && isKept && (
                        <motion.div
                          key="expand"
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.18, ease: "easeInOut" }}
                          className="overflow-hidden"
                        >
                        <div className="px-4 pb-4 pt-3 bg-black/[0.015] border-t border-black/[0.04]">
                          <div className="grid grid-cols-3 gap-2">
                            <div className="col-span-3">
                              <label className="text-[10px] font-bold uppercase tracking-widest text-black/30 block mb-1.5">Date</label>
                              <input
                                type="date"
                                value={date}
                                onChange={(e) => setPlanDates((prev) => ({ ...prev, [i]: e.target.value }))}
                                className="w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-sm font-medium text-black outline-none focus:border-[var(--lifeos-pink)] transition-colors"
                              />
                            </div>
                            <div>
                              <label className="text-[10px] font-bold uppercase tracking-widest text-black/30 block mb-1.5">Start</label>
                              <input
                                type="time"
                                value={toHHMM(startMin)}
                                onChange={(e) => setPlanStarts((prev) => ({ ...prev, [i]: parseHHMM(e.target.value) }))}
                                className="w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-sm font-medium text-black outline-none focus:border-[var(--lifeos-pink)] transition-colors"
                              />
                            </div>
                            <div>
                              <label className="text-[10px] font-bold uppercase tracking-widest text-black/30 block mb-1.5">End</label>
                              <input
                                type="time"
                                value={toHHMM(endMin)}
                                onChange={(e) => setPlanEnds((prev) => ({ ...prev, [i]: parseHHMM(e.target.value) }))}
                                className="w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-sm font-medium text-black outline-none focus:border-[var(--lifeos-pink)] transition-colors"
                              />
                            </div>
                            <div className="flex items-end">
                              <button
                                onClick={() => setPlanExpandedRow(null)}
                                className="w-full rounded-xl bg-[var(--lifeos-pink)]/10 text-[var(--lifeos-pink)] px-3 py-2 text-xs font-bold hover:bg-[var(--lifeos-pink)]/20 transition-colors"
                              >
                                Done ✓
                              </button>
                            </div>
                          </div>
                        </div>
                        </motion.div>
                      )}
                      </AnimatePresence>
                    </div>
                  );
                })
              )}
            </div>

            {/* Ambiguities banner — shown when confidence < 0.75 or ambiguities exist */}
            {(() => {
              const planData = pendingHistory?.plan as any;
              const ambiguities: string[] = Array.isArray(planData?.ambiguities) ? planData.ambiguities.filter((s: any) => typeof s === "string" && s.trim()) : [];
              const confidence: number | undefined = typeof planData?.confidence === "number" ? planData.confidence : undefined;
              if (ambiguities.length === 0 && (confidence === undefined || confidence >= 0.8)) return null;
              return (
                <div className="mx-4 mb-3 mt-1 rounded-xl bg-amber-50 border border-amber-200/80 px-3.5 py-2.5">
                  <div className="flex items-center gap-1.5 mb-1">
                    <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5 text-amber-500 flex-shrink-0">
                      <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd"/>
                    </svg>
                    <span className="text-[11px] font-bold text-amber-700">
                      {confidence !== undefined && confidence < 0.6 ? "Low confidence — please verify" : "I made some guesses"}
                    </span>
                  </div>
                  {ambiguities.length > 0 && (
                    <ul className="space-y-0.5">
                      {ambiguities.slice(0, 4).map((a, idx) => (
                        <li key={idx} className="text-[11px] text-amber-700/80 leading-snug">• {a}</li>
                      ))}
                    </ul>
                  )}
                  <p className="mt-1 text-[10px] text-amber-600/70">Tap the pencil icon on any block to correct date or time.</p>
                </div>
              );
            })()}

            {/* Footer */}
            <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-black/[0.05]">
              <span className="text-xs text-black/30 font-medium">
                {Object.values(planKeep).filter(Boolean).length} of {planPreview.proposed.length} selected
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setPlanPreview(null);
                    setPendingHistory(null);
                    setPlanDates({});
                    setPlanStarts({});
                    setPlanEnds({});
                    setPlanExpandedRow(null);
                  }}
                  className="rounded-xl border border-black/[0.08] bg-white px-4 py-2 text-sm font-semibold text-black/60 hover:bg-black/[0.04] transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmPlanImport}
                  className="rounded-xl bg-[var(--lifeos-pink)] px-5 py-2 text-sm font-bold text-white shadow-[0_2px_8px_rgba(217,108,125,0.3)] hover:shadow-[0_4px_16px_rgba(217,108,125,0.4)] hover:scale-[1.02] active:scale-[0.98] transition-all"
                >
                  Add to Calendar
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── Settings Modal ── */}
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={() => setSettingsOpen(false)}
      />

      {/* ── Feedback Modal ── */}
      {/* ── Day Plan Modal ── */}
      <DayPlanModal
        open={dayPlanModalOpen}
        prefs={dayPlanPrefs}
        onPrefsChange={(partial) => setDayPlanPrefs((prev) => ({ ...prev, ...partial }))}
        onBuildMyDay={handleBuildMyDay}
        onClose={() => setDayPlanModalOpen(false)}
      />

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
