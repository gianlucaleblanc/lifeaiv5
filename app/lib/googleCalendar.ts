// ─────────────────────────────────────────────────────────────
// OpenHour Web — Google Calendar OAuth + API client  (Phase 6a)
// Web OAuth uses standard authorization_code + PKCE flow
// Tokens stored in localStorage (browser-side only, never server)
// ─────────────────────────────────────────────────────────────

// ── Config ────────────────────────────────────────────────────

const GOOGLE_CLIENT_ID =
  process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "openid",
  "email",
  "profile",
].join(" ");

const GCAL_BASE = "https://www.googleapis.com/calendar/v3";

// ── Storage keys ──────────────────────────────────────────────

const KEYS = {
  accessToken: "openhour_gcal_access_token",
  refreshToken: "openhour_gcal_refresh_token",
  expiresAt: "openhour_gcal_expires_at",
  connected: "openhour_gcal_connected",
  codeVerifier: "openhour_gcal_code_verifier",
  eventsCache: "openhour_gcal_events_cache",
  eventsCacheDate: "openhour_gcal_events_cache_date",
};

// ── Types ──────────────────────────────────────────────────────

export interface GoogleCalendarEvent {
  id: string;
  title: string;
  startTime: string;   // ISO
  endTime: string;     // ISO
  date: string;        // YYYY-MM-DD
  startMin: number;    // minutes from midnight
  endMin: number;
  calendarId?: string;
  calendarName?: string;
  color?: string;
  description?: string;
  location?: string;
  isAllDay?: boolean;
  isGoogle: true;
}

interface GoogleTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

// ── PKCE helpers ───────────────────────────────────────────────

function generateRandomString(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const arr = new Uint8Array(length);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((x) => chars[x % chars.length]).join("");
}

async function sha256(plain: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  return crypto.subtle.digest("SHA-256", data);
}

function base64URLEncode(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function generatePKCE(): Promise<{ codeVerifier: string; codeChallenge: string }> {
  const codeVerifier = generateRandomString(64);
  const hashed = await sha256(codeVerifier);
  const codeChallenge = base64URLEncode(hashed);
  return { codeVerifier, codeChallenge };
}

// ── Token storage ──────────────────────────────────────────────

export function getGoogleTokens(): GoogleTokens | null {
  if (typeof window === "undefined") return null;
  try {
    const access = localStorage.getItem(KEYS.accessToken);
    const expiresAtStr = localStorage.getItem(KEYS.expiresAt);
    if (!access || !expiresAtStr) return null;
    return {
      accessToken: access,
      refreshToken: localStorage.getItem(KEYS.refreshToken) ?? undefined,
      expiresAt: parseInt(expiresAtStr, 10),
    };
  } catch {
    return null;
  }
}

function saveGoogleTokens(tokens: GoogleTokens): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(KEYS.accessToken, tokens.accessToken);
  localStorage.setItem(KEYS.expiresAt, tokens.expiresAt.toString());
  localStorage.setItem(KEYS.connected, "true");
  if (tokens.refreshToken) {
    localStorage.setItem(KEYS.refreshToken, tokens.refreshToken);
  }
}

export function clearGoogleTokens(): void {
  if (typeof window === "undefined") return;
  [KEYS.accessToken, KEYS.refreshToken, KEYS.expiresAt, KEYS.connected,
   KEYS.eventsCache, KEYS.eventsCacheDate].forEach((k) => localStorage.removeItem(k));
}

export function isGoogleCalendarConnected(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(KEYS.connected) === "true";
}

// ── Token refresh ──────────────────────────────────────────────

async function refreshAccessToken(refreshToken: string): Promise<GoogleTokens | null> {
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }).toString(),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const tokens: GoogleTokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    };
    saveGoogleTokens(tokens);
    return tokens;
  } catch {
    return null;
  }
}

// ── Get valid access token (auto-refreshes if expired) ─────────

export async function getValidAccessToken(): Promise<string | null> {
  const tokens = getGoogleTokens();
  if (!tokens) return null;

  if (tokens.expiresAt - Date.now() > 2 * 60_000) {
    return tokens.accessToken;
  }

  if (tokens.refreshToken) {
    const refreshed = await refreshAccessToken(tokens.refreshToken);
    return refreshed?.accessToken ?? null;
  }

  return null;
}

