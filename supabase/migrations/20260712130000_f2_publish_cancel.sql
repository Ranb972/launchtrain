-- F2: publish / cancel / grow-slots as atomic DB functions, post-publish
-- freeze guard, and a public slot-count view (2026-07-12).
-- Single-transaction migration: a failed run leaves the database clean.
--
-- Why DB functions: SPEC §0.4 requires credit_transactions rows to be created
-- inside the SAME database transaction as the state change that caused them.
-- The Supabase JS client cannot open multi-statement transactions, so every
-- credit-moving transition lives here as a SECURITY DEFINER function invoked
-- via RPC by the authenticated user (auth.uid() is the real caller).
--
-- Ledger shape (SPEC F6, approved reading):
--   publish (non-founding): spend_post  -N settled  + escrow_hold +N pending
--   slot growth           : same pair for the delta (every slot escrow-backed,
--                           preserving mint = burn; founding requests grow free)
--   cancel                : escrow_release +1 settled per confirmed/at-risk
--                           tester (fairness rule), escrow_hold rows ->
--                           cancelled, refund of the remainder to the owner
--   balance_after semantics: the settled balance after this row settles;
--   pending rows record the settled balance at write time (unchanged by them).
--
-- Error protocol: RAISE EXCEPTION 'LT_<CODE>[:detail]' — server actions map
-- codes to friendly UI messages (e.g. LT_INSUFFICIENT_CREDITS:3).

BEGIN;

-- ============================================================
-- 1. HELPERS
-- ============================================================

-- Internal only (no client grant — balances of arbitrary users must not leak;
-- clients read their own balance through RLS-scoped credit_transactions).
CREATE OR REPLACE FUNCTION public.settled_balance(uid uuid)
RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(sum(amount), 0)::int
  FROM public.credit_transactions
  WHERE user_id = uid AND status = 'settled';
$$;

