import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { CancelSection } from "@/components/cancel-section";
import { EngagementStatusChip } from "@/components/engagement-status-chip";
import { FeedbackCard } from "@/components/feedback-card";
import { PublishedEditForm } from "@/components/published-edit-form";
import { RateFeedbackButtons } from "@/components/rate-feedback-buttons";
import { RequestForm } from "@/components/request-form";
import { SlotBuffer } from "@/components/slot-buffer";
import { FoundingBadge, StatusChip } from "@/components/status-chip";
import {
  ConfirmTesterButton,
  ReplacementButton,
} from "@/components/tester-actions";
import {
  engagementDayLabel,
  pendingCancelEmphasized,
  timeAgoLabel,
} from "@/lib/clocks";
import { CATEGORY_LABELS, SLOTS_MAX } from "@/lib/requests";

export const metadata = { title: "Manage Request — LaunchTrain" };

type Params = Promise<{ id: string }>;

export default async function ManageRequestPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Promise<{ published?: string }>;
}) {
  const { id } = await params;
  const { published } = await searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const { data: request } = await supabase
    .from("test_requests")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  // Non-owners get a 404, not a 403 — don't reveal the request exists.
  if (!request || request.owner_id !== user.id) notFound();

  const { data: slotRow } = await supabase
    .from("request_slot_counts")
    .select("confirmed_count, occupied_count")
    .eq("request_id", id)
    .maybeSingle();
  const confirmed = slotRow?.confirmed_count ?? 0;
  const occupied = slotRow?.occupied_count ?? 0;

  const isDraft = request.status === "draft";
  const isTerminal = ["completed", "cancelled", "expired"].includes(
    request.status,
  );
  const isPublished = !isDraft && !isTerminal;

  // Testers list (SPEC F2 manage page + F3): engagements with tester names
  // (public_profiles), devices (owner-visible via RLS), and — for email_list
  // requests — the testing email through the owner-scoped contacts view.
  const { data: engagements } = await supabase
    .from("engagements")
    .select("*")
    .eq("request_id", id)
    .order("joined_at", { ascending: true });
  const allEngagements = engagements ?? [];

  const testerIds = [...new Set(allEngagements.map((e) => e.tester_id))];
  const deviceIds = [...new Set(allEngagements.map((e) => e.device_id))];

  const [{ data: profiles }, { data: deviceRows }, { data: contacts }] =
    await Promise.all([
      testerIds.length > 0
        ? supabase
            .from("public_profiles")
            .select("id, display_name, reliability_score")
            .in("id", testerIds)
        : Promise.resolve({ data: [] as never[] }),
      deviceIds.length > 0
        ? supabase
            .from("devices")
            .select("id, manufacturer, model, android_version")
            .in("id", deviceIds)
        : Promise.resolve({ data: [] as never[] }),
      request.join_method === "email_list" && allEngagements.length > 0
        ? supabase
            .from("engagement_tester_contacts")
            .select("engagement_id, testing_email")
            .eq("request_id", id)
        : Promise.resolve({ data: [] as never[] }),
    ]);

  const profileById = new Map(
    (profiles ?? []).map((p) => [p.id, p] as const),
  );
  const deviceById = new Map(
    (deviceRows ?? []).map((d) => [d.id, d] as const),
  );
  const emailByEngagement = new Map(
    (contacts ?? []).map((c) => [c.engagement_id, c.testing_email] as const),
  );

  const activeEngagements = allEngagements.filter(
    (e) => !["dropped", "cancelled"].includes(e.status),
  );
  const formerEngagements = allEngagements.filter((e) =>
    ["dropped", "cancelled"].includes(e.status),
  );
  const now = new Date();

  // Feedback Hub (SPEC Flow 5): every incoming feedback + issue check-ins.
  const engagementIds = allEngagements.map((e) => e.id);
  const [{ data: feedbackRows }, { data: issueCheckins }] = await Promise.all([
    engagementIds.length > 0
      ? supabase
          .from("feedback")
          .select("*")
          .in("engagement_id", engagementIds)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] as never[] }),
    engagementIds.length > 0
      ? supabase
          .from("checkins")
          .select("engagement_id, note, created_at")
          .in("engagement_id", engagementIds)
          .eq("status", "issue")
          .order("created_at", { ascending: false })
          .limit(20)
      : Promise.resolve({ data: [] as never[] }),
  ]);
  const allFeedback = feedbackRows ?? [];
  const engagementById = new Map(allEngagements.map((e) => [e.id, e] as const));
  const finalCount = allFeedback.filter((f) => f.type === "final").length;
  const midCount = allFeedback.length - finalCount;

  return (
    <div className="mx-auto max-w-2xl">
      {published === "1" && (
        <div className="mb-6 rounded-md border border-emerald-900 bg-emerald-950/40 px-4 py-3 text-sm text-emerald-300">
          Published! Your request is now recruiting on the board
          {request.is_founding ? " — for free, as a founding request" : ""}.
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">{request.app_name}</h1>
        <StatusChip status={request.status} />
        {request.is_founding && <FoundingBadge />}
      </div>
      <p className="mt-1 text-sm text-zinc-500">
        {CATEGORY_LABELS[request.category]} · {request.package_name}
      </p>
      <Link
        href={`/requests/${request.id}`}
        className="mt-2 inline-block text-sm text-emerald-400 hover:text-emerald-300"
      >
        {isDraft ? "Preview & publish →" : "View public page →"}
      </Link>

      {!isDraft && (
        <section className="mt-8 space-y-4">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
            <SlotBuffer confirmed={confirmed} needed={request.slots_needed} />
            {occupied > confirmed && (
              <p className="mt-2 text-xs text-zinc-500">
                {occupied - confirmed} more{" "}
                {occupied - confirmed === 1 ? "tester is" : "testers are"}{" "}
                waiting for your confirmation below.
              </p>
            )}
          </div>
          <div
            className={`rounded-xl border p-5 ${
              request.status === "at_risk"
                ? "border-amber-900 bg-amber-950/30"
                : "border-zinc-800 bg-zinc-900/50"
            }`}
          >
            <p className="text-sm text-zinc-300">
              <span className="text-lg font-bold text-zinc-100">
                Streak day {Math.min(request.streak_days, 14)}
              </span>{" "}
              of 14
            </p>
            {request.status === "at_risk" && request.clock_started_at ? (
              <p className="mt-1 text-xs text-amber-300">
                Streak broken — the request fell below 12 confirmed testers and
                the counter reset to zero. Your request is boosted on the
                board; confirm new testers to restart the clock.
              </p>
            ) : request.status === "active" ? (
              <p className="mt-1 text-xs text-zinc-500">
                The Google clock is running: the streak advances at UTC
                midnight for every full day that holds 12+ confirmed testers.
              </p>
            ) : (
              <p className="mt-1 text-xs text-zinc-500">
                The 14-day streak starts once 12 testers are confirmed
                simultaneously.
              </p>
            )}
          </div>
        </section>
      )}

      {isPublished && (
        <section className="mt-8">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
            Testers
          </h2>

          {activeEngagements.length === 0 ? (
            <div className="mt-3 rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">
              No testers yet. Your request is on the board — testers who join
              appear here with Confirm buttons.
            </div>
          ) : (
            <ul className="mt-3 space-y-3">
              {activeEngagements.map((e) => {
                const profile = profileById.get(e.tester_id);
                const device = deviceById.get(e.device_id);
                const email = emailByEngagement.get(e.id);
                const waitingLong =
                  e.status === "pending_developer" &&
                  pendingCancelEmphasized(e.joined_at, now);
                return (
                  <li
                    key={e.id}
                    className={`rounded-xl border p-4 ${
                      waitingLong
                        ? "border-amber-900 bg-amber-950/20"
                        : "border-zinc-800 bg-zinc-900/50"
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">
                        {profile?.display_name ?? "Tester"}
                      </span>
                      <EngagementStatusChip status={e.status} />
                      {e.opted_in_at ? (
                        <span className="text-xs font-medium text-emerald-400">
                          ✓ opted in
                        </span>
                      ) : (
                        <span className="text-xs text-zinc-500">
                          not opted in yet
                        </span>
                      )}
                      <span className="ml-auto text-xs text-zinc-500">
                        {e.confirmed_at
                          ? engagementDayLabel(e.confirmed_at, now)
                          : `joined ${timeAgoLabel(e.joined_at, now)}`}
                      </span>
                    </div>

                    <p className="mt-1.5 text-xs text-zinc-400">
                      {device
                        ? `${device.manufacturer} ${device.model} · Android ${device.android_version}`
                        : "Device on file"}
                      {profile ? ` · reliability ${profile.reliability_score}` : ""}
                    </p>

                    {request.join_method === "email_list" && email && (
                      <p className="mt-2 rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2 font-mono text-xs text-zinc-300">
                        {email}
                        <span className="ml-2 font-sans text-zinc-500">
                          ← add this email in Play Console
                        </span>
                      </p>
                    )}

                    {e.status === "pending_developer" && (
                      <div className="mt-3">
                        {waitingLong && (
                          <p className="mb-2 text-xs text-amber-300">
                            Waiting 72h+ — this tester can now cancel without
                            penalty.
                          </p>
                        )}
                        <ConfirmTesterButton
                          engagementId={e.id}
                          requestId={request.id}
                        />
                      </div>
                    )}

                    {e.status === "at_risk" && (
                      <div className="mt-3">
                        {e.replacement_requested_at ? (
                          <p className="text-xs text-zinc-500">
                            ✓ Replacement slot already opened for this tester.
                          </p>
                        ) : (
                          <ReplacementButton
                            engagementId={e.id}
                            requestId={request.id}
                            isFounding={request.is_founding}
                            slotsAtMax={request.slots_needed >= SLOTS_MAX}
                          />
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {formerEngagements.length > 0 && (
            <details className="mt-4">
              <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-300">
                Former testers ({formerEngagements.length})
              </summary>
              <ul className="mt-2 space-y-1.5">
                {formerEngagements.map((e) => (
                  <li
                    key={e.id}
                    className="flex items-center gap-2 rounded-lg border border-zinc-800/60 bg-zinc-900/30 px-3 py-2 text-xs text-zinc-500"
                  >
                    <span>
                      {profileById.get(e.tester_id)?.display_name ?? "Tester"}
                    </span>
                    <EngagementStatusChip status={e.status} />
                    {e.ended_at && (
                      <span className="ml-auto">
                        left {timeAgoLabel(e.ended_at, now)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}

      {!isDraft && (allFeedback.length > 0 || (issueCheckins ?? []).length > 0) && (
        <section className="mt-10">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
            Feedback Hub
          </h2>
          <p className="mt-1 text-xs text-zinc-500">
            {finalCount} final · {midCount} mid-test — this evidence feeds the
            Submission Dossier{finalCount < 8 ? " (Google favors 8+ final feedbacks)" : ""}.
          </p>

          {(issueCheckins ?? []).length > 0 && (
            <div className="mt-4 rounded-xl border border-amber-900/50 bg-amber-950/20 p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-amber-400">
                Issues reported in check-ins
              </h3>
              <ul className="mt-2 space-y-1.5">
                {(issueCheckins ?? []).map((c, i) => {
                  const eng = engagementById.get(c.engagement_id);
                  return (
                    <li key={i} className="flex items-start gap-2 text-sm text-zinc-300">
                      <span className="shrink-0 text-zinc-500">
                        {eng
                          ? (profileById.get(eng.tester_id)?.display_name ?? "Tester")
                          : "Tester"}
                        :
                      </span>
                      <span className="min-w-0">{c.note}</span>
                      <span className="ml-auto shrink-0 text-xs text-zinc-600">
                        {timeAgoLabel(c.created_at, now)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <div className="mt-4 space-y-4">
            {allFeedback.map((f) => {
              const eng = engagementById.get(f.engagement_id);
              const tester = eng
                ? (profileById.get(eng.tester_id)?.display_name ?? "Tester")
                : "Tester";
              return (
                <div key={f.id}>
                  <div className="mb-1.5 flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-semibold">{tester}</span>
                    <span
                      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${
                        f.type === "final"
                          ? "border-emerald-800 bg-emerald-950/60 text-emerald-300"
                          : "border-zinc-700 bg-zinc-800/60 text-zinc-300"
                      }`}
                    >
                      {f.type === "final" ? "Final" : "Mid-test"}
                    </span>
                    {eng?.status === "completed" && (
                      <EngagementStatusChip status="completed" />
                    )}
                    <span className="ml-auto text-xs text-zinc-600">
                      {timeAgoLabel(f.created_at, now)}
                    </span>
                  </div>
                  <FeedbackCard feedback={f}>
                    {f.type === "final" ? (
                      f.developer_rating ? (
                        <p className="text-xs text-zinc-500">
                          {f.developer_rating === "helpful"
                            ? "✓ Rated helpful — +1 bonus credit sent to the tester."
                            : "Rated not helpful."}
                        </p>
                      ) : (
                        <RateFeedbackButtons
                          feedbackId={f.id}
                          requestId={request.id}
                        />
                      )
                    ) : null}
                  </FeedbackCard>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {!isTerminal && (
        <section className="mt-10">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
            {isDraft ? "Edit draft" : "Edit request"}
          </h2>

          {isDraft ? (
            <div className="mt-4">
              <RequestForm mode="edit-draft" request={request} />
            </div>
          ) : (
            <>
              <dl className="mt-4 grid grid-cols-1 gap-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 text-sm sm:grid-cols-2">
                {[
                  ["Package", request.package_name],
                  ["Join method", request.join_method === "email_list" ? "Email list" : "Google Group"],
                  ["Opt-in URL", request.opt_in_url],
                  ...(request.group_url
                    ? ([["Group URL", request.group_url]] as const)
                    : []),
                  ["Min Android", `${request.min_android_version}+`],
                  ["Category", CATEGORY_LABELS[request.category]],
                ].map(([label, value]) => (
                  <div key={label} className="min-w-0">
                    <dt className="text-zinc-500">{label}</dt>
                    <dd className="mt-0.5 truncate font-medium text-zinc-300">
                      {value}
                    </dd>
                  </div>
                ))}
                <p className="text-xs text-zinc-500 sm:col-span-2">
                  These fields are frozen after publish — cancel and republish
                  to change them.
                </p>
              </dl>
              <div className="mt-6">
                <PublishedEditForm request={request} />
              </div>
            </>
          )}
        </section>
      )}

      {!isTerminal && (
        <div className="mt-10">
          <CancelSection
            requestId={request.id}
            isDraft={isDraft}
            isFounding={request.is_founding}
          />
        </div>
      )}

      {isTerminal && (
        <p className="mt-8 rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 text-sm text-zinc-400">
          This request is closed. Its records are kept for your history
          {request.status === "completed" ? " and the Submission Dossier" : ""}
          .
        </p>
      )}
    </div>
  );
}
