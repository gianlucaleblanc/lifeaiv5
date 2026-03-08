"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { User } from "@supabase/supabase-js";
import { track } from "@vercel/analytics";
import { createSupabaseBrowserClient } from "../lib/supabase";
import { mergeAndSync } from "../lib/cloud-sync";
import { setCurrentUserId } from "../lib/storage-sync";

// ── Context ───────────────────────────────────────────────────────────────

type AuthContextValue = {
  user: User | null;
  loading: boolean;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  signInWithGoogle: async () => {},
  signOut: async () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

// ── Provider ──────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: ReactNode }) {
  const supabase = createSupabaseBrowserClient();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  // Prevents re-running mergeAndSync on token refresh events
  const mergedRef = useRef<string | null>(null);

  useEffect(() => {
    // Restore session on page load (handles post-OAuth redirect)
    supabase.auth.getSession().then(({ data: { session } }) => {
      const currentUser = session?.user ?? null;
      setUser(currentUser);
      setCurrentUserId(currentUser?.id ?? null);
      setLoading(false);

      // If there's already a session on mount (page refresh), run merge once
      if (currentUser && mergedRef.current !== currentUser.id) {
        mergedRef.current = currentUser.id;
        mergeAndSync(currentUser.id).catch((err) =>
          console.error("[AuthProvider] mergeAndSync on mount failed:", err)
        );
      }
    });

    // Listen for auth state changes (sign-in, sign-out, token refresh)
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, session) => {
      const currentUser = session?.user ?? null;
      setUser(currentUser);
      setLoading(false);

      if (event === "SIGNED_IN" && currentUser) {
        setCurrentUserId(currentUser.id);
        if (mergedRef.current !== currentUser.id) {
          mergedRef.current = currentUser.id;
          try {
            await mergeAndSync(currentUser.id);
          } catch (err) {
            console.error("[AuthProvider] mergeAndSync failed:", err);
            // Non-fatal: app continues in localStorage-only mode
          }
        }
      }

      if (event === "SIGNED_OUT") {
        setCurrentUserId(null);
        mergedRef.current = null;
      }
    });

    return () => subscription.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const signInWithGoogle = useCallback(async () => {
    track("Signup", { method: "google" });
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/api/auth/callback`,
      },
    });
  }, [supabase]);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setUser(null);
    setCurrentUserId(null);
    mergedRef.current = null;
  }, [supabase]);

  return (
    <AuthContext.Provider value={{ user, loading, signInWithGoogle, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}
