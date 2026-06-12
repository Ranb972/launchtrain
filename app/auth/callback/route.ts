import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      // New or incomplete users land on onboarding; everyone else on the dashboard.
      let destination = "/onboarding";
      if (user) {
        const { data: profile } = await supabase
          .from("users")
          .select("onboarded_at")
          .eq("id", user.id)
          .single();
        if (profile?.onboarded_at) {
          destination = "/dashboard";
        }
      }
      return NextResponse.redirect(`${origin}${destination}`);
    }
  }

  return NextResponse.redirect(`${origin}/auth/error`);
}
