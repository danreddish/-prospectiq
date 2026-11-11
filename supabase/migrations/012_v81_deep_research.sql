-- v81: deep research. One JSON column on prospects holding the background
-- research job's state, the evidence it gathered (Companies House, FCA
-- Register, LinkedIn profile via Apollo, the firm's website) and the
-- decision-maker check. Null for prospects researched before v81.
alter table public.prospects add column if not exists deep_research jsonb;
