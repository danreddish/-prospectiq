-- ============================================
-- Reply Coach Migration
-- Run this in Supabase SQL Editor
-- Adds conversations column to prospects table
-- ============================================

-- Add conversations column (stores Reply Coach conversation history)
ALTER TABLE public.prospects 
ADD COLUMN IF NOT EXISTS conversations jsonb DEFAULT '[]';

-- Add comment for documentation
COMMENT ON COLUMN public.prospects.conversations IS 'Reply Coach conversation history. Array of {from, message, timestamp, step} objects.';
