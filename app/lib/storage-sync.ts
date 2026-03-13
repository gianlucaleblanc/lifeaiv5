/**
 * storage-sync.ts
 * Sync-aware wrapper layer over storage.ts.
 *
 * All save functions call the original storage.ts function first (localStorage),
 * then fire-and-forget cloud sync if the user is signed in.
 * All read functions and types are re-exported unchanged.
 *
 * Guest mode (no sign-in) is 100% identical to importing from storage.ts directly —
 * _currentUserId is null and all sync calls are skipped.
 */

import {
  loadCalendar,
  saveCalendar as _saveCalendar,
  saveOnboardingProfile as _saveOnboardingProfile,
  savePreferences as _savePreferences,
  saveHistory as _saveHistory,
  saveCustomEventKeywords as _saveCustomEventKeywords,
  saveFeedback as _saveFeedback,
  saveProfile as _saveProfile,
  addCalendarBlock as _addCalendarBlock,
  updateCalendarBlock as _updateCalendarBlock,
  deleteCalendarBlock as _deleteCalendarBlock,
  deleteCalendarSeries as _deleteCalendarSeries,
  updateCalendarSeries as _updateCalendarSeries,
  addTodoItem as _addTodoItem,
  deleteTodoItem as _deleteTodoItem,
  updateTodoItem as _updateTodoItem,
  scheduleTodoItem as _scheduleTodoItem,
} from "./storage";

import { syncCalendar, syncField } from "./cloud-sync";
import {
  isGoogleCalendarConnected,
  createGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
} from "./googleCalendar";

import type { CalendarBlock, OnboardingProfile, UserPreferences, HistoryItem, FeedbackEntry, UserProfile, TodoItem } from "./storage";

// ── Auth bridge ───────────────────────────────────────────────────────────
// AuthProvider calls setCurrentUserId() whenever auth state changes.
// Storage wrappers check this before firing cloud sync.

let _currentUserId: string | null = null;

export function setCurrentUserId(id: string | null) {
  _currentUserId = id;
}

export function getCurrentUserId(): string | null {
  return _currentUserId;
}

// ── Sync-aware save wrappers ──────────────────────────────────────────────

export function saveCalendar(items: CalendarBlock[]): boolean {
  const result = _saveCalendar(items); // compacts + saves to localStorage
  if (_currentUserId) {
    // Read the post-compact state (what was actually stored) and sync that
    syncCalendar(_currentUserId).catch(console.error);
  }
  return result;
}

export function saveOnboardingProfile(profile: OnboardingProfile): void {
  _saveOnboardingProfile(profile);
  if (_currentUserId) {
    syncField(_currentUserId, "onboarding", profile).catch(console.error);
  }
}

export function savePreferences(p: UserPreferences): void {
  _savePreferences(p);
  if (_currentUserId) {
    syncField(_currentUserId, "preferences", p).catch(console.error);
  }
}

export function saveHistory(items: HistoryItem[]): void {
  _saveHistory(items);
  if (_currentUserId) {
    syncField(_currentUserId, "history", items).catch(console.error);
  }
}

export function saveCustomEventKeywords(keywords: string[]): void {
  _saveCustomEventKeywords(keywords);
  if (_currentUserId) {
    syncField(_currentUserId, "custom_keywords", keywords).catch(console.error);
  }
}

export function saveFeedback(entries: FeedbackEntry[]): void {
  _saveFeedback(entries);
  if (_currentUserId) {
    syncField(_currentUserId, "feedback", entries).catch(console.error);
  }
}

export function saveProfile(p: UserProfile): void {
  _saveProfile(p);
  if (_currentUserId) {
    syncField(_currentUserId, "profile_stats", p).catch(console.error);
  }
}

// ── Google Calendar write-back helpers ───────────────────────────────────
// Only active when user has enabled "Sync new blocks to Google Calendar"
// in Settings (UserPreferences.gcalWriteBack === true). Off by default.

/** Convert a CalendarBlock's date + startMin/endMin to ISO strings for GCal */
function blockToISO(block: CalendarBlock): { startISO: string; endISO: string } {
  const [y, m, d] = block.date.split("-").map(Number);
  const startDate = new Date(y, m - 1, d, Math.floor(block.startMin / 60), block.startMin % 60, 0, 0);
  const endDate   = new Date(y, m - 1, d, Math.floor(block.endMin   / 60), block.endMin   % 60, 0, 0);
  return { startISO: startDate.toISOString(), endISO: endDate.toISOString() };
}

function isGCalWriteBackEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = window.localStorage.getItem("openhour_preferences_v1");
    if (!raw) return false;
    const prefs = JSON.parse(raw);
    return prefs?.gcalWriteBack === true;
  } catch { return false; }
}

/**
 * Fire-and-forget: create a Google Calendar event for a block, then
 * patch the stored block with the returned gcalEventId.
 * Only runs when GCal is connected AND gcalWriteBack preference is on.
 */
