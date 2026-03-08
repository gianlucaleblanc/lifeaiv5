"use client";

import { useState } from "react";
import { saveOnboardingProfile, type OnboardingProfile } from "../lib/storage-sync";
// saveOnboardingProfile also seeds UserPreferences.preferredStartHour / preferredEndHour
// so the very first AI session is already personalized without any feedback required.

type Step = 0 | 1 | 2 | 3 | 4 | 5;

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

  function next() {
    setStep((s) => Math.min(5, s + 1) as Step);
  }

  function finish() {
    const profile: OnboardingProfile = {
      name: name.trim() || "Friend",
      role,
      wakeHour,
      sleepHour,
      completedAt: new Date().toISOString(),
    };
    saveOnboardingProfile(profile);
    onComplete();
  }

  // Progress dots
  const totalSteps = 5; // steps 1–5 are shown (step 0 = welcome, step 5 = done)
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
      {step > 0 && step < 5 && (
        <div className="absolute top-0 left-0 right-0 h-1 bg-black/5">
          <div
            className="h-full bg-[var(--lifeos-pink)] transition-all duration-500"
            style={{ width: `${((step) / 4) * 100}%` }}
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

        {/* ── Step 5: Done ── */}
        {step === 5 && (
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

      {/* Skip link (only shown for steps 1–4) */}
      {step > 0 && step < 5 && (
        <div className="pb-8 text-center">
          <button
            onClick={finish}
            className="text-sm text-black/30 hover:text-black/60 transition-colors"
          >
            Skip for now
          </button>
        </div>
      )}
    </div>
  );
}
