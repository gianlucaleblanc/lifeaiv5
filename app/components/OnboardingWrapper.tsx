"use client";

/**
 * OnboardingWrapper — previously gated the app behind a 5-step onboarding flow.
 *
 * CHANGED: Users now land directly on the app with zero friction. Preferences
 * (wake time, role, etc.) are collected inline after their first generate,
 * not upfront. This dramatically reduces bounce rate.
 *
 * The OnboardingFlow component still exists and can be surfaced contextually
 * (e.g. from Settings) if needed.
 */
export default function OnboardingWrapper({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
