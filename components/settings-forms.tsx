"use client";

import { useActionState, useState } from "react";
import {
  addDevice,
  removeDevice,
  updateProfile,
  type SettingsState,
} from "@/app/settings/actions";
import { DeviceFields } from "@/components/device-fields";
import { COUNTRIES } from "@/lib/countries";

const INPUT =
  "w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-emerald-500 focus:outline-none disabled:opacity-50";
const LABEL = "mb-1 block text-sm font-medium text-zinc-300";

function Messages({ state }: { state: SettingsState }) {
  if (state.error) {
    return (
      <p className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-300">
        {state.error}
      </p>
    );
  }
  if (state.success) {
    return (
      <p className="rounded-md border border-emerald-900 bg-emerald-950/50 px-3 py-2 text-sm text-emerald-300">
        {state.success}
      </p>
    );
  }
  return null;
}

export function ProfileForm({
  profile,
  testingEmailLocked,
}: {
  profile: { display_name: string; country: string; testing_email: string };
  testingEmailLocked: boolean;
}) {
  const [state, formAction, isPending] = useActionState<
    SettingsState,
    FormData
  >(updateProfile, {});

  return (
    <form action={formAction} className="space-y-5">
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
          defaultValue={profile.display_name}
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
          defaultValue={profile.country}
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
          defaultValue={profile.testing_email}
          disabled={testingEmailLocked}
          className={INPUT}
        />
        {testingEmailLocked && (
          <p className="mt-1 text-xs text-amber-400">
            Locked while you have an active engagement — developers already
            have this address on their tester lists.
          </p>
        )}
        {/* keep the value submitted even when the input is disabled */}
        {testingEmailLocked && (
          <input
            type="hidden"
            name="testing_email"
            value={profile.testing_email}
          />
        )}
      </div>

      {/* Hidden while a save is in flight so a stale message never lingers. */}
      {!isPending && <Messages state={state} />}

      <button
        type="submit"
        disabled={isPending}
        className="rounded-lg bg-emerald-500 px-5 py-2 text-sm font-semibold text-zinc-950 transition-colors hover:bg-emerald-400 disabled:opacity-50"
      >
        {isPending ? "Saving..." : "Save profile"}
      </button>
    </form>
  );
}

export function DeviceManager({
  devices,
}: {
  devices: {
    id: string;
    manufacturer: string;
    model: string;
    android_version: number;
  }[];
}) {
  const [lastIntent, setLastIntent] = useState<"add" | "remove">("add");
  // One state for add AND remove: only the latest action's message exists,
  // and it is hidden while the next action is pending (stale-banner fix).
  const [state, deviceAction, isPending] = useActionState<
    SettingsState,
    FormData
  >((prev, formData) => {
    const intent = formData.get("intent") === "remove" ? "remove" : "add";
    setLastIntent(intent);
    return intent === "remove"
      ? removeDevice(prev, formData)
      : addDevice(prev, formData);
  }, {});

  return (
    <div className="space-y-5">
      <ul className="space-y-2">
        {devices.map((device) => (
          <li
            key={device.id}
            className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-sm"
          >
            <span>
              {device.manufacturer} {device.model}
              <span className="ml-2 text-zinc-500">
                Android {device.android_version}
              </span>
            </span>
            <form action={deviceAction}>
              <input type="hidden" name="intent" value="remove" />
              <input type="hidden" name="device_id" value={device.id} />
              <button
                type="submit"
                disabled={isPending}
                className="text-zinc-500 transition-colors hover:text-red-400 disabled:opacity-50"
              >
                Remove
              </button>
            </form>
          </li>
        ))}
      </ul>

      {!isPending && <Messages state={state} />}

      <form action={deviceAction} className="space-y-3">
        <input type="hidden" name="intent" value="add" />
        <DeviceFields ariaPrefix="New device" required />

        <button
          type="submit"
          disabled={isPending}
          className="rounded-lg border border-emerald-700 px-5 py-2 text-sm font-semibold text-emerald-400 transition-colors hover:bg-emerald-950 disabled:opacity-50"
        >
          {isPending && lastIntent === "add" ? "Adding..." : "+ Add device"}
        </button>
      </form>
    </div>
  );
}
