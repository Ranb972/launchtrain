import { createClient } from "@/lib/supabase/server";
import { requireOnboardedUser } from "@/lib/auth";
import { RequestForm } from "@/components/request-form";

export const metadata = { title: "New Test Request — LaunchTrain" };

export default async function NewRequestPage() {
  await requireOnboardedUser();

  const supabase = await createClient();
  const { data: configRows } = await supabase
    .from("system_config")
    .select("key, value")
    .in("key", ["founding_phase", "founding_cap", "founding_used"]);
  const cfg = Object.fromEntries(
    (configRows ?? []).map((r) => [r.key, r.value]),
  );
  const foundingFree =
    cfg.founding_phase === true &&
    Number(cfg.founding_used ?? 0) < Number(cfg.founding_cap ?? 0);

  return (
    <div className="mx-auto max-w-lg">
      <h1 className="text-2xl font-bold">Create a Test Request</h1>
      <p className="mt-2 text-sm text-zinc-400">
        Describe your app and how testers join. You&apos;ll preview everything
        before publishing.
      </p>
      {foundingFree && (
        <p className="mt-3 rounded-md border border-emerald-900 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-300">
          Founding launch — publishing is free right now.
        </p>
      )}
      <div className="mt-8">
        <RequestForm mode="create" />
      </div>
    </div>
  );
}
