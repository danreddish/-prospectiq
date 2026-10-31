-- ============================================
-- ProspectIQ Database Schema
-- Run this in Supabase SQL Editor
-- ============================================

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- ============================================
-- 1. PROFILES (extends Supabase auth.users)
-- ============================================
create table public.profiles (
  id uuid references auth.users on delete cascade primary key,
  email text not null,
  full_name text,
  company_name text,
  niche text,                          -- e.g. "UK expat wealth management"
  sender_name text,                    -- name that signs outreach messages
  stripe_customer_id text unique,
  plan_tier text default 'free' check (plan_tier in ('free', 'trial', 'starter', 'professional', 'growth')),
  plan_status text default 'active' check (plan_status in ('active', 'trialing', 'past_due', 'canceled', 'unpaid')),
  trial_ends_at timestamptz,
  prospects_used_this_cycle int default 0,
  cycle_reset_at timestamptz default (now() + interval '30 days'),
  service_profile jsonb default '{}'::jsonb,   -- account-level service offering (v75)
  -- Recruitment mode (v76): a separate subscription from plan_tier
  recruitment_status text not null default 'inactive' check (recruitment_status in ('inactive', 'active', 'past_due', 'cancelled')),
  recruitment_period text check (recruitment_period is null or recruitment_period in ('monthly', 'annual')),
  recruitment_subscription_id text,
  recruitment_current_period_end timestamptz,
  recruitment_advisers_used int not null default 0,
  recruitment_finds_used int not null default 0,      -- adviser searches this cycle (v76)
  recruitment_usage_reset_at timestamptz,
  recruitment_profile jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Auto-create profile on signup. New accounts start on the 7-day trial (v75.6).
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, full_name, plan_tier, plan_status, trial_ends_at)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    'trial',
    'active',
    now() + interval '7 days'
  );
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================
-- 2. CAMPAIGNS
-- ============================================
create table public.campaigns (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid references public.profiles(id) on delete cascade not null,
  name text not null,
  niche text,                          -- campaign-level niche override
  sender_name text,                    -- campaign-level sender override
  prospect_count int default 0,
  service_profile jsonb default '{}'::jsonb,   -- per-campaign service profile override (v75)
  custom_instructions text,                    -- plain English batch instructions (v75)
  audience_mode text check (audience_mode in ('match_profile', 'different_audience')),
  purpose text not null default 'clients' check (purpose in ('clients', 'advisers')),  -- v76
  recruitment_profile jsonb default '{}'::jsonb,  -- per-campaign recruitment profile override (v76)
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index idx_campaigns_user on public.campaigns(user_id);
create index idx_campaigns_user_purpose on public.campaigns(user_id, purpose);

-- ============================================
-- 3. PROSPECTS
-- ============================================
create table public.prospects (
  id uuid default uuid_generate_v4() primary key,
  campaign_id uuid references public.campaigns(id) on delete cascade not null,
  user_id uuid references public.profiles(id) on delete cascade not null,

  -- Input data
  name text not null,
  role text,
  company text,
  location text,
  linkedin_url text,

  -- AI-generated research
  research_notes text,
  wealth_estimate text,
  est_age text,
  yrs_at_sr_level int,
  key_trigger text,

  -- Scoring (JSONB for flexibility across niches)
  scores jsonb default '{}',           -- e.g. {"wealth": 8, "timing": 7, "accessibility": 6, "complexity": 5}
  total_score int default 0,
  tier text check (tier in ('A', 'B', 'C')),

  -- Outreach sequences (JSONB)
  outreach jsonb default '{}',         -- contains step1, step2, step3 objects

  -- Status
  status text default 'pending' check (status in ('pending', 'processing', 'completed', 'failed')),
  error_message text,

  -- Reply Coach conversation history
  conversations jsonb default '[]',

  -- Apollo enrichment (v75)
  email text,
  phone text,
  headline text,

  -- Companies House financials (v75, hnw_clients source only)
  company_number text,
  accounts_category text,
  turnover bigint,
  total_assets bigint,
  employee_count int,
  accounts_last_filed date,

  -- Recruitment mode (v76): adviser prospects and their FCA Register data
  prospect_type text not null default 'client' check (prospect_type in ('client', 'adviser')),
  fca_irn text,
  fca_frn text,
  fca_firm_name text,
  fca_status text,
  fca_data jsonb default '{}'::jsonb,   -- {current_functions[], previous_functions[], permissions[], tenure_months, years_approved, previous_firms[], moves_count, firm_signals{}, disciplinary, workplaces[]}

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index idx_prospects_campaign on public.prospects(campaign_id);
create index idx_prospects_user on public.prospects(user_id);
create index idx_prospects_status on public.prospects(status);
create index idx_prospects_type on public.prospects(prospect_type);

-- ============================================
-- 4. USAGE EVENTS (for billing metering)
-- ============================================
create table public.usage_events (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid references public.profiles(id) on delete cascade not null,
  event_type text not null check (event_type in ('prospect_researched', 'prospect_refunded', 'prospects_found', 'find_refunded', 'campaign_created', 'export_generated', 'adviser_research', 'adviser_refunded', 'adviser_search', 'adviser_search_refunded')),
  prospect_count int default 1,
  metadata jsonb default '{}',
  created_at timestamptz default now()
);

create index idx_usage_user on public.usage_events(user_id);

-- ============================================
-- 5. SHARED DASHBOARD LINKS
-- ============================================
create table public.shared_links (
  id uuid default uuid_generate_v4() primary key,
  campaign_id uuid references public.campaigns(id) on delete cascade not null,
  user_id uuid references public.profiles(id) on delete cascade not null,
  token text unique not null default encode(gen_random_bytes(32), 'hex'),
  expires_at timestamptz default (now() + interval '30 days'),
  is_active boolean default true,
  created_at timestamptz default now()
);

create index idx_shared_links_token on public.shared_links(token);

-- ============================================
-- 6. ROW LEVEL SECURITY
-- ============================================

alter table public.profiles enable row level security;
alter table public.campaigns enable row level security;
alter table public.prospects enable row level security;
alter table public.usage_events enable row level security;
alter table public.shared_links enable row level security;

-- Profiles: users can only read/update their own
create policy "Users can view own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = id);

-- Campaigns: users can CRUD their own
create policy "Users can view own campaigns"
  on public.campaigns for select
  using (auth.uid() = user_id);

create policy "Users can create campaigns"
  on public.campaigns for insert
  with check (auth.uid() = user_id);

create policy "Users can update own campaigns"
  on public.campaigns for update
  using (auth.uid() = user_id);

create policy "Users can delete own campaigns"
  on public.campaigns for delete
  using (auth.uid() = user_id);

-- Prospects: users can CRUD their own
create policy "Users can view own prospects"
  on public.prospects for select
  using (auth.uid() = user_id);

create policy "Users can create prospects"
  on public.prospects for insert
  with check (auth.uid() = user_id);

create policy "Users can update own prospects"
  on public.prospects for update
  using (auth.uid() = user_id);

create policy "Users can delete own prospects"
  on public.prospects for delete
  using (auth.uid() = user_id);

-- Usage events: users can view their own
create policy "Users can view own usage"
  on public.usage_events for select
  using (auth.uid() = user_id);

create policy "Users can create usage events"
  on public.usage_events for insert
  with check (auth.uid() = user_id);

-- Shared links: users can manage their own
create policy "Users can view own shared links"
  on public.shared_links for select
  using (auth.uid() = user_id);

create policy "Users can create shared links"
  on public.shared_links for insert
  with check (auth.uid() = user_id);

-- ============================================
-- 7. PLAN LIMITS FUNCTION
-- ============================================
create or replace function public.get_plan_limits(plan text)
returns jsonb as $$
begin
  return case plan
    when 'free' then '{"prospects_per_cycle": 3, "campaigns": 1}'::jsonb
    when 'trial' then '{"prospects_per_cycle": 5, "campaigns": 2}'::jsonb
    when 'starter' then '{"prospects_per_cycle": 25, "campaigns": 2}'::jsonb
    when 'professional' then '{"prospects_per_cycle": 100, "campaigns": 10}'::jsonb
    when 'growth' then '{"prospects_per_cycle": 300, "campaigns": 999}'::jsonb
    else '{"prospects_per_cycle": 0, "campaigns": 0}'::jsonb
  end;
end;
$$ language plpgsql immutable;

-- ============================================
-- 8. USAGE CHECK FUNCTION
-- ============================================
create or replace function public.can_research_prospects(p_user_id uuid, p_count int default 1)
returns boolean as $$
declare
  v_profile public.profiles;
  v_limits jsonb;
begin
  select * into v_profile from public.profiles where id = p_user_id;
  v_limits := public.get_plan_limits(v_profile.plan_tier);

  -- Check if cycle needs resetting
  if v_profile.cycle_reset_at < now() then
    update public.profiles
    set prospects_used_this_cycle = 0,
        cycle_reset_at = now() + interval '30 days'
    where id = p_user_id;
    return true;
  end if;

  return (v_profile.prospects_used_this_cycle + p_count) <= (v_limits->>'prospects_per_cycle')::int;
end;
$$ language plpgsql security definer;

-- ============================================
-- 9. INCREMENT USAGE FUNCTION
-- ============================================
create or replace function public.increment_usage(p_user_id uuid, p_count int default 1)
returns void as $$
begin
  update public.profiles
  set prospects_used_this_cycle = prospects_used_this_cycle + p_count,
      updated_at = now()
  where id = p_user_id;

  insert into public.usage_events (user_id, event_type, prospect_count)
  values (p_user_id, 'prospect_researched', p_count);
end;
$$ language plpgsql security definer;

-- ============================================
-- 10. PLAN ENFORCEMENT (v75.7)
-- Same as supabase/migrations/005_v75_7_plan_enforcement.sql, sections 1-6.
-- ============================================

-- ---------- Lock billing columns on profiles ----------

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS finds_used_this_cycle int NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.protect_profile_billing_fields()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- current_user is 'authenticated' or 'anon' only for requests made with a
  -- user's own login. The service role, the SQL editor and our SECURITY
  -- DEFINER functions run as other roles and pass straight through.
  IF current_user IN ('authenticated', 'anon') AND (
       NEW.plan_tier                 IS DISTINCT FROM OLD.plan_tier
    OR NEW.plan_status               IS DISTINCT FROM OLD.plan_status
    OR NEW.trial_ends_at             IS DISTINCT FROM OLD.trial_ends_at
    OR NEW.prospects_used_this_cycle IS DISTINCT FROM OLD.prospects_used_this_cycle
    OR NEW.finds_used_this_cycle     IS DISTINCT FROM OLD.finds_used_this_cycle
    OR NEW.cycle_reset_at            IS DISTINCT FROM OLD.cycle_reset_at
    OR NEW.stripe_customer_id        IS DISTINCT FROM OLD.stripe_customer_id
    OR NEW.email                     IS DISTINCT FROM OLD.email
  ) THEN
    RAISE EXCEPTION 'Plan and billing details can only be changed by ProspectIQ.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_profile_billing_fields ON public.profiles;
CREATE TRIGGER protect_profile_billing_fields
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.protect_profile_billing_fields();


-- ---------- 2. Plan rules ----------

-- Whether a plan is usable. Returns 'ok', 'trial_ended', 'no_plan',
-- 'payment_failed' or 'canceled'. Mirrored in lib/access.ts planAccess().
CREATE OR REPLACE FUNCTION public.plan_access(p_tier text, p_status text, p_trial_ends_at timestamptz)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN coalesce(p_tier, 'free') IN ('starter', 'professional', 'growth') THEN
      CASE
        WHEN coalesce(p_status, 'active') IN ('active', 'trialing', 'past_due') THEN 'ok'
        WHEN p_status = 'unpaid' THEN 'payment_failed'
        ELSE 'canceled'
      END
    WHEN p_tier = 'trial' THEN
      CASE WHEN p_trial_ends_at IS NOT NULL AND p_trial_ends_at > now() THEN 'ok' ELSE 'trial_ended' END
    ELSE 'no_plan'
  END;
$$;

-- Plan limits. finds_per_cycle is the monthly budget for finding
-- prospects: one unit per AI search and one per Apollo-enriched contact.
CREATE OR REPLACE FUNCTION public.get_plan_limits(plan text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  RETURN CASE plan
    WHEN 'free'         THEN '{"prospects_per_cycle": 3,   "campaigns": 1,   "finds_per_cycle": 0}'::jsonb
    WHEN 'trial'        THEN '{"prospects_per_cycle": 5,   "campaigns": 2,   "finds_per_cycle": 40}'::jsonb
    WHEN 'starter'      THEN '{"prospects_per_cycle": 25,  "campaigns": 2,   "finds_per_cycle": 100}'::jsonb
    WHEN 'professional' THEN '{"prospects_per_cycle": 100, "campaigns": 10,  "finds_per_cycle": 400}'::jsonb
    WHEN 'growth'       THEN '{"prospects_per_cycle": 300, "campaigns": 999, "finds_per_cycle": 1200}'::jsonb
    ELSE '{"prospects_per_cycle": 0, "campaigns": 0, "finds_per_cycle": 0}'::jsonb
  END;
END;
$$;

-- True when the request comes from an admin's own login. Reads the
-- verified email in the Supabase JWT, which users cannot edit.
-- Keep the list in step with lib/access.ts ADMIN_EMAILS.
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT lower(coalesce(auth.jwt() ->> 'email', '')) IN ('dan.reddish@gmail.com', 'dan@aiwealthpartners.co.uk');
$$;


-- ---------- 3. Atomic research counting ----------

-- Locks the profile row, starts a new 30-day cycle if the old one has run
-- out, and returns the row. Shared by the consume functions.
CREATE OR REPLACE FUNCTION public.lock_profile_for_usage(p_user_id uuid)
RETURNS public.profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile public.profiles;
BEGIN
  SELECT * INTO v_profile FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  IF FOUND AND (v_profile.cycle_reset_at IS NULL OR v_profile.cycle_reset_at < now()) THEN
    UPDATE public.profiles
       SET prospects_used_this_cycle = 0,
           finds_used_this_cycle = 0,
           cycle_reset_at = now() + interval '30 days'
     WHERE id = p_user_id
     RETURNING * INTO v_profile;
  END IF;
  RETURN v_profile;
END;
$$;

-- Reserves one research for p_user_id, or says why not.
-- Returns {"ok": true, "used": n, "limit": n} or
--         {"ok": false, "reason": "...", "used": n, "limit": n, "resets_at": "..."}.
CREATE OR REPLACE FUNCTION public.consume_research_credit(p_user_id uuid)
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
  v_profile := public.lock_profile_for_usage(p_user_id);
  IF v_profile.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_plan', 'used', 0, 'limit', 0);
  END IF;

  v_limit  := coalesce((public.get_plan_limits(v_profile.plan_tier)->>'prospects_per_cycle')::int, 0);
  v_reason := public.plan_access(v_profile.plan_tier, v_profile.plan_status, v_profile.trial_ends_at);

  IF v_reason = 'ok' AND v_profile.prospects_used_this_cycle >= v_limit THEN
    v_reason := 'limit_reached';
  END IF;

  IF v_reason <> 'ok' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', v_reason,
      'used', v_profile.prospects_used_this_cycle,
      'limit', v_limit,
      'resets_at', v_profile.cycle_reset_at
    );
  END IF;

  UPDATE public.profiles
     SET prospects_used_this_cycle = prospects_used_this_cycle + 1,
         updated_at = now()
   WHERE id = p_user_id;

  INSERT INTO public.usage_events (user_id, event_type, prospect_count)
  VALUES (p_user_id, 'prospect_researched', 1);

  RETURN jsonb_build_object('ok', true, 'used', v_profile.prospects_used_this_cycle + 1, 'limit', v_limit);
END;
$$;

-- Gives back a credit when the research itself failed. Capped at 10
-- refunds in 30 days, so failures can't be forced in a loop to spend
-- Apollo and Claude credits for free. Returns whether it refunded.
CREATE OR REPLACE FUNCTION public.refund_research_credit(p_user_id uuid)
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
     AND event_type = 'prospect_refunded'
     AND created_at > now() - interval '30 days';
  IF v_recent >= 10 THEN
    RETURN false;
  END IF;

  UPDATE public.profiles
     SET prospects_used_this_cycle = greatest(prospects_used_this_cycle - 1, 0),
         updated_at = now()
   WHERE id = p_user_id;

  INSERT INTO public.usage_events (user_id, event_type, prospect_count)
  VALUES (p_user_id, 'prospect_refunded', 1);
  RETURN true;
END;
$$;


-- ---------- 4. Find budget ----------

-- Reserves up to p_units of this month's find budget. Grants what is
-- left if that is less than asked. Returns
--   {"ok": true, "granted": n, "used": n, "limit": n} or
--   {"ok": false, "reason": "...", "used": n, "limit": n, "resets_at": "..."}.
CREATE OR REPLACE FUNCTION public.consume_find_units(p_user_id uuid, p_units int)
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
  v_profile := public.lock_profile_for_usage(p_user_id);
  IF v_profile.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_plan', 'used', 0, 'limit', 0);
  END IF;

  v_limit  := coalesce((public.get_plan_limits(v_profile.plan_tier)->>'finds_per_cycle')::int, 0);
  v_reason := public.plan_access(v_profile.plan_tier, v_profile.plan_status, v_profile.trial_ends_at);
  v_grant  := least(greatest(coalesce(p_units, 0), 0), greatest(v_limit - v_profile.finds_used_this_cycle, 0));

  IF v_reason = 'ok' AND v_grant = 0 THEN
    v_reason := 'find_limit_reached';
  END IF;

  IF v_reason <> 'ok' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', v_reason,
      'used', v_profile.finds_used_this_cycle,
      'limit', v_limit,
      'resets_at', v_profile.cycle_reset_at
    );
  END IF;

  UPDATE public.profiles
     SET finds_used_this_cycle = finds_used_this_cycle + v_grant,
         updated_at = now()
   WHERE id = p_user_id;

  INSERT INTO public.usage_events (user_id, event_type, prospect_count)
  VALUES (p_user_id, 'prospects_found', v_grant);

  RETURN jsonb_build_object('ok', true, 'granted', v_grant,
                            'used', v_profile.finds_used_this_cycle + v_grant, 'limit', v_limit);
END;
$$;

-- Returns unused find units, for example when Apollo returned fewer
-- contacts than were reserved.
CREATE OR REPLACE FUNCTION public.refund_find_units(p_user_id uuid, p_units int)
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
     SET finds_used_this_cycle = greatest(finds_used_this_cycle - p_units, 0),
         updated_at = now()
   WHERE id = p_user_id;

  INSERT INTO public.usage_events (user_id, event_type, prospect_count)
  VALUES (p_user_id, 'find_refunded', p_units);
END;
$$;

-- Server only. Without this, any signed-in user could call these with
-- someone else's id, or refund themselves endlessly.
REVOKE ALL ON FUNCTION public.lock_profile_for_usage(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.consume_research_credit(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refund_research_credit(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.consume_find_units(uuid, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refund_find_units(uuid, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lock_profile_for_usage(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.consume_research_credit(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.refund_research_credit(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.consume_find_units(uuid, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.refund_find_units(uuid, int) TO service_role;


-- ---------- 5. Campaign limit ----------

CREATE OR REPLACE FUNCTION public.enforce_campaign_limit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_tier    text;
  v_status  text;
  v_trial   timestamptz;
  v_reason  text;
  v_limit   int;
  v_count   int;
BEGIN
  -- Only limit inserts made with a user's own login, and never an admin's.
  IF current_user NOT IN ('authenticated', 'anon') OR public.is_admin() THEN
    RETURN NEW;
  END IF;

  -- Lock the profile row so two inserts at once can't both slip under the limit.
  SELECT plan_tier, plan_status, trial_ends_at
    INTO v_tier, v_status, v_trial
    FROM public.profiles WHERE id = NEW.user_id
    FOR UPDATE;

  v_reason := public.plan_access(v_tier, v_status, v_trial);
  IF v_reason = 'trial_ended' THEN
    RAISE EXCEPTION 'Your 7-day free trial has ended. Choose a plan in Settings to create campaigns.' USING ERRCODE = 'P0001';
  ELSIF v_reason = 'payment_failed' THEN
    RAISE EXCEPTION 'Your last payment did not go through. Update your card in Settings to create campaigns.' USING ERRCODE = 'P0001';
  ELSIF v_reason <> 'ok' THEN
    RAISE EXCEPTION 'Your account does not have an active plan. Choose a plan in Settings to create campaigns.' USING ERRCODE = 'P0001';
  END IF;

  v_limit := coalesce((public.get_plan_limits(v_tier)->>'campaigns')::int, 0);
  SELECT count(*) INTO v_count FROM public.campaigns WHERE user_id = NEW.user_id;

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


-- ---------- 6. Close the old any-user functions to the browser ----------
-- Neither is called by the app. Both took any user's id.

REVOKE ALL ON FUNCTION public.increment_usage(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.can_research_prospects(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_usage(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.can_research_prospects(uuid, integer) TO service_role;

-- ============================================
-- 11. RECRUITMENT (v76)
-- Same as supabase/migrations/007_v76_recruitment.sql, sections 2-6. Its
-- column changes (section 1) are in the tables above. Replaces the v75.7
-- enforce_campaign_limit() above with the purpose-aware version.
-- ============================================

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


-- ============================================
-- 12. RECRUITMENT WATCHLIST AND ALERTS (v76.1)
-- Same as supabase/migrations/008_v76_1_watchlist.sql.
-- ============================================

-- ── Watchlist items ──
CREATE TABLE IF NOT EXISTS public.watchlist_items (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
  item_type text NOT NULL CHECK (item_type IN ('adviser', 'firm')),
  fca_irn text,
  fca_frn text,
  display_name text NOT NULL,
  firm_name text,
  prospect_id uuid REFERENCES public.prospects(id) ON DELETE SET NULL,
  campaign_id uuid REFERENCES public.campaigns(id) ON DELETE SET NULL,
  last_checked_at timestamptz,
  last_snapshot jsonb,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT watchlist_items_identifier_check CHECK (
    (item_type = 'adviser' AND fca_irn IS NOT NULL) OR
    (item_type = 'firm' AND fca_frn IS NOT NULL)
  )
);

-- One entry per user per adviser (IRN) and per firm (FRN)
CREATE UNIQUE INDEX IF NOT EXISTS uq_watchlist_user_irn
  ON public.watchlist_items(user_id, fca_irn) WHERE item_type = 'adviser';
CREATE UNIQUE INDEX IF NOT EXISTS uq_watchlist_user_frn
  ON public.watchlist_items(user_id, fca_frn) WHERE item_type = 'firm';

-- The check job takes the oldest last_checked_at first, nulls first
CREATE INDEX IF NOT EXISTS idx_watchlist_last_checked
  ON public.watchlist_items(last_checked_at ASC NULLS FIRST);
CREATE INDEX IF NOT EXISTS idx_watchlist_user ON public.watchlist_items(user_id);

COMMENT ON COLUMN public.watchlist_items.last_snapshot IS
  'Adviser: {status, current_frn, current_firm_name, current_functions[]}. Firm: {status, individual_count, ar_count, ar_count_is_minimum, requirement_count}.';

-- ── Alerts ──
CREATE TABLE IF NOT EXISTS public.alerts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
  watchlist_item_id uuid REFERENCES public.watchlist_items(id) ON DELETE CASCADE NOT NULL,
  alert_type text NOT NULL CHECK (alert_type IN (
    'adviser_status_changed', 'adviser_moved_firm', 'adviser_left_firm', 'adviser_new_function',
    'firm_status_changed', 'firm_headcount_drop', 'firm_ar_count_drop', 'firm_requirements_added'
  )),
  title text NOT NULL,
  detail jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  read_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_alerts_user_read ON public.alerts(user_id, read_at);
CREATE INDEX IF NOT EXISTS idx_alerts_user_created ON public.alerts(user_id, created_at DESC);

-- ── Row level security: users see only their own rows ──
ALTER TABLE public.watchlist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own watchlist" ON public.watchlist_items;
CREATE POLICY "Users can view own watchlist"
  ON public.watchlist_items FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can add to own watchlist" ON public.watchlist_items;
CREATE POLICY "Users can add to own watchlist"
  ON public.watchlist_items FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can remove from own watchlist" ON public.watchlist_items;
CREATE POLICY "Users can remove from own watchlist"
  ON public.watchlist_items FOR DELETE
  USING (auth.uid() = user_id);

-- Snapshots and check times are written by the service role only, so there
-- is no update policy on watchlist_items. Alerts are inserted by the service
-- role only; users can read them and mark them read.
DROP POLICY IF EXISTS "Users can view own alerts" ON public.alerts;
CREATE POLICY "Users can view own alerts"
  ON public.alerts FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can mark own alerts read" ON public.alerts;
CREATE POLICY "Users can mark own alerts read"
  ON public.alerts FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ── 200 item limit, enforced in the database ──
-- Not SECURITY DEFINER, so current_user is the caller's role. A browser
-- insert needs Recruitment (the insert policy alone would let anyone add
-- items). Admins are exempt from the access check and the limit. The
-- profile row lock stops two inserts at once from both slipping under the
-- limit.
CREATE OR REPLACE FUNCTION public.enforce_watchlist_limit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_profile public.profiles;
  v_admin boolean;
  v_count int;
  v_limit int;
BEGIN
  v_admin := current_user IN ('authenticated', 'anon') AND public.is_admin();

  SELECT * INTO v_profile FROM public.profiles WHERE id = NEW.user_id FOR UPDATE;

  IF current_user IN ('authenticated', 'anon') AND NOT v_admin
     AND public.recruitment_access(v_profile.recruitment_status, v_profile.recruitment_subscription_id,
                                   v_profile.recruitment_current_period_end) <> 'ok' THEN
    RAISE EXCEPTION 'Recruitment is not active on your account.' USING ERRCODE = 'P0001';
  END IF;

  -- Identifiers must look like register numbers, so junk can't clog the
  -- check queue. IRNs are letters then digits (e.g. ABC01234), FRNs digits.
  IF NEW.item_type = 'adviser' AND NEW.fca_irn !~ '^[A-Za-z]{2,4}[0-9]{4,6}$' THEN
    RAISE EXCEPTION 'That is not an FCA individual reference number.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.item_type = 'firm' AND NEW.fca_frn !~ '^[0-9]{5,7}$' THEN
    RAISE EXCEPTION 'That is not an FCA firm reference number.' USING ERRCODE = 'P0001';
  END IF;

  -- Foreign keys ignore row level security, so check the linked prospect and
  -- campaign belong to the same user.
  IF NEW.prospect_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.prospects WHERE id = NEW.prospect_id AND user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'Prospect not found.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.campaign_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.campaigns WHERE id = NEW.campaign_id AND user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'Campaign not found.' USING ERRCODE = 'P0001';
  END IF;

  v_limit := (public.get_recruitment_limits()->>'watchlist_items')::int;
  SELECT count(*) INTO v_count FROM public.watchlist_items WHERE user_id = NEW.user_id;
  IF v_count >= v_limit AND NOT v_admin THEN
    RAISE EXCEPTION 'Watchlist limit reached (%). Remove an item first.', v_limit USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_watchlist_limit ON public.watchlist_items;
CREATE TRIGGER trg_watchlist_limit
  BEFORE INSERT ON public.watchlist_items
  FOR EACH ROW EXECUTE FUNCTION public.enforce_watchlist_limit();

-- ── Alerts: users may only mark them read ──
-- The update policy lets a user update their own alerts. Without this, they
-- could rewrite an alert, or move created_at into the future so the daily
-- digest kept resending it.
CREATE OR REPLACE FUNCTION public.protect_alert_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') AND (
       NEW.user_id           IS DISTINCT FROM OLD.user_id
    OR NEW.watchlist_item_id IS DISTINCT FROM OLD.watchlist_item_id
    OR NEW.alert_type        IS DISTINCT FROM OLD.alert_type
    OR NEW.title             IS DISTINCT FROM OLD.title
    OR NEW.detail            IS DISTINCT FROM OLD.detail
    OR NEW.created_at        IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Alerts can only be marked as read.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_alert_columns ON public.alerts;
CREATE TRIGGER trg_protect_alert_columns
  BEFORE UPDATE ON public.alerts
  FOR EACH ROW EXECUTE FUNCTION public.protect_alert_columns();


-- ============================================
-- v77: LinkedIn exclusions and HeyReach test (same as migrations/009_v77_heyreach.sql)
-- ============================================
-- ── 1. LinkedIn exclusions ──
CREATE TABLE IF NOT EXISTS public.linkedin_exclusions (
  user_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
  profile_slug text NOT NULL,
  source text NOT NULL CHECK (source IN ('ulinc', 'heyreach')),
  -- Set on every upload. A finished upload deletes 'ulinc' rows it didn't
  -- touch, so a failed upload leaves the old list in place.
  seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  -- A profile can be on the list from both sources.
  PRIMARY KEY (user_id, profile_slug, source)
);

-- Safe to run over an earlier draft of this table.
ALTER TABLE public.linkedin_exclusions ADD COLUMN IF NOT EXISTS seen_at timestamptz NOT NULL DEFAULT now();
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
       WHERE i.indrelid = 'public.linkedin_exclusions'::regclass AND i.indisprimary) <> 3 THEN
    ALTER TABLE public.linkedin_exclusions DROP CONSTRAINT IF EXISTS linkedin_exclusions_pkey;
    ALTER TABLE public.linkedin_exclusions ADD PRIMARY KEY (user_id, profile_slug, source);
  END IF;
END $$;
ALTER TABLE public.linkedin_exclusions DROP CONSTRAINT IF EXISTS linkedin_exclusions_source_check;
ALTER TABLE public.linkedin_exclusions ADD CONSTRAINT linkedin_exclusions_source_check CHECK (source IN ('ulinc', 'heyreach'));

CREATE INDEX IF NOT EXISTS idx_linkedin_exclusions_user_slug
  ON public.linkedin_exclusions(user_id, profile_slug);

ALTER TABLE public.linkedin_exclusions ENABLE ROW LEVEL SECURITY;

-- Users can read their own list. No insert, update or delete policies:
-- the server writes with the service role.
DROP POLICY IF EXISTS "Users can view own LinkedIn exclusions" ON public.linkedin_exclusions;
CREATE POLICY "Users can view own LinkedIn exclusions"
  ON public.linkedin_exclusions FOR SELECT
  USING (auth.uid() = user_id);

-- ── 2. HeyReach state on prospects ──
ALTER TABLE public.prospects ADD COLUMN IF NOT EXISTS heyreach jsonb;

COMMENT ON COLUMN public.prospects.heyreach IS
  'v77 HeyReach sequence: {first_name, last_name, profile_url, msgs:{msg_1..msg_4}, status: draft|approved|rejected|pushing|pushed|push_failed, approved_at, approved_hash, pushing_at, push:{at, heyreach_campaign_id, linkedin_account_id, sent_lead, response, read_back, outcome}, push_error}. Written by the server only.';

-- Same pattern as protect_profile_billing_fields (v75.7): requests made with
-- a user's own login run as 'authenticated' or 'anon'. The service role
-- (our API routes) passes straight through.
CREATE OR REPLACE FUNCTION public.protect_prospect_heyreach()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF TG_OP = 'INSERT' AND NEW.heyreach IS NOT NULL THEN
      RAISE EXCEPTION 'HeyReach details can only be set by ProspectIQ.' USING ERRCODE = '42501';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.heyreach IS DISTINCT FROM OLD.heyreach THEN
      RAISE EXCEPTION 'HeyReach details can only be changed by ProspectIQ.' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_prospect_heyreach ON public.prospects;
CREATE TRIGGER protect_prospect_heyreach
  BEFORE INSERT OR UPDATE ON public.prospects
  FOR EACH ROW EXECUTE FUNCTION public.protect_prospect_heyreach();

-- ── 3. Conditional save ──
-- Writes prospects.heyreach only if the row is still in a status the caller
-- expects (and, for a stuck push, only if it started before p_pushing_before).
-- One atomic UPDATE, so two requests can't both claim the same person.
-- Server only: not callable with a user's own login.
-- Drop the earlier draft signature if it exists.
DROP FUNCTION IF EXISTS public.save_prospect_heyreach_if(uuid, uuid, text[], boolean, jsonb, timestamptz);

CREATE OR REPLACE FUNCTION public.save_prospect_heyreach_if(
  p_prospect_id uuid,
  p_user_id uuid,
  p_expected text[],
  p_allow_null boolean,
  p_next jsonb,
  p_pushing_before timestamptz DEFAULT NULL,
  p_expected_hash text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  n int;
BEGIN
  UPDATE public.prospects
     SET heyreach = p_next
   WHERE id = p_prospect_id
     AND user_id = p_user_id
     AND (
       (p_allow_null AND (heyreach IS NULL OR heyreach->>'status' IS NULL))
       OR (heyreach->>'status') = ANY (coalesce(p_expected, ARRAY[]::text[]))
     )
     AND (
       p_pushing_before IS NULL
       OR heyreach->>'pushing_at' IS NULL
       OR (heyreach->>'pushing_at')::timestamptz < p_pushing_before
     )
     -- Push claims only the exact text that was approved.
     AND (p_expected_hash IS NULL OR heyreach->>'approved_hash' = p_expected_hash);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.save_prospect_heyreach_if(uuid, uuid, text[], boolean, jsonb, timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_prospect_heyreach_if(uuid, uuid, text[], boolean, jsonb, timestamptz, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_prospect_heyreach_if(uuid, uuid, text[], boolean, jsonb, timestamptz, text) TO service_role;

-- ============================================
-- 13. HEYREACH CAMPAIGN ACCESS (v78)
-- Same as supabase/migrations/010_v78_heyreach_access.sql.
-- ============================================

CREATE TABLE IF NOT EXISTS public.heyreach_campaign_access (
  user_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
  heyreach_campaign_id bigint NOT NULL CHECK (heyreach_campaign_id > 0),
  -- The campaign's name in HeyReach when it was assigned, for the admin list.
  campaign_name text,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, heyreach_campaign_id)
);

CREATE INDEX IF NOT EXISTS idx_heyreach_campaign_access_campaign
  ON public.heyreach_campaign_access(heyreach_campaign_id);

ALTER TABLE public.heyreach_campaign_access ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own HeyReach campaign access" ON public.heyreach_campaign_access;
CREATE POLICY "Users can view own HeyReach campaign access"
  ON public.heyreach_campaign_access FOR SELECT
  USING (auth.uid() = user_id);

REVOKE INSERT, UPDATE, DELETE ON public.heyreach_campaign_access FROM anon, authenticated;

-- ============================================
-- 14. HEYREACH WORKSPACES AND KEYS (v79)
-- Same as supabase/migrations/011_v79_heyreach_workspaces.sql.
-- ============================================

CREATE TABLE IF NOT EXISTS public.heyreach_workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  -- vault.secrets.id holding this workspace's API key
  secret_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  key_updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.heyreach_workspaces ENABLE ROW LEVEL SECURITY;
-- No policies: no access with a user's own login.
REVOKE ALL ON public.heyreach_workspaces FROM anon, authenticated;

ALTER TABLE public.heyreach_campaign_access
  ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES public.heyreach_workspaces(id) ON DELETE CASCADE;

-- Seeing a campaign's pipeline and sending into it are separate. A campaign
-- sends from whichever LinkedIn account is attached to it, so sending is off
-- unless Dan turns it on (existing v78 grants stay view only).
ALTER TABLE public.heyreach_campaign_access
  ADD COLUMN IF NOT EXISTS can_send boolean NOT NULL DEFAULT false;

-- ── Server-only functions. The key goes in and comes out only here. ──

CREATE OR REPLACE FUNCTION public.heyreach_workspace_create(p_name text, p_key text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  v_id uuid := gen_random_uuid();
  v_secret uuid;
BEGIN
  IF p_key IS NULL OR length(trim(p_key)) < 10 THEN
    RAISE EXCEPTION 'That does not look like a HeyReach API key.';
  END IF;
  v_secret := vault.create_secret(trim(p_key), 'heyreach_workspace_' || v_id::text, 'HeyReach API key for ' || trim(p_name));
  INSERT INTO public.heyreach_workspaces (id, name, secret_id) VALUES (v_id, trim(p_name), v_secret);
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.heyreach_workspace_set_key(p_id uuid, p_key text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  v_secret uuid;
BEGIN
  IF p_key IS NULL OR length(trim(p_key)) < 10 THEN
    RAISE EXCEPTION 'That does not look like a HeyReach API key.';
  END IF;
  SELECT secret_id INTO v_secret FROM public.heyreach_workspaces WHERE id = p_id;
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'Workspace not found.';
  END IF;
  PERFORM vault.update_secret(v_secret, trim(p_key));
  UPDATE public.heyreach_workspaces SET key_updated_at = now() WHERE id = p_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.heyreach_workspace_key(p_id uuid)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, vault
AS $$
  SELECT s.decrypted_secret
    FROM public.heyreach_workspaces w
    JOIN vault.decrypted_secrets s ON s.id = w.secret_id
   WHERE w.id = p_id;
$$;

CREATE OR REPLACE FUNCTION public.heyreach_workspace_delete(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  v_secret uuid;
BEGIN
  SELECT secret_id INTO v_secret FROM public.heyreach_workspaces WHERE id = p_id;
  -- Removes the workspace and, by cascade, every campaign assigned from it.
  DELETE FROM public.heyreach_workspaces WHERE id = p_id;
  IF v_secret IS NOT NULL THEN
    DELETE FROM vault.secrets WHERE id = v_secret;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.heyreach_workspace_create(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.heyreach_workspace_set_key(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.heyreach_workspace_key(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.heyreach_workspace_delete(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.heyreach_workspace_create(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.heyreach_workspace_set_key(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.heyreach_workspace_key(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.heyreach_workspace_delete(uuid) TO service_role;
