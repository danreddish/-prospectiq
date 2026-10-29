-- ============================================
-- v76 Migration (007): Recruitment mode
--
-- Adds a second buyer (firm principals and network BDMs hiring advisers)
-- as a separate subscription alongside the client prospecting plans.
--
-- Builds on v75.7 (migration 005). Recruitment follows the same rules:
--   1. New columns on profiles, campaigns and prospects.
--   2. Recruitment rules in one place: get_recruitment_limits() and
--      recruitment_access().
--   3. consume_recruitment_research() / refund_recruitment_research():
--      atomic per-adviser research counting, refunds capped.
--   4. consume_recruitment_find_units() / refund_recruitment_find_units():
--      a monthly budget for adviser searches (Claude brief parsing and
--      Apollo-enriched contacts).
--   5. enforce_campaign_limit() now knows about purpose. Client campaigns
--      count against the client plan, recruitment campaigns against
--      Recruitment. A campaign cannot switch purpose from the browser.
--   6. The recruitment billing and usage columns are locked to the server.
--   7. The usage event list keeps every v75.7 type and adds the
--      recruitment ones.
--
-- Idempotent. Safe to re-run. Safe to run while v75.x code is live:
-- existing campaigns become purpose 'clients' and old code never sets
-- purpose, so nothing changes for client prospecting.
-- ============================================


-- ---------- 1. Columns ----------

-- Profiles: recruitment subscription, usage and hiring profile
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS recruitment_status text NOT NULL DEFAULT 'inactive';
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_recruitment_status_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_recruitment_status_check
  CHECK (recruitment_status IN ('inactive', 'active', 'past_due', 'cancelled'));

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS recruitment_period text;
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_recruitment_period_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_recruitment_period_check
  CHECK (recruitment_period IS NULL OR recruitment_period IN ('monthly', 'annual'));

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS recruitment_subscription_id text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS recruitment_current_period_end timestamptz;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS recruitment_advisers_used int NOT NULL DEFAULT 0;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS recruitment_finds_used int NOT NULL DEFAULT 0;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS recruitment_usage_reset_at timestamptz;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS recruitment_profile jsonb DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.profiles.recruitment_status IS
  'Recruitment subscription state, separate from plan_tier/plan_status: inactive, active, past_due, cancelled.';
COMMENT ON COLUMN public.profiles.recruitment_current_period_end IS
  'Stripe period end for paid Recruitment. For admin-enabled (beta) access with no subscription id, access ends here.';
COMMENT ON COLUMN public.profiles.recruitment_profile IS
  'Account-level hiring profile: {firm_name, proposition, roles_needed[], adviser_types[], target_locations[], min_years_approved, permissions_required[], notes}';

-- Campaigns: purpose and recruitment profile override
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'clients';
ALTER TABLE public.campaigns DROP CONSTRAINT IF EXISTS campaigns_purpose_check;
ALTER TABLE public.campaigns ADD CONSTRAINT campaigns_purpose_check
  CHECK (purpose IN ('clients', 'advisers'));
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS recruitment_profile jsonb DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS idx_campaigns_user_purpose ON public.campaigns(user_id, purpose);

COMMENT ON COLUMN public.campaigns.purpose IS
  'clients = HNW client prospecting (default). advisers = recruitment campaign.';
COMMENT ON COLUMN public.campaigns.recruitment_profile IS
  'Per-campaign override of the account recruitment profile.';

-- Prospects: adviser type and FCA data
ALTER TABLE public.prospects ADD COLUMN IF NOT EXISTS prospect_type text NOT NULL DEFAULT 'client';
ALTER TABLE public.prospects DROP CONSTRAINT IF EXISTS prospects_prospect_type_check;
ALTER TABLE public.prospects ADD CONSTRAINT prospects_prospect_type_check
  CHECK (prospect_type IN ('client', 'adviser'));
ALTER TABLE public.prospects ADD COLUMN IF NOT EXISTS fca_irn text;
ALTER TABLE public.prospects ADD COLUMN IF NOT EXISTS fca_frn text;
ALTER TABLE public.prospects ADD COLUMN IF NOT EXISTS fca_firm_name text;
ALTER TABLE public.prospects ADD COLUMN IF NOT EXISTS fca_status text;
ALTER TABLE public.prospects ADD COLUMN IF NOT EXISTS fca_data jsonb DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS idx_prospects_type ON public.prospects(prospect_type);

COMMENT ON COLUMN public.prospects.fca_data IS
  'Register snapshot for advisers: {current_functions[], previous_functions[], permissions[], tenure_months, years_approved, previous_firms[], moves_count, firm_signals{}, disciplinary, workplaces[]}';

