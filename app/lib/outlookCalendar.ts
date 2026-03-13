// ─────────────────────────────────────────────────────────────
// OpenHour Web — Outlook / Microsoft Graph Calendar  (Phase 6f)
// Web OAuth uses standard authorization_code + PKCE flow
// Tokens stored in localStorage (browser-side only, never server)
// Uses /me/calendarview to auto-expand recurring events
// ─────────────────────────────────────────────────────────────

// ── Config ────────────────────────────────────────────────────

const OUTLOOK_CLIENT_ID =
  process.env.NEXT_PUBLIC_OUTLOOK_CLIENT_ID ?? "";

const MSFT_TENANT = "common"; // multi-tenant + personal MSA accounts
const AUTHORITY = `https://login.microsoftonline.com/${MSFT_TENANT}/oauth2/v2.0`;
const AUTH_ENDPOINT = `${AUTHORITY}/authorize`;
const TOKEN_ENDPOINT = `${AUTHORITY}/token`;
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

const SCOPES = [
  "Calendars.Read",
  "offline_access",
  "openid",
  "profile",
  "email",
].join(" ");

// ── Storage keys ──────────────────────────────────────────────

const KEYS = {
  accessToken:     "openhour_outlook_access_token",
  refreshToken:    "openhour_outlook_refresh_token",
  expiresAt:       "openhour_outlook_expires_at",
  connected:       "openhour_outlook_connected",
  codeVerifier:    "openhour_outlook_code_verifier",
  oauthState:      "openhour_outlook_oauth_state",
  eventsCache:     "openhour_outlook_events_cache",
  eventsCacheDate: "openhour_outlook_events_cache_date",
};

// ── Types ──────────────────────────────────────────────────────

export interface OutlookCalendarEvent {
  id: string;
  title: string;
  startTime: string;   // ISO
  endTime: string;     // ISO
  date: string;        // YYYY-MM-DD (local timezone)
  startMin: number;    // minutes from midnight
  endMin: number;
  calendarName?: string;
  color?: string;      // hex; fallback "#0078d4" (Microsoft blue)
  description?: string;
  location?: string;
  isAllDay?: boolean;
  isOutlook: true;
}

interface OutlookTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // epoch ms
}

// ── PKCE helpers ───────────────────────────────────────────────
// Identical to googleCalendar.ts

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

function getOutlookTokens(): OutlookTokens | null {
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

function saveOutlookTokens(tokens: OutlookTokens): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(KEYS.accessToken, tokens.accessToken);
  localStorage.setItem(KEYS.expiresAt, tokens.expiresAt.toString());
  localStorage.setItem(KEYS.connected, "true");
  if (tokens.refreshToken) {
    localStorage.setItem(KEYS.refreshToken, tokens.refreshToken);
  }
}

export function clearOutlookTokens(): void {
  if (typeof window === "undefined") return;
  [KEYS.accessToken, KEYS.refreshToken, KEYS.expiresAt, KEYS.connected,
   KEYS.eventsCache, KEYS.eventsCacheDate].forEach((k) => localStorage.removeItem(k));
}

export function isOutlookCalendarConnected(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(KEYS.connected) === "true";
}

// ── Token refresh ──────────────────────────────────────────────

async function refreshAccessToken(refreshToken: string): Promise<OutlookTokens | null> {
  try {
    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: OUTLOOK_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        scope: SCOPES,
      }).toString(),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const tokens: OutlookTokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    };
    saveOutlookTokens(tokens);
    return tokens;
  } catch {
    return null;
  }
}

// ── Get valid access token (auto-refreshes if expired) ─────────

export async function getValidOutlookAccessToken(): Promise<string | null> {
  const tokens = getOutlookTokens();
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
 * Redirects the user to the Microsoft OAuth consent screen.
 * Call this from a button click handler.
 */
export async function signInWithOutlook(): Promise<void> {
  if (!OUTLOOK_CLIENT_ID) {
    console.error("[OutlookCalendar] NEXT_PUBLIC_OUTLOOK_CLIENT_ID is not set");
    return;
  }

  const { codeVerifier, codeChallenge } = await generatePKCE();
  const state = generateRandomString(32);

  // Save verifier + state for the callback to use
  localStorage.setItem(KEYS.codeVerifier, codeVerifier);
  localStorage.setItem(KEYS.oauthState, state);

  const redirectUri = `${window.location.origin}/api/auth/outlook/callback`;

  const params = new URLSearchParams({
    client_id: OUTLOOK_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    response_mode: "query",
  });

  window.location.href = `${AUTH_ENDPOINT}?${params}`;
}

/**
 * Exchange the authorization code for tokens.
 * Called from the calendar page after the OAuth redirect returns.
 */
export async function exchangeOutlookCodeForTokens(
  code: string,
  codeVerifier: string,
  redirectUri: string
): Promise<boolean> {
  try {
    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: OUTLOOK_CLIENT_ID,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        code_verifier: codeVerifier,
        scope: SCOPES,
      }).toString(),
    });

    if (!res.ok) {
      console.error("[OutlookCalendar] Token exchange failed:", await res.text());
      return false;
    }

    const data = await res.json();
    const tokens: OutlookTokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    };
    saveOutlookTokens(tokens);
    return true;
  } catch (e) {
    console.error("[OutlookCalendar] Token exchange error:", e);
    return false;
  }
}

