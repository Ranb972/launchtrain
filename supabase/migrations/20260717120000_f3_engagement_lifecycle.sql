-- F3: engagement lifecycle & the two clocks (2026-07-17).
-- Single-transaction migration: a failed run leaves the database clean.
--
-- Implements SPEC Flow 3 (join/opt-in/confirm), the clock parts of Flow 4,
-- Feature F3, and the two cron jobs. Same architecture as F2: every state
-- transition that moves credits or races with joins is a SECURITY DEFINER
-- Postgres function invoked via RPC, so the credit_transactions rows land in
-- the SAME database transaction as the state change (SPEC §0.4).
--
-- Approved F3 design decisions (Ran, 2026-07-17 — recorded in SPEC v1.6):
--   A1. confirmed_count (the "12 simultaneous" number) counts engagements in
--       confirmed/at_risk/completed. Completed testers keep counting —
--       confirmations are staggered, so early confirmers finish their personal
--       14 days before the request streak reaches 14; removing them would make
--       completion mathematically impossible.
--   A2. Slot occupancy (join capacity) = every non-terminal engagement PLUS
--       completed (a completed engagement consumed its escrowed credit — its
--       slot cannot be resold). Only dropped/cancelled reopen slots.
--   A3. Streak bookkeeping: test_requests.streak_ok_since marks when
--       confirmed_count last rose to >= 12 (NULLed the moment it dips below).
--       The daily cron credits one streak day per COMPLETE UTC day since
--       streak_ok_since, using streak_last_counted_day for idempotency and
--       missed-day catch-up. Dips reset the streak immediately (event-driven,
--       inside drop_engagement) — cron is the advance + self-heal backstop.
--   A4. Reaching 12 is event-driven: the confirm that crosses 12 sets
--       clock_started_at (first time only), flips the request to active, and
--       notifies the owner ("Google clock started").
--   A5. A pending_developer tester may cancel penalty-free AT ANY TIME (the
--       72h mark only changes UI emphasis). The -15 dropped path applies to
--       confirmed/at_risk engagements only.
--   A6. Cooldown: users.join_blocked_until, set to now()+14d whenever a
--       penalty leaves reliability_score < 60 (GREATEST-extended). Joining
--       requires score >= 60 AND cooldown expired.
--   A7. The -5 at_risk reliability penalty is DEFERRED to F4 (check-ins do
--       not exist yet, so 5-day inactivity is currently unavoidable). The
--       at_risk transition + notifications land now, penalty-free.
--   A8. Joinable request statuses: recruiting / active / at_risk, with open
--       slots.
--   A9. Requests stay 'active' past streak 14 (completion arrives with F5).
--       The F2 leftover 30-day zero-confirm expiry runs in the daily cron,
--       with a request_expired notification (justified addition to Flow 7).
--   A10. Replacement is once per at-risk engagement
--       (engagements.replacement_requested_at), via grow_request_slots
--       semantics: founding grows free, normal charges the 1-credit delta.
--
-- Seed wrappers: seed_* functions (service_role only) call the same _impl
-- logic with an explicit caller id. The project is Google-OAuth-only, so
-- seeded testers cannot password-sign-in; impersonation through the service
-- role exercises the REAL join/confirm/drop code paths headlessly.
--
-- Error protocol (extends F2): RAISE EXCEPTION 'LT_<CODE>[:detail]'.
-- New codes: LT_NOT_JOINABLE, LT_OWN_REQUEST, LT_ONBOARDING_REQUIRED,
-- LT_RELIABILITY_LOW:<score>, LT_COOLDOWN_ACTIVE:<yyyy-mm-dd>,
-- LT_DEVICE_NOT_FOUND, LT_DEVICE_INCOMPATIBLE, LT_ALREADY_JOINED,
-- LT_TEST_FULL, LT_ENGAGEMENT_CLOSED, LT_TESTER_CANCELLED,
-- LT_ALREADY_CONFIRMED, LT_NOT_PENDING, LT_NOT_AT_RISK,
-- LT_REPLACEMENT_ALREADY.
--
-- Lock ordering (deadlock prevention), everywhere: request row -> engagement
-- row -> user row. Functions that start from an engagement id read it
-- UNLOCKED first to find the request, lock the request, then re-read the
-- engagement under lock.

BEGIN;

-- ============================================================
-- 1. COLUMNS
-- ============================================================

-- A6: cooldown gate. NOT client-writable (column grants below are untouched;
-- the F1 UPDATE grant enumerates columns explicitly).
ALTER TABLE public.users
  ADD COLUMN join_blocked_until timestamptz;

ALTER TABLE public.engagements
  ADD COLUMN ended_at                 timestamptz,  -- set when entering dropped/cancelled
  ADD COLUMN replacement_requested_at timestamptz,  -- A10: once per engagement
  ADD COLUMN confirm_reminded_at      timestamptz;  -- 48h reminder sent marker

ALTER TABLE public.test_requests
  ADD COLUMN streak_ok_since         timestamptz,   -- A3: >=12 held since this moment
  ADD COLUMN streak_last_counted_day date;          -- A3: last UTC day credited (idempotency)

