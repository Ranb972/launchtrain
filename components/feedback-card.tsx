import type { Json, Tables } from "@/lib/supabase/types";

const SEVERITY_CLS: Record<string, string> = {
  low: "border-zinc-700 bg-zinc-800/60 text-zinc-300",
  medium: "border-amber-800 bg-amber-950/60 text-amber-300",
  high: "border-red-900 bg-red-950/60 text-red-300",
};

const USAGE_LABELS: Record<string, string> = {
  daily: "Used daily",
  few_weekly: "Used a few times a week",
  rarely: "Used once or twice",
};

export function parseBugs(
  bugs: Json,
): Array<{ text: string; severity: string }> {
  if (!Array.isArray(bugs)) return [];
  const out: Array<{ text: string; severity: string }> = [];
  for (const item of bugs) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, Json | undefined>;
    if (typeof record.text !== "string") continue;
    out.push({
      text: record.text,
      severity: typeof record.severity === "string" ? record.severity : "low",
    });
  }
  return out;
}

// Read-only rendering of an immutable feedback record — used on the tester's
// feedback page and in the developer's Feedback Hub.
export function FeedbackCard({
  feedback,
  children,
}: {
  feedback: Tables<"feedback">;
  children?: React.ReactNode; // rating controls (hub) or addendum form (tester)
}) {
  const bugs = parseBugs(feedback.bugs);
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        {(
          [
            ["Stability", feedback.stability],
            ["Ease of use", feedback.ux],
            ["Usefulness", feedback.value],
          ] as const
        ).map(([label, score]) => (
          <span key={label} className="text-zinc-400">
            {label}:{" "}
            <span className="font-semibold text-zinc-100">{score}/5</span>
          </span>
        ))}
        <span className="text-xs text-zinc-500">
          {USAGE_LABELS[feedback.usage_frequency] ?? feedback.usage_frequency}
        </span>
      </div>

      {bugs.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {bugs.map((bug, i) => (
            <li key={i} className="flex items-start gap-2 text-sm text-zinc-300">
              <span
                className={`mt-0.5 inline-flex shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase ${SEVERITY_CLS[bug.severity] ?? SEVERITY_CLS.low}`}
              >
                {bug.severity}
              </span>
              <span>{bug.text}</span>
            </li>
          ))}
        </ul>
      )}

      {feedback.suggestions && (
        <p className="mt-3 text-sm text-zinc-300">
          <span className="text-zinc-500">Suggestions:</span>{" "}
          {feedback.suggestions}
        </p>
      )}

      {feedback.addendum && (
        <p className="mt-3 border-l-2 border-zinc-700 pl-3 text-sm text-zinc-400">
          <span className="text-zinc-500">Addendum:</span> {feedback.addendum}
        </p>
      )}

      {children && <div className="mt-4 border-t border-zinc-800 pt-3">{children}</div>}
    </div>
  );
}
