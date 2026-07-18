import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { EngagementStatusChip } from "@/components/engagement-status-chip";
import { StatusChip } from "@/components/status-chip";
import { TrackProgress } from "@/components/track-progress";
import {
  ENGAGEMENT_CLOCK_DAYS,
  engagementDay,
  pendingCancelEmphasized,
  timeAgoLabel,
} from "@/lib/clocks";

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const [{ data: profile }, { data: myRequests }, { data: myEngagements }] =
    await Promise.all([
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
      // My Tests (SPEC F3): live + completed engagements; dropped/cancelled
      // stay off the dashboard.
      supabase
        .from("engagements")
        .select("id, request_id, status, joined_at, opted_in_at, confirmed_at")
        .eq("tester_id", user.id)
        .in("status", ["pending_developer", "confirmed", "at_risk", "completed"])
        .order("joined_at", { ascending: false }),
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

  // App names for tested requests (RLS: published requests are readable).
  const tests = myEngagements ?? [];
  const testedRequestIds = [...new Set(tests.map((t) => t.request_id))];
  const testedApps = new Map<string, string>();
  if (testedRequestIds.length > 0) {
    const { data: testedRequests } = await supabase
      .from("test_requests")
      .select("id, app_name")
      .in("id", testedRequestIds);
    for (const r of testedRequests ?? []) {
      testedApps.set(r.id, r.app_name);
    }
  }
  const now = new Date();

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
        <section id="my-requests" className="scroll-mt-4">
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

        <section id="my-tests" className="scroll-mt-4">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
            My Tests
          </h3>
          {tests.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {tests.map((t) => {
                const day = t.confirmed_at
                  ? Math.min(
                      ENGAGEMENT_CLOCK_DAYS,
                      engagementDay(t.confirmed_at, now),
                    )
                  : 0;
                return (
                  <li
                    key={t.id}
                    className="rounded-xl border border-zinc-800 bg-zinc-900/50 px-4 py-3"
                  >
                    <Link
                      href={`/requests/${t.request_id}`}
                      className="flex items-center justify-between gap-3"
                    >
                      <span className="truncate text-sm font-semibold hover:text-emerald-400">
                        {testedApps.get(t.request_id) ?? "Test request"}
                      </span>
                      <EngagementStatusChip status={t.status} />
                    </Link>

                    {t.status === "pending_developer" ? (
                      <p className="mt-2 text-xs text-zinc-500">
                        {pendingCancelEmphasized(t.joined_at, now)
                          ? "Waiting 72h+ for the developer — you can cancel penalty-free."
                          : t.opted_in_at
                            ? "Opted in — waiting for the developer to confirm you."
                            : `Joined ${timeAgoLabel(t.joined_at, now)} — opt in, install, then mark it on the request page.`}
                      </p>
                    ) : (
                      <div className="mt-2.5">
                        <div className="flex items-baseline justify-between">
                          <span className="text-xs font-medium text-zinc-300">
                            Day {day}/{ENGAGEMENT_CLOCK_DAYS}
                          </span>
                          {t.status === "at_risk" && (
                            <span className="text-xs text-amber-400">
                              5 days inactive — open the app
                            </span>
                          )}
                        </div>
                        <div className="mt-1.5">
                          <TrackProgress day={day} />
                        </div>
                      </div>
                    )}

                    {t.status !== "completed" && (
                      <button
                        type="button"
                        disabled
                        title="Check-ins arrive with the next phase"
                        className="mt-3 w-full cursor-not-allowed rounded-lg border border-zinc-800 bg-zinc-800/40 px-4 py-2 text-xs font-semibold text-zinc-500"
                      >
                        Check in — arrives with the next phase
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="mt-3 rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">
              No active tests.{" "}
              <Link
                href="/board"
                className="text-emerald-400 hover:text-emerald-300"
              >
                Earn your first credit
              </Link>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
