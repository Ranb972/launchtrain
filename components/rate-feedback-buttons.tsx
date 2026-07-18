"use client";

import { useActionState } from "react";
import {
  rateFeedback,
  type EngagementActionState,
} from "@/app/engagements/actions";

// Flow 5 step 2: the developer rates a FINAL feedback once. Helpful mints a
// +1 bonus credit to the tester (idempotent — the DB never double-mints).
export function RateFeedbackButtons({
  feedbackId,
  requestId,
}: {
  feedbackId: string;
  requestId: string;
}) {
  const [state, formAction, isPending] = useActionState<
    EngagementActionState,
    FormData
  >(rateFeedback, {});

  if (state.success) {
    return <p className="text-xs font-medium text-emerald-400">{state.success}</p>;
  }

  return (
    <div>
      {state.error && (
        <p className="mb-2 rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-xs text-red-300">
          {state.error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-zinc-500">Was this feedback helpful?</span>
        <form action={formAction}>
          <input type="hidden" name="feedback_id" value={feedbackId} />
          <input type="hidden" name="request_id" value={requestId} />
          <input type="hidden" name="rating" value="helpful" />
          <button
            type="submit"
            disabled={isPending}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
          >
            Helpful (+1 credit to tester)
          </button>
        </form>
        <form action={formAction}>
          <input type="hidden" name="feedback_id" value={feedbackId} />
          <input type="hidden" name="request_id" value={requestId} />
          <input type="hidden" name="rating" value="not_helpful" />
          <button
            type="submit"
            disabled={isPending}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:bg-zinc-800"
          >
            Not helpful
          </button>
        </form>
      </div>
      <p className="mt-1 text-[11px] text-zinc-600">
        Ratings are final and can&apos;t be changed.
      </p>
    </div>
  );
}