-- Cron scan helpers (tiny tables today; hygiene for later).
CREATE INDEX engagements_pending_reminder_idx
  ON public.engagements (joined_at)
  WHERE status = 'pending_developer' AND confirm_reminded_at IS NULL;

CREATE INDEX engagements_activity_idx
  ON public.engagements ((COALESCE(last_checkin_at, confirmed_at)))
  WHERE status = 'confirmed';

-- ============================================================
-- 2. COUNT HELPERS + NOTIFICATION HELPER (internal only)
-- ============================================================

-- A1: the number Google cares about.
CREATE OR REPLACE FUNCTION public.request_confirmed_count(req uuid)
RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT count(*)::int
  FROM public.engagements e
  WHERE e.request_id = req
    AND e.status IN ('confirmed', 'at_risk', 'completed');
$$;

-- A2: the capacity number.
CREATE OR REPLACE FUNCTION public.request_occupied_count(req uuid)
RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT count(*)::int
  FROM public.engagements e
  WHERE e.request_id = req
    AND e.status NOT IN ('dropped', 'cancelled');
$$;

-- Inserts an in-app notification row and returns a jsonb descriptor.
-- Every mutating function accumulates these into its return value so the
-- server action / cron route can dispatch the matching emails (Resend runs
-- in Node, not in Postgres).
CREATE OR REPLACE FUNCTION public.add_notification(uid uuid, ntype text, npayload jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.notifications (user_id, type, payload)
  VALUES (uid, ntype, npayload)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('id', v_id, 'user_id', uid, 'type', ntype, 'payload', npayload);
END;
$$;

-- ============================================================
-- 3. JOIN (SPEC Flow 3 steps 1–3)
-- ============================================================

CREATE OR REPLACE FUNCTION public.join_test_impl(caller uuid, req uuid, device uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_req      public.test_requests%ROWTYPE;
  v_user     public.users%ROWTYPE;
  v_dev      public.devices%ROWTYPE;
  v_occupied int;
  v_eng_id   uuid;
  v_notifs   jsonb := '[]'::jsonb;
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'LT_AUTH_REQUIRED'; END IF;

  -- Request lock serializes competing joins: the loser of a last-slot race
  -- re-counts under the lock and gets LT_TEST_FULL ("This test just filled up").
  SELECT * INTO v_req FROM public.test_requests WHERE id = req FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'LT_NOT_FOUND'; END IF;
  IF v_req.status NOT IN ('recruiting', 'active', 'at_risk') THEN
    RAISE EXCEPTION 'LT_NOT_JOINABLE';
  END IF;
  IF v_req.owner_id = caller THEN RAISE EXCEPTION 'LT_OWN_REQUEST'; END IF;

  SELECT * INTO v_user FROM public.users WHERE id = caller;
  IF NOT FOUND OR v_user.onboarded_at IS NULL THEN
    RAISE EXCEPTION 'LT_ONBOARDING_REQUIRED';
  END IF;
  IF v_user.reliability_score < 60 THEN
    RAISE EXCEPTION 'LT_RELIABILITY_LOW:%', v_user.reliability_score;
  END IF;
  IF v_user.join_blocked_until IS NOT NULL AND v_user.join_blocked_until > now() THEN
    RAISE EXCEPTION 'LT_COOLDOWN_ACTIVE:%',
      to_char(v_user.join_blocked_until AT TIME ZONE 'utc', 'YYYY-MM-DD');
  END IF;

  SELECT * INTO v_dev FROM public.devices WHERE id = device AND user_id = caller;
  IF NOT FOUND THEN RAISE EXCEPTION 'LT_DEVICE_NOT_FOUND'; END IF;
  IF v_dev.android_version < v_req.min_android_version THEN
    RAISE EXCEPTION 'LT_DEVICE_INCOMPATIBLE';
  END IF;

  -- Re-join after drop/cancel is a NEW row (SPEC §6); a live row blocks.
  IF EXISTS (
    SELECT 1 FROM public.engagements e
    WHERE e.request_id = req AND e.tester_id = caller
      AND e.status NOT IN ('dropped', 'cancelled')
  ) THEN
    RAISE EXCEPTION 'LT_ALREADY_JOINED';
  END IF;

  v_occupied := public.request_occupied_count(req);
  IF v_occupied >= v_req.slots_needed THEN RAISE EXCEPTION 'LT_TEST_FULL'; END IF;

  INSERT INTO public.engagements (request_id, tester_id, device_id)
  VALUES (req, caller, device)
  RETURNING id INTO v_eng_id;

  v_notifs := v_notifs || public.add_notification(
    v_req.owner_id, 'tester_joined',
    jsonb_build_object(
      'request_id', req, 'engagement_id', v_eng_id, 'app_name', v_req.app_name,
      'tester_name', v_user.display_name, 'join_method', v_req.join_method));

  RETURN jsonb_build_object(
    'engagement_id', v_eng_id,
    'join_method', v_req.join_method,
    'notifications', v_notifs);
END;
$$;

CREATE OR REPLACE FUNCTION public.join_test(req uuid, device uuid)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.join_test_impl(auth.uid(), req, device);
$$;

-- ============================================================
-- 4. MARK OPTED IN (SPEC Flow 3 step 4)
-- ============================================================

CREATE OR REPLACE FUNCTION public.mark_opted_in_impl(caller uuid, eng uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_eng public.engagements%ROWTYPE;
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'LT_AUTH_REQUIRED'; END IF;

  -- Single-row update, no request read: engagement lock alone is safe here.
  SELECT * INTO v_eng FROM public.engagements WHERE id = eng FOR UPDATE;
  IF NOT FOUND OR v_eng.tester_id <> caller THEN RAISE EXCEPTION 'LT_NOT_FOUND'; END IF;
  IF v_eng.status IN ('dropped', 'cancelled', 'completed') THEN
    RAISE EXCEPTION 'LT_ENGAGEMENT_CLOSED';
  END IF;

  IF v_eng.opted_in_at IS NULL THEN
    UPDATE public.engagements SET opted_in_at = now() WHERE id = eng;
  END IF;

  RETURN jsonb_build_object('opted_in', true, 'notifications', '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_opted_in(eng uuid)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.mark_opted_in_impl(auth.uid(), eng);
$$;

-- ============================================================
-- 5. CONFIRM (SPEC Flow 3 step 5, decision A4)
-- ============================================================

CREATE OR REPLACE FUNCTION public.confirm_engagement_impl(caller uuid, eng uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_req_id uuid;
  v_req    public.test_requests%ROWTYPE;
  v_eng    public.engagements%ROWTYPE;
  v_count  int;
  v_notifs jsonb := '[]'::jsonb;
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'LT_AUTH_REQUIRED'; END IF;

  SELECT request_id INTO v_req_id FROM public.engagements WHERE id = eng;
  IF NOT FOUND THEN RAISE EXCEPTION 'LT_NOT_FOUND'; END IF;

  SELECT * INTO v_req FROM public.test_requests WHERE id = v_req_id FOR UPDATE;
  IF v_req.owner_id <> caller THEN RAISE EXCEPTION 'LT_NOT_FOUND'; END IF;
  IF v_req.status NOT IN ('recruiting', 'active', 'at_risk') THEN
    RAISE EXCEPTION 'LT_NOT_JOINABLE';
  END IF;

  -- Re-read under lock: the tester may have withdrawn since the page rendered.
  SELECT * INTO v_eng FROM public.engagements WHERE id = eng FOR UPDATE;
  IF v_eng.status = 'cancelled' THEN RAISE EXCEPTION 'LT_TESTER_CANCELLED'; END IF;
  IF v_eng.status IN ('confirmed', 'at_risk') THEN RAISE EXCEPTION 'LT_ALREADY_CONFIRMED'; END IF;
  IF v_eng.status <> 'pending_developer' THEN RAISE EXCEPTION 'LT_NOT_PENDING'; END IF;

  UPDATE public.engagements
    SET status = 'confirmed', confirmed_at = now()
    WHERE id = eng;

  v_notifs := v_notifs || public.add_notification(
    v_eng.tester_id, 'engagement_confirmed',
    jsonb_build_object(
      'request_id', v_req.id, 'engagement_id', eng, 'app_name', v_req.app_name));

  v_count := public.request_confirmed_count(v_req.id);
  IF v_count >= 12 THEN
    -- A3/A4: mark the >=12 window open; start the Google clock on first cross;
    -- recruiting/at_risk flip to active (streak_days stays as-is: a broken
    -- streak was already reset to 0 at dip time).
    UPDATE public.test_requests
      SET streak_ok_since  = COALESCE(streak_ok_since, now()),
          clock_started_at = COALESCE(clock_started_at, now()),
          status           = 'active'
      WHERE id = v_req.id;

    IF v_req.status IN ('recruiting', 'at_risk') THEN
      v_notifs := v_notifs || public.add_notification(
        v_req.owner_id, 'request_reached_12',
        jsonb_build_object(
          'request_id', v_req.id, 'app_name', v_req.app_name,
          'confirmed_count', v_count));
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'confirmed', true, 'confirmed_count', v_count, 'notifications', v_notifs);
END;
$$;

CREATE OR REPLACE FUNCTION public.confirm_engagement(eng uuid)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.confirm_engagement_impl(auth.uid(), eng);
$$;

-- ============================================================
-- 6. DROP / WITHDRAW (Flow 3 & 4 error states, decisions A5/A6)
-- ============================================================

CREATE OR REPLACE FUNCTION public.drop_engagement_impl(caller uuid, eng uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_req_id    uuid;
  v_req       public.test_requests%ROWTYPE;
  v_eng       public.engagements%ROWTYPE;
  v_tester    public.users%ROWTYPE;
  v_count     int;
  v_new_score int;
  v_outcome   text;
  v_notifs    jsonb := '[]'::jsonb;
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'LT_AUTH_REQUIRED'; END IF;

  SELECT request_id INTO v_req_id FROM public.engagements WHERE id = eng;
  IF NOT FOUND THEN RAISE EXCEPTION 'LT_NOT_FOUND'; END IF;

  SELECT * INTO v_req FROM public.test_requests WHERE id = v_req_id FOR UPDATE;

  SELECT * INTO v_eng FROM public.engagements WHERE id = eng FOR UPDATE;
  IF v_eng.tester_id <> caller THEN RAISE EXCEPTION 'LT_NOT_FOUND'; END IF;

  SELECT * INTO v_tester FROM public.users WHERE id = caller;

  IF v_eng.status = 'pending_developer' THEN
    -- A5: penalty-free withdrawal at any time before confirmation.
    UPDATE public.engagements
      SET status = 'cancelled', ended_at = now()
      WHERE id = eng;
    v_outcome := 'cancelled';
    v_new_score := v_tester.reliability_score;

  ELSIF v_eng.status IN ('confirmed', 'at_risk') THEN
    UPDATE public.engagements
      SET status = 'dropped', ended_at = now()
      WHERE id = eng;
    v_outcome := 'dropped';

    -- -15 reliability; A6 cooldown when the result is below 60.
    -- (GREATEST ignores NULL, so an unset cooldown extends cleanly.)
    PERFORM 1 FROM public.users WHERE id = caller FOR UPDATE;
    v_new_score := GREATEST(0, v_tester.reliability_score - 15);
    UPDATE public.users
      SET reliability_score = v_new_score,
          join_blocked_until = CASE
            WHEN v_new_score < 60
              THEN GREATEST(join_blocked_until, now() + interval '14 days')
            ELSE join_blocked_until
          END
      WHERE id = caller;

    -- A3: an under-12 dip breaks the streak immediately, not at the next cron.
    v_count := public.request_confirmed_count(v_req.id);
    IF v_count < 12 AND v_req.streak_ok_since IS NOT NULL THEN
      UPDATE public.test_requests
        SET streak_ok_since = NULL, streak_days = 0, status = 'at_risk'
        WHERE id = v_req.id;
      v_notifs := v_notifs || public.add_notification(
        v_req.owner_id, 'streak_broken',
        jsonb_build_object(
          'request_id', v_req.id, 'app_name', v_req.app_name,
          'confirmed_count', v_count, 'tester_name', v_tester.display_name));
    END IF;

  ELSE
    RAISE EXCEPTION 'LT_ENGAGEMENT_CLOSED';
  END IF;

  v_notifs := v_notifs || public.add_notification(
    v_req.owner_id, 'tester_dropped',
    jsonb_build_object(
      'request_id', v_req.id, 'engagement_id', eng, 'app_name', v_req.app_name,
      'tester_name', v_tester.display_name,
      'was_confirmed', v_outcome = 'dropped'));

  RETURN jsonb_build_object(
    'outcome', v_outcome, 'reliability_score', v_new_score,
    'notifications', v_notifs);
END;
$$;

CREATE OR REPLACE FUNCTION public.drop_engagement(eng uuid)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.drop_engagement_impl(auth.uid(), eng);
$$;

-- ============================================================
-- 7. REQUEST REPLACEMENT (Flow 4 error state, decision A10)
-- ============================================================

CREATE OR REPLACE FUNCTION public.request_replacement(eng uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_req_id uuid;
  v_req    public.test_requests%ROWTYPE;
  v_eng    public.engagements%ROWTYPE;
  v_result jsonb;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'LT_AUTH_REQUIRED'; END IF;

  SELECT request_id INTO v_req_id FROM public.engagements WHERE id = eng;
  IF NOT FOUND THEN RAISE EXCEPTION 'LT_NOT_FOUND'; END IF;

  SELECT * INTO v_req FROM public.test_requests WHERE id = v_req_id FOR UPDATE;
  IF v_req.owner_id <> v_caller THEN RAISE EXCEPTION 'LT_NOT_FOUND'; END IF;

  SELECT * INTO v_eng FROM public.engagements WHERE id = eng FOR UPDATE;
  IF v_eng.status <> 'at_risk' THEN RAISE EXCEPTION 'LT_NOT_AT_RISK'; END IF;
  IF v_eng.replacement_requested_at IS NOT NULL THEN
    RAISE EXCEPTION 'LT_REPLACEMENT_ALREADY';
  END IF;

  -- Escrow-backed growth by exactly one slot (founding grows free).
  -- grow_request_slots re-checks ownership/status and raises
  -- LT_SLOTS_MAX_20 / LT_INSUFFICIENT_CREDITS as needed; auth.uid() inside
  -- it still resolves to this caller.
  v_result := public.grow_request_slots(v_req_id, v_req.slots_needed + 1);

  UPDATE public.engagements SET replacement_requested_at = now() WHERE id = eng;

  RETURN jsonb_build_object(
    'slots', v_result -> 'slots', 'cost', v_result -> 'cost',
    'notifications', '[]'::jsonb);
END;
$$;

-- ============================================================
-- 8. DAILY CLOCKS CRON (SPEC F3 business logic, §7)
-- ============================================================

CREATE OR REPLACE FUNCTION public.run_daily_clocks()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_today     date := (now() AT TIME ZONE 'utc')::date;
  v_yesterday date := (now() AT TIME ZONE 'utc')::date - 1;
  v_req       public.test_requests%ROWTYPE;
  r           RECORD;
  v_count     int;
  v_from      date;
  v_add       int;
  v_held      int;
  v_balance   int;
  v_advanced  int := 0;
  v_reset     int := 0;
  v_eng_risk  int := 0;
  v_expired   int := 0;
  v_notifs    jsonb := '[]'::jsonb;
BEGIN
  -- ---- A. Request streaks (advance / reset / self-heal) ----
  -- Deterministic id order keeps concurrent runs deadlock-safe.
  FOR r IN
    SELECT id FROM public.test_requests
    WHERE status IN ('active', 'at_risk')
    ORDER BY id
  LOOP
    SELECT * INTO v_req FROM public.test_requests WHERE id = r.id FOR UPDATE;
    v_count := public.request_confirmed_count(v_req.id);

    IF v_count >= 12 THEN
      IF v_req.streak_ok_since IS NULL THEN
        -- Self-heal: >=12 but no window marker (missed event) — open it now.
        -- Today becomes the first potential full day; nothing credited yet.
        UPDATE public.test_requests
          SET streak_ok_since  = now(),
              clock_started_at = COALESCE(clock_started_at, now()),
              status           = 'active'
          WHERE id = v_req.id;
      ELSE
        -- Credit every COMPLETE UTC day since the window opened that has not
        -- been counted yet. streak_last_counted_day makes re-runs no-ops and
        -- catches up cleanly after missed cron days (A3).
        v_from := (v_req.streak_ok_since AT TIME ZONE 'utc')::date + 1;
        IF v_req.streak_last_counted_day IS NOT NULL
           AND v_req.streak_last_counted_day + 1 > v_from THEN
          v_from := v_req.streak_last_counted_day + 1;
        END IF;
        v_add := v_yesterday - v_from + 1;
        IF v_add > 0 THEN
          UPDATE public.test_requests
            SET streak_days = streak_days + v_add,
                streak_last_counted_day = v_yesterday
            WHERE id = v_req.id;
          v_advanced := v_advanced + 1;
        END IF;
      END IF;

    ELSE
      -- Below 12. Normally drop_engagement already did this (A3); this is the
      -- self-heal backstop, and it must not re-fire on already-reset rows.
      IF v_req.status = 'active'
         OR v_req.streak_days > 0
         OR v_req.streak_ok_since IS NOT NULL THEN
        UPDATE public.test_requests
          SET streak_days = 0, streak_ok_since = NULL, status = 'at_risk'
          WHERE id = v_req.id;
        v_reset := v_reset + 1;
        v_notifs := v_notifs || public.add_notification(
          v_req.owner_id, 'streak_broken',
          jsonb_build_object(
            'request_id', v_req.id, 'app_name', v_req.app_name,
            'confirmed_count', v_count));
      END IF;
    END IF;
  END LOOP;

  -- ---- B. Engagement 5-day inactivity -> at_risk (A7: no penalty in F3) ----
  -- Activity falls back to confirmed_at until check-ins exist (F4).
  FOR r IN
    SELECT e.id, e.request_id, e.tester_id,
           req.owner_id, req.app_name,
           u.display_name AS tester_name
    FROM public.engagements e
    JOIN public.test_requests req ON req.id = e.request_id
    JOIN public.users u ON u.id = e.tester_id
    WHERE e.status = 'confirmed'
      AND COALESCE(e.last_checkin_at, e.confirmed_at) < now() - interval '5 days'
      AND req.status IN ('recruiting', 'active', 'at_risk')
    ORDER BY e.id
  LOOP
    UPDATE public.engagements
      SET status = 'at_risk'
      WHERE id = r.id AND status = 'confirmed';
    IF FOUND THEN
      v_eng_risk := v_eng_risk + 1;
      v_notifs := v_notifs || public.add_notification(
        r.tester_id, 'engagement_at_risk',
        jsonb_build_object(
          'request_id', r.request_id, 'engagement_id', r.id,
          'app_name', r.app_name, 'role', 'tester'));
      v_notifs := v_notifs || public.add_notification(
        r.owner_id, 'engagement_at_risk',
        jsonb_build_object(
          'request_id', r.request_id, 'engagement_id', r.id,
          'app_name', r.app_name, 'role', 'owner',
          'tester_name', r.tester_name));
    END IF;
  END LOOP;

  -- ---- C. 30-day zero-confirm expiry + full escrow refund (F2 rule, A9) ----
  FOR r IN
    SELECT id FROM public.test_requests
    WHERE status = 'recruiting'
      AND published_at < now() - interval '30 days'
    ORDER BY id
  LOOP
    SELECT * INTO v_req FROM public.test_requests WHERE id = r.id FOR UPDATE;
    IF v_req.status = 'recruiting'
       AND v_req.published_at < now() - interval '30 days'
       AND NOT EXISTS (
         SELECT 1 FROM public.engagements e
         WHERE e.request_id = v_req.id AND e.confirmed_at IS NOT NULL
       ) THEN

      UPDATE public.engagements
        SET status = 'cancelled', ended_at = now()
        WHERE request_id = v_req.id AND status = 'pending_developer';

      v_held := 0;
      IF NOT v_req.is_founding THEN
        SELECT COALESCE(sum(amount), 0)::int INTO v_held
        FROM public.credit_transactions
        WHERE request_id = v_req.id AND type = 'escrow_hold' AND status = 'pending';

        UPDATE public.credit_transactions
          SET status = 'cancelled'
          WHERE request_id = v_req.id AND type = 'escrow_hold' AND status = 'pending';

        IF v_held > 0 THEN
          PERFORM 1 FROM public.users WHERE id = v_req.owner_id FOR UPDATE;
          v_balance := public.settled_balance(v_req.owner_id);
          INSERT INTO public.credit_transactions
            (user_id, amount, type, status, request_id, balance_after)
          VALUES
            (v_req.owner_id, v_held, 'refund', 'settled', v_req.id, v_balance + v_held);
        END IF;
      END IF;

      UPDATE public.test_requests SET status = 'expired' WHERE id = v_req.id;
      v_expired := v_expired + 1;
      v_notifs := v_notifs || public.add_notification(
        v_req.owner_id, 'request_expired',
        jsonb_build_object(
          'request_id', v_req.id, 'app_name', v_req.app_name, 'refund', v_held));
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'evaluated_day', v_yesterday,
    'advanced', v_advanced, 'reset', v_reset,
    'engagements_at_risk', v_eng_risk, 'expired', v_expired,
    'notifications', v_notifs);
END;
$$;

-- ============================================================
-- 9. CONFIRM REMINDERS CRON (Flow 3 error state: 48h)
-- ============================================================

CREATE OR REPLACE FUNCTION public.run_confirm_reminders()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r        RECORD;
  v_count  int := 0;
  v_notifs jsonb := '[]'::jsonb;
BEGIN
  FOR r IN
    SELECT e.id, e.request_id, e.tester_id,
           req.owner_id, req.app_name,
           u.display_name AS tester_name
    FROM public.engagements e
    JOIN public.test_requests req ON req.id = e.request_id
    JOIN public.users u ON u.id = e.tester_id
    WHERE e.status = 'pending_developer'
      AND e.confirm_reminded_at IS NULL
      AND e.joined_at < now() - interval '48 hours'
      AND req.status IN ('recruiting', 'active', 'at_risk')
    ORDER BY e.id
  LOOP
    UPDATE public.engagements
      SET confirm_reminded_at = now()
      WHERE id = r.id AND status = 'pending_developer' AND confirm_reminded_at IS NULL;
    IF FOUND THEN
      v_count := v_count + 1;
      v_notifs := v_notifs || public.add_notification(
        r.owner_id, 'confirm_reminder_48h',
        jsonb_build_object(
          'request_id', r.request_id, 'engagement_id', r.id,
          'app_name', r.app_name, 'tester_name', r.tester_name));
    END IF;
  END LOOP;

  RETURN jsonb_build_object('reminders', v_count, 'notifications', v_notifs);
END;
$$;

-- ============================================================
-- 10. PUBLISH REFACTOR (impl + wrapper; body unchanged from F2)
-- ============================================================

CREATE OR REPLACE FUNCTION public.publish_request_impl(caller uuid, req uuid, expect_free boolean)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_req     public.test_requests%ROWTYPE;
  v_phase   boolean;
  v_cap     int;
  v_used    int;
  v_price   int;
  v_cost    int;
  v_balance int;
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'LT_AUTH_REQUIRED'; END IF;

  SELECT * INTO v_req FROM public.test_requests WHERE id = req FOR UPDATE;
  IF NOT FOUND OR v_req.owner_id <> caller THEN
    RAISE EXCEPTION 'LT_NOT_FOUND';
  END IF;
  IF v_req.status <> 'draft' THEN RAISE EXCEPTION 'LT_NOT_DRAFT'; END IF;

  PERFORM 1 FROM public.users WHERE id = caller FOR UPDATE;

  SELECT (value #>> '{}')::int INTO v_used
  FROM public.system_config WHERE key = 'founding_used' FOR UPDATE;

  v_phase := COALESCE(
    (SELECT (value #>> '{}')::boolean FROM public.system_config WHERE key = 'founding_phase'),
    false);
  v_cap   := public.config_int('founding_cap', 0);
  v_price := public.config_int('credit_price_per_slot', 1);

  IF v_phase AND COALESCE(v_used, 0) < v_cap THEN
    UPDATE public.system_config
      SET value = to_jsonb(COALESCE(v_used, 0) + 1)
      WHERE key = 'founding_used';
    UPDATE public.test_requests
      SET status = 'recruiting', is_founding = true, published_at = now()
      WHERE id = req;
    RETURN jsonb_build_object('cost', 0, 'is_founding', true);
  END IF;

  IF expect_free THEN RAISE EXCEPTION 'LT_FOUNDING_CAP_REACHED'; END IF;

  v_cost := v_req.slots_needed * v_price;
  v_balance := public.settled_balance(caller);
  IF v_balance < v_cost THEN
    RAISE EXCEPTION 'LT_INSUFFICIENT_CREDITS:%', v_cost - v_balance;
  END IF;

  INSERT INTO public.credit_transactions
    (user_id, amount, type, status, request_id, balance_after)
  VALUES
    (caller, -v_cost, 'spend_post',  'settled', req, v_balance - v_cost),
    (caller,  v_cost, 'escrow_hold', 'pending', req, v_balance - v_cost);

  UPDATE public.test_requests
    SET status = 'recruiting', is_founding = false, published_at = now()
    WHERE id = req;

  RETURN jsonb_build_object('cost', v_cost, 'is_founding', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.publish_request(req uuid, expect_free boolean)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.publish_request_impl(auth.uid(), req, expect_free);
$$;

-- ============================================================
-- 11. CANCEL: stamp ended_at on engagement cancellation (only change)
-- ============================================================

CREATE OR REPLACE FUNCTION public.cancel_request(req uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller   uuid := auth.uid();
  v_req      public.test_requests%ROWTYPE;
  v_eng      RECORD;
  v_released int := 0;
  v_held     int := 0;
  v_refund   int := 0;
  v_balance  int;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'LT_AUTH_REQUIRED'; END IF;

  SELECT * INTO v_req FROM public.test_requests WHERE id = req FOR UPDATE;
  IF NOT FOUND OR v_req.owner_id <> v_caller THEN
    RAISE EXCEPTION 'LT_NOT_FOUND';
  END IF;
  IF v_req.status IN ('completed', 'cancelled', 'expired') THEN
    RAISE EXCEPTION 'LT_ALREADY_TERMINAL';
  END IF;

  IF v_req.status = 'draft' THEN
    UPDATE public.test_requests SET status = 'cancelled' WHERE id = req;
    RETURN jsonb_build_object('refund', 0, 'released', 0);
  END IF;

  -- Fairness rule: confirmed/at-risk testers are released their escrowed
  -- credit immediately.
  FOR v_eng IN
    SELECT e.id, e.tester_id
    FROM public.engagements e
    WHERE e.request_id = req AND e.status IN ('confirmed', 'at_risk')
    ORDER BY e.joined_at
  LOOP
    PERFORM 1 FROM public.users WHERE id = v_eng.tester_id FOR UPDATE;
    v_balance := public.settled_balance(v_eng.tester_id);
    INSERT INTO public.credit_transactions
      (user_id, amount, type, status, request_id, engagement_id, balance_after)
    VALUES
      (v_eng.tester_id, 1, 'escrow_release', 'settled', req, v_eng.id, v_balance + 1);
    v_released := v_released + 1;
  END LOOP;

  UPDATE public.engagements
    SET status = 'cancelled', ended_at = now()
    WHERE request_id = req
      AND status IN ('pending_developer', 'confirmed', 'at_risk');

  IF NOT v_req.is_founding THEN
    SELECT COALESCE(sum(amount), 0)::int INTO v_held
    FROM public.credit_transactions
    WHERE request_id = req AND type = 'escrow_hold' AND status = 'pending';

    UPDATE public.credit_transactions
      SET status = 'cancelled'
      WHERE request_id = req AND type = 'escrow_hold' AND status = 'pending';

    v_refund := GREATEST(v_held - v_released, 0);
    IF v_refund > 0 THEN
      PERFORM 1 FROM public.users WHERE id = v_caller FOR UPDATE;
      v_balance := public.settled_balance(v_caller);
      INSERT INTO public.credit_transactions
        (user_id, amount, type, status, request_id, balance_after)
      VALUES
        (v_caller, v_refund, 'refund', 'settled', req, v_balance + v_refund);
    END IF;
  END IF;

  UPDATE public.test_requests SET status = 'cancelled' WHERE id = req;

  RETURN jsonb_build_object('refund', v_refund, 'released', v_released);
END;
$$;

-- ============================================================
-- 12. SEED WRAPPERS (service_role ONLY — dev/test harness)
-- ============================================================

-- The harness impersonates seeded users through these; they run the exact
-- same _impl code paths as the real actions. Never granted to end users.

CREATE OR REPLACE FUNCTION public.seed_join_test(tester uuid, req uuid, device uuid)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.join_test_impl(tester, req, device);
$$;

CREATE OR REPLACE FUNCTION public.seed_mark_opted_in(eng uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tester uuid;
BEGIN
  SELECT tester_id INTO v_tester FROM public.engagements WHERE id = eng;
  IF NOT FOUND THEN RAISE EXCEPTION 'LT_NOT_FOUND'; END IF;
  RETURN public.mark_opted_in_impl(v_tester, eng);
END;
$$;

CREATE OR REPLACE FUNCTION public.seed_confirm_engagement(eng uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_owner uuid;
BEGIN
  SELECT r.owner_id INTO v_owner
  FROM public.engagements e
  JOIN public.test_requests r ON r.id = e.request_id
  WHERE e.id = eng;
  IF NOT FOUND THEN RAISE EXCEPTION 'LT_NOT_FOUND'; END IF;
  RETURN public.confirm_engagement_impl(v_owner, eng);
END;
$$;

CREATE OR REPLACE FUNCTION public.seed_drop_engagement(eng uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tester uuid;
BEGIN
  SELECT tester_id INTO v_tester FROM public.engagements WHERE id = eng;
  IF NOT FOUND THEN RAISE EXCEPTION 'LT_NOT_FOUND'; END IF;
  RETURN public.drop_engagement_impl(v_tester, eng);
END;
$$;

CREATE OR REPLACE FUNCTION public.seed_publish_request(req uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_owner uuid;
BEGIN
  SELECT owner_id INTO v_owner FROM public.test_requests WHERE id = req;
  IF NOT FOUND THEN RAISE EXCEPTION 'LT_NOT_FOUND'; END IF;
  RETURN public.publish_request_impl(v_owner, req, false);
END;
$$;

-- ============================================================
-- 13. VIEW: slot counts now expose capacity too (A1/A2)
-- ============================================================

-- confirmed_count changes meaning: completed now counts (A1).
-- occupied_count is the capacity number the board/request pages display.
CREATE OR REPLACE VIEW public.request_slot_counts AS
SELECT
  r.id AS request_id,
  count(e.id) FILTER (
    WHERE e.status IN ('confirmed', 'at_risk', 'completed')
  )::int AS confirmed_count,
  count(e.id) FILTER (
    WHERE e.status NOT IN ('dropped', 'cancelled')
  )::int AS occupied_count
FROM public.test_requests r
LEFT JOIN public.engagements e ON e.request_id = r.id
WHERE r.status IN ('recruiting', 'at_risk', 'active', 'completed')
GROUP BY r.id;

-- Re-assert view privileges (REPLACE preserves ACLs; belt and suspenders).
REVOKE ALL ON public.request_slot_counts FROM anon, authenticated, PUBLIC;
GRANT SELECT ON public.request_slot_counts TO anon, authenticated;

-- ============================================================
-- 14. FUNCTION PRIVILEGES
-- ============================================================

-- Postgres grants EXECUTE to PUBLIC on new functions by default — strip
-- everything, then grant deliberately.

-- internal helpers: no client access at all
REVOKE ALL ON FUNCTION public.request_confirmed_count(uuid)              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.request_occupied_count(uuid)               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.add_notification(uuid, text, jsonb)        FROM PUBLIC, anon, authenticated;

-- impls: callable only through their wrappers
REVOKE ALL ON FUNCTION public.join_test_impl(uuid, uuid, uuid)           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_opted_in_impl(uuid, uuid)             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.confirm_engagement_impl(uuid, uuid)        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.drop_engagement_impl(uuid, uuid)           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.publish_request_impl(uuid, uuid, boolean)  FROM PUBLIC, anon, authenticated;

-- user-facing actions: authenticated only
REVOKE ALL ON FUNCTION public.join_test(uuid, uuid)                      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mark_opted_in(uuid)                        FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.confirm_engagement(uuid)                   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.drop_engagement(uuid)                      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.request_replacement(uuid)                  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.join_test(uuid, uuid)                   TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_opted_in(uuid)                     TO authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_engagement(uuid)                TO authenticated;
GRANT EXECUTE ON FUNCTION public.drop_engagement(uuid)                   TO authenticated;
GRANT EXECUTE ON FUNCTION public.request_replacement(uuid)               TO authenticated;

-- cron + seed: service_role only (the SQL Editor runs as postgres and keeps
-- owner access for manual admin runs)
REVOKE ALL ON FUNCTION public.run_daily_clocks()                         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.run_confirm_reminders()                    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.seed_join_test(uuid, uuid, uuid)           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.seed_mark_opted_in(uuid)                   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.seed_confirm_engagement(uuid)              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.seed_drop_engagement(uuid)                 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.seed_publish_request(uuid)                 FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_daily_clocks()                      TO service_role;
GRANT EXECUTE ON FUNCTION public.run_confirm_reminders()                 TO service_role;
GRANT EXECUTE ON FUNCTION public.seed_join_test(uuid, uuid, uuid)        TO service_role;
GRANT EXECUTE ON FUNCTION public.seed_mark_opted_in(uuid)                TO service_role;
GRANT EXECUTE ON FUNCTION public.seed_confirm_engagement(uuid)           TO service_role;
GRANT EXECUTE ON FUNCTION public.seed_drop_engagement(uuid)              TO service_role;
GRANT EXECUTE ON FUNCTION public.seed_publish_request(uuid)              TO service_role;

COMMIT;
