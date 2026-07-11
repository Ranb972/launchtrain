-- Device data integrity (pre-F2 micro-slice, 2026-07-11).
-- Single-transaction migration: a failed run leaves the database clean.
--
-- Tightens devices.android_version from the initial schema's 1-50 to 8-30
-- (Android 8.0 Oreo through a generous future ceiling). Device data drives
-- tester eligibility (Flow 3: android_version >= min_android_version) and the
-- Dossier's Device Coverage Matrix, so out-of-range rows corrupt core evidence.
--
-- Defensive by design: if any existing row violates the range, this migration
-- RAISEs an exception listing the offending rows and applies nothing. It never
-- alters or deletes data — fix or remove the listed rows manually, re-run.

BEGIN;

DO $$
DECLARE
  v_offenders text;
BEGIN
  SELECT string_agg(
           format('  id=%s user_id=%s "%s %s" android_version=%s',
                  d.id, d.user_id, d.manufacturer, d.model, d.android_version),
           E'\n' ORDER BY d.created_at)
    INTO v_offenders
    FROM public.devices d
   WHERE d.android_version NOT BETWEEN 8 AND 30;

  IF v_offenders IS NOT NULL THEN
    RAISE EXCEPTION E'devices.android_version must be between 8 and 30 — fix or remove these rows, then re-run this migration:\n%', v_offenders;
  END IF;
END;
$$;

-- Replace the initial schema's inline 1-50 column check with the tighter range.
-- IF EXISTS keeps this idempotent-ish: should the auto-generated name ever
-- differ, the old wider check would simply coexist with (and be subsumed by)
-- the new one instead of failing the migration.
ALTER TABLE public.devices
  DROP CONSTRAINT IF EXISTS devices_android_version_check;

ALTER TABLE public.devices
  ADD CONSTRAINT devices_android_version_range
  CHECK (android_version BETWEEN 8 AND 30);

COMMIT;
