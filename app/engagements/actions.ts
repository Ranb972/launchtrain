"use server";

import { revalidatePath } from "next/cache";
import { requireOnboardedUser } from "@/lib/auth";
import { dispatchNotificationEmails, notificationsFromResult } from "@/lib/email";
import { mapRequestFunctionError } from "@/lib/requests";
import type { Json } from "@/lib/supabase/types";

// All five F3 transitions are SECURITY DEFINER Postgres functions (see the F3
// migration) invoked via RPC — the engagement state change, credit moves, and
// notification rows land in one DB transaction. These actions only map
// errors, dispatch the returned notification emails, and revalidate.

export type EngagementActionState = {
  error?: string;
  success?: string;
};

function jsonField(data: Json, key: string): Json | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  return (data as Record<string, Json | undefined>)[key];
}

function revalidateRequestPages(requestId: string) {
  revalidatePath(`/requests/${requestId}`);
  revalidatePath(`/requests/${requestId}/manage`);
  revalidatePath("/board");
  revalidatePath("/dashboard");
}

// ------------------------------------------------------------
// joinTest (SPEC Flow 3 steps 1–3, §7)
// ------------------------------------------------------------

export async function joinTest(
  _prev: EngagementActionState,
  formData: FormData,
): Promise<EngagementActionState> {
  const { supabase } = await requireOnboardedUser();

  const requestId = String(formData.get("request_id") ?? "");
  const deviceId = String(formData.get("device_id") ?? "");
  if (!deviceId) return { error: "Pick the device you'll test with." };

  const { data, error } = await supabase.rpc("join_test", {
    req: requestId,
    device: deviceId,
  });

  if (error) {
    return {
      error:
        mapRequestFunctionError(error.message) ??
        "Could not join this test. Please try again.",
    };
  }

  await dispatchNotificationEmails(notificationsFromResult(data));
  revalidateRequestPages(requestId);
  return { success: "joined" };
}

// ------------------------------------------------------------
// markOptedIn (SPEC Flow 3 step 4, §7)
// ------------------------------------------------------------

export async function markOptedIn(
  _prev: EngagementActionState,
  formData: FormData,
): Promise<EngagementActionState> {
  const { supabase } = await requireOnboardedUser();

  const engagementId = String(formData.get("engagement_id") ?? "");
  const requestId = String(formData.get("request_id") ?? "");

  const { error } = await supabase.rpc("mark_opted_in", { eng: engagementId });
  if (error) {
    return {
      error:
        mapRequestFunctionError(error.message) ??
        "Could not save. Please try again.",
    };
  }

  revalidateRequestPages(requestId);
  return { success: "Marked as opted in — the developer can now verify and confirm you." };
}

// ------------------------------------------------------------
// confirmEngagement (SPEC Flow 3 step 5, §7 — request owner)
// ------------------------------------------------------------

export async function confirmEngagement(
  _prev: EngagementActionState,
  formData: FormData,
): Promise<EngagementActionState> {
  const { supabase } = await requireOnboardedUser();

  const engagementId = String(formData.get("engagement_id") ?? "");
  const requestId = String(formData.get("request_id") ?? "");

  const { data, error } = await supabase.rpc("confirm_engagement", {
    eng: engagementId,
  });

  if (error) {
    return {
      error:
        mapRequestFunctionError(error.message) ??
        "Could not confirm this tester. Please try again.",
    };
  }

  await dispatchNotificationEmails(notificationsFromResult(data));
  revalidateRequestPages(requestId);

  const count = jsonField(data, "confirmed_count");
  return {
    success:
      typeof count === "number" && count >= 12
        ? `Tester confirmed — ${count} confirmed. The Google clock is running!`
        : "Tester confirmed — their personal 14-day clock started.",
  };
}

// ------------------------------------------------------------
// dropEngagement (Flow 3/4 error states, §7 — tester)
// ------------------------------------------------------------

export async function dropEngagement(
  _prev: EngagementActionState,
  formData: FormData,
): Promise<EngagementActionState> {
  const { supabase } = await requireOnboardedUser();

  const engagementId = String(formData.get("engagement_id") ?? "");
  const requestId = String(formData.get("request_id") ?? "");

  const { data, error } = await supabase.rpc("drop_engagement", {
    eng: engagementId,
  });

  if (error) {
    return {
      error:
        mapRequestFunctionError(error.message) ??
        "Could not leave this test. Please try again.",
    };
  }

  await dispatchNotificationEmails(notificationsFromResult(data));
  revalidateRequestPages(requestId);

  const outcome = jsonField(data, "outcome");
  const score = jsonField(data, "reliability_score");
  return {
    success:
      outcome === "cancelled"
        ? "You've withdrawn from this test — no reliability penalty."
        : `You've dropped out of this test. Your reliability score is now ${typeof score === "number" ? score : "reduced"}.`,
  };
}

// ------------------------------------------------------------
// requestReplacement (SPEC Flow 4 error state, §7 — request owner)
// ------------------------------------------------------------

export async function requestReplacement(
  _prev: EngagementActionState,
  formData: FormData,
): Promise<EngagementActionState> {
  const { supabase } = await requireOnboardedUser();

  const engagementId = String(formData.get("engagement_id") ?? "");
  const requestId = String(formData.get("request_id") ?? "");

  const { data, error } = await supabase.rpc("request_replacement", {
    eng: engagementId,
  });

  if (error) {
    return {
      error:
        mapRequestFunctionError(error.message) ??
        "Could not open a replacement slot. Please try again.",
    };
  }

  revalidateRequestPages(requestId);

  const cost = jsonField(data, "cost");
  const slots = jsonField(data, "slots");
  return {
    success: `Replacement slot opened — this request now has ${typeof slots === "number" ? slots : "an extra"} slots${typeof cost === "number" && cost > 0 ? ` (${cost} credit escrowed)` : ""}. The at-risk tester keeps their spot for now.`,
  };
}
