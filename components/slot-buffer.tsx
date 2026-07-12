// SlotBuffer (SPEC §8): visual "14/12" buffer — how many slots are confirmed
// vs needed, with a marker at Google's 12-tester requirement.
export function SlotBuffer({
  confirmed,
  needed,
}: {
  confirmed: number;
  needed: number;
}) {
  const pct = needed > 0 ? Math.min(100, (confirmed / needed) * 100) : 0;
  const googleMarkPct = needed >= 12 ? (12 / needed) * 100 : null;

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <p className="text-sm text-zinc-300">
          <span className="text-lg font-bold text-zinc-100">{confirmed}</span>{" "}
          of {needed} slots confirmed
        </p>
        <p className="text-xs text-zinc-500">Google requires 12</p>
      </div>
      <div className="relative mt-2 h-3 overflow-hidden rounded-full bg-zinc-800">
        <div
          className={`h-full rounded-full transition-all ${
            confirmed >= 12 ? "bg-emerald-500" : "bg-emerald-800"
          }`}
          style={{ width: `${pct}%` }}
        />
        {googleMarkPct !== null && (
          <div
            className="absolute top-0 h-full w-0.5 bg-amber-400"
            style={{ left: `${googleMarkPct}%` }}
            title="Google's 12-tester requirement"
          />
        )}
      </div>
      {confirmed < 12 && (
        <p className="mt-2 text-xs text-zinc-500">
          The 14-day streak clock starts once 12 testers are confirmed
          simultaneously.
        </p>
      )}
    </div>
  );
}