// ── OAuth sign-in ──────────────────────────────────────────────

/**
 * Redirects the user to Google OAuth consent screen.
 * Call this from a button click handler.
 */
export async function signInWithGoogleCalendar(): Promise<void> {
  if (!GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID === "REPLACE_WITH_GOOGLE_CLIENT_ID") {
    console.error("[GoogleCalendar] NEXT_PUBLIC_GOOGLE_CLIENT_ID is not set");
    return;
  }

  const { codeVerifier, codeChallenge } = await generatePKCE();
  const state = generateRandomString(32);

  // Save verifier + state for the callback to use
  localStorage.setItem(KEYS.codeVerifier, codeVerifier);
  localStorage.setItem("openhour_gcal_oauth_state", state);

  const redirectUri = `${window.location.origin}/api/auth/google-calendar/callback`;

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    access_type: "offline",
    prompt: "consent",
  });

  window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

/**
 * Exchange the authorization code for tokens.
 * Called from the OAuth callback route.
 */
export async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  redirectUri: string
): Promise<boolean> {
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        code_verifier: codeVerifier,
      }).toString(),
    });

    if (!res.ok) {
      console.error("[GoogleCalendar] Token exchange failed:", await res.text());
      return false;
    }

    const data = await res.json();
    const tokens: GoogleTokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    };
    saveGoogleTokens(tokens);
    return true;
  } catch (e) {
    console.error("[GoogleCalendar] Token exchange error:", e);
    return false;
  }
}

/**
 * Sign out from Google Calendar — revokes token and clears storage.
 */
export async function signOutGoogleCalendar(): Promise<void> {
  const tokens = getGoogleTokens();
  if (tokens?.accessToken) {
    fetch(`https://oauth2.googleapis.com/revoke?token=${tokens.accessToken}`).catch(() => {});
  }
  clearGoogleTokens();
}

// ── Google Calendar API ────────────────────────────────────────

async function fetchCalendars(): Promise<
  { id: string; summary: string; backgroundColor: string; primary?: boolean }[]
> {
  const token = await getValidAccessToken();
  if (!token) return [];

  try {
    const res = await fetch(`${GCAL_BASE}/users/me/calendarList`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.items ?? []).map((c: Record<string, unknown>) => ({
      id: c.id as string,
      summary: (c.summary as string) ?? "Untitled",
      backgroundColor: (c.backgroundColor as string) ?? "#e5e7eb",
      primary: c.primary as boolean | undefined,
    }));
  } catch {
    return [];
  }
}

/**
 * Fetch events from all Google Calendars for a date range.
 * Returns events formatted for the OpenHour calendar grid.
 */
