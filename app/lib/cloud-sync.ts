/**
 * cloud-sync.ts
 * Push / pull / merge between localStorage and Supabase user_data table.
 * All functions are fire-and-forget safe — errors are logged but never thrown
 * to callers, so the UI is never blocked by cloud failures.
 */

import { getSupabaseBrowserClient } from "./supabase";
import {
  loadCalendar,
  loadOnboardingProfile,
  loadPreferences,
  loadHistory,
  loadCustomEventKeywords,
  loadFeedback,
  loadProfile,
  saveCalendar,
  saveOnboardingProfile,
  savePreferences,
  saveHistory,
  saveCustomEventKeywords,
  saveFeedback,
  saveProfile,
} from "./storage";

import type {
  CalendarBlock,
  OnboardingProfile,
  UserPreferences,
  HistoryItem,
  FeedbackEntry,
  UserProfile,
} from "./storage";

// ── Types ─────────────────────────────────────────────────────────────────

type CloudField =
  | "calendar"
  | "onboarding"
  | "preferences"
  | "history"
  | "custom_keywords"
  | "feedback"
  | "profile_stats";

// ── Merge helpers ─────────────────────────────────────────────────────────

/** Union of two CalendarBlock arrays by id. Cloud blocks win on conflict. */
function mergeCalendar(
  local: CalendarBlock[],
  cloud: CalendarBlock[]
): CalendarBlock[] {
  const cloudIds = new Set(cloud.map((b) => b.id));
  const localOnly = local.filter((b) => !cloudIds.has(b.id));
  return [...cloud, ...localOnly];
}

/** Union of two HistoryItem arrays by id. Sorted newest-first, capped at 30. */
function mergeHistory(
  local: HistoryItem[],
  cloud: HistoryItem[]
): HistoryItem[] {
  const cloudIds = new Set(cloud.map((h) => h.id));
  const localOnly = local.filter((h) => !cloudIds.has(h.id));
  return [...cloud, ...localOnly]
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )
    .slice(0, 30);
}

/** Union of two FeedbackEntry arrays by id, capped at 200. */
function mergeFeedback(
  local: FeedbackEntry[],
  cloud: FeedbackEntry[]
): FeedbackEntry[] {
  const cloudIds = new Set(cloud.map((f) => f.id));
  const localOnly = local.filter((f) => !cloudIds.has(f.id));
  return [...cloud, ...localOnly].slice(0, 200);
}

/** Union of two string[] keyword arrays (unique). */
function mergeKeywords(local: string[], cloud: string[]): string[] {
  return Array.from(new Set([...cloud, ...local]));
}

/** Merge scalar objects: cloud wins on shared keys; local fills in missing ones. */
function mergeScalar<T extends object>(local: T, cloud: T | null): T {
  if (!cloud) return local;
  return { ...local, ...cloud };
}

// ── Core sync functions ───────────────────────────────────────────────────

/**
 * pushToCloud — snapshot all localStorage data up to Supabase.
 * Creates the row if it doesn't exist yet (upsert).
 */
export async function pushToCloud(userId: string): Promise<void> {
  const supabase = getSupabaseBrowserClient();
  const { error } = await supabase.from("user_data").upsert(
    {
      user_id: userId,
      calendar: loadCalendar(),
      onboarding: loadOnboardingProfile(),
      preferences: loadPreferences(),
      history: loadHistory(),
      custom_keywords: loadCustomEventKeywords(),
      feedback: loadFeedback(),
      profile_stats: loadProfile(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );
  if (error) {
    console.error("[cloud-sync] pushToCloud error:", error.message);
  }
}

/**
 * pullFromCloud — fetch cloud row, merge into localStorage, write back.
 * If no cloud row exists yet (new user), this is a no-op.
 */
export async function pullFromCloud(userId: string): Promise<void> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("user_data")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle(); // returns null (not error) when no row exists

  if (error) {
    console.error("[cloud-sync] pullFromCloud error:", error.message);
    return;
  }
  if (!data) {
    // New user — nothing to pull yet
    return;
  }

  // Merge cloud → local (cloud wins scalars, union for arrays)
  const mergedCalendar = mergeCalendar(
    loadCalendar(),
    (data.calendar as CalendarBlock[]) ?? []
  );
  const mergedHistory = mergeHistory(
    loadHistory(),
    (data.history as HistoryItem[]) ?? []
  );
  const mergedFeedback = mergeFeedback(
    loadFeedback(),
    (data.feedback as FeedbackEntry[]) ?? []
  );
  const mergedKeywords = mergeKeywords(
    loadCustomEventKeywords(),
    (data.custom_keywords as string[]) ?? []
  );
  const mergedPreferences = mergeScalar(
    loadPreferences(),
    (data.preferences as UserPreferences) ?? null
  );
  const mergedProfile = mergeScalar(
    loadProfile(),
    (data.profile_stats as UserProfile) ?? null
  );

  // Write merged data back to localStorage
  saveCalendar(mergedCalendar);
  saveHistory(mergedHistory);
  saveFeedback(mergedFeedback);
  saveCustomEventKeywords(mergedKeywords);
  savePreferences(mergedPreferences);
  saveProfile(mergedProfile);

  // Onboarding: only overwrite if cloud has a record
  if (data.onboarding) {
    const local = loadOnboardingProfile();
    const merged = mergeScalar(
      local ?? ({} as OnboardingProfile),
      data.onboarding as OnboardingProfile
    );
    saveOnboardingProfile(merged);
  }
}

/**
 * mergeAndSync — called once on sign-in.
 * 1. Pull cloud data and merge with local (union, cloud wins scalars)
 * 2. Push fully merged state back to cloud
 * 3. Dispatch openhour:cloud-sync so mounted pages re-read localStorage
 */
export async function mergeAndSync(userId: string): Promise<void> {
  try {
    await pullFromCloud(userId);
    await pushToCloud(userId);
  } catch (err) {
    console.error("[cloud-sync] mergeAndSync error:", err);
  }
  // Always signal UI to refresh — even if cloud was unreachable, local data is still valid
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("openhour:cloud-sync"));
  }
}

/**
 * syncField — targeted upsert of a single JSONB column.
 * Used by storage-sync.ts wrappers after every save call.
 * Fire-and-forget — callers do not await this.
 */
export async function syncField(
  userId: string,
  field: CloudField,
  value: unknown
): Promise<void> {
  const supabase = getSupabaseBrowserClient();
  const { error } = await supabase.from("user_data").upsert(
    {
      user_id: userId,
      [field]: value,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );
  if (error) {
    console.error(`[cloud-sync] syncField(${field}) error:`, error.message);
  }
}

/**
 * syncCalendar — reads the post-compact localStorage state and syncs it.
 * Called by the saveCalendar wrapper AFTER saveCalendar has already
 * compacted the data, so we sync exactly what was stored.
 */
export async function syncCalendar(userId: string): Promise<void> {
  await syncField(userId, "calendar", loadCalendar());
}
