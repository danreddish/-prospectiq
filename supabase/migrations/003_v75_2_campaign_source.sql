-- ============================================
-- v75.2 Migration: store the data source used on each campaign
--
-- Why: campaigns did not record which data source found their
-- prospects, so off-target results (for example "tech founders"
-- run against Companies House) were hard to diagnose.
--
-- Idempotent. Safe to re-run.
-- Run in Supabase SQL Editor before deploying v75.2.
-- ============================================

ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS source text
  CHECK (source IN ('hnw_clients','financial_professionals','global_prospects'));

COMMENT ON COLUMN public.campaigns.source IS
  'Data source last used to find prospects for this campaign: hnw_clients (Companies House), financial_professionals (FCA Register), global_prospects (Apollo).';

-- Backfill: campaigns holding prospects with a Companies House company
-- number were found via the UK HNW Clients source.
UPDATE public.campaigns c SET source = 'hnw_clients'
  WHERE source IS NULL AND EXISTS (
    SELECT 1 FROM public.prospects p
    WHERE p.campaign_id = c.id AND p.company_number IS NOT NULL);