export async function pushBlockToGCal(block: CalendarBlock): Promise<void> {
  if (!isGCalWriteBackEnabled()) return;
  if (!isGoogleCalendarConnected()) return;
  const { startISO, endISO } = blockToISO(block);
  const gcalId = await createGoogleCalendarEvent({
    title: block.title,
    startTime: startISO,
    endTime: endISO,
    description: (block.meta as { fullDetail?: string } | undefined)?.fullDetail,
  });
  if (gcalId) {
    _updateCalendarBlock(block.id, { gcalEventId: gcalId });
  }
}

/**
 * Fire-and-forget: delete the Google Calendar event for a block if it has one.
 * Only runs when GCal is connected AND gcalWriteBack preference is on.
 */
export async function removeBlockFromGCal(block: CalendarBlock): Promise<void> {
  if (!block.gcalEventId) return;
  if (!isGCalWriteBackEnabled()) return;
  if (!isGoogleCalendarConnected()) return;
  await deleteGoogleCalendarEvent("primary", block.gcalEventId);
}

// ── Sync-aware composite calendar mutators ────────────────────────────────
// These call the original function, then sync the resulting calendar state.

export function addCalendarBlock(block: CalendarBlock): void {
  _addCalendarBlock(block);
  // Opt-in GCal write-back (only runs if user enabled it in Settings)
  pushBlockToGCal(block).catch(console.error);
  if (_currentUserId) {
    syncCalendar(_currentUserId).catch(console.error);
  }
}

export function updateCalendarBlock(
  id: string,
  patch: Partial<CalendarBlock>
): CalendarBlock[] {
  const updated = _updateCalendarBlock(id, patch);
  if (_currentUserId) {
    syncCalendar(_currentUserId).catch(console.error);
  }
  return updated;
}

export function deleteCalendarBlock(id: string): CalendarBlock[] {
  // Read the block before deleting so we can remove it from GCal
  const allBefore = loadCalendar();
  const block = allBefore.find((b) => b.id === id);
  if (block) removeBlockFromGCal(block).catch(console.error);
  const updated = _deleteCalendarBlock(id);
  if (_currentUserId) {
    syncCalendar(_currentUserId).catch(console.error);
  }
  return updated;
}

export function deleteCalendarSeries(seriesId: string): CalendarBlock[] {
  const updated = _deleteCalendarSeries(seriesId);
  if (_currentUserId) {
    syncCalendar(_currentUserId).catch(console.error);
  }
  return updated;
}

export function updateCalendarSeries(
  seriesId: string,
  patch: Partial<Pick<CalendarBlock, "title" | "startMin" | "endMin">>
): CalendarBlock[] {
  const updated = _updateCalendarSeries(seriesId, patch);
  if (_currentUserId) {
    syncCalendar(_currentUserId).catch(console.error);
  }
  return updated;
}

// ── To-Do list mutators ───────────────────────────────────────────────────

export function addTodoItem(item: TodoItem): void {
  _addTodoItem(item);
  if (_currentUserId) {
    syncField(_currentUserId, "todos", null).catch(console.error);
  }
}

export function deleteTodoItem(id: string): TodoItem[] {
  const updated = _deleteTodoItem(id);
  if (_currentUserId) {
    syncField(_currentUserId, "todos", null).catch(console.error);
  }
  return updated;
}

export function updateTodoItem(id: string, patch: Partial<TodoItem>): TodoItem[] {
  const updated = _updateTodoItem(id, patch);
  if (_currentUserId) {
    syncField(_currentUserId, "todos", null).catch(console.error);
  }
  return updated;
}

export function scheduleTodoItem(
  id: string,
  date: string,
  startMin: number,
  endMin: number
): ReturnType<typeof _scheduleTodoItem> {
  return _scheduleTodoItem(id, date, startMin, endMin);
}

// ── Re-export everything else from storage.ts unchanged ───────────────────

export {
  // Read functions
  loadCalendar,
  loadOnboardingProfile,
  loadPreferences,
  loadHistory,
  loadCustomEventKeywords,
  loadFeedback,
  loadProfile,
  loadTodos,
  // Helpers
  addToHistory,
  addFeedback,
  addCustomEventKeyword,
  updatePreferences,
  getLatestHistoryItem,
  loadDone,
  saveDone,
  doneKey,
  hasCompletedOnboarding,
  mergeCalendarFromHistory,
  previewCalendarFromHistory,
  applyApprovedPlanBlocks,
  addSyllabusEventsToCalendar,
  buildPreferenceContext,
  // Types
  type CalendarBlock,
  type OnboardingProfile,
  type UserPreferences,
  type HistoryItem,
  type FeedbackEntry,
  type UserProfile,
  type Plan,
  type DoneMap,
  type FeedbackSignal,
  type CalendarMergePreview,
  type SyllabusEvent,
  type TodoItem,
  // Constants
  HISTORY_KEY,
  CUSTOM_EVENT_KEYWORDS_KEY,
} from "./storage";
