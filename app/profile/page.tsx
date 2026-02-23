"use client";

import { useEffect, useMemo, useState } from "react";
import { loadProfile, type UserProfile } from "../lib/storage";

function weekdayShort(yyyyMmDd: string) {
  const [y, m, d] = yyyyMmDd.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, { weekday: "short" });
}

function WhiteCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-[var(--lifeos-border-soft)] bg-white p-5">
      {children}
    </div>
  );
}

export default function ProfilePage() {
  // Avoid hydration mismatches: localStorage isn't available during server render.
  const [profile, setProfile] = useState<UserProfile>({ daysTracked: 0, avgCompletion: 0, last7: [] });

  useEffect(() => {
    setProfile(loadProfile());
  }, []);

  const avgPct = Math.round((profile.avgCompletion ?? 0) * 100);
  const trend = useMemo(() => (profile.last7 ?? []).slice().reverse(), [profile.last7]);

  let suggestion = "Pick one small task for tomorrow and make it 5 minutes.";
  if (avgPct >= 70) suggestion = "You’re consistent — add one small stretch goal only if you finish early.";
  else if (avgPct >= 45) suggestion = "Tighten the first task so it’s easier to start.";

  return (
    <div className="min-h-[calc(100vh-220px)]">
      <div className="flex items-center gap-6">
        <div className="h-20 w-20 rounded-full bg-black" aria-label="Profile picture" />
        <div className="h-20 flex-1 rounded-[999px] bg-[var(--lifeos-pink)] grid place-items-center">
          <div className="text-white text-xl sm:text-2xl font-extrabold" style={{ letterSpacing: "-0.02em" }}>
            Profile Name
          </div>
        </div>
      </div>

      <div className="mt-10">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-black/70">Profile snapshot</div>
          <div className="text-xs text-black/40">last 7 days</div>
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <WhiteCard>
            <div className="text-xs font-semibold uppercase tracking-wide text-black/50">Consistency</div>
            <div className="mt-2 text-2xl font-extrabold" style={{ letterSpacing: "-0.02em" }}>
              {avgPct}%
            </div>
            <div className="mt-1 text-sm text-black/70">average completion (recent)</div>

            <div className="mt-3 text-sm text-black/80">
              {avgPct >= 70
                ? "You finish most days — keep it simple and repeatable."
                : avgPct >= 45
                  ? "You’re building momentum — make starting easier."
                  : "You’re often not finishing — shrink the plan to 1–2 core tasks."}
            </div>
          </WhiteCard>

          <WhiteCard>
            <div className="text-xs font-semibold uppercase tracking-wide text-black/50">Trend</div>
            <div className="mt-3 flex items-end gap-2">
              {trend.length ? (
                trend.map((d) => {
                  const pct = Math.round(d.completion * 100);
                  const h = Math.max(8, Math.round((pct / 100) * 64));
                  return (
                    <div key={d.date} className="flex flex-col items-center gap-2">
                      <div
                        className="w-6 rounded-xl border border-[var(--lifeos-border-soft)] bg-white"
                        style={{ height: h }}
                        title={`${d.date} • ${pct}%`}
                      />
                      <div className="text-[10px] text-black/50">{weekdayShort(d.date)}</div>
                    </div>
                  );
                })
              ) : (
                <div className="text-sm text-black/60">No data yet.</div>
              )}
            </div>
            <div className="mt-3 text-xs text-black/50">Hover bars for exact %.</div>
          </WhiteCard>
        </div>

        <div className="mt-4">
          <WhiteCard>
            <div className="text-xs font-semibold uppercase tracking-wide text-black/50">Suggestion</div>
            <div className="mt-1 text-sm text-black/80">{suggestion}</div>
          </WhiteCard>
        </div>
      </div>
    </div>
  );
}
