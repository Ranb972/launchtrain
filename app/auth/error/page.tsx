import { signInWithGoogle } from "@/app/auth/actions";

export default function AuthErrorPage() {
  return (
    <div className="flex flex-col items-center py-24 text-center">
      <h1 className="text-2xl font-bold">Sign-in failed</h1>
      <p className="mt-3 max-w-md text-zinc-400">
        Something went wrong while signing you in with Google. This is usually
        temporary — please try again.
      </p>
      <form action={signInWithGoogle} className="mt-8">
        <button
          type="submit"
          className="rounded-lg bg-emerald-500 px-6 py-3 font-semibold text-zinc-950 transition-colors hover:bg-emerald-400"
        >
          Retry sign-in with Google
        </button>
      </form>
    </div>
  );
}
