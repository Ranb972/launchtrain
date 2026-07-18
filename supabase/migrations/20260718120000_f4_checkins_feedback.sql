-- F4: check-ins & structured feedback (2026-07-18).
-- Single-transaction migration: a failed run leaves the database clean.
--
-- Implements SPEC Flow 4 (check-ins, mid/final feedback, completion +
-- escrow release), Flow 5 steps 1–2 (feedback structure, helpful rating),
-- Feature F4, and the §7 actions createCheckin / submitFeedback /
-- rateFeedback. Same architecture as F2/F3: SECURITY DEFINER impl functions
-- with auth wrappers and service-role seed wrappers; credits move in the
-- same transaction as the state change (SPEC §0.4).
--
-- Approved F4 rules (Ran, 2026-07-18 — recorded in SPEC v1.7):
--   B2. A check-in on an at_risk engagement returns it to confirmed and
--       re-arms the day-3 reminder; the −5 is NOT refunded; no notification.
--   B3. The 3/week minimum is a display-only meter (rolling 7 UTC days);
--       enforcement stays with the 5-day at-risk mechanism.
--   B4. −5 reliability per at-risk FLIP (not per day), with the <60
--       cooldown; a re-flip after recovery costs another −5.
--   B5. Day-3 check-in reminder in the hourly cron via
--       engagements.checkin_reminded_at, cleared on each check-in so every
--       fresh 3-day gap reminds once.
--   B6. Feedback gates: mid from engagement day >= 7 (no upper bound),
--       final from day >= 14; live engagement required. Final ALWAYS
--       completes: status, escrow_release +1 settled, reliability +2
--       (cap 100), notifications — one transaction.
--   B7. Immutability by privilege: no client UPDATE grants on feedback;
--       add_feedback_addendum is write-once; rate_feedback touches only
--       developer_rating.
--   B8. Rating applies to FINAL feedback only (v1.7 clarification of Flow 5
--       "each feedback"). Same-value repeat → no-op success (never a second
--       bonus); changing the value → LT_ALREADY_RATED. not_helpful mints
--       nothing and sends nothing.
--   B10. CORRECTIVE (approved): cancel_request refund now deducts escrow
--       releases already settled by completions, preserving mint = burn.
--       Prior formula would over-refund once F4 completions exist.
--
-- New error codes: LT_NOT_CONFIRMED, LT_ALREADY_CHECKED_IN_TODAY,
-- LT_NOTE_REQUIRED, LT_INVALID_RATING, LT_INVALID_BUGS,
-- LT_FEEDBACK_TOO_EARLY:<unlock_day>, LT_FEEDBACK_EXISTS,
-- LT_ADDENDUM_EXISTS, LT_INVALID_ADDENDUM, LT_ALREADY_RATED, LT_NOT_FINAL.
--
-- Lock ordering (unchanged hierarchy): request -> engagement -> feedback ->
-- user. submit_feedback locks the REQUEST first so completions serialize
-- with cancel_request's release loop (no double escrow release).

BEGIN;

-- ============================================================
-- 1. COLUMNS
-- ============================================================

ALTER TABLE public.engagements
  ADD COLUMN checkin_reminded_at       timestamptz,  -- B5: day-3 reminder marker, re-armed by check-ins
  ADD COLUMN feedback_mid_prompted_at  timestamptz,  -- day-7 prompt sent
  ADD COLUMN feedback_final_prompted_at timestamptz; -- day-14 prompt sent

-- ============================================================
-- 2. HELPERS
-- ============================================================

-- Engagement day N in UTC: day 1 = the UTC day of confirmation (Flow 4).
CREATE OR REPLACE FUNCTION public.engagement_day_utc(confirmed timestamptz)
RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT ((now() AT TIME ZONE 'utc')::date
          - (confirmed AT TIME ZONE 'utc')::date + 1)::int;
$$;

-- ============================================================
-- 3. CREATE CHECKIN (SPEC Flow 4 step 2, §7)
-- ============================================================

