import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { markAllNotificationsRead } from "./actions";
import { timeAgoLabel } from "@/lib/clocks";
import { notificationHref, notificationText } from "@/lib/notifications";

export const metadata = { title: "Notifications — LaunchTrain" };

export default async function NotificationsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const { data: notifications } = await supabase
    .from("notifications")
    .select("id, type, payload, read_at, created_at")
    .order("created_at", { ascending: false })
    .limit(50);

  const rows = notifications ?? [];
  const unread = rows.filter((r) => r.read_at === null).length;
  const now = new Date();

  return (
    <div className="mx-auto max-w-2xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Notifications</h1>
        {unread > 0 && (
          <form action={markAllNotificationsRead}>
            <button
              type="submit"
              className="text-sm text-emerald-400 hover:text-emerald-300"
            >
              Mark all as read
            </button>
          </form>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-zinc-800 p-12 text-center text-sm text-zinc-500">
          Nothing yet. Activity on your requests and tests lands here.{" "}
          <Link href="/board" className="text-emerald-400 hover:text-emerald-300">
            Browse the board →
          </Link>
        </div>
      ) : (
        <ul className="mt-6 space-y-2">
          {rows.map((row) => {
            const href = notificationHref(row.type, row.payload);
            const isUnread = row.read_at === null;
            const inner = (
              <>
                <div className="flex items-start gap-3">
                  {isUnread && (
                    <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
                  )}
                  <p
                    className={`min-w-0 text-sm ${isUnread ? "text-zinc-100" : "text-zinc-400"}`}
                  >
                    {notificationText(row.type, row.payload)}
                  </p>
                  <span className="ml-auto shrink-0 text-xs text-zinc-600">
                    {timeAgoLabel(row.created_at, now)}
                  </span>
                </div>
              </>
            );
            const cls = `block rounded-xl border px-4 py-3 transition-colors ${
              isUnread
                ? "border-zinc-700 bg-zinc-900/80"
                : "border-zinc-800/60 bg-zinc-900/30"
            } ${href ? "hover:border-emerald-700" : ""}`;
            return (
              <li key={row.id}>
                {href ? (
                  <Link href={href} className={cls}>
                    {inner}
                  </Link>
                ) : (
                  <div className={cls}>{inner}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
