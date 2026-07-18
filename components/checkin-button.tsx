"use client";

import { useActionState, useState } from "react";
import {
  createCheckin,
  type EngagementActionState,
} from "@/app/engagements/actions";

// CheckinButton (SPEC §8, Flow 4 step 2): one check-in per engagement per
// UTC day. done/locked states; "Found an issue" requires a note. The DB
// unique index is authoritative — a race just surfaces the friendly error.
export function CheckinButton({
  engagementId,
  requestId,
  checkedInToday,
  weeklyCount,
  weeklyMin,
}: {
  engagementId: string;
  requestId: string;
  checkedInToday: boolean;
  weeklyCount: number;
  weeklyMin: number;
}) {
  const [mode, setMode] = useState<"idle" | "pick" | "issue">("idle");
  const [state, formAction, isPending] = useActionState<
    EngagementActionState,
    FormData
  >(createCheckin, {});

  const meter = (
    <p
      className={`text-xs ${weeklyCount >= weeklyMin ? "text-zinc-500" : "text-amber-400"}`}
    >
      {Math.min(weeklyCount, weeklyMin)}/{weeklyMin} check-ins this week
      {weeklyCount >= weeklyMin ? " ✓" : ""}
    </p>
  );

  if (checkedInToday || state.success) {
    return (
      <div className="mt-3 space-y-1">
        <div className="w-full rounded-lg border border-emerald-900 bg-emerald-950/40 px-4 py-2 text-center text-xs font-semibold text-emerald-400">
          {state.success ?? "Checked in today ✓ — unlocks at UTC midnight"}
        </div>
        {meter}
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-2">
      {state.error && (
        <p className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-xs text-red-300">
          {state.error}
        </p>
      )}

      {mode === "idle" && (
        <button
          type="button"
          onClick={() => setMode("pick")}
          className="w-full rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-500"
        >
          Check in — I opened the app today
        </button>
      )}

      {mode === "pick" && (
        <div className="flex gap-2">
          <form action={formAction} className="flex-1">
            <input type="hidden" name="engagement_id" value={engagementId} />
            <input type="hidden" name="request_id" value={requestId} />
            <input type="hidden" name="checkin_status" value="ok" />
            <button
              type="submit"
              disabled={isPending}
              className="w-full rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
            >
              {isPending ? "Saving..." : "Works fine"}
            </button>
          </form>
          <button
            type="button"
            onClick={() => setMode("issue")}
            disabled={isPending}
            className="flex-1 rounded-lg border border-amber-800 px-3 py-2 text-sm font-semibold text-amber-400 transition-colors hover:bg-amber-950/50"
          >
            Found an issue
          </button>
        </div>
      )}

      {mode === "issue" && (
        <form action={formAction} className="space-y-2">
          <input type="hidden" name="engagement_id" value={engagementId} />
          <input type="hidden" name="request_id" value={requestId} />
          <input type="hidden" name="checkin_status" value="issue" />
          <textarea
            name="note"
            required
            rows={2}
            maxLength={500}
            placeholder="What went wrong? (required)"
            className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none"
          />
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={isPending}
              className="flex-1 rounded-lg bg-amber-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-amber-500 disabled:opacity-50"
            >
              {isPending ? "Saving..." : "Report issue & check in"}
            </button>
            <button
              type="button"
              onClick={() => setMode("pick")}
              disabled={isPending}
              className="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
            >
              Back
            </button>
          </div>
        </form>
      )}

      {meter}
    </div>
  );
}
