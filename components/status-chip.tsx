import type { Enums } from "@/lib/supabase/types";

const CHIP: Record<Enums<"request_status">, { label: string; cls: string }> = {
  draft: { label: "Draft", cls: "border-zinc-700 bg-zinc-800/60 text-zinc-300" },
  recruiting: {
    label: "Recruiting",
    cls: "border-emerald-800 bg-emerald-950/60 text-emerald-300",
  },
  active: { label: "Active", cls: "border-sky-800 bg-sky-950/60 text-sky-300" },
  at_risk: {
    label: "At risk",
    cls: "border-amber-800 bg-amber-950/60 text-amber-300",
  },
  completed: {
    label: "Completed",
    cls: "border-emerald-900 bg-emerald-950/40 text-emerald-400",
  },
  cancelled: {
    label: "Cancelled",
    cls: "border-red-900 bg-red-950/40 text-red-400",
  },
  expired: {
    label: "Expired",
    cls: "border-zinc-800 bg-zinc-900/60 text-zinc-500",
  },
};

export function StatusChip({ status }: { status: Enums<"request_status"> }) {
  const { label, cls } = CHIP[status];
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${cls}`}
    >
      {label}
    </span>
  );
}

export function FoundingBadge() {
  return (
    <span className="inline-flex items-center rounded-full border border-emerald-700 bg-emerald-950/60 px-2.5 py-0.5 text-xs font-medium text-emerald-300">
      Founding
    </span>
  );
}
