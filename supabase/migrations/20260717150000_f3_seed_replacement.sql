-- F3 addendum: impl-split for slot growth + replacement (2026-07-17).
-- Single-transaction migration: a failed run leaves the database clean.
--
-- Why: request_replacement (and the grow_request_slots it delegates to) read
-- auth.uid() directly, so the dev harness could not exercise the replacement
-- path headlessly. This splits both into caller-explicit _impl functions —
-- byte-identical logic — and adds seed_request_replacement, service_role
-- only, matching the other seed_* wrappers. The authenticated signatures and
-- behavior are unchanged.

BEGIN;

-- ============================================================
-- 1. GROW SLOTS impl (body from F2, caller as parameter)
-- ============================================================

CREATE OR REPLACE FUNCTION public.grow_request_slots_impl(caller uuid, req uuid, new_slots int)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_req     public.test_requests%ROWTYPE;
  v_price   int;
  v_cost    int := 0;
  v_balance int;
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'LT_AUTH_REQUIRED'; END IF;

  SELECT * INTO v_req FROM public.test_requests WHERE id = req FOR UPDATE;
  IF NOT FOUND OR v_req.owner_id <> caller THEN
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

    PERFORM 1 FROM public.users WHERE id = caller FOR UPDATE;
    v_balance := public.settled_balance(caller);
    IF v_balance < v_cost THEN
      RAISE EXCEPTION 'LT_INSUFFICIENT_CREDITS:%', v_cost - v_balance;
    END IF;

    INSERT INTO public.credit_transactions
      (user_id, amount, type, status, request_id, balance_after)
    VALUES
      (caller, -v_cost, 'spend_post',  'settled', req, v_balance - v_cost),
      (caller,  v_cost, 'escrow_hold', 'pending', req, v_balance - v_cost);
  END IF;

  -- Transaction-local flag: the freeze guard only lets slot growth through
  -- when it came from here (a direct client UPDATE would dodge the escrow).
  PERFORM set_config('app.lt_slot_growth', 'on', true);

  UPDATE public.test_requests SET slots_needed = new_slots WHERE id = req;

  RETURN jsonb_build_object('cost', v_cost, 'slots', new_slots);
END;
$$;

CREATE OR REPLACE FUNCTION public.grow_request_slots(req uuid, new_slots int)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.grow_request_slots_impl(auth.uid(), req, new_slots);
$$;

-- ============================================================
-- 2. REQUEST REPLACEMENT impl (body from F3, caller as parameter)
-- ============================================================

CREATE OR REPLACE FUNCTION public.request_replacement_impl(caller uuid, eng uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_req_id uuid;
  v_req    public.test_requests%ROWTYPE;
  v_eng    public.engagements%ROWTYPE;
  v_result jsonb;
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'LT_AUTH_REQUIRED'; END IF;

  SELECT request_id INTO v_req_id FROM public.engagements WHERE id = eng;
  IF NOT FOUND THEN RAISE EXCEPTION 'LT_NOT_FOUND'; END IF;

  SELECT * INTO v_req FROM public.test_requests WHERE id = v_req_id FOR UPDATE;
  IF v_req.owner_id <> caller THEN RAISE EXCEPTION 'LT_NOT_FOUND'; END IF;

  SELECT * INTO v_eng FROM public.engagements WHERE id = eng FOR UPDATE;
  IF v_eng.status <> 'at_risk' THEN RAISE EXCEPTION 'LT_NOT_AT_RISK'; END IF;
  IF v_eng.replacement_requested_at IS NOT NULL THEN
    RAISE EXCEPTION 'LT_REPLACEMENT_ALREADY';
  END IF;

  v_result := public.grow_request_slots_impl(caller, v_req_id, v_req.slots_needed + 1);

  UPDATE public.engagements SET replacement_requested_at = now() WHERE id = eng;

  RETURN jsonb_build_object(
    'slots', v_result -> 'slots', 'cost', v_result -> 'cost',
    'notifications', '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.request_replacement(eng uuid)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.request_replacement_impl(auth.uid(), eng);
$$;

-- ============================================================
-- 3. SEED WRAPPER (service_role only — dev/test harness)
-- ============================================================

CREATE OR REPLACE FUNCTION public.seed_request_replacement(eng uuid)
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
  RETURN public.request_replacement_impl(v_owner, eng);
END;
$$;

-- ============================================================
-- 4. PRIVILEGES
-- ============================================================

REVOKE ALL ON FUNCTION public.grow_request_slots_impl(uuid, uuid, int)   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.request_replacement_impl(uuid, uuid)       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.seed_request_replacement(uuid)             FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seed_request_replacement(uuid)          TO service_role;

-- Wrappers keep their existing grants (CREATE OR REPLACE preserves ACLs);
-- re-asserted for clarity.
REVOKE ALL ON FUNCTION public.grow_request_slots(uuid, int)              FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.request_replacement(uuid)                  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.grow_request_slots(uuid, int)           TO authenticated;
GRANT EXECUTE ON FUNCTION public.request_replacement(uuid)               TO authenticated;

COMMIT;
