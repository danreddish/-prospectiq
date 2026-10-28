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
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index idx_campaigns_user on public.campaigns(user_id);

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

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index idx_prospects_campaign on public.prospects(campaign_id);
create index idx_prospects_user on public.prospects(user_id);
create index idx_prospects_status on public.prospects(status);

-- ============================================
-- 4. USAGE EVENTS (for billing metering)
-- ============================================
create table public.usage_events (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid references public.profiles(id) on delete cascade not null,
  event_type text not null check (event_type in ('prospect_researched', 'prospect_refunded', 'prospects_found', 'find_refunded', 'campaign_created', 'export_generated')),
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
