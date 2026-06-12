import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "./types";

// Routes that require a session. Public: /, /board, /requests/[id], /profile/[id].
const PROTECTED_PREFIXES = [
  "/dashboard",
  "/settings",
  "/onboarding",
  "/credits",
  "/admin",
];

function isProtectedPath(pathname: string): boolean {
  if (
    PROTECTED_PREFIXES.some(
      (p) => pathname === p || pathname.startsWith(`${p}/`),
    )
  ) {
    return true;
  }
  if (pathname === "/requests/new") return true;
  // /requests/[id]/manage and /requests/[id]/dossier are owner-only pages
  if (/^\/requests\/[^/]+\/(manage|dossier)(\/|$)/.test(pathname)) return true;
  return false;
}

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Do not run code between createServerClient and auth.getUser() —
  // it can cause hard-to-debug session desync issues.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  // Any redirect must carry the refreshed auth cookies, or the session is lost.
  const redirectWithCookies = (path: string) => {
    const url = request.nextUrl.clone();
    url.pathname = path;
    url.search = "";
    const redirect = NextResponse.redirect(url);
    supabaseResponse.cookies
      .getAll()
      .forEach((cookie) => redirect.cookies.set(cookie));
    return redirect;
  };

  if (!user) {
    if (isProtectedPath(pathname)) {
      return redirectWithCookies("/");
    }
    return supabaseResponse;
  }

  // Onboarding gate (SPEC F1): no authenticated action before onboarding
  // completes. Only checked where it matters, to avoid a DB query per request.
  if (isProtectedPath(pathname)) {
    const { data: profile } = await supabase
      .from("users")
      .select("onboarded_at")
      .eq("id", user.id)
      .single();

    const onboarded = Boolean(profile?.onboarded_at);

    if (!onboarded && pathname !== "/onboarding") {
      return redirectWithCookies("/onboarding");
    }
    if (onboarded && pathname === "/onboarding") {
      return redirectWithCookies("/dashboard");
    }
  }

  return supabaseResponse;
}
