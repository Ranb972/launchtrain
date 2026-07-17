import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { signInWithGoogle } from "@/app/auth/actions";
import { EngagementPanel } from "@/components/engagement-panel";
import { JoinSection, type JoinDevice } from "@/components/join-section";
import { PublishSection } from "@/components/publish-section";
import { FoundingBadge, StatusChip } from "@/components/status-chip";
import {
  engagementDayLabel,
  joinEligibility,
  pendingCancelEmphasized,
} from "@/lib/clocks";
import { CATEGORY_LABELS } from "@/lib/requests";
import { screenshotPaths, screenshotPublicUrl } from "@/lib/storage";
import type { Tables } from "@/lib/supabase/types";

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

const TERMINAL_ENGAGEMENT = ["dropped", "cancelled"] as const;

// The tester-side join/engagement area (SPEC Flow 3). Server-side eligibility
// pre-render mirrors the authoritative join_test DB checks (lib/clocks.ts).
async function JoinArea({
  request,
  userId,
  occupied,
}: {
  request: Tables<"test_requests">;
  userId: string | null;
  occupied: number;
}) {
  const supabase = await createClient();

  if (!userId) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 text-center">
        <form action={signInWithGoogle}>
          <button
            type="submit"
            className="w-full rounded-lg bg-emerald-600 px-6 py-3 font-semibold text-white transition-colors hover:bg-emerald-500"
          >
            Sign in with Google to join
          </button>
        </form>
        <p className="mt-2 text-sm text-zinc-500">
          Test this app for 14 days and earn 1 credit toward your own request.
        </p>
      </div>
    );
  }

  const [{ data: profile }, { data: devices }, { data: engagementRows }] =
    await Promise.all([
      supabase
        .from("users")
        .select(
          "onboarded_at, reliability_score, join_blocked_until, testing_email",
        )
        .eq("id", userId)
        .single(),
      supabase
        .from("devices")
        .select("id, manufacturer, model, android_version")
        .eq("user_id", userId)
        .order("android_version", { ascending: false }),
      supabase
        .from("engagements")
        .select("id, status, joined_at, opted_in_at, confirmed_at")
        .eq("request_id", request.id)
        .eq("tester_id", userId)
        .order("joined_at", { ascending: false }),
    ]);

  if (!profile?.onboarded_at) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 text-center text-sm text-zinc-300">
        <Link
          href="/onboarding"
          className="font-semibold text-emerald-400 hover:text-emerald-300"
        >
          Finish onboarding →
        </Link>{" "}
        to join tests and earn credits.
      </div>
    );
  }

  const rows = engagementRows ?? [];
  const live = rows.find(
    (e) => !(TERMINAL_ENGAGEMENT as readonly string[]).includes(e.status),
  );

  if (live) {
    const now = new Date();
    return (
      <EngagementPanel
        engagement={{
          id: live.id,
          status: live.status,
          optedIn: live.opted_in_at !== null,
        }}
        requestId={request.id}
        joinMethod={request.join_method}
        optInUrl={request.opt_in_url}
        groupUrl={request.group_url}
        testingEmail={profile.testing_email}
        dayLabel={
          live.confirmed_at ? engagementDayLabel(live.confirmed_at, now) : null
        }
        pendingOver72h={
          live.status === "pending_developer" &&
          pendingCancelEmphasized(live.joined_at, now)
        }
      />
    );
  }

  const deviceList = devices ?? [];
  const eligibility = joinEligibility({
    requestStatus: request.status,
    isOwner: false,
    reliabilityScore: profile.reliability_score,
    joinBlockedUntil: profile.join_blocked_until,
    deviceVersions: deviceList.map((d) => d.android_version),
    minAndroidVersion: request.min_android_version,
    alreadyJoined: false,
    occupiedCount: occupied,
    slotsNeeded: request.slots_needed,
    now: new Date(),
  });

  if (!eligibility.ok) {
    const message =
      eligibility.reason === "not_joinable"
        ? "This test isn't accepting new testers."
        : eligibility.reason === "reliability_low"
          ? `Your reliability score (${profile.reliability_score}) is below 60 — complete your active tests to raise it.`
          : eligibility.reason === "cooldown"
            ? `After a recent drop you're in a join cooldown until ${profile.join_blocked_until?.slice(0, 10)} (UTC).`
            : eligibility.reason === "no_compatible_device"
              ? `None of your devices runs Android ${request.min_android_version}+.`
              : eligibility.reason === "full"
                ? "This test is full — every slot is taken."
                : "You can't join this test right now.";

    return (
      <div>
        <button
          type="button"
          disabled
          className="w-full cursor-not-allowed rounded-lg bg-zinc-700 px-6 py-3 font-semibold text-zinc-400"
        >
          Join this test
        </button>
        <p className="mt-2 text-center text-sm text-zinc-500">
          {message}
          {eligibility.reason === "no_compatible_device" && (
            <>
              {" "}
              <Link
                href="/settings"
                className="text-emerald-400 hover:text-emerald-300"
              >
                Add a device →
              </Link>
            </>
          )}
          {eligibility.reason === "full" && (
            <>
              {" "}
              <Link
                href="/board"
                className="text-emerald-400 hover:text-emerald-300"
              >
                Find another test →
              </Link>
            </>
          )}
        </p>
      </div>
    );
  }

  const joinDevices: JoinDevice[] = deviceList.map((d) => ({
    id: d.id,
    label: `${d.manufacturer} ${d.model} · Android ${d.android_version}`,
    compatible: d.android_version >= request.min_android_version,
  }));

  return (
    <div>
      {rows.length > 0 && (
        <p className="mb-3 rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-400">
          You previously left this test — joining again starts a fresh
          engagement and a fresh clock.
        </p>
      )}
      <JoinSection
        requestId={request.id}
        devices={joinDevices}
        minAndroid={request.min_android_version}
      />
    </div>
  );
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
    .select("confirmed_count, occupied_count")
    .eq("request_id", id)
    .maybeSingle();
  const occupied = slotRow?.occupied_count ?? 0;

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
            {occupied}/{request.slots_needed} filled
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
          <JoinArea
            request={request}
            userId={user?.id ?? null}
            occupied={occupied}
          />
        )}
      </div>
    </div>
  );
}
