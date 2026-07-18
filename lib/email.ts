// Notification email dispatch (SPEC Flow 7). The F3 DB functions insert the
// in-app notification rows and return their descriptors; this module sends
// the matching emails via Resend when RESEND_API_KEY exists, and is a logged
// no-op otherwise. It NEVER throws — a failed email must not fail the state
// change that caused it (the in-app record already exists).
import { Resend } from "resend";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

export type NotificationDescriptor = {
  id: string;
  user_id: string;
  type: string;
  payload: Record<string, Json | undefined>;
};

// Extracts the `notifications` array that every F3 RPC returns.
export function notificationsFromResult(data: Json): NotificationDescriptor[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const list = (data as Record<string, Json | undefined>).notifications;
  if (!Array.isArray(list)) return [];
  const out: NotificationDescriptor[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const n = item as Record<string, Json | undefined>;
    if (typeof n.id !== "string" || typeof n.user_id !== "string") continue;
    out.push({
      id: n.id,
      user_id: n.user_id,
      type: typeof n.type === "string" ? n.type : "unknown",
      payload:
        n.payload && typeof n.payload === "object" && !Array.isArray(n.payload)
          ? (n.payload as Record<string, Json | undefined>)
          : {},
    });
  }
  return out;
}

function appUrl(path: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3456";
  return `${base}${path}`;
}

function str(payload: Record<string, Json | undefined>, key: string): string {
  const v = payload[key];
  return typeof v === "string" ? v : "";
}

// Subject + plain-text body per F3 notification type (SPEC Flow 7 events).
function emailContent(
  n: NotificationDescriptor,
): { subject: string; body: string } | null {
  const p = n.payload;
  const app = str(p, "app_name");
  const tester = str(p, "tester_name");
  const requestId = str(p, "request_id");
  const manage = appUrl(`/requests/${requestId}/manage`);
  const request = appUrl(`/requests/${requestId}`);

  switch (n.type) {
    case "tester_joined": {
      const method = str(p, "join_method");
      const action =
        method === "email_list"
          ? "Add their testing email to your closed-testing list in Play Console, then confirm them on the manage page."
          : "They're joining your Google Group and opting in — confirm them on the manage page once you see them in Play Console.";
      return {
        subject: `${tester} joined "${app}"`,
        body: `${tester} joined your test of ${app}.\n\n${action}\n\n${manage}`,
      };
    }
    case "confirm_reminder_48h":
      return {
        subject: `Reminder: ${tester} is still waiting on "${app}"`,
        body: `${tester} joined your test of ${app} over 48 hours ago and hasn't been confirmed yet.\n\nAdd them in Play Console and confirm them, or they may cancel without penalty after 72 hours.\n\n${manage}`,
      };
    case "engagement_confirmed":
      return {
        subject: `You're confirmed for "${app}" — your 14-day clock started`,
        body: `The developer confirmed you as a tester of ${app}. Your personal 14-day clock starts now.\n\nKeep the app installed, use it, and stay opted in for the full 14 days.\n\n${request}`,
      };
    case "request_reached_12":
      return {
        subject: `"${app}" reached 12 confirmed testers — the Google clock is running`,
        body: `Your test of ${app} now holds 12+ confirmed testers. The 14-day streak advances on every full UTC day that stays at 12 or more.\n\nKeep the buffer full — a dip below 12 resets the streak to zero.\n\n${manage}`,
      };
    case "streak_broken":
      return {
        subject: `URGENT: "${app}" dropped below 12 testers — refill now`,
        body: `Your test of ${app} fell below 12 confirmed testers and the 14-day streak has reset to zero.\n\nYour request is now boosted on the board. Confirm new testers to restart the clock.\n\n${manage}`,
      };
    case "engagement_at_risk":
      return str(p, "role") === "owner"
        ? {
            subject: `${tester}'s engagement on "${app}" is at risk`,
            body: `${tester} has shown no activity for 5 days on your test of ${app}.\n\nYou can request a replacement slot from the manage page (this doesn't drop them).\n\n${manage}`,
          }
        : {
            subject: `Your test of "${app}" is at risk`,
            body: `You haven't been active on ${app} for 5 days. Open the app and keep testing to stay on track for your credit.\n\n${request}`,
          };
    case "tester_dropped": {
      const wasConfirmed = p.was_confirmed === true;
      return {
        subject: `${tester} left "${app}" — a slot reopened`,
        body: `${tester} ${wasConfirmed ? "dropped out of" : "withdrew from"} your test of ${app}. The slot is open again${wasConfirmed ? " and your request gets board priority if the streak broke" : ""}.\n\n${manage}`,
      };
    }
    case "request_expired": {
      const refund = typeof p.refund === "number" ? p.refund : 0;
      return {
        subject: `"${app}" expired after 30 days without confirmations`,
        body: `Your test request for ${app} was recruiting for 30 days without a confirmed tester and has expired.${refund > 0 ? `\n\n${refund} escrowed credit${refund === 1 ? "" : "s"} were refunded to your balance.` : ""}\n\nYou can publish a fresh request any time.`,
      };
    }
    case "checkin_reminder_3d":
      return {
        subject: `No check-in on "${app}" for 3 days`,
        body: `You haven't checked in on ${app} for 3 days. Open the app, use it, and check in — 2 more inactive days marks your engagement at risk (−5 reliability).\n\n${appUrl("/dashboard#my-tests")}`,
      };
    case "feedback_prompt_mid":
      return {
        subject: `Mid-test feedback due for "${app}"`,
        body: `You've reached day 7 of your test of ${app} — a one-minute mid-test feedback is due.\n\n${appUrl(`/engagements/${str(p, "engagement_id")}/feedback?type=mid`)}`,
      };
    case "feedback_prompt_final":
      return {
        subject: `Final feedback due for "${app}" — complete your test`,
        body: `Day 14 of your test of ${app}! Submit the final feedback to complete the test and release your escrowed credit.\n\n${appUrl(`/engagements/${str(p, "engagement_id")}/feedback?type=final`)}`,
      };
    case "engagement_completed": {
      const score = typeof p.reliability_score === "number" ? p.reliability_score : null;
      return {
        subject: `Test of "${app}" completed — +1 credit released`,
        body: `You completed the full 14-day test of ${app}. Your escrowed credit was released (+1)${score !== null ? ` and your reliability score is now ${score}` : ""}.\n\nOne more thing: please STAY OPTED IN on Google Play until the developer's request finishes its 14-day streak — leaving early can still hurt their approval.\n\n${request}`,
      };
    }
    case "feedback_received": {
      const ftype = str(p, "feedback_type") === "final" ? "Final" : "Mid-test";
      return {
        subject: `${ftype} feedback from ${tester} on "${app}"`,
        body: `${tester} submitted ${ftype.toLowerCase()} feedback on ${app}. It's waiting in your Feedback Hub${ftype === "Final" ? " — rate it helpful to send them a +1 bonus credit" : ""}.\n\n${manage}`,
      };
    }
    case "bonus_credit":
      return {
        subject: `+1 bonus credit for your feedback on "${app}"`,
        body: `The developer of ${app} rated your feedback helpful — a +1 bonus credit was added to your balance. Thanks for testing thoroughly!`,
      };
    default:
      return null;
  }
}

