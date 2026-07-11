"use client";

import { useState } from "react";
import {
  ANDROID_VERSION_ERROR,
  ANDROID_VERSION_MAX,
  ANDROID_VERSION_MIN,
  DEVICE_MANUFACTURERS,
  MANUFACTURER_OTHER,
  parseAndroidVersion,
} from "@/lib/validation";

const INPUT =
  "w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-emerald-500 focus:outline-none";

// Device fields shared by the onboarding and settings forms (SPEC F1, Flow 1):
// curated manufacturer select ("Other" reveals a required free-text input),
// model, and Android version with a live inline range error.
//
// The "Other" input is always in the DOM (hidden via CSS when unused) so that
// FormData.getAll() arrays stay index-aligned across onboarding's device rows.
export function DeviceFields({
  ariaPrefix,
  required = false,
}: {
  ariaPrefix: string;
  required?: boolean;
}) {
  const [choice, setChoice] = useState("");
  const [version, setVersion] = useState("");
  const isOther = choice === MANUFACTURER_OTHER;
  const versionInvalid =
    version.trim() !== "" && parseAndroidVersion(version.trim()) === null;

  return (
    <div className="flex-1 space-y-2">
      <div className="grid grid-cols-3 gap-2">
        <select
          name="manufacturer"
          required={required}
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
          aria-label={`${ariaPrefix} manufacturer`}
          className={INPUT}
        >
          <option value="" disabled>
            Manufacturer
          </option>
          {DEVICE_MANUFACTURERS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
          <option value={MANUFACTURER_OTHER}>{MANUFACTURER_OTHER}</option>
        </select>
        <input
          name="model"
          type="text"
          required={required}
          placeholder="Model"
          aria-label={`${ariaPrefix} model`}
          className={INPUT}
        />
        <input
          name="android_version"
          type="number"
          required={required}
          min={ANDROID_VERSION_MIN}
          max={ANDROID_VERSION_MAX}
          value={version}
          onChange={(e) => setVersion(e.target.value)}
          placeholder={`Android (${ANDROID_VERSION_MIN}-${ANDROID_VERSION_MAX})`}
          aria-label={`${ariaPrefix} Android version`}
          className={INPUT}
        />
      </div>
      <input
        name="manufacturer_other"
        type="text"
        required={isOther}
        placeholder="Manufacturer name"
        aria-label={`${ariaPrefix} manufacturer (other)`}
        className={isOther ? INPUT : "hidden"}
      />
      {versionInvalid && (
        <p role="alert" className="text-xs text-red-400">
          {ANDROID_VERSION_ERROR}
        </p>
      )}
    </div>
  );
}
