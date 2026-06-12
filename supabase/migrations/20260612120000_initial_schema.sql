-- LaunchTrain — initial schema (SPEC.md §6, full MVP schema)
-- Single-transaction migration: a failed run leaves the database clean.
--
-- Approved deviations from SPEC §6 (decisions by Ran, 2026-06-12):
--   * engagements.opted_in_at      — backs the markOptedIn action (§7, Flow 3 step 4)
--   * feedback.addendum            — backs the F4 "addendum note" edge case
--   * users.country default ''     — row is created by auth trigger before onboarding;
--                                    a CHECK enforces a real ISO-2 code once onboarded
--   * public reads of test_requests limited to recruiting/at_risk/active/completed

BEGIN;

-- ============================================================
-- 1. ENUMS
-- ============================================================

CREATE TYPE public.user_role AS ENUM ('user', 'admin');
CREATE TYPE public.request_category AS ENUM
  ('games', 'productivity', 'social', 'tools', 'lifestyle', 'education', 'finance', 'health', 'other');
CREATE TYPE public.join_method AS ENUM ('email_list', 'google_group');
CREATE TYPE public.request_status AS ENUM
  ('draft', 'recruiting', 'active', 'at_risk', 'completed', 'cancelled', 'expired');
CREATE TYPE public.engagement_status AS ENUM
  ('pending_developer', 'confirmed', 'at_risk', 'completed', 'dropped', 'cancelled');
CREATE TYPE public.checkin_status AS ENUM ('ok', 'issue');
CREATE TYPE public.feedback_type AS ENUM ('mid', 'final');
CREATE TYPE public.usage_frequency AS ENUM ('daily', 'few_weekly', 'rarely');
CREATE TYPE public.developer_rating AS ENUM ('helpful', 'not_helpful');
CREATE TYPE public.transaction_type AS ENUM
  ('spend_post', 'escrow_hold', 'escrow_release', 'refund', 'bonus', 'admin_adjust');
CREATE TYPE public.transaction_status AS ENUM ('pending', 'settled', 'cancelled');

-- ============================================================
-- 2. TABLES
-- ============================================================

