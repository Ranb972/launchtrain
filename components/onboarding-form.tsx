"use client";

import { useActionState, useState } from "react";
import {
  completeOnboarding,
  type OnboardingState,
} from "@/app/onboarding/actions";
import { COUNTRIES } from "@/lib/countries";

const INPUT =
  "w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-emerald-500 focus:outline-none";
const LABEL = "mb-1 block text-sm font-medium text-zinc-300";

export function OnboardingForm({
  defaultDisplayName,
  defaultTestingEmail,
}: {
  defaultDisplayName: string;
  defaultTestingEmail: string;
}) {
  const [state, formAction, isPending] = useActionState<
    OnboardingState,
    FormData
  >(completeOnboarding, {});
  const [deviceRows, setDeviceRows] = useState<number[]>([0]);
  const [nextRowId, setNextRowId] = useState(1);

  const addRow = () => {
    setDeviceRows((rows) => [...rows, nextRowId]);
    setNextRowId((id) => id + 1);
  };
  const removeRow = (rowId: number) => {
    setDeviceRows((rows) => rows.filter((id) => id !== rowId));
  };

  return (
    <form action={formAction} className="space-y-6">
      <div>
        <label htmlFor="display_name" className={LABEL}>
          Display name
        </label>
        <input
          id="display_name"
          name="display_name"
          type="text"
          required
          maxLength={80}
          defaultValue={defaultDisplayName}
          className={INPUT}
        />
      </div>

      <div>
        <label htmlFor="country" className={LABEL}>
          Country
        </label>
        <select
          id="country"
          name="country"
          required
          defaultValue=""
          className={INPUT}
        >
          <option value="" disabled>
            Select your country
          </option>
          {COUNTRIES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="testing_email" className={LABEL}>
          Testing email
        </label>
        <input
          id="testing_email"
          name="testing_email"
          type="email"
          required
          defaultValue={defaultTestingEmail}
          className={INPUT}
        />
        <p className="mt-1 text-xs text-zinc-500">
          The Gmail address you&apos;ll use to opt in to Play tests. Defaults
          to your login email.
        </p>
      </div>

      <fieldset>
        <legend className={LABEL}>Your devices</legend>
        <div className="space-y-3">
          {deviceRows.map((rowId, index) => (
            <div key={rowId} className="flex items-start gap-2">
              <div className="grid flex-1 grid-cols-3 gap-2">
                <input
                  name="manufacturer"
                  type="text"
                  placeholder="Manufacturer"
                  aria-label={`Device ${index + 1} manufacturer`}
                  className={INPUT}
                />
                <input
                  name="model"
                  type="text"
                  placeholder="Model"
                  aria-label={`Device ${index + 1} model`}
                  className={INPUT}
                />
                <input
                  name="android_version"
                  type="number"
                  min={1}
                  max={50}
                  placeholder="Android (e.g. 15)"
                  aria-label={`Device ${index + 1} Android version`}
                  className={INPUT}
                />
              </div>
              {deviceRows.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeRow(rowId)}
                  aria-label={`Remove device ${index + 1}`}
                  className="mt-2 text-sm text-zinc-500 hover:text-red-400"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={addRow}
          className="mt-3 text-sm text-emerald-400 hover:text-emerald-300"
        >
          + Add another device
        </button>
      </fieldset>

      {state.error && (
        <p className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-300">
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={isPending}
        className="w-full rounded-lg bg-emerald-500 px-6 py-3 font-semibold text-zinc-950 transition-colors hover:bg-emerald-400 disabled:opacity-50"
      >
        {isPending ? "Saving..." : "Complete onboarding"}
      </button>
    </form>
  );
}