/**
 * Sign out from Outlook Calendar — clears all stored tokens.
 * Microsoft doesn't support token revocation for public clients the same way Google does,
 * so we just clear local storage.
 */
export async function signOutOutlook(): Promise<void> {
  clearOutlookTokens();
}

// ── Microsoft Graph API ────────────────────────────────────────

/**
 * Fetch Outlook calendar events for a date range using /me/calendarview.
 * calendarview automatically expands recurring events — preferred over /me/events.
 */
export async function fetchOutlookCalendarEvents(
  startDate: Date,
  endDate: Date
): Promise<OutlookCalendarEvent[]> {
  const token = await getValidOutlookAccessToken();
  if (!token) return [];

  try {
    const params = new URLSearchParams({
      startDateTime: startDate.toISOString(),
      endDateTime: endDate.toISOString(),
      $top: "250",
      $select: "subject,start,end,isAllDay,categories,body,location,calendar",
      $orderby: "start/dateTime asc",
    });

    const res = await fetch(
      `${GRAPH_BASE}/me/calendarview?${params}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          // Required header for calendarview — tells Graph what timezone to use for date expansion
          Prefer: `outlook.timezone="UTC"`,
        },
      }
    );

    if (!res.ok) return [];

    const data = await res.json();
    const events: OutlookCalendarEvent[] = [];

    for (const e of data.value ?? []) {
      const startStr: string = e.start?.dateTime ?? "";
      const endStr: string = e.end?.dateTime ?? "";
      if (!startStr || !endStr) continue;

      const isAllDay = e.isAllDay === true;

      // Graph returns UTC when we send the Prefer: outlook.timezone="UTC" header
      const startISO = startStr.endsWith("Z") ? startStr : `${startStr}Z`;
      const endISO = endStr.endsWith("Z") ? endStr : `${endStr}Z`;

      const startDt = new Date(startISO);
      const endDt = new Date(endISO);

      const dateStr = isoDateLocal(startDt);
      const startMin = startDt.getHours() * 60 + startDt.getMinutes();
      const endMin = endDt.getHours() * 60 + endDt.getMinutes();

      // Map category color (first category wins; fallback to Microsoft blue)
      const firstCategory: string = e.categories?.[0] ?? "";
      const color = OUTLOOK_CATEGORY_COLORS[firstCategory] ?? "#0078d4";

      events.push({
        id: `outlook_${e.id as string}`,
        title: (e.subject as string) ?? "Untitled",
        startTime: startISO,
        endTime: endISO,
        date: dateStr,
        startMin: isAllDay ? 0 : startMin,
        endMin: isAllDay ? 24 * 60 : Math.max(endMin, startMin + 15),
        calendarName: (e.calendar?.name as string) ?? undefined,
        color,
        description: (e.body?.content as string) ?? undefined,
        location: (e.location?.displayName as string) ?? undefined,
        isAllDay,
        isOutlook: true as const,
      });
    }

    return events;
  } catch {
    return [];
  }
}

/**
 * Fetch Outlook events for a week (7 days starting from weekStart).
 * Caches results in localStorage keyed by the week start date.
 */
export async function fetchOutlookEventsForWeek(
  weekStart: Date
): Promise<OutlookCalendarEvent[]> {
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);
  weekEnd.setHours(23, 59, 59, 999);

  const cacheKey = isoDateLocal(weekStart);

  // Return cache immediately if same week
  try {
    const cachedKey = localStorage.getItem(KEYS.eventsCacheDate);
    if (cachedKey === cacheKey) {
      const raw = localStorage.getItem(KEYS.eventsCache);
      if (raw) return JSON.parse(raw) as OutlookCalendarEvent[];
    }
  } catch { /* ignore */ }

  const events = await fetchOutlookCalendarEvents(weekStart, weekEnd);

  // Cache it
  try {
    localStorage.setItem(KEYS.eventsCacheDate, cacheKey);
    localStorage.setItem(KEYS.eventsCache, JSON.stringify(events));
  } catch { /* ignore */ }

  return events;
}

/**
 * Fetch Outlook calendar events for today only.
 * Used to inject context into the AI planner + morning briefing.
 */
export async function fetchTodayOutlookEvents(): Promise<OutlookCalendarEvent[]> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return fetchOutlookCalendarEvents(start, end);
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

// ── Outlook category color map ─────────────────────────────────
// Maps Microsoft Outlook's built-in category names to hex colors

const OUTLOOK_CATEGORY_COLORS: Record<string, string> = {
  "Red category":    "#d13438",
  "Orange category": "#ca5010",
  "Brown category":  "#8e562e",
  "Yellow category": "#eaa300",
  "Green category":  "#107c10",
  "Teal category":   "#038387",
  "Cyan category":   "#0099bc",
  "Blue category":   "#0078d4",
  "Purple category": "#5c2d91",
  "Pink category":   "#e3008c",
  "Silver category": "#767676",
  // Short names (some Outlook versions omit " category")
  "Red":    "#d13438",
  "Orange": "#ca5010",
  "Brown":  "#8e562e",
  "Yellow": "#eaa300",
  "Green":  "#107c10",
  "Teal":   "#038387",
  "Cyan":   "#0099bc",
  "Blue":   "#0078d4",
  "Purple": "#5c2d91",
  "Pink":   "#e3008c",
  "Silver": "#767676",
};
