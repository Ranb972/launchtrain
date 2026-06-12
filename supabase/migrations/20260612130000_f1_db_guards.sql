-- F1 integrity backstops (post-review hardening, 2026-06-12).
-- Single-transaction migration: a failed run leaves the database clean.
--
-- 1. users_update_guard now validates profile fields on EVERY update of an
--    onboarded row (previously only on the onboarding transition), closing a
--    crafted-API path that could blank testing_email/display_name.
-- 2. devices_delete_guard makes the ">=1 device for onboarded users" invariant
--    durable: the app-layer count check is racy under concurrent removals.
--    The user-row lock (FOR UPDATE) serializes concurrent device deletes.

BEGIN;

CREATE OR REPLACE FUNCTION public.users_update_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.onboarded_at IS NOT NULL THEN
    IF NEW.country = '' OR btrim(NEW.display_name) = ''
       OR NEW.testing_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
      RAISE EXCEPTION 'Profile fields missing or invalid for an onboarded user';
    END IF;
    IF OLD.onboarded_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.devices d WHERE d.user_id = NEW.id) THEN
      RAISE EXCEPTION 'Onboarding incomplete: at least one device required';
    END IF;
  END IF;

  IF NEW.testing_email IS DISTINCT FROM OLD.testing_email THEN
    IF EXISTS (
      SELECT 1 FROM public.engagements e
      WHERE e.tester_id = NEW.id
        AND e.status IN ('pending_developer', 'confirmed', 'at_risk')
    ) THEN
      RAISE EXCEPTION 'testing_email cannot be changed while an engagement is active';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.devices_delete_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_onboarded_at timestamptz;
BEGIN
  -- Lock the owner's user row so concurrent deletes for the same user serialize.
  SELECT u.onboarded_at INTO v_onboarded_at
  FROM public.users u
  WHERE u.id = OLD.user_id
  FOR UPDATE;

  IF v_onboarded_at IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.devices d
    WHERE d.user_id = OLD.user_id AND d.id <> OLD.id
  ) THEN
    RAISE EXCEPTION 'An onboarded user must keep at least one device';
  END IF;

  RETURN OLD;
END;
$$;

CREATE TRIGGER devices_delete_guard
  BEFORE DELETE ON public.devices
  FOR EACH ROW EXECUTE FUNCTION public.devices_delete_guard();

COMMIT;
