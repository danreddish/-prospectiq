-- ============================================
-- v76.1 Migration: Recruitment watchlist and alerts
--
-- Advisers and firms a user watches for FCA Register changes, and the
-- alerts raised when a change is found. Checked every 15 minutes by the
-- watchlist-check scheduled function.
--
-- Idempotent. Safe to re-run. Run after 007.
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
