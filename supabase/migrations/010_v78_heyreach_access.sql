-- ============================================
-- v78 Migration: who can see which HeyReach campaign
--
-- Dan runs HeyReach for clients in his own workspace (one HeyReach key, in
-- Netlify). Each user sees the LinkedIn pipeline only for the HeyReach
-- campaigns Dan assigns to them on /dashboard/heyreach.
--
-- Users can read their own rows. There are no insert, update or delete
-- policies: only ProspectIQ's server (service role) writes, from the
-- admin-only /api/heyreach/access route.
--
-- Idempotent. Run BEFORE merging v78.
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
