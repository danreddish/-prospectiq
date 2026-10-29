export interface Profile {
  id: string
  email: string
  full_name: string | null
  company_name: string | null
  niche: string | null
  sender_name: string | null
  stripe_customer_id: string | null
  plan_tier: PlanTier
  plan_status: PlanStatus
  trial_ends_at: string | null
  prospects_used_this_cycle: number
  cycle_reset_at: string
  service_profile?: ServiceProfile | null
  // Recruitment mode (v76). A separate subscription from plan_tier.
  recruitment_status: RecruitmentStatus
  recruitment_period: RecruitmentPeriod | null
  recruitment_subscription_id: string | null
  recruitment_current_period_end: string | null
  recruitment_advisers_used: number
  recruitment_finds_used: number
  recruitment_usage_reset_at: string | null
  recruitment_profile: RecruitmentProfile | null
  created_at: string
  updated_at: string
}

export type PlanTier = 'free' | 'trial' | 'starter' | 'professional' | 'growth'
export type PlanStatus = 'active' | 'trialing' | 'past_due' | 'canceled' | 'unpaid'

export type RecruitmentStatus = 'inactive' | 'active' | 'past_due' | 'cancelled'
export type RecruitmentPeriod = 'monthly' | 'annual'

export interface ServiceProfile {
  what_you_do: string | null
  who_you_help: string | null
  key_outcomes: string | null
  minimum_threshold: string | null
  geographic_focus: string | null
}

// Recruitment profile: what the hiring firm offers and who it wants.
// Account level in Settings, campaign level override at campaign creation.
export type AdviserType = 'AR' | 'DA' | 'employed' | 'self-employed'

export interface RecruitmentProfile {
  firm_name: string | null
  proposition: string | null
  roles_needed: string[]
  adviser_types: AdviserType[]
  target_locations: string[]
  min_years_approved: number | null
  permissions_required: string[]
  notes: string | null
}

export const ADVISER_TYPES: AdviserType[] = ['AR', 'DA', 'employed', 'self-employed']
export const PERMISSION_OPTIONS = ['mortgages', 'protection', 'investments', 'pensions', 'equity release', 'general insurance']

export type AudienceMode = 'match_profile' | 'different_audience'
export type CampaignPurpose = 'clients' | 'advisers'

export type CampaignSource = 'hnw_clients' | 'financial_professionals' | 'global_prospects'

export interface Campaign {
  id: string
  user_id: string
  name: string
  niche: string | null
  sender_name: string | null
  prospect_count: number
  service_profile: ServiceProfile | null
  custom_instructions: string | null
  audience_mode: AudienceMode | null
  // Data source last used to find prospects. Null on campaigns created
  // before v75.2 added the column.
  source: CampaignSource | null
  purpose: CampaignPurpose
  recruitment_profile: RecruitmentProfile | null
  created_at: string
  updated_at: string
}

export interface Prospect {
  id: string
  campaign_id: string
  user_id: string
  name: string
  role: string | null
  company: string | null
  location: string | null
  linkedin_url: string | null
  email: string | null
  phone: string | null
  headline: string | null
  research_notes: string | null
  wealth_estimate: string | null
  est_age: string | null
  yrs_at_sr_level: number | null
  key_trigger: string | null
  scores: ProspectScores
  total_score: number
  tier: 'A' | 'B' | 'C' | null
  outreach: OutreachSequence
  status: ProspectStatus
  error_message: string | null
  // Companies House financial data (UK HNW source only)
  company_number: string | null
  accounts_category: string | null
  turnover: number | null
  total_assets: number | null
  employee_count: number | null
  accounts_last_filed: string | null
  // Recruitment mode (v76): adviser prospects
  prospect_type: ProspectType
  fca_irn: string | null
  fca_frn: string | null
  fca_firm_name: string | null
  fca_status: string | null
  fca_data: AdviserFcaData | null
  created_at: string
  updated_at: string
}

export type ProspectStatus = 'pending' | 'processing' | 'completed' | 'failed'
export type ProspectType = 'client' | 'adviser'

export interface ProspectScores {
  wealth?: number
  timing?: number
  accessibility?: number
  complexity?: number
  // Adviser dimensions (recruitment mode). Same four slots, same tier logic.
  quality?: number
  move_likelihood?: number
  fit?: number
  [key: string]: number | undefined
}

// UI labels for the four adviser score slots
export const ADVISER_SCORE_LABELS: Record<string, string> = {
  quality: 'Adviser quality',
  move_likelihood: 'Move likelihood',
  accessibility: 'Accessibility',
  fit: 'Fit',
}

// ── FCA Register data stored on adviser prospects ──

export interface FcaFunction {
  name: string
  firm_name: string
  frn: string | null
  effective_from: string | null   // ISO date or null
  end_date: string | null         // ISO date, previous functions only
  customer_facing: boolean
  engagement_method: string | null
  restriction: string | null
}