-- users: NO balance column (SPEC §0.4) — balance derives from credit_transactions.
CREATE TABLE public.users (
  id                 uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  email              text NOT NULL
                     CHECK (email = '' OR email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  testing_email      text NOT NULL
                     CHECK (testing_email = '' OR testing_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  display_name       text NOT NULL CHECK (char_length(display_name) <= 80),
  country            text NOT NULL DEFAULT ''
                     CHECK (country = '' OR country ~ '^[A-Z]{2}$'),
  avatar_url         text,
  role               public.user_role NOT NULL DEFAULT 'user',
  reliability_score  int NOT NULL DEFAULT 100 CHECK (reliability_score BETWEEN 0 AND 100),
  is_founding_member boolean NOT NULL DEFAULT false,
  onboarded_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  -- a user may not be marked onboarded without a real country
  CONSTRAINT users_onboarded_requires_country CHECK (onboarded_at IS NULL OR country <> '')
);

CREATE TABLE public.devices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  manufacturer    text NOT NULL CHECK (btrim(manufacturer) <> ''),
  model           text NOT NULL CHECK (btrim(model) <> ''),
  android_version int NOT NULL CHECK (android_version BETWEEN 1 AND 50),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX devices_user_idx ON public.devices (user_id);

CREATE TABLE public.test_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id            uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  app_name            text NOT NULL CHECK (btrim(app_name) <> ''),
  package_name        text NOT NULL CHECK (btrim(package_name) <> ''),
  description         text NOT NULL CHECK (char_length(description) <= 300),
  category            public.request_category NOT NULL,
  join_method         public.join_method NOT NULL,
  opt_in_url          text NOT NULL
                      CHECK (opt_in_url LIKE 'https://play.google.com/apps/testing/%'),
  group_url           text
                      CHECK (group_url IS NULL OR group_url LIKE 'https://groups.google.com/%'),
  instructions        text NOT NULL CHECK (char_length(instructions) <= 1000),
  min_android_version int NOT NULL CHECK (min_android_version BETWEEN 1 AND 50),
  slots_needed        int NOT NULL DEFAULT 14 CHECK (slots_needed BETWEEN 1 AND 20),
  status              public.request_status NOT NULL DEFAULT 'draft',
  streak_days         int NOT NULL DEFAULT 0 CHECK (streak_days >= 0),
  clock_started_at    timestamptz,
  is_founding         boolean NOT NULL DEFAULT false,
  icon_url            text,
  screenshots         jsonb
                      CHECK (screenshots IS NULL
                             OR (jsonb_typeof(screenshots) = 'array'
                                 AND jsonb_array_length(screenshots) <= 4)),
  created_at          timestamptz NOT NULL DEFAULT now(),
  published_at        timestamptz,
  -- group_url present if and only if join_method = google_group (SPEC §6)
  CONSTRAINT test_requests_group_url_iff
    CHECK ((join_method = 'google_group') = (group_url IS NOT NULL))
);

-- One non-terminal request per (owner, package): drafts also block duplicates (approved).
CREATE UNIQUE INDEX test_requests_one_active_per_package
  ON public.test_requests (owner_id, package_name)
  WHERE status NOT IN ('completed', 'cancelled', 'expired');

CREATE INDEX test_requests_board_idx ON public.test_requests (status, published_at DESC);
CREATE INDEX test_requests_owner_idx ON public.test_requests (owner_id);

CREATE TABLE public.engagements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id      uuid NOT NULL REFERENCES public.test_requests (id) ON DELETE CASCADE,
  tester_id       uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  -- RESTRICT: device rows referenced by any engagement are kept for the Dossier's
  -- Device Coverage Matrix; the app additionally blocks deletes with a friendly error.
  device_id       uuid NOT NULL REFERENCES public.devices (id) ON DELETE RESTRICT,
  status          public.engagement_status NOT NULL DEFAULT 'pending_developer',
  joined_at       timestamptz NOT NULL DEFAULT now(),
  opted_in_at     timestamptz,
  confirmed_at    timestamptz,
  completed_at    timestamptz,
  last_checkin_at timestamptz,
  checkin_count   int NOT NULL DEFAULT 0 CHECK (checkin_count >= 0),
  CONSTRAINT engagements_confirmed_has_ts
    CHECK (status NOT IN ('confirmed', 'at_risk', 'completed') OR confirmed_at IS NOT NULL),
  CONSTRAINT engagements_completed_has_ts
    CHECK (status <> 'completed' OR completed_at IS NOT NULL)
);

-- One tester per request among non-terminal rows; re-join after drop/cancel = new row (SPEC §6).
CREATE UNIQUE INDEX engagements_one_per_tester
  ON public.engagements (request_id, tester_id)
  WHERE status NOT IN ('dropped', 'cancelled');

CREATE INDEX engagements_request_idx ON public.engagements (request_id);
CREATE INDEX engagements_tester_idx ON public.engagements (tester_id);

CREATE TABLE public.checkins (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id uuid NOT NULL REFERENCES public.engagements (id) ON DELETE CASCADE,
  status        public.checkin_status NOT NULL,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- note required when an issue is reported (one-directional: ok may carry a note too)
  CONSTRAINT checkins_issue_requires_note
    CHECK (status <> 'issue' OR (note IS NOT NULL AND btrim(note) <> ''))
);

-- One check-in per engagement per UTC day (SPEC §0.3, §6).
CREATE UNIQUE INDEX checkins_once_per_utc_day
  ON public.checkins (engagement_id, ((created_at AT TIME ZONE 'utc')::date));

