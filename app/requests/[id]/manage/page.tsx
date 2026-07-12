import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { CancelSection } from "@/components/cancel-section";
import { PublishedEditForm } from "@/components/published-edit-form";
import { RequestForm } from "@/components/request-form";
import { SlotBuffer } from "@/components/slot-buffer";
import { FoundingBadge, StatusChip } from "@/components/status-chip";
import { CATEGORY_LABELS } from "@/lib/requests";

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
    .select("confirmed_count")
    .eq("request_id", id)
    .maybeSingle();
  const confirmed = slotRow?.confirmed_count ?? 0;

  const isDraft = request.status === "draft";
  const isTerminal = ["completed", "cancelled", "expired"].includes(
    request.status,
  );
  const isPublished = !isDraft && !isTerminal;

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
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
            <p className="text-sm text-zinc-300">
              <span className="text-lg font-bold text-zinc-100">
                Streak day {request.streak_days}
              </span>{" "}
              of 14
            </p>
            <p className="mt-1 text-xs text-zinc-500">
              The streak advances on every UTC day that holds 12+ confirmed
              testers. Daily tracking arrives with the engagement phase.
            </p>
          </div>
        </section>
      )}

      {isPublished && (
        <section className="mt-8">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
            Testers
          </h2>
          <div className="mt-3 rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">
            No testers yet — joining opens in the next phase. They&apos;ll
            appear here with Confirm buttons.
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
