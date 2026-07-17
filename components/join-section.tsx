"use client";

import { useActionState, useState } from "react";
import { joinTest, type EngagementActionState } from "@/app/engagements/actions";

export type JoinDevice = {
  id: string;
  label: string; // "Samsung Galaxy S24 · Android 14"
  compatible: boolean;
};

// Device picker + Join button (SPEC Flow 3 step 2). Rendered only when the
// server-side eligibility pre-check passed; the DB function re-checks
// everything atomically, so a race (e.g. last slot taken) surfaces here as an
// error message.
export function JoinSection({
  requestId,
  devices,
  minAndroid,
}: {
  requestId: string;
  devices: JoinDevice[];
  minAndroid: number;
}) {
  const compatible = devices.filter((d) => d.compatible);
  const [selected, setSelected] = useState<string>(
    compatible.length === 1 ? compatible[0].id : "",
  );
  const [state, formAction, isPending] = useActionState<
    EngagementActionState,
    FormData
  >(joinTest, {});

  return (
    <form action={formAction} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <input type="hidden" name="request_id" value={requestId} />
      <input type="hidden" name="device_id" value={selected} />

      <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
        Join this test
      </h2>
      <p className="mt-1 text-sm text-zinc-400">
        Pick the device you&apos;ll test with (Android {minAndroid}+ required):
      </p>

      <div className="mt-3 space-y-2">
        {devices.map((d) => (
          <label
            key={d.id}
            className={`flex items-center gap-3 rounded-lg border px-4 py-2.5 text-sm ${
              d.compatible
                ? "cursor-pointer border-zinc-700 text-zinc-200 hover:border-emerald-700"
                : "cursor-not-allowed border-zinc-800 text-zinc-600"
            } ${selected === d.id ? "border-emerald-600 bg-emerald-950/30" : ""}`}
          >
            <input
              type="radio"
              name="device_choice"
              value={d.id}
              disabled={!d.compatible}
              checked={selected === d.id}
              onChange={() => setSelected(d.id)}
            />
            <span>{d.label}</span>
            {!d.compatible && (
              <span className="ml-auto text-xs">below Android {minAndroid}</span>
            )}
          </label>
        ))}
      </div>

      {state.error && (
        <p className="mt-3 rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-300">
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={isPending || selected === ""}
        className="mt-4 w-full rounded-lg bg-emerald-600 px-6 py-3 font-semibold text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isPending ? "Joining..." : "Join this test"}
      </button>
      <p className="mt-2 text-center text-xs text-zinc-500">
        You&apos;ll earn 1 credit after completing the 14-day test with final
        feedback.
      </p>
    </form>
  );
}