-- Usage events: every v75.7 type, plus recruitment
ALTER TABLE public.usage_events DROP CONSTRAINT IF EXISTS usage_events_event_type_check;
ALTER TABLE public.usage_events ADD CONSTRAINT usage_events_event_type_check
  CHECK (event_type IN ('prospect_researched', 'prospect_refunded', 'prospects_found', 'find_refunded',
                        'campaign_created', 'export_generated',
                        'adviser_research', 'adviser_refunded', 'adviser_search', 'adviser_search_refunded'));


-- ---------- 2. Recruitment rules ----------

-- Keep in step with RECRUITMENT_PLAN and PLAN_LIMITS.recruitment in types/index.ts.
CREATE OR REPLACE FUNCTION public.get_recruitment_limits()
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT '{"advisers_per_cycle": 100, "campaigns": 10, "watchlist_items": 200, "finds_per_cycle": 400}'::jsonb
$$;

-- 'ok' or why Recruitment is blocked. Mirrors recruitmentAccess() in
-- lib/recruitment/access-rules.ts. Admin-enabled (beta) access has no
-- Stripe subscription and ends at recruitment_current_period_end.
-- past_due blocks access straight away (unlike client plans, where Stripe
-- keeps retrying and the plan keeps working).
CREATE OR REPLACE FUNCTION public.recruitment_access(p_status text, p_subscription_id text, p_period_end timestamptz)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_status = 'active' AND p_subscription_id IS NULL
         AND p_period_end IS NOT NULL AND p_period_end <= now() THEN 'recruitment_expired'
    WHEN p_status = 'active'    THEN 'ok'
    WHEN p_status = 'past_due'  THEN 'recruitment_payment_failed'
    WHEN p_status = 'cancelled' THEN 'recruitment_cancelled'
    ELSE 'recruitment_inactive'
  END
$$;

-- The v76 draft functions were never applied, but drop them in case.
DROP FUNCTION IF EXISTS public.can_research_advisers(uuid, int);
DROP FUNCTION IF EXISTS public.increment_recruitment_usage(uuid, int);


-- ---------- 3. Adviser research counting ----------

-- Locks the profile row, starts a new 30-day recruitment cycle if the old
-- one has run out, and returns the row. Shared by the consume functions.
CREATE OR REPLACE FUNCTION public.lock_recruitment_for_usage(p_user_id uuid)
RETURNS public.profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile public.profiles;
BEGIN
  SELECT * INTO v_profile FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  IF FOUND AND (v_profile.recruitment_usage_reset_at IS NULL OR v_profile.recruitment_usage_reset_at < now()) THEN
    UPDATE public.profiles
       SET recruitment_advisers_used = 0,
           recruitment_finds_used = 0,
           recruitment_usage_reset_at = now() + interval '30 days'
     WHERE id = p_user_id
     RETURNING * INTO v_profile;
  END IF;
  RETURN v_profile;
END;
$$;

-- Reserves one adviser research, or says why not.
-- Returns {"ok": true, "used": n, "limit": n} or
--         {"ok": false, "reason": "...", "used": n, "limit": n, "resets_at": "..."}.
CREATE OR REPLACE FUNCTION public.consume_recruitment_research(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile public.profiles;
  v_reason  text;
  v_limit   int;
BEGIN
  v_profile := public.lock_recruitment_for_usage(p_user_id);
  IF v_profile.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'recruitment_inactive', 'used', 0, 'limit', 0);
  END IF;

  v_limit  := (public.get_recruitment_limits()->>'advisers_per_cycle')::int;
  v_reason := public.recruitment_access(v_profile.recruitment_status, v_profile.recruitment_subscription_id,
                                        v_profile.recruitment_current_period_end);

  IF v_reason = 'ok' AND v_profile.recruitment_advisers_used >= v_limit THEN
    v_reason := 'recruitment_limit_reached';
  END IF;

  IF v_reason <> 'ok' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', v_reason,
      'used', v_profile.recruitment_advisers_used,
      'limit', v_limit,
      'resets_at', v_profile.recruitment_usage_reset_at
    );
  END IF;

  UPDATE public.profiles
     SET recruitment_advisers_used = recruitment_advisers_used + 1,
         updated_at = now()
   WHERE id = p_user_id;

  INSERT INTO public.usage_events (user_id, event_type, prospect_count)
  VALUES (p_user_id, 'adviser_research', 1);

  RETURN jsonb_build_object('ok', true, 'used', v_profile.recruitment_advisers_used + 1, 'limit', v_limit);
END;
$$;

