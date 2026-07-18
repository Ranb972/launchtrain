import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { EngagementStatusChip } from "@/components/engagement-status-chip";
import { FeedbackCard } from "@/components/feedback-card";
import { AddendumForm, FeedbackForm } from "@/components/feedback-form";
import { engagementDay, feedbackGate } from "@/lib/clocks";

export const metadata = { title: "Feedback — LaunchTrain" };

type Params = Promise<{ id: string }>;

// Tester-side feedback page (SPEC Flow 5 step 1; §7 v1.7 addition).
// ?type=mid|final — defaults to final when it's due, else mid.
export default async function FeedbackPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Promise<{ type?: string }>;
}) {
  const { id } = await params;
  const { type: typeParam } = await searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const { data: engagement } = await supabase
    .from("engagements")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  // The form is tester-only; owners read feedback in their Feedback Hub.
  if (!engagement || engagement.tester_id !== user.id) notFound();

  const [{ data: request }, { data: feedbackRows }] = await Promise.all([
    supabase
      .from("test_requests")
      .select("id, app_name")
      .eq("id", engagement.request_id)
      .maybeSingle(),
    supabase
      .from("feedback")
      .select("*")
      .eq("engagement_id", id)
      .order("created_at"),
  ]);
  const appName = request?.app_name ?? "this app";

  const rows = feedbackRows ?? [];
  const existingByType = new Map(rows.map((f) => [f.type, f] as const));
  const now = new Date();
  const day = engagement.confirmed_at
    ? engagementDay(engagement.confirmed_at, now)
    : 0;

  const type: "mid" | "final" =
    typeParam === "mid" || typeParam === "final"
      ? typeParam
      : feedbackGate("final", day).allowed && !existingByType.has("final")
        ? "final"
        : "mid";

  const existing = existingByType.get(type);
  const isLive =
    engagement.status === "confirmed" || engagement.status === "at_risk";
  const gate = feedbackGate(type, day);

  return (
    <div className="mx-auto max-w-lg">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">
          {type === "final" ? "Final feedback" : "Mid-test feedback"}
        </h1>
        <EngagementStatusChip status={engagement.status} />
      </div>
      <p className="mt-1 text-sm text-zinc-500">
        {appName}
        {engagement.confirmed_at ? ` · Day ${day} of your test` : ""}
      </p>
      <Link
        href={`/requests/${engagement.request_id}`}
        className="mt-1 inline-block text-sm text-emerald-400 hover:text-emerald-300"
      >
        View the test request →
      </Link>

      {/* Toggle between the two forms */}
      <div className="mt-5 flex gap-2 text-sm">
        {(["mid", "final"] as const).map((t) => (
          <Link
            key={t}
            href={`/engagements/${id}/feedback?type=${t}`}
            className={`rounded-full border px-3 py-1 ${
              type === t
                ? "border-emerald-700 bg-emerald-950/50 text-emerald-300"
                : "border-zinc-800 text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {t === "mid" ? "Mid-test (day 7+)" : "Final (day 14+)"}
            {existingByType.has(t) ? " ✓" : ""}
          </Link>
        ))}
      </div>

      <div className="mt-6">
        {existing ? (
          <div className="space-y-3">
            <p className="text-sm text-zinc-400">
              Submitted — feedback is immutable (it&apos;s evidence for the
              developer&apos;s Google application).
            </p>
            <FeedbackCard feedback={existing}>
              {existing.addendum === null ? (
                <AddendumForm
                  feedbackId={existing.id}
                  engagementId={id}
                  requestId={engagement.request_id}
                />
              ) : null}
            </FeedbackCard>
            {engagement.status === "completed" && (
              <p className="rounded-lg border border-emerald-900 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-300">
                Test completed ✓ +1 credit released. Please stay opted in on
                Google Play until the request finishes its streak.
              </p>
            )}
          </div>
        ) : !isLive ? (
          <p className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 text-sm text-zinc-400">
            {engagement.status === "completed"
              ? "This test is already completed."
              : engagement.status === "pending_developer"
                ? "You'll be able to submit feedback once the developer confirms you."
                : "This engagement is closed."}
          </p>
        ) : !gate.allowed ? (
          <p className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 text-sm text-zinc-400">
            {type === "final" ? "Final" : "Mid-test"} feedback unlocks on day{" "}
            {gate.unlocksOnDay} of your test — you&apos;re on day{" "}
            {Math.max(1, day)}. Keep checking in daily until then.
          </p>
        ) : (
          <FeedbackForm
            engagementId={id}
            requestId={engagement.request_id}
            type={type}
            appName={appName}
          />
        )}
      </div>
    </div>
  );
}