CREATE TABLE public.feedback (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id    uuid NOT NULL REFERENCES public.engagements (id) ON DELETE CASCADE,
  type             public.feedback_type NOT NULL,
  stability        int NOT NULL CHECK (stability BETWEEN 1 AND 5),
  ux               int NOT NULL CHECK (ux BETWEEN 1 AND 5),
  value            int NOT NULL CHECK (value BETWEEN 1 AND 5),
  bugs             jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(bugs) = 'array'),
  suggestions      text,
  usage_frequency  public.usage_frequency NOT NULL,
  developer_rating public.developer_rating,
  addendum         text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT feedback_one_per_type UNIQUE (engagement_id, type)
);

-- credit_transactions: the ONLY source of truth for balances (SPEC §0.4, F6).
-- RESTRICT on request/engagement: ledger rows must never disappear via cascading
-- deletes (cancellation is a status change, not a delete).
CREATE TABLE public.credit_transactions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  amount        int NOT NULL CHECK (amount <> 0),
  type          public.transaction_type NOT NULL,
  status        public.transaction_status NOT NULL,
  request_id    uuid REFERENCES public.test_requests (id) ON DELETE RESTRICT,
  engagement_id uuid REFERENCES public.engagements (id) ON DELETE RESTRICT,
  balance_after int NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- every transaction is anchored to a request or engagement, except admin_adjust (SPEC F6)
  CONSTRAINT credit_tx_linkage
    CHECK (type = 'admin_adjust' OR request_id IS NOT NULL OR engagement_id IS NOT NULL)
);

CREATE INDEX credit_tx_user_idx ON public.credit_transactions (user_id, created_at DESC);
CREATE INDEX credit_tx_request_idx ON public.credit_transactions (request_id);

CREATE TABLE public.dossiers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id    uuid NOT NULL UNIQUE REFERENCES public.test_requests (id) ON DELETE CASCADE,
  content_md    text NOT NULL,
  model_version text NOT NULL,
  generated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  type       text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  emailed_at timestamptz,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notifications_user_idx ON public.notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON public.notifications (user_id) WHERE read_at IS NULL;

CREATE TABLE public.system_config (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);

-- ============================================================
-- 3. FUNCTIONS (SECURITY DEFINER helpers — avoid recursive RLS)
-- ============================================================

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid() AND role = 'admin'
  );
$$;

