import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { OnboardingForm } from "@/components/onboarding-form";

export default async function OnboardingPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const { data: profile } = await supabase
    .from("users")
    .select("display_name, testing_email, onboarded_at")
    .eq("id", user.id)
    .single();
  if (profile?.onboarded_at) redirect("/dashboard");

  return (
    <div className="mx-auto max-w-lg">
      <h1 className="text-2xl font-bold">Welcome aboard</h1>
      <p className="mt-2 text-sm text-zinc-400">
        Complete your profile to start testing and recruiting testers. One
        step, one minute.
      </p>
      <div className="mt-8">
        <OnboardingForm
          defaultDisplayName={profile?.display_name ?? ""}
          defaultTestingEmail={profile?.testing_email ?? user.email ?? ""}
        />
      </div>
    </div>
  );
}
