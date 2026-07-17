import type { Enums } from "@/lib/supabase/types";

const CHIP: Record<Enums<"engagement_status">, { label: string; cls: string }> =
  {
    pending_developer: {
      label: "Waiting for developer",
      cls: "border-zinc-700 bg-zinc-800/60 text-zinc-300",
    },
    confirmed: {
      label: "Confirmed",
      cls: "border-emerald-800 bg-emerald-950/60 text-emerald-300",
    },
    at_risk: {
      label: "At risk",
      cls: "border-amber-800 bg-amber-950/60 text-amber-300",
    },
    completed: {
      label: "Completed",
      cls: "border-emerald-900 bg-emerald-950/40 text-emerald-400",
    },
    dropped: {
      label: "Dropped",
      cls: "border-red-900 bg-red-950/40 text-red-400",
    },
    cancelled: {
      label: "Withdrawn",
      cls: "border-zinc-800 bg-zinc-900/60 text-zinc-500",
    },
  };

export function EngagementStatusChip({
  status,
}: {
  status: Enums<"engagement_status">;
}) {
  const { label, cls } = CHIP[status];
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${cls}`}
    >
      {label}
    </span>
  );
}
