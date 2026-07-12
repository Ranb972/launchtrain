"use client";

import { useActionState, useState } from "react";
import {
  createRequest,
  updateRequest,
  type RequestFormState,
} from "@/app/requests/actions";
import {
  ALLOWED_IMAGE_TYPES,
  CATEGORIES,
  DESCRIPTION_MAX,
  GROUP_URL_PREFIX,
  IMAGE_MAX_BYTES,
  INSTRUCTIONS_MAX,
  MAX_SCREENSHOTS,
  OPT_IN_URL_PREFIX,
  SLOTS_DEFAULT,
  SLOTS_EXPLAINER,
  SLOTS_MAX,
  SLOTS_MIN,
  extractPackageName,
} from "@/lib/requests";
import { screenshotPublicUrl } from "@/lib/storage";
import type { Enums, Tables } from "@/lib/supabase/types";

const INPUT =
  "w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-emerald-500 focus:outline-none";
const LABEL = "mb-1 block text-sm font-medium text-zinc-300";
const HINT = "mt-1 text-xs text-zinc-500";
const FILE_INPUT =
  "block w-full text-sm text-zinc-400 file:mr-3 file:rounded-md file:border file:border-zinc-700 file:bg-zinc-900 file:px-3 file:py-1.5 file:text-sm file:text-zinc-300 hover:file:border-emerald-700";

const CATEGORY_LABELS: Record<Enums<"request_category">, string> = {
  games: "Games",
  productivity: "Productivity",
  social: "Social",
  tools: "Tools",
  lifestyle: "Lifestyle",
  education: "Education",
  finance: "Finance",
  health: "Health",
  other: "Other",
};

function Counter({ value, max }: { value: number; max: number }) {
  return (
    <span
      className={`text-xs ${value > max ? "text-red-400" : "text-zinc-500"}`}
    >
      {value}/{max}
    </span>
  );
}

// Client-side image pre-check; the server action and the bucket both back
// this up.
function fileProblem(files: FileList | null, max: number): string | null {
  if (!files) return null;
  if (files.length > max) {
    return max === 1
      ? "Pick a single file."
      : `Up to ${max} screenshots are allowed.`;
  }
  for (const f of Array.from(files)) {
    if (!ALLOWED_IMAGE_TYPES.includes(f.type)) {
      return "Only PNG, JPEG, or WebP images are allowed.";
    }
    if (f.size > IMAGE_MAX_BYTES) {
      return "Each image must be 2 MB or smaller.";
    }
  }
  return null;
}

