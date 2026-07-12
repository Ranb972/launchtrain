"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireOnboardedUser } from "@/lib/auth";
import {
  ALLOWED_IMAGE_TYPES,
  CATEGORIES,
  DESCRIPTION_MAX,
  GROUP_URL_PREFIX,
  IMAGE_MAX_BYTES,
  INSTRUCTIONS_MAX,
  MAX_SCREENSHOTS,
  OPT_IN_URL_PREFIX,
  SLOTS_MAX,
  SLOTS_MIN,
  extractPackageName,
  mapRequestFunctionError,
} from "@/lib/requests";
import { screenshotPaths } from "@/lib/storage";
import type { Database, Enums } from "@/lib/supabase/types";

export type RequestFormState = {
  error?: string;
  success?: string;
  // publish-flow flags the UI turns into dedicated affordances
  needCredits?: boolean;
  capReached?: boolean;
};

type Supabase = SupabaseClient<Database>;

const GENERIC_SAVE_ERROR = "Could not save the request. Please try again.";

// ------------------------------------------------------------
// field parsing shared by create and draft-edit
// ------------------------------------------------------------

type ParsedFields = {
  app_name: string;
  package_name: string;
  description: string;
  category: Enums<"request_category">;
  join_method: Enums<"join_method">;
  opt_in_url: string;
  group_url: string | null;
  instructions: string;
  min_android_version: number;
  slots_needed: number;
};

function parseRequestFields(
  formData: FormData,
): { values: ParsedFields } | { error: string } {
  const appName = String(formData.get("app_name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const category = String(formData.get("category") ?? "");
  const joinMethod = String(formData.get("join_method") ?? "");
  const optInUrl = String(formData.get("opt_in_url") ?? "").trim();
  const groupUrlRaw = String(formData.get("group_url") ?? "").trim();
  const instructions = String(formData.get("instructions") ?? "").trim();
  const minAndroid = Number(String(formData.get("min_android_version") ?? ""));
  const slots = Number(String(formData.get("slots_needed") ?? ""));

  if (!appName) return { error: "App name is required." };
  if (!description || description.length > DESCRIPTION_MAX) {
    return {
      error: `Short description is required (max ${DESCRIPTION_MAX} characters).`,
    };
  }
  if (!(CATEGORIES as string[]).includes(category)) {
    return { error: "Please pick a category." };
  }
  if (joinMethod !== "email_list" && joinMethod !== "google_group") {
    return { error: "Please pick how testers join." };
  }

  if (!optInUrl.startsWith(OPT_IN_URL_PREFIX)) {
    return {
      error: `Opt-in URL must start with ${OPT_IN_URL_PREFIX}`,
    };
  }
  const packageName = extractPackageName(optInUrl);
  if (!packageName) {
    return {
      error:
        "Couldn't extract a package name from the opt-in URL — it should end with your app's package (e.g. .../apps/testing/com.example.app).",
    };
  }

  let groupUrl: string | null = null;
  if (joinMethod === "google_group") {
    if (!groupUrlRaw.startsWith(GROUP_URL_PREFIX)) {
      return {
        error: `Google Group URL must start with ${GROUP_URL_PREFIX}`,
      };
    }
    groupUrl = groupUrlRaw;
  }

  if (!instructions || instructions.length > INSTRUCTIONS_MAX) {
    return {
      error: `Instructions for testers are required (max ${INSTRUCTIONS_MAX} characters).`,
    };
  }
  // Devices are 8–30 (SPEC §6), so a min outside that range is meaningless.
  if (!Number.isInteger(minAndroid) || minAndroid < 8 || minAndroid > 30) {
    return { error: "Minimum Android version must be between 8 and 30." };
  }
  if (!Number.isInteger(slots) || slots < SLOTS_MIN || slots > SLOTS_MAX) {
    return {
      error: `Tester slots must be between ${SLOTS_MIN} and ${SLOTS_MAX}.`,
    };
  }

  return {
    values: {
      app_name: appName,
      package_name: packageName,
      description,
      category: category as Enums<"request_category">,
      join_method: joinMethod as Enums<"join_method">,
      opt_in_url: optInUrl,
      group_url: groupUrl,
      instructions,
      min_android_version: minAndroid,
      slots_needed: slots,
    },
  };
}

// ------------------------------------------------------------
// image handling
// ------------------------------------------------------------

function pickFiles(formData: FormData, name: string): File[] {
  return formData
    .getAll(name)
    .filter((f): f is File => f instanceof File && f.size > 0);
}

function imageValidationError(files: File[], label: string): string | null {
  for (const f of files) {
    if (!ALLOWED_IMAGE_TYPES.includes(f.type)) {
      return `${label} must be a PNG, JPEG, or WebP image.`;
    }
    if (f.size > IMAGE_MAX_BYTES) {
      return `${label} must be 2 MB or smaller.`;
    }
  }
  return null;
}

function fileExt(type: string): string {
  return type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg";
}

// Uploads icon + screenshots for a request. Storage failures do NOT fail the
// save (SPEC Flow 2 error state: "request saves without the image + notice") —
// the caller surfaces `failed` as a notice.
async function uploadRequestImages(
  supabase: Supabase,
  userId: string,
  requestId: string,
  icon: File | null,
  shots: File[],
): Promise<{ iconPath: string | null; shotPaths: string[]; failed: boolean }> {
  let failed = false;
  let iconPath: string | null = null;
  const shotPaths: string[] = [];
  const stamp = Date.now();

  if (icon) {
    const path = `${userId}/${requestId}/icon-${stamp}.${fileExt(icon.type)}`;
    const { error } = await supabase.storage
      .from("screenshots")
      .upload(path, icon, { contentType: icon.type });
    if (error) failed = true;
    else iconPath = path;
  }

  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i];
    const path = `${userId}/${requestId}/shot-${stamp}-${i}.${fileExt(shot.type)}`;
    const { error } = await supabase.storage
      .from("screenshots")
      .upload(path, shot, { contentType: shot.type });
    if (error) failed = true;
    else shotPaths.push(path);
  }

  return { iconPath, shotPaths, failed };
}

