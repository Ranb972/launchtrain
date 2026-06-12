# LaunchTrain

Reciprocal-testing marketplace for Google Play closed testing (12 testers / 14 days → Production Access).

# Source of Truth
- SPEC.md governs everything. Read it before any task.
- On conflict or ambiguity (code vs SPEC vs chat) — stop and ask Ran. Never improvise product rules.
- Build phase-by-phase per SPEC.md §10. Current phase: **Phase 1**. Do not pull Phase 2/3 features forward.

# Commands (after scaffold)
- npm run dev: dev server :3000
- npm run build: production build
- npx tsc --noEmit: type check

# Style
- TypeScript strict, Next.js 15 App Router, Server Components by default
- Tailwind only; UI copy in English only
- Code, comments, commits in English; converse with Ran in Hebrew

# Rules
- All date/time logic in UTC; day boundary = UTC midnight
- Credits move ONLY via credit_transactions rows, inside the same DB transaction as the state change; users table has no balance column
- RLS on every table; SUPABASE_SERVICE_ROLE_KEY server-side only; never read or print .env*
- testing_email is visible only to the owner of a request that tester joined
- Dossier AI never invents data — SPEC.md Appendix B prompt is non-negotiable
- AI provider is selected via env (AI_PROVIDER/AI_MODEL) through lib/ai/provider.ts only — no direct SDK imports elsewhere
- End every completed feature with a manual verification recipe: numbered browser steps for Ran. Ran's own test is the acceptance test.
