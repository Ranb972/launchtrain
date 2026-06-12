import Image from "next/image";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "@/app/auth/actions";

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
    <header className="border-b border-zinc-800">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
        <Link href="/" className="text-lg font-bold tracking-tight">
          Launch<span className="text-emerald-400">Train</span>
        </Link>

        <nav className="flex items-center gap-5 text-sm">
          <Link
            href="/board"
            className="text-zinc-300 transition-colors hover:text-emerald-400"
          >
            Board
          </Link>
          {user ? (
            <>
            <Link
              href="/dashboard"
              className="text-zinc-300 transition-colors hover:text-emerald-400"
            >
              Dashboard
            </Link>
            <Link
              href="/settings"
              className="text-zinc-300 transition-colors hover:text-emerald-400"
            >
              Settings
            </Link>
            {profile?.avatar_url ? (
              <Image
                src={profile.avatar_url}
                alt={profile.display_name}
                width={28}
                height={28}
                className="rounded-full"
              />
            ) : (
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-900 text-xs font-semibold text-emerald-300">
                {(profile?.display_name ?? "?").charAt(0).toUpperCase()}
              </span>
            )}
            <form action={signOut}>
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
  );
}