// ------------------------------------------------------------
// createRequest (SPEC Flow 2 steps 1–2, §7)
// ------------------------------------------------------------

export async function createRequest(
  _prev: RequestFormState,
  formData: FormData,
): Promise<RequestFormState> {
  const { supabase, user } = await requireOnboardedUser();

  const parsed = parseRequestFields(formData);
  if ("error" in parsed) return { error: parsed.error };

  const icon = pickFiles(formData, "icon")[0] ?? null;
  const shots = pickFiles(formData, "screenshots");
  if (shots.length > MAX_SCREENSHOTS) {
    return { error: `Up to ${MAX_SCREENSHOTS} screenshots are allowed.` };
  }
  const imageError =
    (icon && imageValidationError([icon], "The icon")) ||
    imageValidationError(shots, "Each screenshot");
  if (imageError) return { error: imageError };

  const { data: created, error: insertError } = await supabase
    .from("test_requests")
    .insert({ owner_id: user.id, ...parsed.values })
    .select("id")
    .single();

  if (insertError || !created) {
    // Partial unique index: one non-terminal request per (owner, package).
    if (insertError?.code === "23505") {
      return { error: "You already have an active request for this app." };
    }
    return { error: GENERIC_SAVE_ERROR };
  }

  let uploadFailed = false;
  if (icon || shots.length > 0) {
    const uploaded = await uploadRequestImages(
      supabase,
      user.id,
      created.id,
      icon,
      shots,
    );
    uploadFailed = uploaded.failed;
    if (uploaded.iconPath || uploaded.shotPaths.length > 0) {
      const { error: imgError } = await supabase
        .from("test_requests")
        .update({
          icon_url: uploaded.iconPath,
          screenshots:
            uploaded.shotPaths.length > 0 ? uploaded.shotPaths : null,
        })
        .eq("id", created.id);
      if (imgError) uploadFailed = true;
    }
  }

  redirect(`/requests/${created.id}${uploadFailed ? "?upload=failed" : ""}`);
}

// ------------------------------------------------------------
// updateRequest — full edit for drafts; freeze rules after publish
// (SPEC F2 v1.5: only description / instructions / screenshots editable,
// slots grow-only via the escrow-backed DB function)
// ------------------------------------------------------------

