// TrackProgress (SPEC §8): the railway-track progress bar — one segment per
// day of the 14-day journey. Compact variant used in My Tests cards.
export function TrackProgress({
  day,
  total = 14,
}: {
  day: number; // 1-based current day; segments < day are "travelled"
  total?: number;
}) {
  const clamped = Math.max(0, Math.min(total, day));
  return (
    <div
      className="flex items-center gap-0.5"
      role="img"
      aria-label={`Day ${clamped} of ${total}`}
    >
      {Array.from({ length: total }, (_, i) => {
        const station = i + 1;
        const reached = station <= clamped;
        const isCurrent = station === clamped;
        return (
          <span
            key={station}
            className={`h-1.5 flex-1 rounded-full ${
              isCurrent
                ? "bg-emerald-400"
                : reached
                  ? "bg-emerald-700"
                  : "bg-zinc-800"
            }`}
          />
        );
      })}
    </div>
  );
}