CREATE OR REPLACE FUNCTION public.owns_request(req uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.test_requests r
    WHERE r.id = req AND r.owner_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION public.is_engagement_party(eng uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.engagements e
    JOIN public.test_requests r ON r.id = e.request_id
    WHERE e.id = eng
      AND (e.tester_id = auth.uid() OR r.owner_id = auth.uid())
  );
$$;

-- Auto-create the profile row at first sign-in (testing_email defaults to login email).
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.users (id, email, testing_email, display_name, avatar_url)
  VALUES (
    NEW.id,
    COALESCE(NEW.email, ''),
    COALESCE(NEW.email, ''),
    COALESCE(
      NULLIF(left(btrim(NEW.raw_user_meta_data ->> 'full_name'), 80), ''),
      NULLIF(left(btrim(NEW.raw_user_meta_data ->> 'name'), 80), ''),
      left(split_part(COALESCE(NEW.email, 'user'), '@', 1), 80)
    ),
    COALESCE(NEW.raw_user_meta_data ->> 'avatar_url', NEW.raw_user_meta_data ->> 'picture')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- Integrity guards on users updates:
--  * onboarded_at may only be set when profile is complete and >=1 device exists (F1)
--  * testing_email is frozen while any engagement is active (F1 edge case)
CREATE OR REPLACE FUNCTION public.users_update_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.onboarded_at IS NOT NULL AND OLD.onboarded_at IS NULL THEN
    IF NEW.country = '' OR btrim(NEW.display_name) = ''
       OR NEW.testing_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
      RAISE EXCEPTION 'Onboarding incomplete: profile fields missing or invalid';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.devices d WHERE d.user_id = NEW.id) THEN
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

-- ============================================================
-- 4. TRIGGERS
-- ============================================================

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

CREATE TRIGGER users_update_guard
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.users_update_guard();

-- ============================================================
-- 5. VIEWS
-- ============================================================

-- Public profile data only — never email / testing_email (SPEC §0.6).
-- Default (definer) view semantics intentionally bypass users RLS for these safe columns.
CREATE VIEW public.public_profiles AS
SELECT
  u.id,
  u.display_name,
  u.avatar_url,
  u.reliability_score,
  u.is_founding_member,
  u.created_at,
  (SELECT count(*)
     FROM public.engagements e
    WHERE e.tester_id = u.id AND e.status = 'completed') AS completed_tests
FROM public.users u
WHERE u.onboarded_at IS NOT NULL;

-- The ONLY channel exposing a tester's testing_email: scoped to the owner of the
-- request that the tester joined (SPEC §0.6, Flow 3 step 3).
CREATE VIEW public.engagement_tester_contacts AS
SELECT
  e.id AS engagement_id,
  e.request_id,
  e.tester_id,
  u.testing_email
FROM public.engagements e
JOIN public.test_requests r ON r.id = e.request_id
JOIN public.users u ON u.id = e.tester_id
WHERE r.owner_id = auth.uid();

-- ============================================================
-- 6. ROW LEVEL SECURITY (every table — SPEC §0.5)
-- ============================================================

ALTER TABLE public.users               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.devices             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.test_requests       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.engagements         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checkins            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feedback            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dossiers            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_config       ENABLE ROW LEVEL SECURITY;

-- users: own row only (public data goes through public_profiles)
CREATE POLICY users_select_own ON public.users
  FOR SELECT TO authenticated
  USING (id = auth.uid() OR public.is_admin());
CREATE POLICY users_update_own ON public.users
  FOR UPDATE TO authenticated
  USING (id = auth.uid() OR public.is_admin())
  WITH CHECK (id = auth.uid() OR public.is_admin());

-- devices: owner CRUD; request owners may see devices on their engagements
CREATE POLICY devices_select ON public.devices
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR public.is_admin()
    OR EXISTS (
      SELECT 1 FROM public.engagements e
      WHERE e.device_id = devices.id AND public.owns_request(e.request_id)
    )
  );
CREATE POLICY devices_insert_own ON public.devices
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());
CREATE POLICY devices_delete_own ON public.devices
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- test_requests: public read for published statuses (approved set); owner sees all own
CREATE POLICY test_requests_select ON public.test_requests
  FOR SELECT TO anon, authenticated
  USING (
    status IN ('recruiting', 'at_risk', 'active', 'completed')
    OR owner_id = auth.uid()
    OR public.is_admin()
  );
CREATE POLICY test_requests_insert_draft ON public.test_requests
  FOR INSERT TO authenticated
  WITH CHECK (owner_id = auth.uid() AND status = 'draft');
CREATE POLICY test_requests_update_own ON public.test_requests
  FOR UPDATE TO authenticated
  USING (owner_id = auth.uid() OR public.is_admin())
  WITH CHECK (owner_id = auth.uid() OR public.is_admin());

-- engagements: visible to the tester and the request owner; writes are service-role only
-- (joinTest slot race, confirm, drop — all atomic server-side transitions)
CREATE POLICY engagements_select ON public.engagements
  FOR SELECT TO authenticated
  USING (tester_id = auth.uid() OR public.owns_request(request_id) OR public.is_admin());

-- checkins / feedback: readable by engagement parties; writes are service-role only
-- (createCheckin maintains engagement counters; submitFeedback releases escrow atomically)
CREATE POLICY checkins_select ON public.checkins
  FOR SELECT TO authenticated
  USING (public.is_engagement_party(engagement_id) OR public.is_admin());
CREATE POLICY feedback_select ON public.feedback
  FOR SELECT TO authenticated
  USING (public.is_engagement_party(engagement_id) OR public.is_admin());

-- credit_transactions: own ledger only; writes are service-role only (SPEC §0.4)
CREATE POLICY credit_tx_select_own ON public.credit_transactions
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_admin());

-- dossiers: request owner only
CREATE POLICY dossiers_select_owner ON public.dossiers
  FOR SELECT TO authenticated
  USING (public.owns_request(request_id) OR public.is_admin());

