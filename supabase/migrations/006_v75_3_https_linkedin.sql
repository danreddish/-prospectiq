-- ============================================
-- v75.3 Migration: force https on stored LinkedIn URLs
--
-- Why: Apollo returned some profile URLs as http, which left prospects with
-- links that browsers and some corporate proxies handle differently from the
-- https original.
--
-- Idempotent. Safe to re-run: rows already on https are not matched.
-- Can run before or after deploying v75.3.
-- ============================================

UPDATE public.prospects
  SET linkedin_url = 'https://' || substring(linkedin_url from 8)
  WHERE linkedin_url LIKE 'http://%';
