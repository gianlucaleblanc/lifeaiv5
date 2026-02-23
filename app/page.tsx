"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  addSyllabusEventsToCalendar,
  addToHistory,
  loadCalendar,
  saveCalendar,
  loadCustomEventKeywords,
  addCustomEventKeyword,
  applyApprovedPlanBlocks,
  previewCalendarFromHistory,
  type CalendarBlock,
  type CalendarMergePreview,
  type HistoryItem,
  type Plan,
  type SyllabusEvent,
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
  const m3 = t.match(/\b(\d{3,4})\s*(am|pm)?\b/);
  if (m3 && !/\d{5}/.test(m3[0])) {
    const num = m3[1];
    const ap = m3[2] ?? "";
    if (num.length === 3) {
      let h = parseInt(num[0], 10);
      const mi = parseInt(num.substring(1), 10);
      if (ap === "pm" && h < 12) h += 12;
      if (ap === "am" && h === 12) h = 0;
      if (h >= 0 && h <= 24 && mi >= 0 && mi <= 59) {
        if (!ap) return normalizeTimeGuess(h, mi, t);
        return { hour: h, minute: mi };
      }
    } else if (num.length === 4) {
      let h = parseInt(num.substring(0, 2), 10);
      const mi = parseInt(num.substring(2), 10);
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

  if (/\btoday\b/.test(t)) return localDateISO(now);
  if (/\btomorrow\b/.test(t)) return addLocalDays(now, 1);

  // "next week" (no specific day) → next Monday
  if (/\bnext\s+week\b/i.test(t) && !/\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(t)) {
    const dow = now.getDay(); // 0=Sun … 6=Sat
    const daysToNextMon = dow === 1 ? 7 : (8 - dow) % 7 || 7;
    return addLocalDays(now, daysToNextMon);
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

function findNextAvailableSlot(blocks: any[], durationMin: number, startDateISO: string, lookaheadDays = 14) {
  const dur = clampMinutes(durationMin);
  const dayStart = 8 * 60;
  const dayEnd = 22 * 60;
  const step = 5;

  // Parse as local midnight so date arithmetic stays in local time.
  const startDate = new Date(startDateISO + "T00:00:00");
  for (let d = 0; d < lookaheadDays; d++) {
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
}: {
  open: boolean;
  eventTitle?: string;
  eventContext?: string;
  suggestions: SuggestedBlock[];
  keep: Record<number, boolean>;
  setKeep: (v: Record<number, boolean>) => void;
  onClose: () => void;
  onConfirm: () => void;
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
            <label
              key={`${s.date}-${s.title}-${i}`}
              className="flex items-start gap-3 p-4 border-b border-black/5 last:border-b-0 cursor-pointer hover:bg-black/[0.02] transition-colors"
            >
              <input
                type="checkbox"
                className="mt-1 accent-[var(--lifeos-pink,#ff6b6b)]"
                checked={!!keep[i]}
                onChange={() => setKeep({ ...keep, [i]: !keep[i] })}
              />
              <div className="flex-1">
                <div className="font-semibold text-sm text-black/90">{s.title}</div>
                <div className="text-xs text-black/50 mt-0.5">
                  {friendlyDate(s.date)} · {minutesToTime(s.startMin)}–{minutesToTime(s.endMin)}
                  {s.kind && s.kind !== "reminder" ? ` · ${s.kind}` : ""}
                </div>
                {s.reason ? (
                  <div className="text-xs text-black/40 mt-0.5 italic">{s.reason}</div>
                ) : null}
              </div>
            </label>
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
function MissingInfoModal({ open, onClose, onPickNext, onPickExact, eventTitle, prefillDate, prefillTime, prefillDuration, hideNextAvailable }: any) {
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

  const totalMinutes = clampMinutes(durationHours * 60 + durationMins);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-3xl p-6 w-full max-w-md shadow-2xl border border-black/5">
        <h2 className="text-xl font-extrabold text-black mb-1" style={{ letterSpacing: "-0.02em" }}>
          {hideNextAvailable ? "What time should I schedule this?" : "When should I schedule this?"}
        </h2>
        {eventTitle && (
          <p className="text-sm text-[var(--lifeos-pink,#ff6b6b)] font-semibold mb-1">{eventTitle}</p>
        )}
        <p className="text-sm text-black/50 mb-5">
          {hideNextAvailable ? "Pick a date and time — I'll keep your duration." : "I'm missing a few details to add this to your calendar."}
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
                  onChange={(e) => setDate(e.target.value)}
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

            <button
              onClick={() => onPickExact(date, time, totalMinutes)}
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

    const slot = findNextAvailableSlot(blocks, dur, startDateISO, (isNextWeek || isNextWeekday) ? 7 : 14);
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

  async function generate() {
    setLoading(true);
    setError(null);

    // If a file is attached, route to syllabus upload with the current input as instructions
    if (pendingFile) {
      const fileToUpload = pendingFile;
      setPendingFile(null); // clear attachment immediately for UX
      setLoading(false);
      await onUploadSyllabus(fileToUpload);
      return;
    }

    try {
      // Detect explicit planning requests
      const looksLikePlanningRequest = /\b(plan\s+my\s+(?:day|week)|make\s+(?:me\s+)?a\s+plan|build\s+(?:me\s+)?(?:a\s+)?schedule|create\s+(?:me\s+)?(?:a\s+)?schedule|organize\s+my\s+(?:day|week)|routine|agenda|help\s+me\s+with\s+my\s+day)\b/i.test(input);

      // Detect simple activity lists (multiple activities)
      const looksLikeSimpleActivityList = !looksLikePlanningRequest &&
        /\b(want|need|have)\s+to\s+(\w+)(?:\s*,\s*\w+)+(?:\s+and\s+\w+)?\b/i.test(input) &&
        !/(essay|project|paper|assignment|deadline|exam|study|prepare|organize|work on)/i.test(input);

      if (!looksLikeSimpleActivityList && !looksLikePlanningRequest) {
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
            return;
          }

          const needsWhen = !dateIso &&
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

          // Ask for time if:
          // - No time was parsed, AND
          // - Not a flexible/vague phrase ("next available", "sometime", "next week"), AND
          // - A specific date was mentioned (tomorrow, next tuesday, monday, etc.)
          //   OR the event context always requires an exact time (flight, interview, etc.)
          //
          // Rule of thumb: if the user pinned the event to a specific day, they almost
          // certainly have a time in mind — always ask.  Only skip the prompt when the
          // user explicitly said "next available" / "sometime" / bare "next week".
          const needsTime = !timeHM &&
            !isFlexible &&
            (!!dateIso || requiresExactTime(input));

          if (needsWhen || needsTime) {
            // Store rawInput so modal handlers can pass the original prompt to the
            // suggestions API even after setInput("") has cleared the textarea.
            // requiresTime=true hides the "next available" button so users must
            // pick an exact time (e.g. "run for 2 hours tomorrow" — date known, time not).
            setPendingQuickEvent({ title, dateIso, timeHM, durationMin, rawInput: input, requiresTime: needsTime && !needsWhen });
            setMissingInfoOpen(true);
            setLoading(false);
            return;
          }

          const ok = scheduleQuickEvent({ title, dateIso, timeHM, durationMin });
          if (!ok) {
            setError("I couldn't find an available time slot. Try a shorter duration or a specific day/time.");
          } else {
            setInput("");
          }
          setLoading(false);
          return;
        }
      }

      // Fall through to planning API
      const res = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input }),
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
          body: JSON.stringify({ input, anchors }),
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

  async function onUploadSyllabus(file: File, yearOverride?: number) {
    setSyllabusLoading(true);
    setSyllabusError(null);
    setSyllabusEvents(null);
    setSyllabusKeep({});
    setSyllabusMeta(null);
    setYearConfirm(null);
    setSyllabusFile(file);

    try {
      const fd = new FormData();
      fd.append("file", file);
      if (typeof yearOverride === "number" && Number.isFinite(yearOverride)) {
        fd.append("yearOverride", String(yearOverride));
      }
      if (input.trim()) fd.append("instructions", input.trim());

      const res = await fetch("/api/import-syllabus", {
        method: "POST",
        body: fd,
      });

      const data = (await res.json()) as { events?: SyllabusEvent[]; meta?: any; error?: string };
      if (!res.ok) throw new Error(data?.error ?? "Upload failed");

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
    const result = addSyllabusEventsToCalendar(selected);
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
      if (first) window.localStorage.setItem("lifeos_calendar_cursor_v1", first);
    } catch {
      // ignore
    }
    setSyllabusEvents(null);
    router.push("/calendar");
  }

  return (
    <div className="min-h-[calc(100vh-220px)] flex flex-col items-center justify-center text-center">
      <h1 className="text-2xl sm:text-3xl font-extrabold text-black" style={{ letterSpacing: "-0.02em" }}>
        What does your day look like today?
      </h1>

      <div className="mt-10 w-full max-w-3xl">
        {/* File attachment chip — shown above textarea when a file is attached */}
        {pendingFile && (
          <div className="mb-3 flex items-center justify-center">
            <div className="inline-flex items-center gap-2 rounded-full bg-white border border-[var(--lifeos-border)] px-4 py-2 shadow-sm text-sm font-semibold text-black/80">
              <span className="text-base">📎</span>
              <span className="max-w-[260px] truncate">{pendingFile.name}</span>
              <button
                onClick={() => setPendingFile(null)}
                className="ml-1 text-black/30 hover:text-black/70 transition-colors font-bold text-base leading-none"
                aria-label="Remove attachment"
              >
                ✕
              </button>
            </div>
          </div>
        )}

        <div className="relative">
          <textarea
            className="w-full resize-none rounded-[999px] bg-[var(--lifeos-pink)] px-10 py-10 text-center text-2xl sm:text-4xl font-extrabold text-white placeholder:text-white/70 outline-none shadow-sm"
            rows={2}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && canGenerate) {
                e.preventDefault();
                generate();
              }
            }}
            placeholder={pendingFile ? `Instructions for ${pendingFile.name}… (optional)` : "Today I want to swim, run and jump"}
          />

          {/* Paperclip attach button — bottom-right of textarea */}
          <label
            className="absolute bottom-4 right-6 flex h-9 w-9 cursor-pointer items-center justify-center rounded-full bg-white/20 text-white hover:bg-white/30 transition-colors"
            title="Attach a file (syllabus, PDF, DOCX)"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66L9.41 17.41a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
            <input
              type="file"
              accept="application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx,application/msword"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) {
                  setPendingFile(f);
                  setSyllabusError(null);
                }
                e.currentTarget.value = "";
              }}
              disabled={syllabusLoading}
            />
          </label>
        </div>

        <div className="mt-8 flex items-center justify-center gap-4">
          <button
            onClick={generate}
            disabled={!canGenerate}
            className="rounded-full border border-[var(--lifeos-border)] bg-white px-8 py-3 text-base font-semibold text-black shadow-sm transition disabled:opacity-40"
          >
            {syllabusLoading ? "Reading…" : loading ? "Generating…" : pendingFile ? "Import file" : "Generate plan"}
          </button>
        </div>

        <p className="mt-4 text-sm text-black/60">
          {pendingFile
            ? "Add instructions above (e.g. \"I'm in Section B, include lectures and assignments\") then hit Import."
            : "Tip: attach a syllabus 📎 and type your instructions, or just describe your day."}
        </p>

        {suggestionsLoading && (
          <div className="mx-auto mt-6 flex items-center justify-center gap-3 text-sm text-black/50">
            <svg className="animate-spin h-4 w-4 text-[var(--lifeos-pink)]" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
            </svg>
            Finding smart suggestions…
          </div>
        )}

        {error && (
          <div className="mx-auto mt-4 w-full max-w-xl rounded-2xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {syllabusError && (
          <div className="mx-auto mt-4 w-full max-w-xl rounded-2xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {syllabusError}
          </div>
        )}

        <p className="mt-6 text-sm text-black/60">
          Tip: add constraints like "sleep by 9" or "free after 3pm".
        </p>
      </div>

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
      />

      {/* Missing Info Modal */}
      <MissingInfoModal
        key={missingInfoOpen ? `open-${pendingQuickEvent?.dateIso ?? ""}-${pendingQuickEvent?.timeHM?.hour ?? ""}` : "closed"}
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
        onClose={() => {
          setMissingInfoOpen(false);
          setPendingQuickEvent(null);
        }}
        onPickNext={(dur: number) => {
          const pe = pendingQuickEvent;
          if (!pe?.title) return;
          // Use the raw prompt saved when the modal was opened — never stale
          const capturedInput = pe.rawInput || pe.title;
          setMissingInfoOpen(false);
          setPendingQuickEvent(null);
          setInput("");
          const ok = scheduleQuickEvent({ title: pe.title, dateIso: pe.dateIso ?? null, timeHM: null, durationMin: dur, capturedInput });
          if (!ok) setError("I couldn't find an available time slot. Try a shorter duration or pick a specific time.");
        }}
        onPickExact={(date: string, time: string, dur: number) => {
          const pe = pendingQuickEvent;
          if (!pe?.title) return;
          const resolvedDate = date || pe?.dateIso || "";
          if (!resolvedDate) {
            setError("Please pick a date.");
            return;
          }
          // Use rawInput saved when modal opened — guaranteed to be the original prompt
          // regardless of whether setInput("") has already fired.
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
          setMissingInfoOpen(false);
          setPendingQuickEvent(null);
          setInput("");
          // Call scheduleAndMaybeSuggest AFTER closing modal and clearing state,
          // with the locked-in original prompt so suggestions fire correctly.
          void scheduleAndMaybeSuggest(block, capturedInput);
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

      {/* Year confirm modal for syllabus */}
      {yearConfirm && syllabusFile ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="w-full max-w-xl rounded-3xl border border-[var(--lifeos-border-soft)] bg-white p-6 text-left">
            <div className="text-lg font-extrabold text-black" style={{ letterSpacing: "-0.02em" }}>
              Confirm year
            </div>
            <p className="mt-2 text-sm text-black/70">
              This file looks like it belongs to{" "}
              <span className="font-semibold">{yearConfirm.detectedYear}</span>, but your current year is{" "}
              <span className="font-semibold">{yearConfirm.nowYear}</span>. Which year should I use for the dates?
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <button
                className="rounded-full border border-[var(--lifeos-border)] bg-white px-5 py-2 text-sm font-semibold text-black shadow-sm"
                onClick={() => {
                  setYearConfirm(null);
                  onUploadSyllabus(syllabusFile, yearConfirm.detectedYear);
                }}
              >
                Use {yearConfirm.detectedYear}
              </button>
              <button
                className="rounded-full bg-[var(--lifeos-pink)] px-5 py-2 text-sm font-semibold text-white shadow-sm"
                onClick={() => {
                  setYearConfirm(null);
                  onUploadSyllabus(syllabusFile, yearConfirm.nowYear);
                }}
              >
                Use {yearConfirm.nowYear}
              </button>
              <button
                className="rounded-full border border-[var(--lifeos-border)] bg-white px-5 py-2 text-sm font-semibold text-black/70"
                onClick={() => {
                  setYearConfirm(null);
                  setSyllabusLoading(false);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Syllabus import review modal */}
      {syllabusEvents ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="w-full max-w-2xl rounded-3xl border border-[var(--lifeos-border-soft)] bg-white p-6">
            <div className="text-lg font-extrabold text-black" style={{ letterSpacing: "-0.02em" }}>
              Import to calendar
            </div>
            <div className="mt-1 text-sm text-black/60">
              Review the extracted dates. Uncheck anything you don't want.
            </div>

            <div className="mt-5 max-h-[55vh] overflow-auto rounded-2xl border border-[var(--lifeos-border-soft)]">
              {syllabusEvents.length === 0 ? (
                <div className="p-4 text-sm text-black/70">No dated items found.</div>
              ) : (
                <div className="divide-y divide-black/5">
                  {syllabusEvents.map((e, i) => (
                    <label key={i} className="flex gap-3 p-4 text-left cursor-pointer">
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4"
                        checked={!!syllabusKeep[i]}
                        onChange={() => setSyllabusKeep((prev) => ({ ...prev, [i]: !prev[i] }))}
                      />
                      <div className="flex-1">
                        <div className="text-sm font-semibold text-black/90">{e.title || "Untitled"}</div>
                        <div className="mt-0.5 text-xs text-black/60">
                          {e.date}
                          {e.startTime ? ` · ${e.startTime}` : ""}
                          {e.endTime ? `–${e.endTime}` : ""}
                          {e.kind ? ` · ${e.kind}` : ""}
                        </div>
                        {e.source ? <div className="mt-1 text-[11px] text-black/45">{e.source}</div> : null}
                      </div>
                    </label>
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
                className="rounded-full bg-[var(--lifeos-pink)] px-5 py-2 text-sm font-semibold text-white"
              >
                Add to Calendar
              </button>
            </div>
          </div>
        </div>
      ) : null}

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
                        <div className="flex-1">
                          <input
                            value={planTitles[i] ?? b.title}
                            onChange={(e) => setPlanTitles((prev) => ({ ...prev, [i]: e.target.value }))}
                            className="w-full rounded-xl border border-[var(--lifeos-border-soft)] px-3 py-2 text-sm font-semibold text-black/90 outline-none"
                          />
                          <div className="mt-1 text-xs text-black/60">
                            {b.date} · {startH}:{startM}–{endH}:{endM}
                          </div>
                        </div>
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
    </div>
  );
}
