import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { signInWithGoogle } from "@/app/auth/actions";

const STEPS = [
  {
    title: "Board the train",
    text: "Sign in, add your devices, and join other developers' closed tests to earn credits.",
  },
  {
    title: "Fill your test",
    text: "Spend credits to recruit reliable testers — with a built-in buffer so a dropout never breaks your 14-day streak.",
  },
  {
    title: "Next station: Production",
    text: "Turn real feedback into a Submission Dossier with draft answers for Google's production access form.",
  },
];

export default async function LandingPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <div className="flex flex-col items-center py-16 text-center">
      <h1 className="max-w-2xl text-4xl font-bold tracking-tight sm:text-5xl">
        Everyone else sells testers.{" "}
        <span className="text-emerald-400">LaunchTrain sells the approval.</span>
      </h1>
      <p className="mt-6 max-w-xl text-lg text-zinc-400">
        Google Play requires 12 testers, opted in continuously for 14 days,
        before your app can go to production. LaunchTrain is a reciprocal
        marketplace where developers test each other&apos;s apps — and turn the
        evidence into a ready-made submission package.
      </p>

      <div className="mt-10">
        {user ? (
          <Link
            href="/dashboard"
            className="rounded-lg bg-emerald-500 px-6 py-3 font-semibold text-zinc-950 transition-colors hover:bg-emerald-400"
          >
            Go to your Dashboard
          </Link>
        ) : (
          <form action={signInWithGoogle}>
            <button
              type="submit"
              className="rounded-lg bg-emerald-500 px-6 py-3 font-semibold text-zinc-950 transition-colors hover:bg-emerald-400"
            >
              Board the Train — Sign in with Google
            </button>
          </form>
        )}
      </div>

      <div className="mt-20 grid max-w-4xl gap-6 text-left sm:grid-cols-3">
        {STEPS.map((step, i) => (
          <div
            key={step.title}
            className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6"
          >
            <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-full bg-emerald-900 text-sm font-bold text-emerald-300">
              {i + 1}
            </div>
            <h2 className="font-semibold">{step.title}</h2>
            <p className="mt-2 text-sm text-zinc-400">{step.text}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