export function RequestForm({
  mode,
  request,
}: {
  mode: "create" | "edit-draft";
  request?: Tables<"test_requests">;
}) {
  const action = mode === "create" ? createRequest : updateRequest;
  const [state, formAction, isPending] = useActionState<
    RequestFormState,
    FormData
  >(action, {});

  const [joinMethod, setJoinMethod] = useState<string>(
    request?.join_method ?? "email_list",
  );
  const [optInUrl, setOptInUrl] = useState(request?.opt_in_url ?? "");
  const [description, setDescription] = useState(request?.description ?? "");
  const [instructions, setInstructions] = useState(
    request?.instructions ?? "",
  );
  const [iconError, setIconError] = useState<string | null>(null);
  const [shotsError, setShotsError] = useState<string | null>(null);

  const pkg = optInUrl ? extractPackageName(optInUrl) : null;
  const existingShots =
    request && Array.isArray(request.screenshots)
      ? request.screenshots.filter((p): p is string => typeof p === "string")
      : [];

  return (
    <form action={formAction} className="space-y-6">
      {mode === "edit-draft" && request && (
        <input type="hidden" name="request_id" value={request.id} />
      )}

      <div>
        <label htmlFor="app_name" className={LABEL}>
          App name
        </label>
        <input
          id="app_name"
          name="app_name"
          type="text"
          required
          maxLength={100}
          defaultValue={request?.app_name ?? ""}
          className={INPUT}
        />
      </div>

      <div>
        <div className="flex items-end justify-between">
          <label htmlFor="description" className={LABEL}>
            Short description
          </label>
          <Counter value={description.length} max={DESCRIPTION_MAX} />
        </div>
        <textarea
          id="description"
          name="description"
          required
          rows={3}
          maxLength={DESCRIPTION_MAX}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What your app does, in a couple of sentences."
          className={INPUT}
        />
      </div>

      <div>
        <label htmlFor="category" className={LABEL}>
          Category
        </label>
        <select
          id="category"
          name="category"
          required
          defaultValue={request?.category ?? ""}
          className={INPUT}
        >
          <option value="" disabled>
            Select a category
          </option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
      </div>

      <fieldset>
        <legend className={LABEL}>How do testers join?</legend>
        <div className="space-y-2">
          <label className="flex items-start gap-2 text-sm text-zinc-300">
            <input
              type="radio"
              name="join_method"
              value="email_list"
              checked={joinMethod === "email_list"}
              onChange={() => setJoinMethod("email_list")}
              className="mt-1"
            />
            <span>
              <span className="font-medium">Email list</span> — you add each
              tester&apos;s email in Play Console yourself.
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm text-zinc-300">
            <input
              type="radio"
              name="join_method"
              value="google_group"
              checked={joinMethod === "google_group"}
              onChange={() => setJoinMethod("google_group")}
              className="mt-1"
            />
            <span>
              <span className="font-medium">Google Group</span> — testers join
              your group themselves; the group is on the test track.
            </span>
          </label>
        </div>
      </fieldset>

      <div>
        <label htmlFor="opt_in_url" className={LABEL}>
          Opt-in URL
        </label>
        <input
          id="opt_in_url"
          name="opt_in_url"
          type="url"
          required
          value={optInUrl}
          onChange={(e) => setOptInUrl(e.target.value.trim())}
          placeholder={`${OPT_IN_URL_PREFIX}com.example.app`}
          className={INPUT}
        />
        {optInUrl === "" ? (
          <p className={HINT}>
            The web opt-in link from Play Console → your closed test → Testers
            tab.
          </p>
        ) : pkg ? (
          <p className="mt-1 text-xs text-emerald-400">Package: {pkg}</p>
        ) : (
          <p className="mt-1 text-xs text-red-400" role="alert">
            Must start with {OPT_IN_URL_PREFIX} and end with your app&apos;s
            package name.
          </p>
        )}
      </div>

      {joinMethod === "google_group" && (
        <div>
          <label htmlFor="group_url" className={LABEL}>
            Google Group URL
          </label>
          <input
            id="group_url"
            name="group_url"
            type="url"
            required
            defaultValue={request?.group_url ?? ""}
            placeholder={`${GROUP_URL_PREFIX}g/your-testers-group`}
            className={INPUT}
          />
        </div>
      )}

      <div>
        <div className="flex items-end justify-between">
          <label htmlFor="instructions" className={LABEL}>
            Instructions for testers
          </label>
          <Counter value={instructions.length} max={INSTRUCTIONS_MAX} />
        </div>
        <textarea
          id="instructions"
          name="instructions"
          required
          rows={5}
          maxLength={INSTRUCTIONS_MAX}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="What should testers focus on? Which flows matter? Where do you expect rough edges?"
          className={INPUT}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="min_android_version" className={LABEL}>
            Min Android version
          </label>
          <input
            id="min_android_version"
            name="min_android_version"
            type="number"
            required
            min={8}
            max={30}
            defaultValue={request?.min_android_version ?? 8}
            className={INPUT}
          />
        </div>
        <div>
          <label htmlFor="slots_needed" className={LABEL}>
            Tester slots
          </label>
          <input
            id="slots_needed"
            name="slots_needed"
            type="number"
            required
            min={SLOTS_MIN}
            max={SLOTS_MAX}
            defaultValue={request?.slots_needed ?? SLOTS_DEFAULT}
            className={INPUT}
          />
        </div>
      </div>
      <p className="-mt-3 text-xs text-zinc-500">{SLOTS_EXPLAINER}</p>

      <div>
        <label htmlFor="icon" className={LABEL}>
          App icon <span className="font-normal text-zinc-500">(optional)</span>
        </label>
        {request?.icon_url && (
          <p className={HINT}>
            Current icon is kept unless you pick a replacement.
          </p>
        )}
        <input
          id="icon"
          name="icon"
          type="file"
          accept={ALLOWED_IMAGE_TYPES.join(",")}
          onChange={(e) => setIconError(fileProblem(e.target.files, 1))}
          className={FILE_INPUT}
        />
        {iconError && (
          <p className="mt-1 text-xs text-red-400" role="alert">
            {iconError}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="screenshots" className={LABEL}>
          Screenshots{" "}
          <span className="font-normal text-zinc-500">
            (optional, up to {MAX_SCREENSHOTS})
          </span>
        </label>
        {existingShots.length > 0 && (
          <div className="mb-2 grid grid-cols-4 gap-2">
            {existingShots.map((path) => (
              <label key={path} className="block cursor-pointer text-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={screenshotPublicUrl(path)}
                  alt="Current screenshot"
                  className="h-24 w-full rounded-md border border-zinc-800 object-cover"
                />
                <span className="mt-1 inline-flex items-center gap-1 text-xs text-zinc-400">
                  <input
                    type="checkbox"
                    name="remove_screenshots"
                    value={path}
                  />
                  Remove
                </span>
              </label>
            ))}
          </div>
        )}
        <input
          id="screenshots"
          name="screenshots"
          type="file"
          multiple
          accept={ALLOWED_IMAGE_TYPES.join(",")}
          onChange={(e) =>
            setShotsError(fileProblem(e.target.files, MAX_SCREENSHOTS))
          }
          className={FILE_INPUT}
        />
        {shotsError && (
          <p className="mt-1 text-xs text-red-400" role="alert">
            {shotsError}
          </p>
        )}
      </div>

      {state.error && (
        <p className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-300">
          {state.error}
        </p>
      )}
      {state.success && (
        <p className="rounded-md border border-emerald-900 bg-emerald-950/50 px-3 py-2 text-sm text-emerald-300">
          {state.success}
        </p>
      )}

      <button
        type="submit"
        disabled={isPending || !!iconError || !!shotsError}
        className="w-full rounded-lg bg-emerald-500 px-6 py-3 font-semibold text-zinc-950 transition-colors hover:bg-emerald-400 disabled:opacity-50"
      >
        {isPending
          ? "Saving..."
          : mode === "create"
            ? "Save draft & preview"
            : "Save draft"}
      </button>
      {mode === "create" && (
        <p className="text-center text-xs text-zinc-500">
          Nothing is published yet — you&apos;ll review a preview first.
        </p>
      )}
    </form>
  );
}
