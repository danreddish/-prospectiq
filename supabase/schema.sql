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

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1))
  );
  return new;
end;
$$ language plpgsql security definer;

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
  event_type text not null check (event_type in ('prospect_researched', 'campaign_created', 'export_generated')),
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
