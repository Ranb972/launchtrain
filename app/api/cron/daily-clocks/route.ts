import { runCron } from "../cron";

// Daily 00:15 UTC (SPEC §5): request streak advance/reset, engagement 5-day
// at_risk flips, 30-day zero-confirm expiry. All logic lives in the
// run_daily_clocks Postgres function (service-role only).

export async function GET(request: Request) {
  return runCron(request, "run_daily_clocks");
}

export async function POST(request: Request) {
  return runCron(request, "run_daily_clocks");
}
