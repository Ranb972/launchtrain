"use client";

import { useActionState, useState } from "react";
import { updateRequest, type RequestFormState } from "@/app/requests/actions";
import {
  ALLOWED_IMAGE_TYPES,
  DESCRIPTION_MAX,
  IMAGE_MAX_BYTES,
  INSTRUCTIONS_MAX,
  MAX_SCREENSHOTS,
  SLOTS_MAX,
} from "@/lib/requests";
import { screenshotPaths, screenshotPublicUrl } from "@/lib/storage";
import type { Tables } from "@/lib/supabase/types";

const INPUT =
  "w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-emerald-500 focus:outline-none";
const LABEL = "mb-1 block text-sm font-medium text-zinc-300";
const FILE_INPUT =
  "block w-full text-sm text-zinc-400 file:mr-3 file:rounded-md file:border file:border-zinc-700 file:bg-zinc-900 file:px-3 file:py-1.5 file:text-sm file:text-zinc-300 hover:file:border-emerald-700";

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

// Edit form for PUBLISHED requests — only the fields that stay editable under
// the SPEC F2 v1.5 freeze rules: description, instructions, screenshots/icon,
// and grow-only slots.
export function PublishedEditForm({
  request,
}: {
  request: Tables<"test_requests">;
}) {
  const [state, formAction, isPending] = useActionState<
    RequestFormState,
    FormData
  >(updateRequest, {});
  const [description, setDescription] = useState(request.description);
  const [instructions, setInstructions] = useState(request.instructions);
  const [iconError, setIconError] = useState<string | null>(null);
  const [shotsError, setShotsError] = useState<string | null>(null);

  const existingShots = screenshotPaths(request.screenshots);

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="request_id" value={request.id} />

      <div>
        <div className="flex items-end justify-between">
          <label htmlFor="description" className={LABEL}>
            Short description
          </label>
          <span
            className={`text-xs ${description.length > DESCRIPTION_MAX ? "text-red-400" : "text-zinc-500"}`}
          >
            {description.length}/{DESCRIPTION_MAX}
          </span>
        </div>
        <textarea
          id="description"
          name="description"
          required
          rows={3}
          maxLength={DESCRIPTION_MAX}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className={INPUT}
        />
      </div>

      <div>
        <div className="flex items-end justify-between">
          <label htmlFor="instructions" className={LABEL}>
            Instructions for testers
          </label>
          <span
            className={`text-xs ${instructions.length > INSTRUCTIONS_MAX ? "text-red-400" : "text-zinc-500"}`}
          >
            {instructions.length}/{INSTRUCTIONS_MAX}
          </span>
        </div>
        <textarea
          id="instructions"
          name="instructions"
          required
          rows={5}
          maxLength={INSTRUCTIONS_MAX}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
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
          min={request.slots_needed}
          max={SLOTS_MAX}
          defaultValue={request.slots_needed}
          className={`${INPUT} w-32`}
        />
        <p className="mt-1 text-xs text-zinc-500">
          Slots can grow (max {SLOTS_MAX}) but never shrink.{" "}
          {request.is_founding
            ? "Growing is free for founding requests."
            : "Each added slot costs 1 credit, held in escrow."}
        </p>
      </div>

      <div>
        <label htmlFor="icon" className={LABEL}>
          Replace icon{" "}
          <span className="font-normal text-zinc-500">(optional)</span>
        </label>
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
            (up to {MAX_SCREENSHOTS})
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
        className="rounded-lg bg-emerald-500 px-5 py-2 text-sm font-semibold text-zinc-950 transition-colors hover:bg-emerald-400 disabled:opacity-50"
      >
        {isPending ? "Saving..." : "Save changes"}
      </button>
    </form>
  );
}
