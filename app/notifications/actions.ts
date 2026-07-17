"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";

// Clients hold a column-level grant on notifications.read_at only, scoped by
// RLS to their own rows — no RPC needed here.
export async function markAllNotificationsRead(): Promise<void> {
  const { supabase, user } = await requireUser();
  await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("user_id", user.id)
    .is("read_at", null);
  revalidatePath("/notifications");
}
