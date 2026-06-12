"use server";

import { revalidatePath } from "next/cache";
import { requireOnboardedUser } from "@/lib/auth";
import { COUNTRY_CODES } from "@/lib/countries";
import {
  DISPLAY_NAME_MAX,
  EMAIL_RE,
  parseAndroidVersion,
} from "@/lib/validation";

export type SettingsState = { error?: string; success?: string };

const ACTIVE_ENGAGEMENT_STATUSES = [
  "pending_developer",
  "confirmed",
  "at_risk",
] as const;

export async function updateProfile(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const { supabase, user } = await requireOnboardedUser();

  const displayName = String(formData.get("display_name") ?? "").trim();
  const country = String(formData.get("country") ?? "");
  const testingEmail = String(formData.get("testing_email") ?? "").trim();

  if (!displayName || displayName.length > DISPLAY_NAME_MAX) {
    return { error: `Display name is required (max ${DISPLAY_NAME_MAX} characters).` };
  }
  if (!COUNTRY_CODES.has(country)) {
    return { error: "Please select a valid country." };
  }
  if (!EMAIL_RE.test(testingEmail)) {
    return { error: "Please enter a valid testing email address." };
  }

  const { data: profile } = await supabase
    .from("users")
    .select("testing_email")
    .eq("id", user.id)
    .single();

  // SPEC F1 edge case: testing_email is frozen while any engagement is active
  // (it is already on developers' Play Console lists). A DB trigger backstops this.
  if (profile && testingEmail !== profile.testing_email) {
    const { count } = await supabase
      .from("engagements")
      .select("id", { count: "exact", head: true })
      .eq("tester_id", user.id)
      .in("status", [...ACTIVE_ENGAGEMENT_STATUSES]);
    if ((count ?? 0) > 0) {
      return {
        error:
          "Your testing email can't be changed while you have an active engagement.",
      };
    }
  }

  const { error } = await supabase
    .from("users")
    .update({
      display_name: displayName,
      country,
      testing_email: testingEmail,
    })
    .eq("id", user.id);

  if (error) {
    // The DB guard trigger fires when an engagement became active between
    // our check above and the update.
    if (error.message?.includes("testing_email")) {
      return {
        error:
          "Your testing email can't be changed while you have an active engagement.",
      };
    }
    return { error: "Could not update your profile. Please try again." };
  }

  revalidatePath("/settings");
  return { success: "Profile updated." };
}

export async function addDevice(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const { supabase, user } = await requireOnboardedUser();

  const manufacturer = String(formData.get("manufacturer") ?? "").trim();
  const model = String(formData.get("model") ?? "").trim();
  const androidVersion = parseAndroidVersion(
    String(formData.get("android_version") ?? "").trim(),
  );

  if (!manufacturer || !model || androidVersion === null) {
    return {
      error:
        "Manufacturer, model, and a valid Android version (1–50) are required.",
    };
  }

  const { error } = await supabase.from("devices").insert({
    user_id: user.id,
    manufacturer,
    model,
    android_version: androidVersion,
  });

  if (error) {
    return { error: "Could not add the device. Please try again." };
  }

  revalidatePath("/settings");
  return { success: "Device added." };
}

export async function removeDevice(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const { supabase, user } = await requireOnboardedUser();

  const deviceId = String(formData.get("device_id") ?? "");
  if (!deviceId) {
    return { error: "Missing device." };
  }

  // Keep the >=1 device invariant from onboarding (approved interpretation).
  // A DB trigger backstops this check against concurrent removals.
  const { count: deviceCount } = await supabase
    .from("devices")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id);
  if ((deviceCount ?? 0) <= 1) {
    return { error: "You need at least one device on your profile." };
  }

  // SPEC F1 edge case: a device linked to an active engagement can't be removed.
  const { count: activeCount } = await supabase
    .from("engagements")
    .select("id", { count: "exact", head: true })
    .eq("device_id", deviceId)
    .in("status", [...ACTIVE_ENGAGEMENT_STATUSES]);
  if ((activeCount ?? 0) > 0) {
    return {
      error: "This device is used by an active engagement and can't be removed.",
    };
  }

  const { data: deleted, error } = await supabase
    .from("devices")
    .delete()
    .eq("id", deviceId)
    .eq("user_id", user.id)
    .select("id");

  if (error) {
    // FK RESTRICT (23503): the device is referenced by a past engagement and
    // must be kept for the Dossier's device coverage records.
    if (error.code === "23503") {
      return {
        error:
          "This device is part of a completed test record and can't be removed.",
      };
    }
    if (error.message?.includes("at least one device")) {
      return { error: "You need at least one device on your profile." };
    }
    return { error: "Could not remove the device. Please try again." };
  }

  if (!deleted || deleted.length === 0) {
    return { error: "Device not found." };
  }

  revalidatePath("/settings");
  return { success: "Device removed." };
}
