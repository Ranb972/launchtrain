import Link from "next/link";
import { FoundingBadge, StatusChip } from "@/components/status-chip";
import { CATEGORY_LABELS } from "@/lib/requests";
import { screenshotPublicUrl } from "@/lib/storage";
import type { Tables } from "@/lib/supabase/types";

// Board card (SPEC F2): icon, name, category, slots filled/needed,
// min Android, credits per test, Founding badge.
// "Filled" = occupied slots (incl. pending/completed — F3 decision A2).
export function RequestCard({
  request,
  occupiedCount,
}: {
  request: Tables<"test_requests">;
  occupiedCount: number;
}) {
  return (
    <Link
      href={`/requests/${request.id}`}
      className="group flex gap-4 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 transition-colors hover:border-emerald-700"
    >
      {request.icon_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={screenshotPublicUrl(request.icon_url)}
          alt=""
          className="h-14 w-14 shrink-0 rounded-xl border border-zinc-800 object-cover"
        />
      ) : (
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900 text-xl">
          📱
        </div>
      )}

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="truncate font-semibold group-hover:text-emerald-400">
            {request.app_name}
          </h2>
          {request.status === "at_risk" && <StatusChip status="at_risk" />}
          {request.is_founding && <FoundingBadge />}
        </div>
        <p className="mt-0.5 text-xs text-zinc-500">
          {CATEGORY_LABELS[request.category]}
        </p>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-400">
          <span>
            <span className="font-medium text-zinc-200">
              {occupiedCount}/{request.slots_needed}
            </span>{" "}
            slots
          </span>
          <span>Android {request.min_android_version}+</span>
          <span className="text-emerald-400">1 credit per test</span>
        </div>
      </div>
    </Link>
  );
}
