-- ============================================
-- v75 Migration: Custom instructions, audience mode,
-- Companies House financials, service profile columns
--
-- Idempotent — safe to re-run.
-- Run in Supabase SQL Editor before deploying v75.
-- ============================================

-- ── Profiles: service profile (account-level defaults) ──
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS service_profile jsonb DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.profiles.service_profile IS
  'Account-level service offering: {what_you_do, who_you_help, key_outcomes, minimum_threshold, geographic_focus}';

-- ── Campaigns: service profile, audience mode, custom instructions ──
ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS service_profile jsonb DEFAULT '{}'::jsonb;

ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS custom_instructions text;

ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS audience_mode text
    CHECK (audience_mode IN ('match_profile', 'different_audience'));

COMMENT ON COLUMN public.campaigns.service_profile IS
  'Per-campaign override of account service profile.';
COMMENT ON COLUMN public.campaigns.custom_instructions IS
  'Plain English instructions for this batch (e.g. "exclude London", "focus on second-time founders").';
COMMENT ON COLUMN public.campaigns.audience_mode IS
  'match_profile = use service profile as positive ICP signal. different_audience = ignore service profile for search.';

-- ── Prospects: Apollo enrichment columns + CH financials ──
ALTER TABLE public.prospects
  ADD COLUMN IF NOT EXISTS email text;

ALTER TABLE public.prospects
  ADD COLUMN IF NOT EXISTS phone text;

ALTER TABLE public.prospects
  ADD COLUMN IF NOT EXISTS headline text;

-- Companies House: company number lets us look up accounts later
ALTER TABLE public.prospects
  ADD COLUMN IF NOT EXISTS company_number text;

-- CH financials (only populated for hnw_clients source)
ALTER TABLE public.prospects
  ADD COLUMN IF NOT EXISTS accounts_category text;

ALTER TABLE public.prospects
  ADD COLUMN IF NOT EXISTS turnover bigint;

ALTER TABLE public.prospects
  ADD COLUMN IF NOT EXISTS total_assets bigint;

ALTER TABLE public.prospects
  ADD COLUMN IF NOT EXISTS employee_count int;

ALTER TABLE public.prospects
  ADD COLUMN IF NOT EXISTS accounts_last_filed date;

COMMENT ON COLUMN public.prospects.accounts_category IS
  'CH accounts type: full, group, medium, small, micro-entity, dormant, abridged, unaudited-abridged, no-accounts.';
COMMENT ON COLUMN public.prospects.turnover IS 'GBP. Only available on medium/full accounts.';
COMMENT ON COLUMN public.prospects.total_assets IS 'GBP. Total assets from latest filed balance sheet.';
