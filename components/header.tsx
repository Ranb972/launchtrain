import Image from "next/image";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "@/app/auth/actions";
import { BottomNav } from "@/components/bottom-nav";
import { NotificationBell } from "@/components/notification-bell";

export async function Header() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let profile: { display_name: string; avatar_url: string | null } | null =
    null;
  if (user) {
    const { data } = await supabase
      .from("users")
      .select("display_name, avatar_url")
      .eq("id", user.id)
      .single();
    profile = data;
  }

  return (
    <>
      <header className="border-b border-zinc-800">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-3 px-4">
          <Link href="/" className="shrink-0 text-lg font-bold tracking-tight">
            Launch<span className="text-emerald-400">Train</span>
          </Link>

          <nav className="flex min-w-0 items-center gap-4 text-sm sm:gap-5">
            {/* Text links live in the bottom nav on mobile (SPEC §8);
                guests keep Board here since the bottom nav is auth-only. */}
            <Link
              href="/board"
              className={`text-zinc-300 transition-colors hover:text-emerald-400 ${
                user ? "hidden sm:block" : ""
              }`}
            >
              Board
            </Link>
            {user ? (
              <>
                <Link
                  href="/dashboard"
                  className="hidden text-zinc-300 transition-colors hover:text-emerald-400 sm:block"
                >
                  Dashboard
                </Link>
                <Link
                  href="/settings"
                  className="hidden text-zinc-300 transition-colors hover:text-emerald-400 sm:block"
                >
                  Settings
                </Link>
                <NotificationBell />
                {profile?.avatar_url ? (
                  <Image
                    src={profile.avatar_url}
                    alt={profile.display_name}
                    width={28}
                    height={28}
                    className="shrink-0 rounded-full"
                  />
                ) : (
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-900 text-xs font-semibold text-emerald-300">
                    {(profile?.display_name ?? "?").charAt(0).toUpperCase()}
                  </span>
                )}
                <form action={signOut} className="hidden sm:block">
                  <button
                    type="submit"
                    className="text-zinc-500 transition-colors hover:text-zinc-200"
                  >
                    Sign out
                  </button>
                </form>
              </>
            ) : null}
          </nav>
        </div>
      </header>
      {user && <BottomNav />}
    </>
  );
}