CREATE OR REPLACE FUNCTION public.create_checkin_impl(
  caller uuid, eng uuid, cstatus public.checkin_status, note text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_eng        public.engagements%ROWTYPE;
  v_checkin_id uuid;
  v_recovered  boolean := false;
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'LT_AUTH_REQUIRED'; END IF;

  -- Single-engagement operation; no credits move. Engagement lock only.
  SELECT * INTO v_eng FROM public.engagements WHERE id = eng FOR UPDATE;
  IF NOT FOUND OR v_eng.tester_id <> caller THEN RAISE EXCEPTION 'LT_NOT_FOUND'; END IF;
  IF v_eng.status = 'pending_developer' THEN RAISE EXCEPTION 'LT_NOT_CONFIRMED'; END IF;
  IF v_eng.status NOT IN ('confirmed', 'at_risk') THEN
    RAISE EXCEPTION 'LT_ENGAGEMENT_CLOSED';
  END IF;

  IF cstatus = 'issue' AND (note IS NULL OR btrim(note) = '') THEN
    RAISE EXCEPTION 'LT_NOTE_REQUIRED';
  END IF;

  -- The unique index (engagement_id, UTC date) is the authoritative
  -- once-per-day rule (SPEC F4); map its violation to a friendly code.
  BEGIN
    INSERT INTO public.checkins (engagement_id, status, note)
    VALUES (eng, cstatus, NULLIF(btrim(COALESCE(note, '')), ''))
    RETURNING id INTO v_checkin_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'LT_ALREADY_CHECKED_IN_TODAY';
  END;

  v_recovered := v_eng.status = 'at_risk';

  -- B2: activity recorded, at_risk recovers to confirmed (no penalty refund),
  -- and the day-3 reminder re-arms for the next gap (B5).
  UPDATE public.engagements
    SET last_checkin_at     = now(),
        checkin_count       = checkin_count + 1,
        status              = 'confirmed',
        checkin_reminded_at = NULL
    WHERE id = eng;

  RETURN jsonb_build_object(
    'checkin_id', v_checkin_id,
    'recovered', v_recovered,
    'checkin_count', v_eng.checkin_count + 1,
    'notifications', '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.create_checkin(eng uuid, cstatus public.checkin_status, note text)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.create_checkin_impl(auth.uid(), eng, cstatus, note);
$$;

-- ============================================================
-- 4. SUBMIT FEEDBACK (Flow 4 steps 3–4, Flow 5 step 1, §7)
-- ============================================================

CREATE OR REPLACE FUNCTION public.submit_feedback_impl(
  caller uuid, eng uuid, ftype public.feedback_type,
  stability int, ux int, value_score int,
  bugs jsonb, suggestions text, usage_freq public.usage_frequency)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_req_id      uuid;
  v_req         public.test_requests%ROWTYPE;
  v_eng         public.engagements%ROWTYPE;
  v_tester      public.users%ROWTYPE;
  v_day         int;
  v_bug         jsonb;
  v_fb_id       uuid;
  v_balance     int;
  v_new_score   int;
  v_notifs      jsonb := '[]'::jsonb;
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'LT_AUTH_REQUIRED'; END IF;

  SELECT request_id INTO v_req_id FROM public.engagements WHERE id = eng;
  IF NOT FOUND THEN RAISE EXCEPTION 'LT_NOT_FOUND'; END IF;

  -- Request lock FIRST: serializes final-feedback completion against
  -- cancel_request's fairness releases (no double escrow release).
  SELECT * INTO v_req FROM public.test_requests WHERE id = v_req_id FOR UPDATE;

  SELECT * INTO v_eng FROM public.engagements WHERE id = eng FOR UPDATE;
  IF v_eng.tester_id <> caller THEN RAISE EXCEPTION 'LT_NOT_FOUND'; END IF;
  IF v_eng.status = 'pending_developer' THEN RAISE EXCEPTION 'LT_NOT_CONFIRMED'; END IF;
  IF v_eng.status NOT IN ('confirmed', 'at_risk') THEN
    RAISE EXCEPTION 'LT_ENGAGEMENT_CLOSED';
  END IF;

  IF stability NOT BETWEEN 1 AND 5 OR ux NOT BETWEEN 1 AND 5
     OR value_score NOT BETWEEN 1 AND 5 THEN
    RAISE EXCEPTION 'LT_INVALID_RATING';
  END IF;

  IF bugs IS NULL OR jsonb_typeof(bugs) <> 'array' OR jsonb_array_length(bugs) > 20 THEN
    RAISE EXCEPTION 'LT_INVALID_BUGS';
  END IF;
  FOR v_bug IN SELECT * FROM jsonb_array_elements(bugs) LOOP
    IF jsonb_typeof(v_bug) <> 'object'
       OR btrim(COALESCE(v_bug ->> 'text', '')) = ''
       OR char_length(v_bug ->> 'text') > 500
       OR (v_bug ->> 'severity') NOT IN ('low', 'medium', 'high') THEN
      RAISE EXCEPTION 'LT_INVALID_BUGS';
    END IF;
  END LOOP;

  IF suggestions IS NOT NULL AND char_length(suggestions) > 2000 THEN
    RAISE EXCEPTION 'LT_INVALID_ADDENDUM';
  END IF;

  -- B6: day gates from confirmed_at (UTC day 1 = confirmation day).
  v_day := public.engagement_day_utc(v_eng.confirmed_at);
  IF ftype = 'mid' AND v_day < 7 THEN RAISE EXCEPTION 'LT_FEEDBACK_TOO_EARLY:7'; END IF;
  IF ftype = 'final' AND v_day < 14 THEN RAISE EXCEPTION 'LT_FEEDBACK_TOO_EARLY:14'; END IF;

  BEGIN
    INSERT INTO public.feedback
      (engagement_id, type, stability, ux, value, bugs, suggestions, usage_frequency)
    VALUES
      (eng, ftype, stability, ux, value_score, bugs,
       NULLIF(btrim(COALESCE(suggestions, '')), ''), usage_freq)
    RETURNING id INTO v_fb_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'LT_FEEDBACK_EXISTS';
  END;

  SELECT * INTO v_tester FROM public.users WHERE id = caller;
  v_notifs := v_notifs || public.add_notification(
    v_req.owner_id, 'feedback_received',
    jsonb_build_object(
      'request_id', v_req.id, 'engagement_id', eng, 'app_name', v_req.app_name,
      'tester_name', v_tester.display_name, 'feedback_type', ftype::text,
      'bug_count', jsonb_array_length(bugs)));

  IF ftype = 'final' THEN
    -- B6: completion + escrow release + reliability, atomically.
    UPDATE public.engagements
      SET status = 'completed', completed_at = now()
      WHERE id = eng;

    PERFORM 1 FROM public.users WHERE id = caller FOR UPDATE;
    v_balance := public.settled_balance(caller);
    INSERT INTO public.credit_transactions
      (user_id, amount, type, status, request_id, engagement_id, balance_after)
    VALUES
      (caller, 1, 'escrow_release', 'settled', v_req.id, eng, v_balance + 1);

    v_new_score := LEAST(100, v_tester.reliability_score + 2);
    UPDATE public.users SET reliability_score = v_new_score WHERE id = caller;

    v_notifs := v_notifs || public.add_notification(
      caller, 'engagement_completed',
      jsonb_build_object(
        'request_id', v_req.id, 'engagement_id', eng, 'app_name', v_req.app_name,
        'credit', 1, 'reliability_score', v_new_score));
  END IF;

  RETURN jsonb_build_object(
    'feedback_id', v_fb_id,
    'completed', ftype = 'final',
    'notifications', v_notifs);
END;
$$;

CREATE OR REPLACE FUNCTION public.submit_feedback(
  eng uuid, ftype public.feedback_type,
  stability int, ux int, value_score int,
  bugs jsonb, suggestions text, usage_freq public.usage_frequency)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.submit_feedback_impl(
    auth.uid(), eng, ftype, stability, ux, value_score, bugs, suggestions, usage_freq);
$$;

-- ============================================================
-- 5. ADDENDUM (F4 edge case: write-once note on immutable feedback)
-- ============================================================

CREATE OR REPLACE FUNCTION public.add_feedback_addendum_impl(caller uuid, fb uuid, note text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_fb     public.feedback%ROWTYPE;
  v_tester uuid;
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'LT_AUTH_REQUIRED'; END IF;
  IF note IS NULL OR btrim(note) = '' OR char_length(note) > 1000 THEN
    RAISE EXCEPTION 'LT_INVALID_ADDENDUM';
  END IF;

  SELECT * INTO v_fb FROM public.feedback WHERE id = fb FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'LT_NOT_FOUND'; END IF;
  SELECT tester_id INTO v_tester FROM public.engagements WHERE id = v_fb.engagement_id;
  IF v_tester <> caller THEN RAISE EXCEPTION 'LT_NOT_FOUND'; END IF;
  IF v_fb.addendum IS NOT NULL THEN RAISE EXCEPTION 'LT_ADDENDUM_EXISTS'; END IF;

  UPDATE public.feedback SET addendum = btrim(note) WHERE id = fb;
  RETURN jsonb_build_object('ok', true, 'notifications', '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.add_feedback_addendum(fb uuid, note text)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.add_feedback_addendum_impl(auth.uid(), fb, note);
$$;

-- ============================================================
-- 6. RATE FEEDBACK (Flow 5 step 2, §7 — B8)
-- ============================================================

CREATE OR REPLACE FUNCTION public.rate_feedback_impl(
  caller uuid, fb uuid, rating public.developer_rating)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_fb      public.feedback%ROWTYPE;
  v_eng     public.engagements%ROWTYPE;
  v_req     public.test_requests%ROWTYPE;
  v_balance int;
  v_bonus   int := 0;
  v_notifs  jsonb := '[]'::jsonb;
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'LT_AUTH_REQUIRED'; END IF;

  SELECT * INTO v_fb FROM public.feedback WHERE id = fb FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'LT_NOT_FOUND'; END IF;

  SELECT * INTO v_eng FROM public.engagements WHERE id = v_fb.engagement_id;
  SELECT * INTO v_req FROM public.test_requests WHERE id = v_eng.request_id;
  IF v_req.owner_id <> caller THEN RAISE EXCEPTION 'LT_NOT_FOUND'; END IF;
  IF v_fb.type <> 'final' THEN RAISE EXCEPTION 'LT_NOT_FINAL'; END IF;

  -- B8: idempotent on repeat of the same value; the rating itself is final.
  IF v_fb.developer_rating IS NOT NULL THEN
    IF v_fb.developer_rating = rating THEN
      RETURN jsonb_build_object('bonus', 0, 'already_rated', true,
                                'notifications', '[]'::jsonb);
    END IF;
    RAISE EXCEPTION 'LT_ALREADY_RATED';
  END IF;

  UPDATE public.feedback SET developer_rating = rating WHERE id = fb;

  IF rating = 'helpful' THEN
    -- Deliberate system mint (SPEC F6): +1 bonus, once per feedback.
    PERFORM 1 FROM public.users WHERE id = v_eng.tester_id FOR UPDATE;
    v_balance := public.settled_balance(v_eng.tester_id);
    INSERT INTO public.credit_transactions
      (user_id, amount, type, status, request_id, engagement_id, balance_after)
    VALUES
      (v_eng.tester_id, 1, 'bonus', 'settled', v_req.id, v_eng.id, v_balance + 1);
    v_bonus := 1;

    v_notifs := v_notifs || public.add_notification(
      v_eng.tester_id, 'bonus_credit',
      jsonb_build_object(
        'request_id', v_req.id, 'engagement_id', v_eng.id,
        'app_name', v_req.app_name, 'amount', 1));
  END IF;

  RETURN jsonb_build_object('bonus', v_bonus, 'already_rated', false,
                            'notifications', v_notifs);
END;
$$;

CREATE OR REPLACE FUNCTION public.rate_feedback(fb uuid, rating public.developer_rating)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.rate_feedback_impl(auth.uid(), fb, rating);
$$;

-- ============================================================
-- 7. DAILY CLOCKS: −5 on at-risk flip (B4) + feedback prompts
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
  v_score     int;
  v_advanced  int := 0;
  v_reset     int := 0;
  v_eng_risk  int := 0;
  v_expired   int := 0;
  v_mid_p     int := 0;
  v_final_p   int := 0;
  v_notifs    jsonb := '[]'::jsonb;
BEGIN
  -- ---- A. Request streaks (advance / reset / self-heal) — unchanged ----
  FOR r IN
    SELECT id FROM public.test_requests
    WHERE status IN ('active', 'at_risk')
    ORDER BY id
  LOOP
    SELECT * INTO v_req FROM public.test_requests WHERE id = r.id FOR UPDATE;
    v_count := public.request_confirmed_count(v_req.id);

    IF v_count >= 12 THEN
      IF v_req.streak_ok_since IS NULL THEN
        UPDATE public.test_requests
          SET streak_ok_since  = now(),
              clock_started_at = COALESCE(clock_started_at, now()),
              status           = 'active'
          WHERE id = v_req.id;
      ELSE
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

  -- ---- B. Engagement 5-day inactivity -> at_risk, now WITH −5 (B4) ----
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

      -- −5 per flip; cooldown when the result is below 60 (F3 rule 5).
      SELECT reliability_score INTO v_score
      FROM public.users WHERE id = r.tester_id FOR UPDATE;
      v_score := GREATEST(0, v_score - 5);
      UPDATE public.users
        SET reliability_score = v_score,
            join_blocked_until = CASE
              WHEN v_score < 60
                THEN GREATEST(join_blocked_until, now() + interval '14 days')
              ELSE join_blocked_until
            END
        WHERE id = r.tester_id;

      v_notifs := v_notifs || public.add_notification(
        r.tester_id, 'engagement_at_risk',
        jsonb_build_object(
          'request_id', r.request_id, 'engagement_id', r.id,
          'app_name', r.app_name, 'role', 'tester',
          'penalty', 5, 'reliability_score', v_score));
      v_notifs := v_notifs || public.add_notification(
        r.owner_id, 'engagement_at_risk',
        jsonb_build_object(
          'request_id', r.request_id, 'engagement_id', r.id,
          'app_name', r.app_name, 'role', 'owner',
          'tester_name', r.tester_name));
    END IF;
  END LOOP;

  -- ---- C. 30-day zero-confirm expiry — unchanged (zero confirms means
  --         zero completions, so no prior releases to account for) ----
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

  -- ---- D. Feedback prompts: day 7 (mid) / day 14 (final), once each,
  --         skipped when the feedback already exists ----
  FOR r IN
    SELECT e.id, e.tester_id, e.request_id, e.confirmed_at,
           e.feedback_mid_prompted_at, e.feedback_final_prompted_at,
           req.app_name,
           public.engagement_day_utc(e.confirmed_at) AS eng_day
    FROM public.engagements e
    JOIN public.test_requests req ON req.id = e.request_id
    WHERE e.status IN ('confirmed', 'at_risk')
      AND e.confirmed_at IS NOT NULL
      AND req.status IN ('recruiting', 'active', 'at_risk')
      AND (
        (e.feedback_mid_prompted_at IS NULL
         AND public.engagement_day_utc(e.confirmed_at) >= 7
         AND NOT EXISTS (SELECT 1 FROM public.feedback f
                         WHERE f.engagement_id = e.id AND f.type = 'mid'))
        OR
        (e.feedback_final_prompted_at IS NULL
         AND public.engagement_day_utc(e.confirmed_at) >= 14
         AND NOT EXISTS (SELECT 1 FROM public.feedback f
                         WHERE f.engagement_id = e.id AND f.type = 'final'))
      )
    ORDER BY e.id
  LOOP
    IF r.feedback_mid_prompted_at IS NULL AND r.eng_day >= 7
       AND NOT EXISTS (SELECT 1 FROM public.feedback f
                       WHERE f.engagement_id = r.id AND f.type = 'mid') THEN
      UPDATE public.engagements
        SET feedback_mid_prompted_at = now() WHERE id = r.id;
      v_mid_p := v_mid_p + 1;
      v_notifs := v_notifs || public.add_notification(
        r.tester_id, 'feedback_prompt_mid',
        jsonb_build_object(
          'request_id', r.request_id, 'engagement_id', r.id,
          'app_name', r.app_name, 'day', r.eng_day));
    END IF;

    IF r.feedback_final_prompted_at IS NULL AND r.eng_day >= 14
       AND NOT EXISTS (SELECT 1 FROM public.feedback f
                       WHERE f.engagement_id = r.id AND f.type = 'final') THEN
      UPDATE public.engagements
        SET feedback_final_prompted_at = now() WHERE id = r.id;
      v_final_p := v_final_p + 1;
      v_notifs := v_notifs || public.add_notification(
        r.tester_id, 'feedback_prompt_final',
        jsonb_build_object(
          'request_id', r.request_id, 'engagement_id', r.id,
          'app_name', r.app_name, 'day', r.eng_day));
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'evaluated_day', v_yesterday,
    'advanced', v_advanced, 'reset', v_reset,
    'engagements_at_risk', v_eng_risk, 'expired', v_expired,
    'mid_prompts', v_mid_p, 'final_prompts', v_final_p,
    'notifications', v_notifs);
END;
$$;

-- ============================================================
-- 8. HOURLY REMINDERS: + day-3 check-in reminder (B5)
-- ============================================================

CREATE OR REPLACE FUNCTION public.run_confirm_reminders()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r          RECORD;
  v_count    int := 0;
  v_checkins int := 0;
  v_notifs   jsonb := '[]'::jsonb;
BEGIN
  -- 48h unconfirmed reminders (F3, unchanged).
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

  -- B5: day-3 check-in nudge (Flow 4 error state). Confirmed only — at_risk
  -- engagements already received the harsher at-risk notice. Re-arms after
  -- every check-in (create_checkin clears the marker).
  FOR r IN
    SELECT e.id, e.request_id, e.tester_id, req.app_name
    FROM public.engagements e
    JOIN public.test_requests req ON req.id = e.request_id
    WHERE e.status = 'confirmed'
      AND e.checkin_reminded_at IS NULL
      AND COALESCE(e.last_checkin_at, e.confirmed_at) < now() - interval '3 days'
      AND req.status IN ('recruiting', 'active', 'at_risk')
    ORDER BY e.id
  LOOP
    UPDATE public.engagements
      SET checkin_reminded_at = now()
      WHERE id = r.id AND status = 'confirmed' AND checkin_reminded_at IS NULL;
    IF FOUND THEN
      v_checkins := v_checkins + 1;
      v_notifs := v_notifs || public.add_notification(
        r.tester_id, 'checkin_reminder_3d',
        jsonb_build_object(
          'request_id', r.request_id, 'engagement_id', r.id,
          'app_name', r.app_name));
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'reminders', v_count, 'checkin_reminders', v_checkins,
    'notifications', v_notifs);
END;
$$;

-- ============================================================
-- 9. CANCEL: prior-release-aware refund (B10 — approved corrective)
-- ============================================================

CREATE OR REPLACE FUNCTION public.cancel_request(req uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller         uuid := auth.uid();
  v_req            public.test_requests%ROWTYPE;
  v_eng            RECORD;
  v_released       int := 0;
  v_prior_released int := 0;
  v_held           int := 0;
  v_refund         int := 0;
  v_balance        int;
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

  -- B10: escrow already released by completions (F4) is spent — it must
  -- reduce the refund, or cancelled requests would over-refund the owner
  -- and break mint = burn. Computed BEFORE this cancel's own releases.
  SELECT COALESCE(sum(amount), 0)::int INTO v_prior_released
  FROM public.credit_transactions
  WHERE request_id = req AND type = 'escrow_release' AND status = 'settled';

  -- Fairness rule: live confirmed/at-risk testers are released immediately.
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

    v_refund := GREATEST(v_held - v_released - v_prior_released, 0);
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
-- 10. SEED WRAPPERS (service_role only — dev/test harness)
-- ============================================================

CREATE OR REPLACE FUNCTION public.seed_create_checkin(eng uuid, cstatus public.checkin_status, note text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tester uuid;
BEGIN
  SELECT tester_id INTO v_tester FROM public.engagements WHERE id = eng;
  IF NOT FOUND THEN RAISE EXCEPTION 'LT_NOT_FOUND'; END IF;
  RETURN public.create_checkin_impl(v_tester, eng, cstatus, note);
END;
$$;

CREATE OR REPLACE FUNCTION public.seed_submit_feedback(
  eng uuid, ftype public.feedback_type,
  stability int, ux int, value_score int,
  bugs jsonb, suggestions text, usage_freq public.usage_frequency)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tester uuid;
BEGIN
  SELECT tester_id INTO v_tester FROM public.engagements WHERE id = eng;
  IF NOT FOUND THEN RAISE EXCEPTION 'LT_NOT_FOUND'; END IF;
  RETURN public.submit_feedback_impl(
    v_tester, eng, ftype, stability, ux, value_score, bugs, suggestions, usage_freq);
END;
$$;

CREATE OR REPLACE FUNCTION public.seed_add_feedback_addendum(fb uuid, note text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tester uuid;
BEGIN
  SELECT e.tester_id INTO v_tester
  FROM public.feedback f
  JOIN public.engagements e ON e.id = f.engagement_id
  WHERE f.id = fb;
  IF NOT FOUND THEN RAISE EXCEPTION 'LT_NOT_FOUND'; END IF;
  RETURN public.add_feedback_addendum_impl(v_tester, fb, note);
END;
$$;

CREATE OR REPLACE FUNCTION public.seed_rate_feedback(fb uuid, rating public.developer_rating)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_owner uuid;
BEGIN
  SELECT r.owner_id INTO v_owner
  FROM public.feedback f
  JOIN public.engagements e ON e.id = f.engagement_id
  JOIN public.test_requests r ON r.id = e.request_id
  WHERE f.id = fb;
  IF NOT FOUND THEN RAISE EXCEPTION 'LT_NOT_FOUND'; END IF;
  RETURN public.rate_feedback_impl(v_owner, fb, rating);
END;
$$;

-- ============================================================
-- 11. FUNCTION PRIVILEGES
-- ============================================================

-- helpers / impls: no client access
REVOKE ALL ON FUNCTION public.engagement_day_utc(timestamptz)                                                                          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_checkin_impl(uuid, uuid, public.checkin_status, text)                                             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.submit_feedback_impl(uuid, uuid, public.feedback_type, int, int, int, jsonb, text, public.usage_frequency) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.add_feedback_addendum_impl(uuid, uuid, text)                                                             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rate_feedback_impl(uuid, uuid, public.developer_rating)                                                  FROM PUBLIC, anon, authenticated;

-- user-facing actions: authenticated only
REVOKE ALL ON FUNCTION public.create_checkin(uuid, public.checkin_status, text)                                                        FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.submit_feedback(uuid, public.feedback_type, int, int, int, jsonb, text, public.usage_frequency)          FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.add_feedback_addendum(uuid, text)                                                                        FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rate_feedback(uuid, public.developer_rating)                                                             FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_checkin(uuid, public.checkin_status, text)                                                     TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_feedback(uuid, public.feedback_type, int, int, int, jsonb, text, public.usage_frequency)       TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_feedback_addendum(uuid, text)                                                                     TO authenticated;
GRANT EXECUTE ON FUNCTION public.rate_feedback(uuid, public.developer_rating)                                                          TO authenticated;

-- seed wrappers: service_role only
REVOKE ALL ON FUNCTION public.seed_create_checkin(uuid, public.checkin_status, text)                                                   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.seed_submit_feedback(uuid, public.feedback_type, int, int, int, jsonb, text, public.usage_frequency)     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.seed_add_feedback_addendum(uuid, text)                                                                   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.seed_rate_feedback(uuid, public.developer_rating)                                                        FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seed_create_checkin(uuid, public.checkin_status, text)                                                TO service_role;
GRANT EXECUTE ON FUNCTION public.seed_submit_feedback(uuid, public.feedback_type, int, int, int, jsonb, text, public.usage_frequency)  TO service_role;
GRANT EXECUTE ON FUNCTION public.seed_add_feedback_addendum(uuid, text)                                                                TO service_role;
GRANT EXECUTE ON FUNCTION public.seed_rate_feedback(uuid, public.developer_rating)                                                     TO service_role;

COMMIT;
