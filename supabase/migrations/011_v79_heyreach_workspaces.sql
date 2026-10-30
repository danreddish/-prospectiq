-- ============================================
-- v79 Migration: HeyReach workspaces and their API keys
--
-- HeyReach API keys belong to one workspace. Dan runs a workspace per
-- client (for example "Rob Saunderson"), so ProspectIQ needs a key for each.
-- The main workspace keeps using HEYREACH_API_KEY in Netlify; every other
-- workspace is a row here, its key stored encrypted in Supabase Vault.
--
-- Nobody reads this table or the keys with their own login. Only ProspectIQ's
-- server (service role) can, through the functions below.
--
-- heyreach_campaign_access.workspace_id says which workspace an assigned
-- campaign lives in (NULL = the main workspace); can_send says whether the
-- user may send into it, or only see its pipeline.
--
-- Idempotent. Run BEFORE merging v79.
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