// Fire-and-forget email dispatch for RPC-returned notifications.
export async function dispatchNotificationEmails(
  notifs: NotificationDescriptor[],
): Promise<void> {
  if (notifs.length === 0) return;

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(
      `[email no-op] RESEND_API_KEY not set — skipped ${notifs.length} email(s): ` +
        notifs.map((n) => n.type).join(", "),
    );
    return;
  }

  try {
    const admin = createAdminClient();
    const userIds = [...new Set(notifs.map((n) => n.user_id))];
    const { data: users } = await admin
      .from("users")
      .select("id, email")
      .in("id", userIds);
    const emailById = new Map((users ?? []).map((u) => [u.id, u.email]));

    const resend = new Resend(apiKey);
    const from = process.env.EMAIL_FROM ?? "LaunchTrain <onboarding@resend.dev>";
    const sentIds: string[] = [];

    for (const n of notifs) {
      const to = emailById.get(n.user_id);
      const content = emailContent(n);
      if (!to || !content) continue;
      try {
        const { error } = await resend.emails.send({
          from,
          to,
          subject: content.subject,
          text: content.body,
        });
        if (!error) sentIds.push(n.id);
        else console.error(`[email] send failed (${n.type}):`, error.message);
      } catch (err) {
        console.error(`[email] send threw (${n.type}):`, err);
      }
    }

    if (sentIds.length > 0) {
      await admin
        .from("notifications")
        .update({ emailed_at: new Date().toISOString() })
        .in("id", sentIds);
    }
  } catch (err) {
    // Email is best-effort; the in-app notification rows already exist.
    console.error("[email] dispatch failed:", err);
  }
}
