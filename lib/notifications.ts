// In-app notification rendering (SPEC Flow 7): type + payload → text + link.
// Payloads are written by the F3 DB functions (add_notification calls).
import type { Json } from "@/lib/supabase/types";

function s(payload: Json, key: string): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
  const v = (payload as Record<string, Json | undefined>)[key];
  return typeof v === "string" ? v : "";
}

function n(payload: Json, key: string): number | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const v = (payload as Record<string, Json | undefined>)[key];
  return typeof v === "number" ? v : null;
}

function b(payload: Json, key: string): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  return (payload as Record<string, Json | undefined>)[key] === true;
}

export function notificationText(type: string, payload: Json): string {
  const app = s(payload, "app_name") || "your test";
  const tester = s(payload, "tester_name") || "A tester";

  switch (type) {
    case "tester_joined":
      return `${tester} joined "${app}" — verify them in Play Console, then confirm.`;
    case "confirm_reminder_48h":
      return `${tester} has been waiting 48h+ on "${app}" — confirm them, or they may cancel penalty-free after 72h.`;
    case "engagement_confirmed":
      return `You're confirmed for "${app}" — your personal 14-day clock started.`;
    case "request_reached_12":
      return `"${app}" reached 12 confirmed testers — the Google clock is running.`;
    case "streak_broken":
      return `"${app}" fell below 12 confirmed testers — the streak reset to zero. Refill now.`;
    case "engagement_at_risk":
      return s(payload, "role") === "owner"
        ? `${tester}'s engagement on "${app}" is at risk — 5 days without activity.`
        : `Your test of "${app}" is at risk — you've been inactive for 5 days.`;
    case "tester_dropped":
      return b(payload, "was_confirmed")
        ? `${tester} dropped out of "${app}" — a slot reopened.`
        : `${tester} withdrew from "${app}" before confirmation — the slot reopened.`;
    case "request_expired": {
      const refund = n(payload, "refund") ?? 0;
      return `"${app}" expired after 30 days without a confirmed tester.${refund > 0 ? ` ${refund} credit${refund === 1 ? "" : "s"} refunded.` : ""}`;
    }
    default:
      return type.replaceAll("_", " ");
  }
}

// Where clicking the notification takes the user.
export function notificationHref(type: string, payload: Json): string | null {
  const requestId = s(payload, "request_id");
  if (!requestId) return null;

  switch (type) {
    // Owner-facing → manage page
    case "tester_joined":
    case "confirm_reminder_48h":
    case "request_reached_12":
    case "streak_broken":
    case "tester_dropped":
    case "request_expired":
      return `/requests/${requestId}/manage`;
    // Tester-facing → public request page (their engagement panel)
    case "engagement_confirmed":
      return `/requests/${requestId}`;
    case "engagement_at_risk":
      return s(payload, "role") === "owner"
        ? `/requests/${requestId}/manage`
        : `/requests/${requestId}`;
    default:
      return `/requests/${requestId}`;
  }
}
