// npm run cron:daily / npm run cron:reminders — POSTs the local cron routes
// with the CRON_SECRET (mirrors what Vercel Cron does in production).
// Requires the dev server: npm run dev in another terminal.

const which = process.argv[2];
if (which !== "daily" && which !== "reminders") {
  console.error("Usage: trigger-cron.ts <daily|reminders>");
  process.exit(1);
}

const secret = process.env.CRON_SECRET;
if (!secret) {
  console.error("✗ CRON_SECRET missing from .env.local.");
  process.exit(1);
}

const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3456";
const path = which === "daily" ? "/api/cron/daily-clocks" : "/api/cron/reminders";

async function main() {
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
    });
  } catch {
    console.error(
      `✗ Could not reach ${base}${path} — is the dev server running? (npm run dev)`,
    );
    process.exit(1);
  }

  const body = await response.text();
  console.log(`${response.ok ? "✓" : "✗"} ${response.status} ${path}`);
  try {
    console.log(JSON.stringify(JSON.parse(body), null, 2));
  } catch {
    console.log(body);
  }
  if (!response.ok) process.exit(1);
}

main();