-- Gives back an adviser research when the research itself failed. Capped
-- at 10 refunds in 30 days, the same as client research. Returns whether
-- it refunded.
CREATE OR REPLACE FUNCTION public.refund_recruitment_research(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_recent int;
BEGIN
  PERFORM 1 FROM public.profiles WHERE id = p_user_id FOR UPDATE;

  SELECT count(*) INTO v_recent
    FROM public.usage_events
   WHERE user_id = p_user_id
     AND event_type = 'adviser_refunded'
     AND created_at > now() - interval '30 days';
  IF v_recent >= 10 THEN
    RETURN false;
  END IF;

  UPDATE public.profiles
     SET recruitment_advisers_used = greatest(recruitment_advisers_used - 1, 0),
         updated_at = now()
   WHERE id = p_user_id;

  INSERT INTO public.usage_events (user_id, event_type, prospect_count)
  VALUES (p_user_id, 'adviser_refunded', 1);
  RETURN true;
END;
$$;


-- ---------- 4. Adviser search budget ----------

-- Reserves up to p_units of this month's adviser search budget. Grants
-- what is left if that is less than asked. Returns
--   {"ok": true, "granted": n, "used": n, "limit": n} or
--   {"ok": false, "reason": "...", "used": n, "limit": n, "resets_at": "..."}.
CREATE OR REPLACE FUNCTION public.consume_recruitment_find_units(p_user_id uuid, p_units int)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile public.profiles;
  v_reason  text;
  v_limit   int;
  v_grant   int;
BEGIN
  v_profile := public.lock_recruitment_for_usage(p_user_id);
  IF v_profile.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'recruitment_inactive', 'used', 0, 'limit', 0);
  END IF;

  v_limit  := (public.get_recruitment_limits()->>'finds_per_cycle')::int;
  v_reason := public.recruitment_access(v_profile.recruitment_status, v_profile.recruitment_subscription_id,
                                        v_profile.recruitment_current_period_end);
  v_grant  := least(greatest(coalesce(p_units, 0), 0), greatest(v_limit - v_profile.recruitment_finds_used, 0));

  IF v_reason = 'ok' AND v_grant = 0 THEN
    v_reason := 'recruitment_find_limit_reached';
  END IF;

  IF v_reason <> 'ok' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', v_reason,
      'used', v_profile.recruitment_finds_used,
      'limit', v_limit,
      'resets_at', v_profile.recruitment_usage_reset_at
    );
  END IF;

  UPDATE public.profiles
     SET recruitment_finds_used = recruitment_finds_used + v_grant,
         updated_at = now()
   WHERE id = p_user_id;

  INSERT INTO public.usage_events (user_id, event_type, prospect_count)
  VALUES (p_user_id, 'adviser_search', v_grant);

  RETURN jsonb_build_object('ok', true, 'granted', v_grant,
                            'used', v_profile.recruitment_finds_used + v_grant, 'limit', v_limit);
END;
$$;

-- Returns unused adviser search units, for example when Apollo returned
-- fewer contacts than were reserved.
CREATE OR REPLACE FUNCTION public.refund_recruitment_find_units(p_user_id uuid, p_units int)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF coalesce(p_units, 0) <= 0 THEN
    RETURN;
  END IF;

  UPDATE public.profiles
     SET recruitment_finds_used = greatest(recruitment_finds_used - p_units, 0),
         updated_at = now()
   WHERE id = p_user_id;

  INSERT INTO public.usage_events (user_id, event_type, prospect_count)
  VALUES (p_user_id, 'adviser_search_refunded', p_units);
END;
$$;

