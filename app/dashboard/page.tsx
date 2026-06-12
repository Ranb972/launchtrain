import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const { data: profile } = await supabase
    .from("users")
    .select("display_name")
    .eq("id", user.id)
    .single();

  return (
    <div>
      <h1 className="text-2xl font-bold">
        Welcome aboard{profile ? `, ${profile.display_name}` : ""}
      </h1>

      <div className="mt-8 grid gap-6 sm:grid-cols-2">
        <Link
          href="/requests/new"
          className="group rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 transition-colors hover:border-emerald-700"
        >
          <h2 className="text-lg font-semibold group-hover:text-emerald-400">
            Get your app tested →
          </h2>
          <p className="mt-2 text-sm text-zinc-400">
            Create a test request and recruit 12+ reliable testers for your
            14-day closed test.
          </p>
        </Link>

        <Link
          href="/board"
          className="group rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 transition-colors hover:border-emerald-700"
        >
          <h2 className="text-lg font-semibold group-hover:text-emerald-400">
            Test apps &amp; earn credits →
          </h2>
          <p className="mt-2 text-sm text-zinc-400">
            Join other developers&apos; tests, check in daily, and fund your
            own request.
          </p>
        </Link>
      </div>

      <div className="mt-12 grid gap-6 sm:grid-cols-2">
        <section>
          <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
            My Requests
          </h3>
          <div className="mt-3 rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">
            No requests yet.{" "}
            <Link
              href="/requests/new"
              className="text-emerald-400 hover:text-emerald-300"
            >
              Get your app tested
            </Link>
          </div>
        </section>

        <section>
          <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
            My Tests
          </h3>
          <div className="mt-3 rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">
            No active tests.{" "}
            <Link
              href="/board"
              className="text-emerald-400 hover:text-emerald-300"
            >
              Earn your first credit
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}
