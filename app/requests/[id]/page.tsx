import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PublishSection } from "@/components/publish-section";
import { FoundingBadge, StatusChip } from "@/components/status-chip";
import { screenshotPaths, screenshotPublicUrl } from "@/lib/storage";

const CATEGORY_LABELS: Record<string, string> = {
  games: "Games",
  productivity: "Productivity",
  social: "Social",
  tools: "Tools",
  lifestyle: "Lifestyle",
  education: "Education",
  finance: "Finance",
  health: "Health",
  other: "Other",
};

type Params = Promise<{ id: string }>;

export async function generateMetadata({
  params,
}: {
  params: Params;
}): Promise<Metadata> {
  const { id } = await params;
  const supabase = await createClient();
  const { data: request } = await supabase
    .from("test_requests")
    .select("app_name, description")
    .eq("id", id)
    .maybeSingle();
  if (!request) return { title: "Test Request — LaunchTrain" };
  return {
    title: `${request.app_name} — closed test on LaunchTrain`,
    description: request.description,
  };
}

export default async function RequestPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Promise<{ upload?: string }>;
}) {
  const { id } = await params;
  const { upload } = await searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Guests read published requests; drafts are RLS-visible to the owner only.
  const { data: request } = await supabase
    .from("test_requests")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!request) notFound();

  const isOwner = user?.id === request.owner_id;
  const isDraft = request.status === "draft";

  const { data: slotRow } = await supabase
    .from("request_slot_counts")
    .select("confirmed_count")
    .eq("request_id", id)
    .maybeSingle();
  const confirmed = slotRow?.confirmed_count ?? 0;

  // Publish economics for the owner's draft preview (SPEC Flow 2 step 3).
  let publishProps: { isFree: boolean; cost: number; balance: number } | null =
    null;
  if (isOwner && isDraft) {
    const { data: configRows } = await supabase
      .from("system_config")
      .select("key, value")
      .in("key", [
        "founding_phase",
        "founding_cap",
        "founding_used",
        "credit_price_per_slot",
      ]);
    const cfg = Object.fromEntries(
      (configRows ?? []).map((r) => [r.key, r.value]),
    );
    const isFree =
      cfg.founding_phase === true &&
      Number(cfg.founding_used ?? 0) < Number(cfg.founding_cap ?? 0);
    const price = Number(cfg.credit_price_per_slot ?? 1);

    const { data: txs } = await supabase
      .from("credit_transactions")
      .select("amount")
      .eq("status", "settled");
    const balance = (txs ?? []).reduce((sum, t) => sum + t.amount, 0);

    publishProps = {
      isFree,
      cost: isFree ? 0 : request.slots_needed * price,
      balance,
    };
  }

  const shots = screenshotPaths(request.screenshots);

  return (
    <div className="mx-auto max-w-2xl">
      {isOwner && isDraft && (
        <div className="mb-6 rounded-md border border-amber-900 bg-amber-950/40 px-4 py-3 text-sm text-amber-300">
          Draft preview — this is how your request will appear once published.
          Only you can see it right now.
        </div>
      )}
      {upload === "failed" && (
        <div className="mb-6 rounded-md border border-amber-900 bg-amber-950/40 px-4 py-3 text-sm text-amber-300">
          One or more images failed to upload — the request was saved without
          them. You can retry from the edit form.
        </div>
      )}

      <div className="flex items-start gap-4">
        {request.icon_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={screenshotPublicUrl(request.icon_url)}
            alt={`${request.app_name} icon`}
            className="h-16 w-16 rounded-xl border border-zinc-800 object-cover"
          />
        ) : (
          <div className="flex h-16 w-16 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900 text-2xl">
            📱
          </div>
        )}
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">{request.app_name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center rounded-full border border-zinc-700 bg-zinc-800/60 px-2.5 py-0.5 text-xs font-medium text-zinc-300">
              {CATEGORY_LABELS[request.category] ?? request.category}
            </span>
            <StatusChip status={request.status} />
            {request.is_founding && <FoundingBadge />}
          </div>
        </div>
      </div>

      <p className="mt-6 text-zinc-300">{request.description}</p>

      <dl className="mt-6 grid grid-cols-2 gap-4 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-zinc-500">Tester slots</dt>
          <dd className="mt-1 font-semibold">
            {confirmed}/{request.slots_needed} filled
          </dd>
        </div>
        <div>
          <dt className="text-zinc-500">Min Android</dt>
          <dd className="mt-1 font-semibold">
            {request.min_android_version}+
          </dd>
        </div>
        <div>
          <dt className="text-zinc-500">Reward</dt>
          <dd className="mt-1 font-semibold">1 credit per completed test</dd>
        </div>
      </dl>

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
          What to test
        </h2>
        <p className="mt-2 whitespace-pre-line text-sm text-zinc-300">
          {request.instructions}
        </p>
      </section>

      {shots.length > 0 && (
        <section className="mt-8">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
            Screenshots
          </h2>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {shots.map((path) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={path}
                src={screenshotPublicUrl(path)}
                alt={`${request.app_name} screenshot`}
                className="w-full rounded-lg border border-zinc-800 object-cover"
              />
            ))}
          </div>
        </section>
      )}

      <div className="mt-10 space-y-4">
        {isOwner && isDraft && publishProps && (
          <>
            <PublishSection requestId={request.id} {...publishProps} />
            <Link
              href={`/requests/${request.id}/manage`}
              className="block text-center text-sm text-emerald-400 hover:text-emerald-300"
            >
              Edit draft →
            </Link>
          </>
        )}

        {isOwner && !isDraft && (
          <Link
            href={`/requests/${request.id}/manage`}
            className="block w-full rounded-lg border border-emerald-700 px-6 py-3 text-center font-semibold text-emerald-400 transition-colors hover:bg-emerald-950"
          >
            Manage this request →
          </Link>
        )}

        {!isOwner && !isDraft && (
          <div>
            <button
              type="button"
              disabled
              className="w-full cursor-not-allowed rounded-lg bg-zinc-700 px-6 py-3 font-semibold text-zinc-400"
            >
              Join this test
            </button>
            <p className="mt-2 text-center text-sm text-zinc-500">
              Joining opens in the next phase.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