-- notifications: own rows; only read_at is client-writable (column grant below)
CREATE POLICY notifications_select_own ON public.notifications
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_admin());
CREATE POLICY notifications_update_own ON public.notifications
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- system_config: public read (founding badge / pricing visible to guests); admin writes
-- go through the service role
CREATE POLICY system_config_select_all ON public.system_config
  FOR SELECT TO anon, authenticated
  USING (true);

-- ============================================================
-- 7. PRIVILEGES (column-level protection; RLS alone is row-level)
-- ============================================================

REVOKE ALL ON public.users               FROM anon, authenticated;
REVOKE ALL ON public.devices             FROM anon, authenticated;
REVOKE ALL ON public.test_requests       FROM anon, authenticated;
REVOKE ALL ON public.engagements         FROM anon, authenticated;
REVOKE ALL ON public.checkins            FROM anon, authenticated;
REVOKE ALL ON public.feedback            FROM anon, authenticated;
REVOKE ALL ON public.credit_transactions FROM anon, authenticated;
REVOKE ALL ON public.dossiers            FROM anon, authenticated;
REVOKE ALL ON public.notifications       FROM anon, authenticated;
REVOKE ALL ON public.system_config       FROM anon, authenticated;

-- users: clients may edit only profile fields — never role, reliability_score,
-- is_founding_member, email, id, created_at
GRANT SELECT ON public.users TO authenticated;
GRANT UPDATE (display_name, country, testing_email, avatar_url, onboarded_at)
  ON public.users TO authenticated;

GRANT SELECT, DELETE ON public.devices TO authenticated;
GRANT INSERT (user_id, manufacturer, model, android_version)
  ON public.devices TO authenticated;

-- test_requests: server-managed columns (status, streak_days, clock_started_at,
-- published_at, is_founding, owner_id at update time) are NOT client-writable —
-- state transitions happen in service-role server actions together with their
-- credit_transactions rows (SPEC §0.4)
GRANT SELECT ON public.test_requests TO anon, authenticated;
GRANT INSERT (owner_id, app_name, package_name, description, category, join_method,
              opt_in_url, group_url, instructions, min_android_version, slots_needed,
              icon_url, screenshots)
  ON public.test_requests TO authenticated;
GRANT UPDATE (app_name, description, category, join_method, opt_in_url, group_url,
              instructions, min_android_version, slots_needed, icon_url, screenshots)
  ON public.test_requests TO authenticated;

GRANT SELECT ON public.engagements TO authenticated;
GRANT SELECT ON public.checkins TO authenticated;
GRANT SELECT ON public.feedback TO authenticated;
GRANT SELECT ON public.credit_transactions TO authenticated;
GRANT SELECT ON public.dossiers TO authenticated;

GRANT SELECT ON public.notifications TO authenticated;
GRANT UPDATE (read_at) ON public.notifications TO authenticated;

GRANT SELECT ON public.system_config TO anon, authenticated;

-- views (definer semantics; safe columns only).
-- CRITICAL: Supabase default privileges auto-grant ALL on new views to anon/authenticated,
-- and public_profiles would otherwise be auto-updatable as its owner (BYPASSRLS) —
-- revoke first, then grant SELECT only.
REVOKE ALL ON public.public_profiles, public.engagement_tester_contacts
  FROM anon, authenticated, PUBLIC;
GRANT SELECT ON public.public_profiles TO anon, authenticated;
GRANT SELECT ON public.engagement_tester_contacts TO authenticated;

-- ============================================================
-- 8. SEED DATA (SPEC §6 system_config keys)
-- ============================================================

INSERT INTO public.system_config (key, value) VALUES
  ('founding_phase',        'true'::jsonb),
  ('founding_cap',          '100'::jsonb),
  ('founding_used',         '0'::jsonb),
  ('credit_price_per_slot', '1'::jsonb),
  ('checkin_min_weekly',    '3'::jsonb);

COMMIT;
