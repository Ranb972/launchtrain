import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");
  return { supabase, user };
}

// SPEC F1: every authenticated action is blocked until onboarding completes.
// The proxy gate is UX only — server actions are dispatched by action id, not
// by URL, so every mutating server action MUST call this guard itself.
export async function requireOnboardedUser() {
  const { supabase, user } = await requireUser();
  const { data: profile } = await supabase
    .from("users")
    .select("onboarded_at")
    .eq("id", user.id)
    .single();
  if (!profile?.onboarded_at) redirect("/onboarding");
  return { supabase, user };
}
