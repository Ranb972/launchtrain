"use client";

import { useActionState, useState } from "react";
import { cancelRequest, type RequestFormState } from "@/app/requests/actions";

export function CancelSection({
  requestId,
  isDraft,
  isFounding,
}: {
  requestId: string;
  isDraft: boolean;
  isFounding: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, isPending] = useActionState<
    RequestFormState,
    FormData
  >(cancelRequest, {});

  const consequence = isDraft
    ? "This discards the draft. The package name becomes available for a new request."
    : isFounding
      ? "This takes the request off the board. Confirmed testers (if any) are released their credit immediately."
      : "This takes the request off the board. Confirmed testers (if any) are released their credit immediately, and every unfilled slot is refunded to your balance.";

  if (state.success) {
    return (
      <p className="rounded-md border border-emerald-900 bg-emerald-950/50 px-3 py-2 text-sm text-emerald-300">
        {state.success}
      </p>
    );
  }

  return (
    <div className="rounded-xl border border-red-900/50 bg-red-950/20 p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-red-400">
        Danger zone
      </h2>

      {state.error && (
        <p className="mt-3 rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-300">
          {state.error}
        </p>
      )}

      {confirming ? (
        <div className="mt-3">
          <p className="text-sm text-zinc-300">{consequence}</p>
          <div className="mt-3 flex gap-3">
            <form action={formAction}>
              <input type="hidden" name="request_id" value={requestId} />
              <button
                type="submit"
                disabled={isPending}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-500 disabled:opacity-50"
              >
                {isPending ? "Cancelling..." : "Yes, cancel this request"}
              </button>
            </form>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={isPending}
              className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 transition-colors hover:bg-zinc-800"
            >
              Keep it
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="mt-3 rounded-lg border border-red-800 px-4 py-2 text-sm font-semibold text-red-400 transition-colors hover:bg-red-950/50"
        >
          Cancel this request
        </button>
      )}
    </div>
  );
}
