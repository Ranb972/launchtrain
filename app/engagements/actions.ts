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
// createCheckin (SPEC Flow 4 step 2, §7 — tester)
// ------------------------------------------------------------

export async function createCheckin(
  _prev: EngagementActionState,
  formData: FormData,
): Promise<EngagementActionState> {
  const { supabase } = await requireOnboardedUser();

  const engagementId = String(formData.get("engagement_id") ?? "");
  const requestId = String(formData.get("request_id") ?? "");
  const status = String(formData.get("checkin_status") ?? "");
  const note = String(formData.get("note") ?? "").trim();

  if (status !== "ok" && status !== "issue") {
    return { error: "Pick how the app behaved today." };
  }
  if (status === "issue" && !note) {
    return { error: "Describe the issue you found — the note is required." };
  }

  const { data, error } = await supabase.rpc("create_checkin", {
    eng: engagementId,
    cstatus: status,
    note: note || null,
  });

  if (error) {
    return {
      error:
        mapRequestFunctionError(error.message) ??
        "Could not save the check-in. Please try again.",
    };
  }

  revalidateRequestPages(requestId);
  const recovered = jsonField(data, "recovered") === true;
  return {
    success: recovered
      ? "Checked in — welcome back! Your engagement is no longer at risk."
      : "Checked in for today. Next check-in unlocks at UTC midnight.",
  };
}

// ------------------------------------------------------------
// submitFeedback (SPEC Flow 4 steps 3–4, Flow 5 step 1, §7 — tester)
// ------------------------------------------------------------

export type BugEntry = { text: string; severity: "low" | "medium" | "high" };

function parseBugs(raw: string): BugEntry[] | null {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length > 20) return null;
    const bugs: BugEntry[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") return null;
      const text = String((item as Record<string, unknown>).text ?? "").trim();
      const severity = (item as Record<string, unknown>).severity;
      if (!text || text.length > 500) return null;
      if (severity !== "low" && severity !== "medium" && severity !== "high") {
        return null;
      }
      bugs.push({ text, severity });
    }
    return bugs;
  } catch {
    return null;
  }
}

export async function submitFeedback(
  _prev: EngagementActionState,
  formData: FormData,
): Promise<EngagementActionState> {
  const { supabase } = await requireOnboardedUser();

  const engagementId = String(formData.get("engagement_id") ?? "");
  const requestId = String(formData.get("request_id") ?? "");
  const ftype = String(formData.get("feedback_type") ?? "");
  const stability = Number(formData.get("stability"));
  const ux = Number(formData.get("ux"));
  const value = Number(formData.get("value"));
  const usage = String(formData.get("usage_frequency") ?? "");
  const suggestions = String(formData.get("suggestions") ?? "").trim();
  const bugs = parseBugs(String(formData.get("bugs") ?? ""));

  if (ftype !== "mid" && ftype !== "final") {
    return { error: "Unknown feedback type." };
  }
  for (const [label, v] of [
    ["Stability", stability],
    ["UX", ux],
    ["Value", value],
  ] as const) {
    if (!Number.isInteger(v) || v < 1 || v > 5) {
      return { error: `${label} needs a 1–5 rating.` };
    }
  }
  if (usage !== "daily" && usage !== "few_weekly" && usage !== "rarely") {
    return { error: "Pick how often you used the app." };
  }
  if (bugs === null) {
    return {
      error:
        "Each bug needs a short description and a severity (low / medium / high).",
    };
  }
  if (suggestions.length > 2000) {
    return { error: "Suggestions are limited to 2000 characters." };
  }

  const { data, error } = await supabase.rpc("submit_feedback", {
    eng: engagementId,
    ftype,
    stability,
    ux,
    value_score: value,
    bugs,
    suggestions: suggestions || null,
    usage_freq: usage,
  });

  if (error) {
    return {
      error:
        mapRequestFunctionError(error.message) ??
        "Could not submit the feedback. Please try again.",
    };
  }

  await dispatchNotificationEmails(notificationsFromResult(data));
  revalidateRequestPages(requestId);
  revalidatePath(`/engagements/${engagementId}/feedback`);

  return {
    success:
      jsonField(data, "completed") === true
        ? "completed" // the form renders the celebration state for this
        : "Mid-test feedback submitted — thank you! It's now in the developer's Feedback Hub.",
  };
}

// ------------------------------------------------------------
// addFeedbackAddendum (F4 edge case — tester, write-once)
// ------------------------------------------------------------

export async function addFeedbackAddendum(
  _prev: EngagementActionState,
  formData: FormData,
): Promise<EngagementActionState> {
  const { supabase } = await requireOnboardedUser();

  const feedbackId = String(formData.get("feedback_id") ?? "");
  const engagementId = String(formData.get("engagement_id") ?? "");
  const requestId = String(formData.get("request_id") ?? "");
  const note = String(formData.get("note") ?? "").trim();

  if (!note) return { error: "The addendum can't be empty." };
  if (note.length > 1000) {
    return { error: "The addendum is limited to 1000 characters." };
  }

  const { error } = await supabase.rpc("add_feedback_addendum", {
    fb: feedbackId,
    note,
  });

  if (error) {
    return {
      error:
        mapRequestFunctionError(error.message) ??
        "Could not save the addendum. Please try again.",
    };
  }

  revalidateRequestPages(requestId);
  revalidatePath(`/engagements/${engagementId}/feedback`);
  return { success: "Addendum saved — it now appears alongside your feedback." };
}

// ------------------------------------------------------------
// rateFeedback (SPEC Flow 5 step 2, §7 — request owner)
// ------------------------------------------------------------

export async function rateFeedback(
  _prev: EngagementActionState,
  formData: FormData,
): Promise<EngagementActionState> {
  const { supabase } = await requireOnboardedUser();

  const feedbackId = String(formData.get("feedback_id") ?? "");
  const requestId = String(formData.get("request_id") ?? "");
  const rating = String(formData.get("rating") ?? "");

  if (rating !== "helpful" && rating !== "not_helpful") {
    return { error: "Unknown rating." };
  }

  const { data, error } = await supabase.rpc("rate_feedback", {
    fb: feedbackId,
    rating,
  });

  if (error) {
    return {
      error:
        mapRequestFunctionError(error.message) ??
        "Could not save the rating. Please try again.",
    };
  }

  await dispatchNotificationEmails(notificationsFromResult(data));
  revalidateRequestPages(requestId);

  return {
    success:
      jsonField(data, "bonus") === 1
        ? "Rated helpful — a +1 bonus credit was sent to the tester."
        : "Rating saved.",
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
