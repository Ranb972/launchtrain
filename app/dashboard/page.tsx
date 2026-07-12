import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { StatusChip } from "@/components/status-chip";

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const [{ data: profile }, { data: myRequests }] = await Promise.all([
    supabase
      .from("users")
      .select("display_name")
      .eq("id", user.id)
      .single(),
    supabase
      .from("test_requests")
      .select("id, app_name, status, slots_needed")
      .eq("owner_id", user.id)
      .order("created_at", { ascending: false }),
  ]);

  const requestIds = (myRequests ?? []).map((r) => r.id);
  const counts = new Map<string, number>();
  if (requestIds.length > 0) {
    const { data: slotRows } = await supabase
      .from("request_slot_counts")
      .select("request_id, confirmed_count")
      .in("request_id", requestIds);
    for (const row of slotRows ?? []) {
      counts.set(row.request_id, row.confirmed_count);
    }
  }

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
          {myRequests && myRequests.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {myRequests.map((request) => (
                <li key={request.id}>
                  <Link
                    href={`/requests/${request.id}/manage`}
                    className="flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900/50 px-4 py-3 transition-colors hover:border-emerald-700"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold">
                        {request.app_name}
                      </span>
                      <span className="mt-0.5 block text-xs text-zinc-500">
                        {request.status === "draft"
                          ? "Draft — continue setup"
                          : `${counts.get(request.id) ?? 0}/${request.slots_needed} slots confirmed`}
                      </span>
                    </span>
                    <StatusChip status={request.status} />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <div className="mt-3 rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">
              No requests yet.{" "}
              <Link
                href="/requests/new"
                className="text-emerald-400 hover:text-emerald-300"
              >
                Get your app tested
              </Link>
            </div>
          )}
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
