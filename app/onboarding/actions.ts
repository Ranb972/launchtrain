"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { COUNTRY_CODES } from "@/lib/countries";
import {
  ANDROID_VERSION_MAX,
  ANDROID_VERSION_MIN,
  DISPLAY_NAME_MAX,
  EMAIL_RE,
  NON_ANDROID_MANUFACTURER_ERROR,
  NON_ANDROID_MANUFACTURER_RE,
  parseAndroidVersion,
  resolveManufacturer,
} from "@/lib/validation";

export type OnboardingState = { error?: string };

export async function completeOnboarding(
  _prev: OnboardingState,
  formData: FormData,
): Promise<OnboardingState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const { data: profile } = await supabase
    .from("users")
    .select("onboarded_at")
    .eq("id", user.id)
    .single();
  if (profile?.onboarded_at) redirect("/dashboard");

  const displayName = String(formData.get("display_name") ?? "").trim();
  const country = String(formData.get("country") ?? "");
  const testingEmail = String(formData.get("testing_email") ?? "").trim();

  if (!displayName || displayName.length > DISPLAY_NAME_MAX) {
    return { error: `Display name is required (max ${DISPLAY_NAME_MAX} characters).` };
  }
  if (!COUNTRY_CODES.has(country)) {
    return { error: "Please select your country." };
  }
  if (!EMAIL_RE.test(testingEmail)) {
    return { error: "Please enter a valid testing email address." };
  }

  const manufacturerChoices = formData.getAll("manufacturer").map(String);
  const manufacturerOthers = formData.getAll("manufacturer_other").map(String);
  const models = formData.getAll("model").map(String);
  const versions = formData.getAll("android_version").map(String);

  const devices: {
    manufacturer: string;
    model: string;
    android_version: number;
  }[] = [];
  for (let i = 0; i < manufacturerChoices.length; i++) {
    const choice = (manufacturerChoices[i] ?? "").trim();
    const model = (models[i] ?? "").trim();
    const versionRaw = (versions[i] ?? "").trim();
    if (!choice && !model && !versionRaw) continue; // fully empty row
    const manufacturer = resolveManufacturer(
      choice,
      manufacturerOthers[i] ?? "",
    );
    const androidVersion = parseAndroidVersion(versionRaw);
    if (!manufacturer || !model || androidVersion === null) {
      return {
        error: `Device ${i + 1} is incomplete — manufacturer, model, and an Android version between ${ANDROID_VERSION_MIN} and ${ANDROID_VERSION_MAX} are required.`,
      };
    }
    if (NON_ANDROID_MANUFACTURER_RE.test(manufacturer)) {
      return { error: NON_ANDROID_MANUFACTURER_ERROR };
    }
    devices.push({ manufacturer, model, android_version: androidVersion });
  }

  if (devices.length === 0) {
    return { error: "Add at least one device you can test with." };
  }

  // Make retries idempotent: clear any devices left by a failed earlier attempt
  // (the user is not onboarded yet, so no engagement can reference them).
  const { error: deleteError } = await supabase
    .from("devices")
    .delete()
    .eq("user_id", user.id);
  if (deleteError) {
    return { error: "Could not save your devices. Please try again." };
  }

  // Devices first: the DB guard refuses onboarded_at without at least one device.
  const { error: insertError } = await supabase
    .from("devices")
    .insert(devices.map((d) => ({ ...d, user_id: user.id })));
  if (insertError) {
    return { error: "Could not save your devices. Please try again." };
  }

  const { error: updateError } = await supabase
    .from("users")
    .update({
      display_name: displayName,
      country,
      testing_email: testingEmail,
      onboarded_at: new Date().toISOString(),
    })
    .eq("id", user.id);
  if (updateError) {
    return { error: "Could not complete onboarding. Please try again." };
  }

  redirect("/dashboard");
}
