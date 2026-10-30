-- ============================================
-- v77 Migration: LinkedIn exclusions and HeyReach test
--
-- 1. linkedin_exclusions: LinkedIn profiles a user must not contact again.
--    Sources: 'ulinc' (their Ulinc contact export) and 'heyreach' (people
--    ProspectIQ has already pushed into HeyReach). Stored as the lower-case
--    profile name from /in/<name>. Find skips them, and the HeyReach routes
--    refuse them.
-- 2. prospects.heyreach: the HeyReach sequence for one prospect: msg_1 to
--    msg_4, first and last name, review status, and what HeyReach returned.
--    Only ProspectIQ's server can change it (trigger below), so an approval
--    can't be faked from the browser.
--
-- Idempotent. Run after 008, BEFORE merging v77.
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
