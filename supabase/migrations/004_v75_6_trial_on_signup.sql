-- ============================================
-- v75.6 Migration: start new accounts on the 7-day trial
--
-- Why: the signup page promises "7-day free trial, 5 prospect
-- researches", but the signup trigger left every new account on the
-- free plan with no trial date. The admin panel showed them as free,
-- and the sidebar showed a 3-prospect allowance.
--
-- What changes: new signups (email or Google) get plan_tier 'trial'
-- and trial_ends_at 7 days out. plan_status stays 'active', because
-- 'trialing' is reserved for Stripe subscription trials.
--
-- What does NOT change: existing accounts keep their current plan.
-- Note that plan limits are not enforced server-side yet (planned for
-- v75.7), so this affects labels and the admin view, not access.
--
-- Idempotent. Safe to re-run. Can be run before or after deploying v75.6.
-- ============================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, plan_tier, plan_status, trial_ends_at)
  VALUES (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    'trial',
    'active',
    now() + interval '7 days'
  );
  RETURN new;
END;
$$;

-- The on_auth_user_created trigger already points at this function,
-- so replacing the function body is enough. No trigger change needed.
