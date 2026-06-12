import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { DeviceManager, ProfileForm } from "@/components/settings-forms";

const ACTIVE_ENGAGEMENT_STATUSES = [
  "pending_developer",
  "confirmed",
  "at_risk",
] as const;

export default async function SettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const [{ data: profile }, { data: devices }, { count: activeEngagements }] =
    await Promise.all([
      supabase
        .from("users")
        .select("display_name, country, testing_email, email")
        .eq("id", user.id)
        .single(),
      supabase
        .from("devices")
        .select("id, manufacturer, model, android_version")
        .eq("user_id", user.id)
        .order("created_at", { ascending: true }),
      supabase
        .from("engagements")
        .select("id", { count: "exact", head: true })
        .eq("tester_id", user.id)
        .in("status", [...ACTIVE_ENGAGEMENT_STATUSES]),
    ]);

  if (!profile) redirect("/");

  return (
    <div className="mx-auto max-w-lg">
      <h1 className="text-2xl font-bold">Settings</h1>

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Profile
        </h2>
        <p className="mt-1 text-xs text-zinc-500">
          Signed in as {profile.email}
        </p>
        <div className="mt-4">
          <ProfileForm
            profile={profile}
            testingEmailLocked={(activeEngagements ?? 0) > 0}
          />
        </div>
      </section>

      <section className="mt-12">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Devices
        </h2>
        <div className="mt-4">
          <DeviceManager devices={devices ?? []} />
        </div>
      </section>
    </div>
  );
}
