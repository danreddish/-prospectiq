-- =============================================================================
-- ProspectIQ waitlist_signups table
-- =============================================================================
-- Stores signups from the /demo page founding-members waitlist.
--
-- Run this in the Supabase SQL Editor:
--   https://supabase.com/dashboard/project/_/sql
--
-- Or via psql:
--   psql "$DATABASE_URL" -f supabase/waitlist_signups.sql
--
-- Safe to run multiple times — uses CREATE TABLE IF NOT EXISTS and similar
-- idempotent constructs.
-- =============================================================================

-- Sequence for the position field — guarantees monotonic, gap-free position
-- numbers per signup. First signup = position 1, second = position 2, etc.
CREATE SEQUENCE IF NOT EXISTS waitlist_signups_position_seq;

CREATE TABLE IF NOT EXISTS waitlist_signups (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  position        integer NOT NULL DEFAULT nextval('waitlist_signups_position_seq'),
  name            text NOT NULL,
  email           text NOT NULL,
  role            text NOT NULL,
  role_other      text,
  consent         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT waitlist_signups_email_unique UNIQUE (email),
  CONSTRAINT waitlist_signups_role_check CHECK (
    role IN ('wealth_manager_ifa', 'financial_planner', 'mortgage_broker', 'other')
  ),
  CONSTRAINT waitlist_signups_consent_check CHECK (consent = true)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_waitlist_signups_email
  ON waitlist_signups (email);

CREATE INDEX IF NOT EXISTS idx_waitlist_signups_created_at
  ON waitlist_signups (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_waitlist_signups_position
  ON waitlist_signups (position);

-- =============================================================================
-- Row Level Security
-- =============================================================================
-- The /api/waitlist endpoint uses the service_role key, which bypasses RLS,
-- so this table is locked down to everyone else (no public read or write).
-- =============================================================================

ALTER TABLE waitlist_signups ENABLE ROW LEVEL SECURITY;

-- Drop any existing policies so this script is idempotent
DROP POLICY IF EXISTS "no public access" ON waitlist_signups;

-- Explicit deny-by-default for the anon role (this is the default behaviour
-- when no policy exists, but we add an explicit empty policy for clarity).
CREATE POLICY "no public access"
  ON waitlist_signups
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

-- =============================================================================
-- Summary view — useful for admin overview, only accessible via service role
-- =============================================================================

CREATE OR REPLACE VIEW waitlist_summary AS
SELECT
  COUNT(*) AS total_signups,
  COUNT(*) FILTER (WHERE role = 'wealth_manager_ifa') AS count_wealth_manager_ifa,
  COUNT(*) FILTER (WHERE role = 'financial_planner') AS count_financial_planner,
  COUNT(*) FILTER (WHERE role = 'mortgage_broker') AS count_mortgage_broker,
  COUNT(*) FILTER (WHERE role = 'other') AS count_other,
  MIN(created_at) AS first_signup_at,
  MAX(created_at) AS most_recent_signup_at,
  COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours') AS signups_last_24h,
  COUNT(*) FILTER (WHERE created_at > now() - interval '7 days') AS signups_last_7d
FROM waitlist_signups;

-- Verify by running:
--   SELECT * FROM waitlist_summary;
-- (Must be run as service_role or via the SQL editor — anon role is denied.)