-- Server only. Without this, any signed-in user could call these with
-- someone else's id, or refund themselves endlessly.
REVOKE ALL ON FUNCTION public.lock_recruitment_for_usage(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.consume_recruitment_research(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refund_recruitment_research(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.consume_recruitment_find_units(uuid, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refund_recruitment_find_units(uuid, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lock_recruitment_for_usage(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.consume_recruitment_research(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.refund_recruitment_research(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.consume_recruitment_find_units(uuid, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.refund_recruitment_find_units(uuid, int) TO service_role;


-- ---------- 5. Campaign limits, by purpose ----------

-- Replaces the v75.7 version. Client campaigns: as before, but only client
-- campaigns count. Recruitment campaigns: need Recruitment, up to its
-- campaign limit. Admins are exempt from both.
CREATE OR REPLACE FUNCTION public.enforce_campaign_limit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_profile public.profiles;
  v_reason  text;
  v_limit   int;
  v_count   int;
BEGIN
  -- Only limit inserts made with a user's own login, and never an admin's.
  IF current_user NOT IN ('authenticated', 'anon') OR public.is_admin() THEN
    RETURN NEW;
  END IF;

  -- Lock the profile row so two inserts at once can't both slip under the limit.
  SELECT * INTO v_profile FROM public.profiles WHERE id = NEW.user_id FOR UPDATE;

  IF NEW.purpose = 'advisers' THEN
    v_reason := public.recruitment_access(v_profile.recruitment_status, v_profile.recruitment_subscription_id,
                                          v_profile.recruitment_current_period_end);
    IF v_reason <> 'ok' THEN
      RAISE EXCEPTION 'Recruitment is not active on your account. Start it from the Recruitment page to create recruitment campaigns.'
        USING ERRCODE = 'P0001';
    END IF;

    v_limit := (public.get_recruitment_limits()->>'campaigns')::int;
    SELECT count(*) INTO v_count FROM public.campaigns WHERE user_id = NEW.user_id AND purpose = 'advisers';
    IF v_count >= v_limit THEN
      RAISE EXCEPTION 'Recruitment includes % campaigns and you have used them all. Delete a recruitment campaign you no longer need.', v_limit
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  v_reason := public.plan_access(v_profile.plan_tier, v_profile.plan_status, v_profile.trial_ends_at);
  IF v_reason = 'trial_ended' THEN
    RAISE EXCEPTION 'Your 7-day free trial has ended. Choose a plan in Settings to create campaigns.' USING ERRCODE = 'P0001';
  ELSIF v_reason = 'payment_failed' THEN
    RAISE EXCEPTION 'Your last payment did not go through. Update your card in Settings to create campaigns.' USING ERRCODE = 'P0001';
  ELSIF v_reason <> 'ok' THEN
    RAISE EXCEPTION 'Your account does not have an active plan. Choose a plan in Settings to create campaigns.' USING ERRCODE = 'P0001';
  END IF;

  v_limit := coalesce((public.get_plan_limits(v_profile.plan_tier)->>'campaigns')::int, 0);
  SELECT count(*) INTO v_count FROM public.campaigns WHERE user_id = NEW.user_id AND purpose = 'clients';

  IF v_count >= v_limit THEN
    RAISE EXCEPTION 'Your plan includes % campaigns and you have used them all. Delete a campaign you no longer need, or upgrade in Settings.', v_limit
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_campaign_limit ON public.campaigns;
CREATE TRIGGER enforce_campaign_limit
  BEFORE INSERT ON public.campaigns
  FOR EACH ROW EXECUTE FUNCTION public.enforce_campaign_limit();

-- The v76 draft had a separate recruitment trigger. enforce_campaign_limit covers it now.
DROP TRIGGER IF EXISTS trg_recruitment_campaign_limit ON public.campaigns;
DROP FUNCTION IF EXISTS public.enforce_recruitment_campaign_limit();

-- A campaign keeps the purpose it was created with. Otherwise a recruitment
-- campaign could be switched to client prospecting to get round the client
-- plan's campaign limit, or the other way round.
CREATE OR REPLACE FUNCTION public.protect_campaign_purpose()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') AND NEW.purpose IS DISTINCT FROM OLD.purpose THEN
    RAISE EXCEPTION 'A campaign cannot be switched between client prospecting and recruitment.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_campaign_purpose ON public.campaigns;
CREATE TRIGGER protect_campaign_purpose
  BEFORE UPDATE ON public.campaigns
  FOR EACH ROW EXECUTE FUNCTION public.protect_campaign_purpose();


-- ---------- 6. Lock the recruitment billing and usage columns ----------
-- "Users can update own profile" would otherwise let a signed-in user set
-- recruitment_status to active from the browser. The webhook, admin panel
-- and research routes use the service role, and SECURITY DEFINER functions
-- run as their owner, so those pass through. recruitment_profile stays
-- user-editable.

CREATE OR REPLACE FUNCTION public.protect_recruitment_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') AND (
       NEW.recruitment_status             IS DISTINCT FROM OLD.recruitment_status
    OR NEW.recruitment_period             IS DISTINCT FROM OLD.recruitment_period
    OR NEW.recruitment_subscription_id    IS DISTINCT FROM OLD.recruitment_subscription_id
    OR NEW.recruitment_current_period_end IS DISTINCT FROM OLD.recruitment_current_period_end
    OR NEW.recruitment_advisers_used      IS DISTINCT FROM OLD.recruitment_advisers_used
    OR NEW.recruitment_finds_used         IS DISTINCT FROM OLD.recruitment_finds_used
    OR NEW.recruitment_usage_reset_at     IS DISTINCT FROM OLD.recruitment_usage_reset_at
  ) THEN
    RAISE EXCEPTION 'Recruitment subscription details can only be changed by ProspectIQ.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_recruitment_columns ON public.profiles;
CREATE TRIGGER trg_protect_recruitment_columns
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.protect_recruitment_columns();
