"use client";

import { useActionState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { publishRequest, type RequestFormState } from "@/app/requests/actions";

export function PublishSection({
  requestId,
  isFree,
  cost,
  balance,
}: {
  requestId: string;
  isFree: boolean;
  cost: number;
  balance: number;
}) {
  const [state, formAction, isPending] = useActionState<
    RequestFormState,
    FormData
  >(publishRequest, {});
  const router = useRouter();

  // Founding cap filled between render and click: the server refused (SPEC
  // Flow 6 transparent revert) — refresh so the real cost renders below.
  useEffect(() => {
    if (state.capReached) router.refresh();
  }, [state.capReached, router]);

  const shortfall = isFree ? 0 : Math.max(0, cost - balance);
  const blocked = shortfall > 0;

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
        Publish
      </h2>

      {isFree ? (
        <p className="mt-3 flex items-center gap-2 text-sm text-zinc-300">
          <span className="inline-flex items-center rounded-full border border-emerald-700 bg-emerald-950/60 px-2.5 py-0.5 text-xs font-medium text-emerald-300">
            Founding launch — free
          </span>
          Publishing costs 0 credits during the founding phase.
        </p>
      ) : (
        <p className="mt-3 text-sm text-zinc-300">
          Cost: <span className="font-semibold">{cost} credits</span>{" "}
          <span className="text-zinc-500">(1 per tester slot)</span> · Your
          balance: <span className="font-semibold">{balance}</span>
        </p>
      )}

      {state.error && (
        <p className="mt-3 rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-300">
          {state.error}
          {state.needCredits && (
            <>
              {" "}
              <Link
                href="/board"
                className="font-medium text-emerald-400 hover:text-emerald-300"
              >
                Earn by testing →
              </Link>
            </>
          )}
        </p>
      )}

      {blocked ? (
        <div className="mt-4">
          <button
            type="button"
            disabled
            className="w-full cursor-not-allowed rounded-lg bg-zinc-700 px-6 py-3 font-semibold text-zinc-400"
          >
            Publish request
          </button>
          <p className="mt-2 text-sm text-amber-400">
            You need {shortfall} more credit{shortfall === 1 ? "" : "s"}.{" "}
            <Link
              href="/board"
              className="font-medium text-emerald-400 hover:text-emerald-300"
            >
              Earn by testing →
            </Link>
          </p>
        </div>
      ) : (
        <form action={formAction} className="mt-4">
          <input type="hidden" name="request_id" value={requestId} />
          <input type="hidden" name="expect_free" value={isFree ? "1" : "0"} />
          <button
            type="submit"
            disabled={isPending}
            className="w-full rounded-lg bg-emerald-500 px-6 py-3 font-semibold text-zinc-950 transition-colors hover:bg-emerald-400 disabled:opacity-50"
          >
            {isPending ? "Publishing..." : "Publish request"}
          </button>
        </form>
      )}
    </div>
  );
}
