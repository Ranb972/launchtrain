import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { RequestCard } from "@/components/request-card";
import { CATEGORIES, CATEGORY_LABELS } from "@/lib/requests";
import type { Enums, Tables } from "@/lib/supabase/types";

export const metadata = {
  title: "Test Request Board — LaunchTrain",
  description:
    "Open Google Play closed tests looking for testers. Join a test, check in daily, earn credits.",
};

const INPUT =
  "rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none";

// Board sort (SPEC F2): at_risk first (priority refill), then reciprocity
// boost, then published_at. Interim until F3: no engagements exist, so the
// reciprocity boost (active tests vs own requests ratio) has no data and is
// skipped — at_risk first, newest published next.
function boardOrder(
  a: Tables<"test_requests">,
  b: Tables<"test_requests">,
): number {
  if (a.status !== b.status) return a.status === "at_risk" ? -1 : 1;
  return (b.published_at ?? "").localeCompare(a.published_at ?? "");
}

export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<{
    category?: string;
    android?: string;
    compatible?: string;
  }>;
}) {
  const params = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const category = (CATEGORIES as string[]).includes(params.category ?? "")
    ? (params.category as Enums<"request_category">)
    : null;
  const android = Number(params.android);
  const androidFilter =
    Number.isInteger(android) && android >= 8 && android <= 30
      ? android
      : null;

  // "Compatible with my devices": any device of mine satisfies the request's
  // minimum, i.e. min_android_version <= my newest device.
  let compatMax: number | null = null;
  if (user && params.compatible === "1") {
    const { data: devices } = await supabase
      .from("devices")
      .select("android_version")
      .eq("user_id", user.id);
    if (devices && devices.length > 0) {
      compatMax = Math.max(...devices.map((d) => d.android_version));
    }
  }

  let query = supabase
    .from("test_requests")
    .select("*")
    .in("status", ["recruiting", "at_risk"]);
  if (category) query = query.eq("category", category);
  if (androidFilter !== null)
    query = query.lte("min_android_version", androidFilter);
  if (compatMax !== null) query = query.lte("min_android_version", compatMax);

  const { data: requests } = await query;
  const sorted = (requests ?? []).sort(boardOrder);

  const counts = new Map<string, number>();
  if (sorted.length > 0) {
    const { data: slotRows } = await supabase
      .from("request_slot_counts")
      .select("request_id, confirmed_count")
      .in(
        "request_id",
        sorted.map((r) => r.id),
      );
    for (const row of slotRows ?? []) {
      counts.set(row.request_id, row.confirmed_count);
    }
  }

  const hasFilters =
    category !== null || androidFilter !== null || compatMax !== null;

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-bold">The Request Board</h1>
      <p className="mt-2 text-sm text-zinc-400">
        Open closed tests looking for testers. Join one, check in daily, and
        earn the credits that fund your own request.
      </p>

      <form
        method="get"
        action="/board"
        className="mt-6 flex flex-wrap items-end gap-3"
      >
        <div>
          <label
            htmlFor="category"
            className="mb-1 block text-xs font-medium text-zinc-500"
          >
            Category
          </label>
          <select
            id="category"
            name="category"
            defaultValue={category ?? ""}
            className={INPUT}
          >
            <option value="">All categories</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label
            htmlFor="android"
            className="mb-1 block text-xs font-medium text-zinc-500"
          >
            Runs on Android
          </label>
          <input
            id="android"
            name="android"
            type="number"
            min={8}
            max={30}
            defaultValue={androidFilter ?? ""}
            placeholder="e.g. 14"
            className={`${INPUT} w-28`}
          />
        </div>
        {user && (
          <label className="flex items-center gap-2 py-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              name="compatible"
              value="1"
              defaultChecked={params.compatible === "1"}
            />
            Compatible with my devices
          </label>
        )}
        <button
          type="submit"
          className="rounded-md border border-emerald-700 px-4 py-2 text-sm font-semibold text-emerald-400 transition-colors hover:bg-emerald-950"
        >
          Filter
        </button>
        {hasFilters && (
          <Link
            href="/board"
            className="py-2 text-sm text-zinc-500 hover:text-zinc-300"
          >
            Clear
          </Link>
        )}
      </form>

      <div className="mt-8 space-y-3">
        {sorted.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-800 p-12 text-center">
            <p className="text-zinc-400">
              {hasFilters
                ? "No open tests match these filters."
                : "The board is empty."}
            </p>
            <Link
              href="/requests/new"
              className="mt-3 inline-block font-semibold text-emerald-400 hover:text-emerald-300"
            >
              Be the first to board →
            </Link>
          </div>
        ) : (
          sorted.map((request) => (
            <RequestCard
              key={request.id}
              request={request}
              confirmedCount={counts.get(request.id) ?? 0}
            />
          ))
        )}
      </div>
    </div>
  );
}