export interface FcaPreviousFirm {
  name: string
  frn: string | null
  from: string | null
  to: string | null
}

export interface FcaFirmSignals {
  frn: string
  name: string
  status: string
  business_type: string | null
  individual_count: number | null
  ar_count: number | null
  ar_count_is_minimum: boolean
  requirement_count: number
  restriction_count?: number   // requirements excluding routine ones (financial promotion approvals, canvassing)
  requirements: string[]
  permissions: string[]
  town: string | null
  postcode: string | null
  status_effective_date: string | null
  fetched_at: string
}

export interface AdviserFcaData {
  current_functions: FcaFunction[]
  previous_functions: FcaFunction[]
  permissions: string[]
  tenure_months: number | null
  years_approved: number | null
  first_approved: string | null
  previous_firms: FcaPreviousFirm[]
  moves_count: number
  firm_signals: FcaFirmSignals | null
  disciplinary: boolean
  disciplinary_detail: string | null
  workplaces: { firm_name: string; location: string | null }[]
  verified: boolean          // false when a role-led candidate could not be matched on the register
  match_note: string | null  // e.g. "Not on register"
  candidate_source?: 'fca_register' | 'apollo' | null  // where the find step found them
  // AI extras
  summary?: string
  key_signals?: string[]
  talking_points?: string[]
  risk_flags?: string[]
}

export interface OutreachStep {
  title: string
  timing: string
  charLimit: number
  message: string
  chars: number
  personalization: string
}

export interface OutreachSequence {
  step1?: OutreachStep
  step2?: OutreachStep
  step3?: OutreachStep
}

export interface ProspectInput {
  name: string
  role?: string
  company?: string
  location?: string
  linkedin_url?: string
}

// Reply Coach types
export interface ConversationTurn {
  from: 'prospect' | 'user'
  message: string
  timestamp: string
  step?: string // e.g. 'step1', 'step2', 'step3', 'reply'
}

export interface ReplyOption {
  label: string
  intent: 'progress' | 'nurture'
  message: string
  chars: number
  reasoning: string
}

export interface ReplyCoachResponse {
  sentiment: string
  replies: ReplyOption[]
}

export interface PlanLimits {
  prospects_per_cycle: number
  campaigns: number
}

// Recruitment is a separate subscription with its own allowances.
// These never count against the main plan, and vice versa.
// Keep in step with public.get_recruitment_limits() (migration 007).
export interface RecruitmentLimits {
  advisers_per_cycle: number
  campaigns: number
  watchlist_items: number
  // Adviser searches: one per AI brief, one per Apollo-enriched contact.
  // FCA Register lookups are free and not counted.
  finds_per_cycle: number
}

export const PLAN_LIMITS: Record<PlanTier, PlanLimits> & { recruitment: RecruitmentLimits } = {
  free: { prospects_per_cycle: 3, campaigns: 1 },
  trial: { prospects_per_cycle: 5, campaigns: 2 },
  starter: { prospects_per_cycle: 25, campaigns: 2 },
  professional: { prospects_per_cycle: 100, campaigns: 10 },
  growth: { prospects_per_cycle: 300, campaigns: 999 },
  recruitment: { advisers_per_cycle: 100, campaigns: 10, watchlist_items: 200, finds_per_cycle: 400 },
}

export const RECRUITMENT_PLAN = {
  name: 'Recruitment',
  tier: 'recruitment' as const,
  monthlyPrice: 297,
  annualPrice: 2970,
  features: [
    '100 adviser researches a month',
    '10 recruitment campaigns',
    'FCA Register career history and firm signals',
    'Move likelihood scoring',
    'Watchlist of 200 advisers and firms with register change alerts',
    'LINK Method outreach in the voice of the hiring principal',
  ],
}

export interface PlanConfig {
  name: string
  tier: PlanTier
  monthlyPrice: number
  annualPrice: number
  features: string[]
}

export const PLANS: PlanConfig[] = [
  {
    name: 'Starter',
    tier: 'starter',
    monthlyPrice: 97,
    annualPrice: 970,
    features: [
      '25 prospects/month',
      '2 active campaigns',
      '3-step LINK Method™ sequences',
      'PDF export',
      'Email support',
    ],
  },
  {
    name: 'Professional',
    tier: 'professional',
    monthlyPrice: 197,
    annualPrice: 1970,
    features: [
      '100 prospects/month',
      '10 active campaigns',
      '3-step + custom templates',
      'PDF + CSV + shareable link',
      'Email + monthly group call',
    ],
  },
  {
    name: 'Growth',
    tier: 'growth',
    monthlyPrice: 397,
    annualPrice: 3970,
    features: [
      '300 prospects/month',
      'Unlimited campaigns',
      '3-step + custom + A/B variants',
      'All formats + API access',
      'Priority + quarterly strategy call',
    ],
  },
]
