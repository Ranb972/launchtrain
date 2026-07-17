"use client";

import { useActionState, useState } from "react";
import {
  confirmEngagement,
  requestReplacement,
  type EngagementActionState,
} from "@/app/engagements/actions";

// Per-row owner actions on the manage page (SPEC Flow 3 step 5, Flow 4).

export function ConfirmTesterButton({
  engagementId,
  requestId,
}: {
  engagementId: string;
  requestId: string;
}) {
  const [state, formAction, isPending] = useActionState<
    EngagementActionState,
    FormData
  >(confirmEngagement, {});

  return (
    <div>
      {state.error && (
        <p className="mb-2 rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-xs text-red-300">
          {state.error}
        </p>
      )}
      {state.success ? (
        <p className="text-xs font-medium text-emerald-400">{state.success}</p>
      ) : (
        <form action={formAction}>
          <input type="hidden" name="engagement_id" value={engagementId} />
          <input type="hidden" name="request_id" value={requestId} />
          <button
            type="submit"
            disabled={isPending}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
          >
            {isPending ? "Confirming..." : "Confirm"}
          </button>
        </form>
      )}
    </div>
  );
}

export function ReplacementButton({
  engagementId,
  requestId,
  isFounding,
  slotsAtMax,
}: {
  engagementId: string;
  requestId: string;
  isFounding: boolean;
  slotsAtMax: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, isPending] = useActionState<
    EngagementActionState,
    FormData
  >(requestReplacement, {});

  if (state.success) {
    return (
      <p className="text-xs font-medium text-emerald-400">{state.success}</p>
    );
  }

  if (slotsAtMax) {
    return (
      <p className="text-xs text-zinc-500">
        Replacement unavailable — this request is at the 20-slot maximum.
      </p>
    );
  }

  return (
    <div>
      {state.error && (
        <p className="mb-2 rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-xs text-red-300">
          {state.error}
        </p>
      )}
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-zinc-400">
            Opens one extra slot{isFounding ? "" : " (1 credit escrowed)"}{" "}
            without dropping this tester.
          </span>
          <form action={formAction}>
            <input type="hidden" name="engagement_id" value={engagementId} />
            <input type="hidden" name="request_id" value={requestId} />
            <button
              type="submit"
              disabled={isPending}
              className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-amber-500 disabled:opacity-50"
            >
              {isPending ? "Opening..." : "Open extra slot"}
            </button>
          </form>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={isPending}
            className="text-xs text-zinc-500 hover:text-zinc-300"
          >
            Never mind
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="rounded-lg border border-amber-800 px-3 py-1.5 text-xs font-semibold text-amber-400 transition-colors hover:bg-amber-950/50"
        >
          Request replacement
        </button>
      )}
    </div>
  );
}