export async function updateRequest(
  _prev: RequestFormState,
  formData: FormData,
): Promise<RequestFormState> {
  const { supabase, user } = await requireOnboardedUser();

  const requestId = String(formData.get("request_id") ?? "");
  const { data: request } = await supabase
    .from("test_requests")
    .select("*")
    .eq("id", requestId)
    .single();
  if (!request || request.owner_id !== user.id) {
    return { error: "Request not found." };
  }
  if (["completed", "cancelled", "expired"].includes(request.status)) {
    return { error: "This request is closed and can't be edited." };
  }

  // ---- images (shared by both branches) ----
  const icon = pickFiles(formData, "icon")[0] ?? null;
  const newShots = pickFiles(formData, "screenshots");
  const removePaths = new Set(
    formData.getAll("remove_screenshots").map(String),
  );
  const existingShots = screenshotPaths(request.screenshots).filter(
    (p) => !removePaths.has(p),
  );
  if (existingShots.length + newShots.length > MAX_SCREENSHOTS) {
    return {
      error: `Up to ${MAX_SCREENSHOTS} screenshots are allowed — remove one first.`,
    };
  }
  const imageError =
    (icon && imageValidationError([icon], "The icon")) ||
    imageValidationError(newShots, "Each screenshot");
  if (imageError) return { error: imageError };

  // ---- field patch ----
  let patch: Partial<ParsedFields> & {
    icon_url?: string | null;
    screenshots?: string[] | null;
  };

  if (request.status === "draft") {
    const parsed = parseRequestFields(formData);
    if ("error" in parsed) return { error: parsed.error };
    patch = { ...parsed.values };
  } else {
    // Published: parse ONLY the editable fields; frozen fields are not read
    // from the form at all (the DB trigger backstops crafted submissions).
    const description = String(formData.get("description") ?? "").trim();
    const instructions = String(formData.get("instructions") ?? "").trim();
    if (!description || description.length > DESCRIPTION_MAX) {
      return {
        error: `Short description is required (max ${DESCRIPTION_MAX} characters).`,
      };
    }
    if (!instructions || instructions.length > INSTRUCTIONS_MAX) {
      return {
        error: `Instructions for testers are required (max ${INSTRUCTIONS_MAX} characters).`,
      };
    }
    patch = { description, instructions };

    const slotsRaw = String(formData.get("slots_needed") ?? "").trim();
    if (slotsRaw !== "") {
      const slots = Number(slotsRaw);
      if (!Number.isInteger(slots) || slots > SLOTS_MAX) {
        return { error: `Tester slots must be between 1 and ${SLOTS_MAX}.` };
      }
      if (slots < request.slots_needed) {
        return {
          error: `Slots can grow but never shrink — this request already promises ${request.slots_needed}.`,
        };
      }
      if (slots > request.slots_needed) {
        // Escrow-backed growth: atomic spend_post/escrow_hold for the delta.
        const { error: growError } = await supabase.rpc("grow_request_slots", {
          req: requestId,
          new_slots: slots,
        });
        if (growError) {
          return {
            error:
              mapRequestFunctionError(growError.message) ?? GENERIC_SAVE_ERROR,
            needCredits: growError.message.includes("LT_INSUFFICIENT_CREDITS"),
          };
        }
      }
    }
  }

  // ---- uploads ----
  let uploadFailed = false;
  let uploadedShots: string[] = [];
  if (icon || newShots.length > 0) {
    const uploaded = await uploadRequestImages(
      supabase,
      user.id,
      requestId,
      icon,
      newShots,
    );
    uploadFailed = uploaded.failed;
    if (uploaded.iconPath) patch.icon_url = uploaded.iconPath;
    uploadedShots = uploaded.shotPaths;
  }

  const finalShots = [...existingShots, ...uploadedShots];
  if (
    removePaths.size > 0 ||
    uploadedShots.length > 0 ||
    request.status === "draft"
  ) {
    patch.screenshots = finalShots.length > 0 ? finalShots : null;
  }

  const { error: updateError } = await supabase
    .from("test_requests")
    .update(patch)
    .eq("id", requestId);

  if (updateError) {
    if (updateError.code === "23505") {
      return { error: "You already have an active request for this app." };
    }
    return {
      error: mapRequestFunctionError(updateError.message) ?? GENERIC_SAVE_ERROR,
    };
  }

  // Best-effort cleanup of removed files; orphans are harmless and the
  // request row is already consistent.
  if (removePaths.size > 0) {
    await supabase.storage.from("screenshots").remove([...removePaths]);
  }

  revalidatePath(`/requests/${requestId}`);
  revalidatePath(`/requests/${requestId}/manage`);
  revalidatePath("/board");
  return {
    success: uploadFailed
      ? "Saved, but an image failed to upload — you can retry from this form."
      : "Saved.",
  };
}

// ------------------------------------------------------------
// publishRequest (SPEC Flow 2 step 4, Flow 6, F6)
// ------------------------------------------------------------

export async function publishRequest(
  _prev: RequestFormState,
  formData: FormData,
): Promise<RequestFormState> {
  const { supabase } = await requireOnboardedUser();

  const requestId = String(formData.get("request_id") ?? "");
  // What the UI promised: "1" means the user was shown a free founding publish.
  const expectFree = formData.get("expect_free") === "1";

  const { error } = await supabase.rpc("publish_request", {
    req: requestId,
    expect_free: expectFree,
  });

  if (error) {
    return {
      error:
        mapRequestFunctionError(error.message) ??
        "Could not publish the request. Please try again.",
      needCredits: error.message.includes("LT_INSUFFICIENT_CREDITS"),
      capReached: error.message.includes("LT_FOUNDING_CAP_REACHED"),
    };
  }

  revalidatePath("/board");
  revalidatePath("/dashboard");
  revalidatePath(`/requests/${requestId}`);
  redirect(`/requests/${requestId}/manage?published=1`);
}

// ------------------------------------------------------------
// cancelRequest (SPEC F2 business logic)
// ------------------------------------------------------------

export async function cancelRequest(
  _prev: RequestFormState,
  formData: FormData,
): Promise<RequestFormState> {
  const { supabase } = await requireOnboardedUser();

  const requestId = String(formData.get("request_id") ?? "");
  const { data, error } = await supabase.rpc("cancel_request", {
    req: requestId,
  });

  if (error) {
    return {
      error:
        mapRequestFunctionError(error.message) ??
        "Could not cancel the request. Please try again.",
    };
  }

  const refund =
    data && typeof data === "object" && !Array.isArray(data)
      ? Number(data.refund ?? 0)
      : 0;

  revalidatePath("/board");
  revalidatePath("/dashboard");
  revalidatePath(`/requests/${requestId}`);
  revalidatePath(`/requests/${requestId}/manage`);
  return {
    success:
      refund > 0
        ? `Request cancelled. ${refund} credit${refund === 1 ? "" : "s"} refunded to your balance.`
        : "Request cancelled.",
  };
}
