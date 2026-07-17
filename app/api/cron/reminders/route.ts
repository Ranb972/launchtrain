import { runCron } from "../cron";

// Hourly (SPEC §5): 48h unconfirmed-tester reminders to developers.
// (Check-in reminders join here with F4.)

export async function GET(request: Request) {
  return runCron(request, "run_confirm_reminders");
}

export async function POST(request: Request) {
  return runCron(request, "run_confirm_reminders");
}
