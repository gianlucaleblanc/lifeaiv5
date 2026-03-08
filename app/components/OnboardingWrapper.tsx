"use client";

import { useEffect, useState } from "react";
import { hasCompletedOnboarding } from "../lib/storage-sync";
import OnboardingFlow from "./OnboardingFlow";

/**
 * OnboardingWrapper — wraps the entire app shell.
 * On first load (localStorage has no onboarding record) it shows OnboardingFlow
 * full-screen. Once the user completes or skips, it writes the profile and
 * renders children normally.
 */
export default function OnboardingWrapper({ children }: { children: React.ReactNode }) {
  // null = not yet checked (SSR), true = show onboarding, false = done
  const [showOnboarding, setShowOnboarding] = useState<boolean | null>(null);

  useEffect(() => {
    // Only runs client-side — avoids hydration mismatch.
    setShowOnboarding(!hasCompletedOnboarding());
  }, []);

  // While we haven't checked yet (SSR pass), render children normally so the
  // page isn't blank. The onboarding overlay will appear on the first client paint.
  if (showOnboarding === null) {
    return <>{children}</>;
  }

  if (showOnboarding) {
    return (
      <>
        {/* Render children in the background so the layout is "warm" */}
        <div aria-hidden className="opacity-0 pointer-events-none select-none">
          {children}
        </div>
        <OnboardingFlow onComplete={() => setShowOnboarding(false)} />
      </>
    );
  }

  return <>{children}</>;
}