CREATE OR REPLACE FUNCTION public.config_int(cfg_key text, fallback int)
RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(
    (SELECT (value #>> '{}')::int FROM public.system_config WHERE key = cfg_key),
    fallback
  );
$$;

-- ============================================================
-- 2. PUBLISH (SPEC Flow 2 step 4, Flow 6, F6)
-- ============================================================

-- expect_free: what the UI showed the user. If they were promised a free
-- founding publish but the cap filled meanwhile, we refuse with
-- LT_FOUNDING_CAP_REACHED so the UI can re-confirm at real pricing
-- (SPEC Flow 6: "transparent notice"). The reverse surprise (expected to
-- pay, turns out free) needs no confirmation.
CREATE OR REPLACE FUNCTION public.publish_request(req uuid, expect_free boolean)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller  uuid := auth.uid();
  v_req     public.test_requests%ROWTYPE;
  v_phase   boolean;
  v_cap     int;
  v_used    int;
  v_price   int;
  v_cost    int;
  v_balance int;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'LT_AUTH_REQUIRED'; END IF;

  SELECT * INTO v_req FROM public.test_requests WHERE id = req FOR UPDATE;
  IF NOT FOUND OR v_req.owner_id <> v_caller THEN
    RAISE EXCEPTION 'LT_NOT_FOUND';
  END IF;
  IF v_req.status <> 'draft' THEN RAISE EXCEPTION 'LT_NOT_DRAFT'; END IF;

  -- Serialize concurrent credit moves by the same user (balance math).
  PERFORM 1 FROM public.users WHERE id = v_caller FOR UPDATE;

  -- Lock founding_used so cap accounting is race-free across publishers.
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
  v_balance := public.settled_balance(v_caller);
  IF v_balance < v_cost THEN
    RAISE EXCEPTION 'LT_INSUFFICIENT_CREDITS:%', v_cost - v_balance;
  END IF;

  INSERT INTO public.credit_transactions
    (user_id, amount, type, status, request_id, balance_after)
  VALUES
    (v_caller, -v_cost, 'spend_post',  'settled', req, v_balance - v_cost),
    (v_caller,  v_cost, 'escrow_hold', 'pending', req, v_balance - v_cost);

  UPDATE public.test_requests
    SET status = 'recruiting', is_founding = false, published_at = now()
    WHERE id = req;

  RETURN jsonb_build_object('cost', v_cost, 'is_founding', false);
END;
$$;

-- ============================================================
-- 3. CANCEL (SPEC F2 business logic)
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
  -- credit immediately. No engagements can exist before F3 lands — this loop
  -- is the complete future-proof implementation, a no-op today.
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
    SET status = 'cancelled'
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
-- 4. GROW SLOTS (approved post-publish rule, SPEC F2 v1.5)
-- ============================================================

CREATE OR REPLACE FUNCTION public.grow_request_slots(req uuid, new_slots int)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller  uuid := auth.uid();
  v_req     public.test_requests%ROWTYPE;
  v_price   int;
  v_cost    int := 0;
  v_balance int;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'LT_AUTH_REQUIRED'; END IF;

  SELECT * INTO v_req FROM public.test_requests WHERE id = req FOR UPDATE;
  IF NOT FOUND OR v_req.owner_id <> v_caller THEN
    RAISE EXCEPTION 'LT_NOT_FOUND';
  END IF;
  IF v_req.status NOT IN ('recruiting', 'active', 'at_risk') THEN
    RAISE EXCEPTION 'LT_NOT_PUBLISHED';
  END IF;
  IF new_slots <= v_req.slots_needed THEN RAISE EXCEPTION 'LT_SLOTS_GROW_ONLY'; END IF;
  IF new_slots > 20 THEN RAISE EXCEPTION 'LT_SLOTS_MAX_20'; END IF;

  IF NOT v_req.is_founding THEN
    v_price := public.config_int('credit_price_per_slot', 1);
    v_cost  := (new_slots - v_req.slots_needed) * v_price;

    PERFORM 1 FROM public.users WHERE id = v_caller FOR UPDATE;
    v_balance := public.settled_balance(v_caller);
    IF v_balance < v_cost THEN
      RAISE EXCEPTION 'LT_INSUFFICIENT_CREDITS:%', v_cost - v_balance;
    END IF;

    INSERT INTO public.credit_transactions
      (user_id, amount, type, status, request_id, balance_after)
    VALUES
      (v_caller, -v_cost, 'spend_post',  'settled', req, v_balance - v_cost),
      (v_caller,  v_cost, 'escrow_hold', 'pending', req, v_balance - v_cost);
  END IF;

  -- Transaction-local flag: the freeze guard only lets slot growth through
  -- when it came from here (a direct client UPDATE would dodge the escrow).
  PERFORM set_config('app.lt_slot_growth', 'on', true);

  UPDATE public.test_requests SET slots_needed = new_slots WHERE id = req;

  RETURN jsonb_build_object('cost', v_cost, 'slots', new_slots);
END;
$$;

-- ============================================================
-- 5. POST-PUBLISH FREEZE GUARD (SPEC F2 v1.5)
-- ============================================================

-- The initial schema GRANTs authenticated column-level UPDATE on these fields
-- (needed for draft editing), so the freeze must be a DB backstop, not just a
-- server-action rule.
CREATE OR REPLACE FUNCTION public.test_requests_update_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF OLD.status IN ('completed', 'cancelled', 'expired')
     AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'LT_TERMINAL_IMMUTABLE';
  END IF;

  IF OLD.status <> 'draft' THEN
    IF NEW.package_name        IS DISTINCT FROM OLD.package_name
       OR NEW.opt_in_url          IS DISTINCT FROM OLD.opt_in_url
       OR NEW.group_url           IS DISTINCT FROM OLD.group_url
       OR NEW.join_method         IS DISTINCT FROM OLD.join_method
       OR NEW.app_name            IS DISTINCT FROM OLD.app_name
       OR NEW.category            IS DISTINCT FROM OLD.category
       OR NEW.min_android_version IS DISTINCT FROM OLD.min_android_version THEN
      RAISE EXCEPTION 'LT_FROZEN_AFTER_PUBLISH';
    END IF;

    IF NEW.slots_needed <> OLD.slots_needed THEN
      IF NEW.slots_needed < OLD.slots_needed THEN
        RAISE EXCEPTION 'LT_SLOTS_GROW_ONLY';
      END IF;
      IF COALESCE(current_setting('app.lt_slot_growth', true), '') <> 'on' THEN
        RAISE EXCEPTION 'LT_USE_GROW_SLOTS';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER test_requests_update_guard
  BEFORE UPDATE ON public.test_requests
  FOR EACH ROW EXECUTE FUNCTION public.test_requests_update_guard();

-- ============================================================
-- 6. PUBLIC SLOT COUNTS (board cards / request pages)
-- ============================================================

-- Engagement rows are party-only under RLS, but the BOARD is public and shows
-- "slots filled/needed" (SPEC F2). This definer view exposes only an aggregate
-- count, only for publicly visible request statuses.
CREATE VIEW public.request_slot_counts AS
SELECT
  r.id AS request_id,
  count(e.id) FILTER (
    WHERE e.status IN ('confirmed', 'at_risk')
  )::int AS confirmed_count
FROM public.test_requests r
LEFT JOIN public.engagements e ON e.request_id = r.id
WHERE r.status IN ('recruiting', 'at_risk', 'active', 'completed')
GROUP BY r.id;

-- Same view-privilege hygiene as the initial schema: revoke the auto-grants,
-- then allow SELECT only.
REVOKE ALL ON public.request_slot_counts FROM anon, authenticated, PUBLIC;
GRANT SELECT ON public.request_slot_counts TO anon, authenticated;

-- ============================================================
-- 7. FUNCTION PRIVILEGES
-- ============================================================

REVOKE ALL ON FUNCTION public.settled_balance(uuid)            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.config_int(text, int)            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.publish_request(uuid, boolean)   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cancel_request(uuid)             FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.grow_request_slots(uuid, int)    FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.publish_request(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_request(uuid)           TO authenticated;
GRANT EXECUTE ON FUNCTION public.grow_request_slots(uuid, int)  TO authenticated;

COMMIT;
