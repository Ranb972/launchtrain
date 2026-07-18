"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import {
  addFeedbackAddendum,
  submitFeedback,
  type BugEntry,
  type EngagementActionState,
} from "@/app/engagements/actions";

const INPUT =
  "w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none";

function RatingRow({
  name,
  label,
  hint,
}: {
  name: string;
  label: string;
  hint: string;
}) {
  const [value, setValue] = useState(0);
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <label className="text-sm font-medium text-zinc-200">{label}</label>
        <span className="text-xs text-zinc-500">{hint}</span>
      </div>
      <input type="hidden" name={name} value={value || ""} />
      <div className="mt-1.5 flex gap-1.5">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => setValue(n)}
            aria-label={`${label} ${n} of 5`}
            className={`h-9 flex-1 rounded-md border text-sm font-semibold transition-colors ${
              value >= n
                ? "border-emerald-600 bg-emerald-950/60 text-emerald-300"
                : "border-zinc-700 text-zinc-500 hover:border-zinc-500"
            }`}
          >
            {n}
          </button>
        ))}
      </div>
    </div>
  );
}

// FeedbackForm (SPEC §8, Flow 5 step 1): short structured form — one minute
// to fill. Final submission on/after day 14 completes the engagement and
// releases the escrowed credit (handled atomically in the DB).
export function FeedbackForm({
  engagementId,
  requestId,
  type,
  appName,
}: {
  engagementId: string;
  requestId: string;
  type: "mid" | "final";
  appName: string;
}) {
  const [bugs, setBugs] = useState<BugEntry[]>([]);
  const [state, formAction, isPending] = useActionState<
    EngagementActionState,
    FormData
  >(submitFeedback, {});

  if (state.success === "completed") {
    return (
      <div className="rounded-xl border border-emerald-800 bg-emerald-950/30 p-6 text-center">
        <p className="text-2xl">🎉</p>
        <h2 className="mt-2 text-lg font-bold text-emerald-300">
          Test completed — +1 credit released!
        </h2>
        <p className="mt-2 text-sm text-zinc-300">
          You finished the full 14-day journey on {appName}. Your escrowed
          credit is settled and your reliability score went up.
        </p>
        <p className="mt-3 rounded-md border border-amber-900 bg-amber-950/30 px-3 py-2 text-sm text-amber-300">
          One last favor: <strong>stay opted in on Google Play</strong> until
          this request finishes its 14-day streak — leaving early can still
          hurt the developer&apos;s approval.
        </p>
        <Link
          href="/dashboard"
          className="mt-4 inline-block font-semibold text-emerald-400 hover:text-emerald-300"
        >
          Back to My Tests →
        </Link>
      </div>
    );
  }

  if (state.success) {
    return (
      <div className="rounded-xl border border-emerald-900 bg-emerald-950/30 p-6 text-center">
        <p className="text-sm text-emerald-300">{state.success}</p>
        <Link
          href="/dashboard"
          className="mt-3 inline-block text-sm font-semibold text-emerald-400 hover:text-emerald-300"
        >
          Back to My Tests →
        </Link>
      </div>
    );
  }

  const setBug = (i: number, patch: Partial<BugEntry>) =>
    setBugs((prev) => prev.map((b, j) => (j === i ? { ...b, ...patch } : b)));

  return (
    <form action={formAction} className="space-y-6">
      <input type="hidden" name="engagement_id" value={engagementId} />
      <input type="hidden" name="request_id" value={requestId} />
      <input type="hidden" name="feedback_type" value={type} />
      <input type="hidden" name="bugs" value={JSON.stringify(bugs)} />

      <div className="space-y-4">
        <RatingRow name="stability" label="Stability" hint="crashes, bugs, glitches" />
        <RatingRow name="ux" label="Ease of use" hint="navigation, clarity" />
        <RatingRow name="value" label="Usefulness" hint="would people want this?" />
      </div>

      <div>
        <div className="flex items-baseline justify-between">
          <label className="text-sm font-medium text-zinc-200">
            Bugs you hit
          </label>
          <span className="text-xs text-zinc-500">optional</span>
        </div>
        <div className="mt-2 space-y-2">
          {bugs.map((bug, i) => (
            <div key={i} className="flex gap-2">
              <input
                type="text"
                value={bug.text}
                onChange={(e) => setBug(i, { text: e.target.value })}
                maxLength={500}
                placeholder="What happened?"
                className={INPUT}
              />
              <select
                value={bug.severity}
                onChange={(e) =>
                  setBug(i, { severity: e.target.value as BugEntry["severity"] })
                }
                className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-2 text-sm text-zinc-100"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
              <button
                type="button"
                onClick={() => setBugs((prev) => prev.filter((_, j) => j !== i))}
                aria-label="Remove bug"
                className="rounded-md border border-zinc-800 px-3 text-zinc-500 hover:text-red-400"
              >
                ×
              </button>
            </div>
          ))}
          {bugs.length < 20 && (
            <button
              type="button"
              onClick={() =>
                setBugs((prev) => [...prev, { text: "", severity: "medium" }])
              }
              className="text-sm text-emerald-400 hover:text-emerald-300"
            >
              + Add a bug
            </button>
          )}
        </div>
      </div>

      <div>
        <label htmlFor="suggestions" className="text-sm font-medium text-zinc-200">
          Suggestions <span className="text-xs text-zinc-500">(optional)</span>
        </label>
        <textarea
          id="suggestions"
          name="suggestions"
          rows={3}
          maxLength={2000}
          placeholder="What would make the app better?"
          className={`mt-1.5 ${INPUT}`}
        />
      </div>

      <div>
        <label htmlFor="usage" className="text-sm font-medium text-zinc-200">
          How often did you use it?
        </label>
        <select
          id="usage"
          name="usage_frequency"
          required
          defaultValue=""
          className={`mt-1.5 ${INPUT}`}
        >
          <option value="" disabled>
            Pick one…
          </option>
          <option value="daily">Daily</option>
          <option value="few_weekly">A few times a week</option>
          <option value="rarely">Once or twice</option>
        </select>
      </div>

      {state.error && (
        <p className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-300">
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={isPending}
        className="w-full rounded-lg bg-emerald-600 px-6 py-3 font-semibold text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
      >
        {isPending
          ? "Submitting..."
          : type === "final"
            ? "Submit final feedback & complete the test"
            : "Submit mid-test feedback"}
      </button>
      <p className="text-center text-xs text-zinc-500">
        Feedback is immutable after submission (it&apos;s evidence for the
        developer&apos;s Google application) — you can add one addendum note
        later.
      </p>
    </form>
  );
}

// Write-once addendum on an existing (immutable) feedback.
export function AddendumForm({
  feedbackId,
  engagementId,
  requestId,
}: {
  feedbackId: string;
  engagementId: string;
  requestId: string;
}) {
  const [state, formAction, isPending] = useActionState<
    EngagementActionState,
    FormData
  >(addFeedbackAddendum, {});

  if (state.success) {
    return <p className="text-sm text-emerald-400">{state.success}</p>;
  }

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="feedback_id" value={feedbackId} />
      <input type="hidden" name="engagement_id" value={engagementId} />
      <input type="hidden" name="request_id" value={requestId} />
      {state.error && (
        <p className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-300">
          {state.error}
        </p>
      )}
      <textarea
        name="note"
        rows={2}
        required
        maxLength={1000}
        placeholder="Anything to add? (one addendum, write-once)"
        className={INPUT}
      />
      <button
        type="submit"
        disabled={isPending}
        className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 transition-colors hover:bg-zinc-800 disabled:opacity-50"
      >
        {isPending ? "Saving..." : "Add addendum"}
      </button>
    </form>
  );
}
