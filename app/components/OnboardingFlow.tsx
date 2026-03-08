"use client";

import { useState } from "react";
import { saveOnboardingProfile, type OnboardingProfile } from "../lib/storage-sync";
import { useAuth } from "./AuthProvider";
// saveOnboardingProfile also seeds UserPreferences.preferredStartHour / preferredEndHour
// so the very first AI session is already personalized without any feedback required.

type Step = 0 | 1 | 2 | 3 | 4 | 5 | 6;

const ROLES = [
  { value: "student", label: "Student", emoji: "🎓", desc: "Classes, exams & assignments" },
  { value: "professional", label: "Professional", emoji: "💼", desc: "Meetings, deadlines & projects" },
  { value: "entrepreneur", label: "Entrepreneur", emoji: "🚀", desc: "Building, shipping & growing" },
  { value: "other", label: "Other", emoji: "✨", desc: "My own path" },
];

function pad2(n: number) {
  return String(n).padStart(2, "0");
}
function hourLabel(h: number) {
  const ampm = h < 12 ? "AM" : "PM";
  const h12 = h % 12 || 12;
  return `${h12}:00 ${ampm}`;
}

export default function OnboardingFlow({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState<Step>(0);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [wakeHour, setWakeHour] = useState(7);
  const [sleepHour, setSleepHour] = useState(23);
  const [emailMode, setEmailMode] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const { signInWithGoogle } = useAuth();

  function next() {
    setStep((s) => Math.min(6, s + 1) as Step);
  }

  function saveProfile() {
    const profile: OnboardingProfile = {
      name: name.trim() || "Friend",
      role,
      wakeHour,
      sleepHour,
      completedAt: new Date().toISOString(),
    };
    saveOnboardingProfile(profile);
  }

  function finish() {
    saveProfile();
    onComplete();
  }

  async function handleGoogleSignIn() {
    saveProfile();
    await signInWithGoogle();
    // signInWithGoogle redirects away — onComplete will be called after redirect
  }

  async function handleEmailSignIn() {
    if (!email.trim() || !password.trim()) return;
    setAuthLoading(true);
    setAuthError("");
    try {
      const { createSupabaseBrowserClient } = await import("../lib/supabase");
      const supabase = createSupabaseBrowserClient();
      // Try sign-in first, then sign-up if user not found
      const { error: signInError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (signInError) {
        if (signInError.message.toLowerCase().includes("invalid") || signInError.message.toLowerCase().includes("not found")) {
          // New user — sign up
          const { error: signUpError } = await supabase.auth.signUp({ email: email.trim(), password });
          if (signUpError) {
            setAuthError(signUpError.message);
            setAuthLoading(false);
            return;
          }
          // Signed up — save profile and finish
          saveProfile();
          onComplete();
        } else {
          setAuthError(signInError.message);
          setAuthLoading(false);
          return;
        }
      } else {
        // Signed in successfully
        saveProfile();
        onComplete();
      }
    } catch {
      setAuthError("Something went wrong. Please try again.");
    }
    setAuthLoading(false);
  }

  // Progress bar — steps 1–4 are preferences, step 5 is sign-in
  const totalSteps = 5;
  const progressStep = Math.min(step, totalSteps);

  return (
    <div className="fixed inset-0 z-[300] flex flex-col bg-white overflow-hidden">
      {/* Gradient background accent */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 80% 60% at 50% -10%, rgba(255,107,107,0.12) 0%, transparent 70%)",
        }}
      />

      {/* Progress bar */}
      {step > 0 && step < 6 && (
        <div className="absolute top-0 left-0 right-0 h-1 bg-black/5">
          <div
            className="h-full bg-[var(--lifeos-pink)] transition-all duration-500"
            style={{ width: `${(step / 5) * 100}%` }}
          />
        </div>
      )}

      {/* Content area */}
      <div className="relative flex flex-1 flex-col items-center justify-center px-6 py-12">

        {/* ── Step 0: Welcome ── */}
        {step === 0 && (
          <div className="flex flex-col items-center text-center max-w-md animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="mb-6 h-20 w-20 rounded-3xl bg-[var(--lifeos-pink)] grid place-items-center shadow-lg">
              <svg viewBox="0 0 24 24" className="h-10 w-10" fill="none" aria-hidden="true">
                <circle cx="12" cy="12" r="8" stroke="white" strokeWidth="1.8" />
                <path d="M12 8v4l2.5 2.5" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <h1 className="text-3xl sm:text-4xl font-extrabold text-black" style={{ letterSpacing: "-0.025em" }}>
              Welcome to OpenHour
            </h1>
            <p className="mt-3 text-base text-black/60 leading-relaxed">
              Your personal AI planner. Let's take 60 seconds to set up your experience.
            </p>
            <button
              onClick={next}
              className="mt-10 rounded-full bg-[var(--lifeos-pink)] px-10 py-3.5 text-base font-bold text-white shadow-md hover:opacity-90 transition-opacity"
            >
              Get started →
            </button>
          </div>
        )}

        {/* ── Step 1: Name ── */}
        {step === 1 && (
          <div className="flex flex-col items-center text-center max-w-md w-full animate-in fade-in slide-in-from-bottom-4 duration-500">
            <p className="text-xs font-bold uppercase tracking-widest text-black/40 mb-4">Step 1 of 4</p>
            <h2 className="text-2xl sm:text-3xl font-extrabold text-black mb-2" style={{ letterSpacing: "-0.02em" }}>
              What's your name?
            </h2>
            <p className="text-sm text-black/50 mb-8">OpenHour will use this to greet you and personalize suggestions.</p>
            <input
              autoFocus
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) next(); }}
              placeholder="Your first name…"
              className="w-full max-w-xs rounded-2xl border-2 border-black/10 px-5 py-3.5 text-lg font-semibold text-center text-black outline-none focus:border-[var(--lifeos-pink)] transition-colors"
            />
            <button
              onClick={next}
              disabled={!name.trim()}
              className="mt-8 rounded-full bg-[var(--lifeos-pink)] px-10 py-3.5 text-base font-bold text-white shadow-md hover:opacity-90 transition-opacity disabled:opacity-40"
            >
              Continue →
            </button>
          </div>
        )}

        {/* ── Step 2: Role ── */}
        {step === 2 && (
          <div className="flex flex-col items-center text-center max-w-lg w-full animate-in fade-in slide-in-from-bottom-4 duration-500">
            <p className="text-xs font-bold uppercase tracking-widest text-black/40 mb-4">Step 2 of 4</p>
            <h2 className="text-2xl sm:text-3xl font-extrabold text-black mb-2" style={{ letterSpacing: "-0.02em" }}>
              What best describes you?
            </h2>
            <p className="text-sm text-black/50 mb-8">This helps OpenHour tailor your plans and event suggestions.</p>
            <div className="grid grid-cols-2 gap-3 w-full">
              {ROLES.map((r) => (
                <button
                  key={r.value}
                  onClick={() => setRole(r.value)}
                  className={
                    "flex flex-col items-start gap-1 rounded-2xl border-2 p-4 text-left transition-all " +
                    (role === r.value
                      ? "border-[var(--lifeos-pink)] bg-[var(--lifeos-pink)]/5"
                      : "border-black/10 hover:border-black/20")
                  }
                >
                  <span className="text-2xl">{r.emoji}</span>
                  <span className="font-bold text-sm text-black">{r.label}</span>
                  <span className="text-xs text-black/50">{r.desc}</span>
                </button>
              ))}
            </div>
            <button
              onClick={next}
              disabled={!role}
              className="mt-8 rounded-full bg-[var(--lifeos-pink)] px-10 py-3.5 text-base font-bold text-white shadow-md hover:opacity-90 transition-opacity disabled:opacity-40"
            >
              Continue →
            </button>
          </div>
        )}

        {/* ── Step 3: Wake time ── */}
        {step === 3 && (
          <div className="flex flex-col items-center text-center max-w-md w-full animate-in fade-in slide-in-from-bottom-4 duration-500">
            <p className="text-xs font-bold uppercase tracking-widest text-black/40 mb-4">Step 3 of 4</p>
            <h2 className="text-2xl sm:text-3xl font-extrabold text-black mb-2" style={{ letterSpacing: "-0.02em" }}>
              When do you usually wake up?
            </h2>
            <p className="text-sm text-black/50 mb-10">OpenHour uses this to avoid scheduling before you're up.</p>
            <div className="flex flex-col items-center gap-4 w-full max-w-xs">
              <div className="text-4xl font-extrabold text-[var(--lifeos-pink)]" style={{ letterSpacing: "-0.02em" }}>
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
            <button
              onClick={next}
              className="mt-10 rounded-full bg-[var(--lifeos-pink)] px-10 py-3.5 text-base font-bold text-white shadow-md hover:opacity-90 transition-opacity"
            >
              Continue →
            </button>
          </div>
        )}

        {/* ── Step 4: Sleep time ── */}
        {step === 4 && (
          <div className="flex flex-col items-center text-center max-w-md w-full animate-in fade-in slide-in-from-bottom-4 duration-500">
            <p className="text-xs font-bold uppercase tracking-widest text-black/40 mb-4">Step 4 of 4</p>
            <h2 className="text-2xl sm:text-3xl font-extrabold text-black mb-2" style={{ letterSpacing: "-0.02em" }}>
              When do you aim to be in bed?
            </h2>
            <p className="text-sm text-black/50 mb-10">OpenHour respects your sleep and won't schedule past this time.</p>
            <div className="flex flex-col items-center gap-4 w-full max-w-xs">
              <div className="text-4xl font-extrabold text-[var(--lifeos-pink)]" style={{ letterSpacing: "-0.02em" }}>
                {hourLabel(sleepHour % 24)}
              </div>
              {/* Slider range 19–26: 19=7PM, 22=10PM, 24=midnight, 26=2AM */}
              <input
                type="range"
                min={19}
                max={26}
                step={1}
                value={sleepHour >= 0 && sleepHour <= 2 ? sleepHour + 24 : sleepHour}
                onChange={(e) => {
                  let v = parseInt(e.target.value, 10);
                  // Convert back: 24→0, 25→1, 26→2 (next-day hours stored as 0–2)
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
            <button
              onClick={next}
              className="mt-10 rounded-full bg-[var(--lifeos-pink)] px-10 py-3.5 text-base font-bold text-white shadow-md hover:opacity-90 transition-opacity"
            >
              Continue →
            </button>
          </div>
        )}

        {/* ── Step 5: Sign in / create account ── */}
        {step === 5 && (
          <div className="flex flex-col items-center text-center max-w-sm w-full animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="mb-5 h-16 w-16 rounded-2xl bg-[var(--lifeos-pink)]/10 grid place-items-center">
              <span className="text-3xl">☁️</span>
            </div>
            <h2 className="text-2xl sm:text-3xl font-extrabold text-black mb-2" style={{ letterSpacing: "-0.02em" }}>
              Save your progress
            </h2>
            <p className="text-sm text-black/50 mb-8 leading-relaxed">
              Create a free account to back up your calendar and preferences across all your devices.
            </p>

            {!emailMode ? (
              <>
                {/* Google sign-in */}
                <button
                  onClick={handleGoogleSignIn}
                  className="w-full flex items-center justify-center gap-3 rounded-2xl border-2 border-black/10 bg-white px-6 py-3.5 text-sm font-bold text-black hover:border-black/20 hover:bg-black/[0.02] transition-all shadow-sm mb-3"
                >
                  <svg viewBox="0 0 24 24" className="h-5 w-5 flex-shrink-0" aria-hidden="true">
                    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                  </svg>
                  Continue with Google
                </button>

                {/* Divider */}
                <div className="flex items-center gap-3 w-full my-1 mb-3">
                  <div className="flex-1 h-px bg-black/10" />
                  <span className="text-xs text-black/30 font-semibold">or</span>
                  <div className="flex-1 h-px bg-black/10" />
                </div>

                {/* Email option */}
                <button
                  onClick={() => setEmailMode(true)}
                  className="w-full flex items-center justify-center gap-2 rounded-2xl border-2 border-black/10 bg-white px-6 py-3.5 text-sm font-bold text-black/70 hover:border-black/20 hover:bg-black/[0.02] transition-all shadow-sm"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <rect x="2" y="4" width="20" height="16" rx="3" />
                    <path d="m2 7 10 7 10-7" />
                  </svg>
                  Continue with email
                </button>
              </>
            ) : (
              /* Email / password form */
              <div className="w-full flex flex-col gap-3">
                <button
                  onClick={() => { setEmailMode(false); setAuthError(""); }}
                  className="self-start text-xs text-black/40 hover:text-black/70 transition-colors mb-1"
                >
                  ← Back
                </button>
                <input
                  autoFocus
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Email address"
                  className="w-full rounded-2xl border-2 border-black/10 px-4 py-3 text-sm font-semibold text-black outline-none focus:border-[var(--lifeos-pink)] transition-colors"
                />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleEmailSignIn(); }}
                  placeholder="Password (min 6 characters)"
                  className="w-full rounded-2xl border-2 border-black/10 px-4 py-3 text-sm font-semibold text-black outline-none focus:border-[var(--lifeos-pink)] transition-colors"
                />
                {authError && (
                  <p className="text-xs text-red-500 font-semibold text-left px-1">{authError}</p>
                )}
                <button
                  onClick={handleEmailSignIn}
                  disabled={!email.trim() || password.length < 6 || authLoading}
                  className="w-full rounded-2xl bg-[var(--lifeos-pink)] px-6 py-3.5 text-sm font-bold text-white shadow-md hover:opacity-90 transition-opacity disabled:opacity-40"
                >
                  {authLoading ? "Saving…" : "Create account & start →"}
                </button>
                <p className="text-[11px] text-black/30 mt-1">
                  Already have an account? Using the same email will sign you in.
                </p>
              </div>
            )}

            {/* Skip */}
            <button
              onClick={finish}
              className="mt-6 text-sm text-black/30 hover:text-black/60 transition-colors"
            >
              Skip for now — I'll sign in later
            </button>
          </div>
        )}

        {/* ── Step 6: Done ── */}
        {step === 6 && (
          <div className="flex flex-col items-center text-center max-w-md animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="mb-6 h-20 w-20 rounded-full bg-[var(--lifeos-pink)] grid place-items-center shadow-lg">
              <span className="text-4xl">✓</span>
            </div>
            <h2 className="text-2xl sm:text-3xl font-extrabold text-black mb-2" style={{ letterSpacing: "-0.02em" }}>
              You're all set{name.trim() ? `, ${name.trim().split(" ")[0]}` : ""}!
            </h2>
            <p className="text-sm text-black/50 mb-2">
              OpenHour is ready to plan your days, import your syllabi, and help you stay on top of everything.
            </p>
            <p className="text-sm text-black/40 mb-10">
              Wake time: <span className="font-semibold text-black/60">{hourLabel(wakeHour)}</span>
              {" · "}
              Sleep: <span className="font-semibold text-black/60">{hourLabel(sleepHour)}</span>
            </p>
            <button
              onClick={finish}
              className="rounded-full bg-[var(--lifeos-pink)] px-10 py-3.5 text-base font-bold text-white shadow-md hover:opacity-90 transition-opacity"
            >
              Start planning →
            </button>
          </div>
        )}
      </div>

      {/* Skip link (shown for steps 1–4 only — step 5 has its own skip) */}
      {step > 0 && step < 5 && (
        <div className="pb-8 text-center">
          <button
            onClick={() => { saveProfile(); next(); }}
            className="text-sm text-black/30 hover:text-black/60 transition-colors"
          >
            Skip for now
          </button>
        </div>
      )}
    </div>
  );
}
