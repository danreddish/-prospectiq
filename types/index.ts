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
  created_at: string
  updated_at: string
}

export type PlanTier = 'free' | 'trial' | 'starter' | 'professional' | 'growth'
export type PlanStatus = 'active' | 'trialing' | 'past_due' | 'canceled' | 'unpaid'

export interface ServiceProfile {
  what_you_do: string | null
  who_you_help: string | null
  key_outcomes: string | null
  minimum_threshold: string | null
  geographic_focus: string | null
}

export type AudienceMode = 'match_profile' | 'different_audience'

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
  created_at: string
  updated_at: string
}

export type ProspectStatus = 'pending' | 'processing' | 'completed' | 'failed'

export interface ProspectScores {
  wealth?: number
  timing?: number
  accessibility?: number
  complexity?: number
  [key: string]: number | undefined
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

export const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  free: { prospects_per_cycle: 3, campaigns: 1 },
  trial: { prospects_per_cycle: 5, campaigns: 2 },
  starter: { prospects_per_cycle: 25, campaigns: 2 },
  professional: { prospects_per_cycle: 100, campaigns: 10 },
  growth: { prospects_per_cycle: 300, campaigns: 999 },
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
