"use client";

import { useActionState, useState } from "react";
import {
  dropEngagement,
  markOptedIn,
  type EngagementActionState,
} from "@/app/engagements/actions";
import { EngagementStatusChip } from "@/components/engagement-status-chip";
import type { Enums } from "@/lib/supabase/types";

// The tester's view of their own engagement on the request page
// (SPEC Flow 3 steps 3–4 + the cancel/drop error states).
// Server passes computed display values; actions re-validate in the DB.
export type EngagementPanelProps = {
  engagement: {
    id: string;
    status: Enums<"engagement_status">;
    optedIn: boolean;
  };
  requestId: string;
  joinMethod: Enums<"join_method">;
  optInUrl: string;
  groupUrl: string | null;
  testingEmail: string; // the tester's own testing email
  dayLabel: string | null; // "Day 3/14" when confirmed, else null
  pendingOver72h: boolean; // developer unresponsive → amber emphasis (A5)
};

const LINK = "font-medium text-emerald-400 underline hover:text-emerald-300";

export function EngagementPanel(props: EngagementPanelProps) {
  const { engagement, requestId, joinMethod } = props;
  const [confirmingExit, setConfirmingExit] = useState(false);
  const [optState, optAction, optPending] = useActionState<
    EngagementActionState,
    FormData
  >(markOptedIn, {});
  const [dropState, dropAction, dropPending] = useActionState<
    EngagementActionState,
    FormData
  >(dropEngagement, {});

  const isPending = engagement.status === "pending_developer";
  const isLive =
    engagement.status === "confirmed" || engagement.status === "at_risk";

  if (dropState.success) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
        <p className="text-sm text-zinc-300">{dropState.success}</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Your engagement
        </h2>
        <div className="flex items-center gap-2">
          {props.dayLabel && (
            <span className="text-sm font-bold text-emerald-400">
              {props.dayLabel}
            </span>
          )}
          <EngagementStatusChip status={engagement.status} />
        </div>
      </div>

      {/* Status-specific headline */}
      {isPending && (
        <p className="mt-3 text-sm text-zinc-300">
          {joinMethod === "email_list"
            ? "Waiting for the developer to add you and confirm. They received your testing email."
            : "Waiting for the developer to confirm you in Play Console."}
        </p>
      )}
      {engagement.status === "confirmed" && (
        <p className="mt-3 text-sm text-zinc-300">
          You&apos;re confirmed — your personal 14-day clock is running. Keep
          the app installed, use it, and stay opted in.
        </p>
      )}
      {engagement.status === "at_risk" && (
        <p className="mt-3 rounded-md border border-amber-900 bg-amber-950/40 px-3 py-2 text-sm text-amber-300">
          Your engagement is marked at risk after 5 days without activity. Keep
          using the app — check-ins arrive with the next phase.
        </p>
      )}
      {engagement.status === "completed" && (
        <p className="mt-3 text-sm text-emerald-300">
          Test completed — thank you for staying the full 14 days.
        </p>
      )}

      {/* Join steps (Flow 3 step 3) */}
      {(isPending || isLive) && (
        <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm text-zinc-300">
          {joinMethod === "email_list" ? (
            <li>
              The developer adds your testing email{" "}
              <span className="font-mono text-xs text-zinc-400">
                {props.testingEmail}
              </span>{" "}
              to the closed-testing list in Play Console.
            </li>
          ) : (
            <li>
              Join the{" "}
              <a
                href={props.groupUrl ?? "#"}
                target="_blank"
                rel="noopener noreferrer"
                className={LINK}
              >
                Google Group
              </a>{" "}
              with your testing account{" "}
              <span className="font-mono text-xs text-zinc-400">
                {props.testingEmail}
              </span>
              .
            </li>
          )}
          <li>
            Opt in on the{" "}
            <a
              href={props.optInUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={LINK}
            >
              testing opt-in page
            </a>
            {joinMethod === "email_list"
              ? " (works once the developer has added you)"
              : ""}
            .
          </li>
          <li>Install the app from Google Play and start using it.</li>
        </ol>
      )}

      {/* Opt-in confirmation (Flow 3 step 4) */}
      {(isPending || isLive) &&
        (engagement.optedIn ? (
          <p className="mt-4 text-sm font-medium text-emerald-400">
            ✓ Opted in &amp; installed
          </p>
        ) : (
          <form action={optAction} className="mt-4">
            <input type="hidden" name="engagement_id" value={engagement.id} />
            <input type="hidden" name="request_id" value={requestId} />
            {optState.error && (
              <p className="mb-2 rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-300">
                {optState.error}
              </p>
            )}
            <button
              type="submit"
              disabled={optPending}
              className="w-full rounded-lg bg-emerald-600 px-6 py-2.5 font-semibold text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
            >
              {optPending ? "Saving..." : "I've opted in & installed"}
            </button>
          </form>
        ))}

      {/* 72h developer-unresponsive emphasis (approved A5) */}
      {isPending && props.pendingOver72h && (
        <p className="mt-4 rounded-md border border-amber-900 bg-amber-950/40 px-3 py-2 text-sm text-amber-300">
          The developer hasn&apos;t confirmed you within 72 hours. You can
          cancel below without any penalty.
        </p>
      )}

      {/* Exit affordances: withdraw (pending, free) / drop (live, −15) */}
      {(isPending || isLive) && (
        <div className="mt-5 border-t border-zinc-800 pt-4">
          {dropState.error && (
            <p className="mb-3 rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-300">
              {dropState.error}
            </p>
          )}
          {confirmingExit ? (
            <div>
              <p className="text-sm text-zinc-300">
                {isPending
                  ? "Withdraw from this test? The slot reopens for someone else. No reliability penalty."
                  : "Drop out of this test? The slot reopens, you forfeit the escrowed credit, and your reliability score takes −15. If this brings the request below 12 confirmed testers, its streak resets."}
              </p>
              <div className="mt-3 flex gap-3">
                <form action={dropAction}>
                  <input
                    type="hidden"
                    name="engagement_id"
                    value={engagement.id}
                  />
                  <input type="hidden" name="request_id" value={requestId} />
                  <button
                    type="submit"
                    disabled={dropPending}
                    className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-500 disabled:opacity-50"
                  >
                    {dropPending
                      ? "Leaving..."
                      : isPending
                        ? "Yes, withdraw"
                        : "Yes, drop out"}
                  </button>
                </form>
                <button
                  type="button"
                  onClick={() => setConfirmingExit(false)}
                  disabled={dropPending}
                  className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 transition-colors hover:bg-zinc-800"
                >
                  Stay
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingExit(true)}
              className={`text-sm ${
                isPending && props.pendingOver72h
                  ? "font-semibold text-amber-400 hover:text-amber-300"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {isPending ? "Withdraw from this test" : "Drop out of this test"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