export async function fetchGoogleCalendarEvents(
  startDate: Date,
  endDate: Date
): Promise<GoogleCalendarEvent[]> {
  const token = await getValidAccessToken();
  if (!token) return [];

  try {
    const calendars = await fetchCalendars();
    if (calendars.length === 0) return [];

    const allEvents: GoogleCalendarEvent[] = [];

    await Promise.all(
      calendars.map(async (cal) => {
        try {
          const params = new URLSearchParams({
            timeMin: startDate.toISOString(),
            timeMax: endDate.toISOString(),
            singleEvents: "true",
            orderBy: "startTime",
            maxResults: "250",
          });

          const res = await fetch(
            `${GCAL_BASE}/calendars/${encodeURIComponent(cal.id)}/events?${params}`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          if (!res.ok) return;

          const data = await res.json();

          for (const e of data.items ?? []) {
            const startStr: string = e.start?.dateTime ?? e.start?.date ?? "";
            const endStr: string = e.end?.dateTime ?? e.end?.date ?? "";
            if (!startStr || !endStr) continue;

            const isAllDay = !e.start?.dateTime;

            const startISO = startStr.includes("T") ? startStr : `${startStr}T00:00:00`;
            const endISO = endStr.includes("T") ? endStr : `${endStr}T23:59:59`;

            const startDt = new Date(startISO);
            const endDt = new Date(endISO);

            // Convert to YYYY-MM-DD + minutes from midnight for the grid
            const dateStr = isoDateLocal(startDt);
            const startMin = startDt.getHours() * 60 + startDt.getMinutes();
            const endMin = endDt.getHours() * 60 + endDt.getMinutes();

            const color = e.colorId
              ? GOOGLE_EVENT_COLORS[e.colorId] ?? cal.backgroundColor
              : cal.backgroundColor;

            allEvents.push({
              id: `gcal_${e.id}`,
              title: e.summary ?? "Untitled",
              startTime: startISO,
              endTime: endISO,
              date: dateStr,
              startMin: isAllDay ? 0 : startMin,
              endMin: isAllDay ? 24 * 60 : Math.max(endMin, startMin + 15),
              calendarId: cal.id,
              calendarName: cal.summary,
              color,
              description: e.description,
              location: e.location,
              isAllDay,
              isGoogle: true as const,
            });
          }
        } catch {
          // best-effort per calendar
        }
      })
    );

    return allEvents;
  } catch {
    return [];
  }
}

/**
 * Fetch Google Calendar events for a week (7 days starting from weekStart).
 * Caches results in localStorage keyed by the week start date.
 */
export async function fetchGoogleEventsForWeek(
  weekStart: Date
): Promise<GoogleCalendarEvent[]> {
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);
  weekEnd.setHours(23, 59, 59, 999);

  const cacheKey = isoDateLocal(weekStart);

  // Return cache immediately if same week
  try {
    const cachedKey = localStorage.getItem(KEYS.eventsCacheDate);
    if (cachedKey === cacheKey) {
      const raw = localStorage.getItem(KEYS.eventsCache);
      if (raw) return JSON.parse(raw) as GoogleCalendarEvent[];
    }
  } catch { /* ignore */ }

  const events = await fetchGoogleCalendarEvents(weekStart, weekEnd);

  // Cache it
  try {
    localStorage.setItem(KEYS.eventsCacheDate, cacheKey);
    localStorage.setItem(KEYS.eventsCache, JSON.stringify(events));
  } catch { /* ignore */ }

  return events;
}

/**
 * Fetch Google Calendar events for today only.
 * Used to inject context into the AI planner.
 */
export async function fetchTodayGoogleEvents(): Promise<GoogleCalendarEvent[]> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return fetchGoogleCalendarEvents(start, end);
}

// ── Helpers ────────────────────────────────────────────────────

function isoDateLocal(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const iso = `${get("year")}-${get("month")}-${get("day")}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : d.toISOString().slice(0, 10);
}

/**
 * Create an event in the user's primary Google Calendar.
 * Returns the Google event ID on success, null on failure.
 * Fire-and-forget safe — errors are non-fatal.
 */
export async function createGoogleCalendarEvent(event: {
  title: string;
  startTime: string; // ISO
  endTime: string;   // ISO
  description?: string;
}): Promise<string | null> {
  const token = await getValidAccessToken();
  if (!token) return null;
  try {
    const res = await fetch(`${GCAL_BASE}/calendars/primary/events`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        summary: event.title,
        start: { dateTime: event.startTime },
        end: { dateTime: event.endTime },
        description: event.description ?? "",
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.id as string ?? null;
  } catch {
    return null;
  }
}

/**
 * Delete an event from a Google Calendar.
 * Strips "gcal_" prefix from event IDs if present.
 * Returns true on success or if already gone (404).
 */
export async function deleteGoogleCalendarEvent(
  calendarId: string,
  eventId: string
): Promise<boolean> {
  const token = await getValidAccessToken();
  if (!token) return false;
  // Strip our "gcal_" prefix to get the real Google event ID
  const realId = eventId.startsWith("gcal_") ? eventId.slice(5) : eventId;
  try {
    const res = await fetch(
      `${GCAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(realId)}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }
    );
    return res.ok || res.status === 204 || res.status === 404;
  } catch {
    return false;
  }
}

// Google event color map (colorId → hex)
const GOOGLE_EVENT_COLORS: Record<string, string> = {
  "1": "#a4bdfc",  // Lavender
  "2": "#7ae7bf",  // Sage
  "3": "#dbadff",  // Grape
  "4": "#ff887c",  // Flamingo
  "5": "#fbd75b",  // Banana
  "6": "#ffb878",  // Tangerine
  "7": "#46d6db",  // Peacock
  "8": "#e1e1e1",  // Graphite
  "9": "#5484ed",  // Blueberry
  "10": "#51b749", // Basil
  "11": "#dc2127", // Tomato
};
