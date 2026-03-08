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
} from "./storage";

import { syncCalendar, syncField } from "./cloud-sync";

import type { CalendarBlock, OnboardingProfile, UserPreferences, HistoryItem, FeedbackEntry, UserProfile } from "./storage";

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

// ── Sync-aware composite calendar mutators ────────────────────────────────
// These call the original function, then sync the resulting calendar state.

export function addCalendarBlock(block: CalendarBlock): void {
  _addCalendarBlock(block);
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
  // Constants
  HISTORY_KEY,
  CUSTOM_EVENT_KEYWORDS_KEY,
} from "./storage";
