import { getAnthropic } from '@/lib/ai-engine'
import { OutreachSequence, ProspectScores, RecruitmentProfile, AdviserFcaData } from '@/types'
import { recruitmentProfileIsEmpty } from './access'

// ── Inputs ─────────────────────────────────────

export interface AdviserInput {
  name: string
  firm: string | null
  firm_from_linkedin: boolean   // false when the firm name only came from the register
  role: string | null           // LinkedIn title only. Register functions go in fca.
  location_from_linkedin: boolean
  location: string | null
  linkedin_url: string | null
  headline: string | null
  has_email: boolean
  has_phone: boolean
  fca_status: string | null
  fca: AdviserFcaData | null
}

export interface AdviserResearchContext {
  principalName: string        // the hiring principal who signs the outreach
  recruitmentProfile: RecruitmentProfile
  customInstructions?: string | null
  timeoutMs?: number           // hard deadline for the Claude call (Netlify 10s limit)
}

export interface AdviserResearchResult {
  summary: string
  research_notes: string
  key_signals: string[]
  talking_points: string[]
  risk_flags: string[]
  scores: ProspectScores
  total_score: number
  tier: 'A' | 'B' | 'C'
  outreach: OutreachSequence
}

// ── Prompt building ────────────────────────────

function buildRecruitmentContext(p: RecruitmentProfile): string {
  if (recruitmentProfileIsEmpty(p)) return ''
  const parts: string[] = []
  if (p.firm_name) parts.push(`HIRING FIRM: ${p.firm_name}`)
  if (p.proposition) parts.push(`PROPOSITION TO ADVISERS: ${p.proposition}`)
  if (p.roles_needed.length) parts.push(`ROLES NEEDED: ${p.roles_needed.join(', ')}`)
  if (p.adviser_types.length) parts.push(`ADVISER TYPES WANTED: ${p.adviser_types.join(', ')}`)
  if (p.target_locations.length) parts.push(`TARGET LOCATIONS: ${p.target_locations.join(', ')}`)
  if (p.min_years_approved) parts.push(`MINIMUM YEARS APPROVED: ${p.min_years_approved}`)
  if (p.permissions_required.length) parts.push(`PERMISSIONS REQUIRED: ${p.permissions_required.join(', ')}`)
  if (p.notes) parts.push(`NOTES: ${p.notes}`)
  return '\n\nRECRUITMENT PROFILE (the hiring firm and who it wants):\n' + parts.join('\n')
}

function tenureBand(months: number | null): string {
  if (months === null) return 'unknown'
  const years = months / 12
  if (months < 12) return `${months} months (under twelve months, low move likelihood)`
  if (years >= 2 && years <= 7) return `${years.toFixed(1)} years (two to seven years, scores highest)`
  if (years >= 10) return `${years.toFixed(1)} years (ten years plus, low unless the firm shows strain)`
  return `${years.toFixed(1)} years`
}

function describeRegisterData(fca: AdviserFcaData | null, individualStatus: string | null): string {
  if (!fca) return 'REGISTER DATA: none available.'
  if (!fca.verified) return `REGISTER DATA: ${fca.match_note || 'Not on register'}. Score quality and move likelihood from the LinkedIn data only and flag the missing register match as a risk.`

  const lines: string[] = []
  const cf = fca.current_functions.filter((f) => f.customer_facing)
  lines.push(`- Individual status on register: ${individualStatus || 'unknown'}`)
  lines.push(`- Current customer-facing functions: ${cf.length ? cf.map((f) => `${f.name} at ${f.firm_name}${f.effective_from ? ` since ${f.effective_from}` : ''}`).join('; ') : 'none found'}`)
  const other = fca.current_functions.filter((f) => !f.customer_facing)
  if (other.length) lines.push(`- Other current functions: ${other.map((f) => `${f.name} at ${f.firm_name}`).join('; ')}`)
  lines.push(`- Tenure at current firm: ${tenureBand(fca.tenure_months)}`)
  lines.push(`- Years approved: ${fca.years_approved ?? 'unknown'}${fca.first_approved ? ` (first approved ${fca.first_approved})` : ''}`)
  lines.push(`- Previous firms (${fca.moves_count} move${fca.moves_count === 1 ? '' : 's'}): ${fca.previous_firms.length ? fca.previous_firms.map((p) => `${p.name}${p.from || p.to ? ` (${p.from || '?'} to ${p.to || '?'})` : ''}`).join('; ') : 'none on register'}`)
  if (fca.workplaces.length) lines.push(`- Workplace on register (use for location fit scoring only): ${fca.workplaces.map((w) => `${w.firm_name}${w.location ? `, ${w.location}` : ''}`).join('; ')}`)
  if (fca.permissions.length) lines.push(`- Current firm permissions: ${fca.permissions.slice(0, 12).join('; ')}`)
  const fs = fca.firm_signals
  if (fs) {
    lines.push(`- Current firm: ${fs.name} (FRN ${fs.frn}), status ${fs.status}${fs.business_type ? `, ${fs.business_type}` : ''}${fs.town ? `, ${fs.town}` : ''}`)
    const restrictions = fs.restriction_count ?? fs.requirement_count
    lines.push(`- Firm headcount on register: ${fs.individual_count ?? 'unknown'}; appointed representatives: ${fs.ar_count ?? 'unknown'}${fs.ar_count_is_minimum ? '+' : ''}; restrictive requirements on the firm: ${restrictions} (standard requirements such as financial promotion approvals are excluded and are not a strain signal)`)
    if (restrictions > 0 && fs.requirements.length) lines.push(`- Requirement detail: ${fs.requirements.slice(0, 3).join(' | ')}`)
    const strained = restrictions > 0 || (fs.status && fs.status.toLowerCase() !== 'authorised' && !fs.status.toLowerCase().startsWith('appointed representative'))
    if (strained) lines.push(`- FIRM STRAIN SIGNAL: yes (raises move likelihood)`)
  }
  lines.push(`- Disciplinary history on register: ${fca.disciplinary ? 'YES, must be a risk flag' : 'none found'}`)
  return 'REGISTER DATA (for scoring and risk flags only. Never referenced in outreach):\n' + lines.join('\n')
}

// Outreach must never read as surveillance. Catch the obvious leaks.
const OUTREACH_LEAK_PATTERNS: RegExp[] = [
  /\bfca\b/i,
  /\bregister\b/i,
  /\bapproved (?:since|in|for)\b/i,
  /\b(?:tenure|years at|since 20\d\d at|joined .{0,30} in 20\d\d)\b/i,
  /\b(?:moved from|left .{0,40} (?:in|for)|your (?:previous|last|old) firm|when you were at)\b/i,
  /\b(?:headcount|losing advisers|advisers leaving|restrictions? on|under (?:a )?requirement)\b/i,
  /\b(?:disciplinary|enforcement)\b/i,
  /\b(?:early (?:in|days)|new (?:in|to) (?:your|the) (?:role|position|firm)|recently (?:joined|moved|started)|settled (?:in|into)|several years|many years|\d+ years)\b/i,
  /\b(?:approved adviser|approval|permissions?|regulat\w*|compliance)\b/i,
  /\b(?:no|without|free (?:of|from)) (?:ar|network|the network|appointed representative)\b/i,
  /\bnetworks?\b/i,
]

export function outreachLeaksRegisterData(outreach: OutreachSequence, linkedInText: string = ''): boolean {
  const text = [outreach.step1?.message, outreach.step2?.message, outreach.step3?.message].filter(Boolean).join('\n')
  if (OUTREACH_LEAK_PATTERNS.some((re) => re.test(text))) return true
  // "Director" is a register function unless LinkedIn says so too
  if (/\bdirector\b/i.test(text) && !/\bdirector\b/i.test(linkedInText)) return true
  return false
}

// ── Research ───────────────────────────────────

export async function researchAdviser(
  input: AdviserInput,
  context: AdviserResearchContext
): Promise<AdviserResearchResult> {
  const recruitmentCtx = buildRecruitmentContext(context.recruitmentProfile)
  const customBlock = context.customInstructions && context.customInstructions.trim()
    ? `\n\nHIRING PRINCIPAL'S INSTRUCTIONS FOR THIS CAMPAIGN (apply to scoring and outreach): "${context.customInstructions.trim()}"`
    : ''
  const registerBlock = describeRegisterData(input.fca, input.fca_status)
  const hasFigures = !!(context.recruitmentProfile.proposition && /\d/.test(context.recruitmentProfile.proposition))

  const linkedinLines: string[] = []
  linkedinLines.push(`- LinkedIn profile: ${input.linkedin_url && input.linkedin_url.includes('/in/') ? 'found' : 'not found (search link only)'}`)
  linkedinLines.push(`- LinkedIn job title: ${input.role || 'not known'}`)
  linkedinLines.push(`- Headline: ${input.headline || 'none'}`)
  linkedinLines.push(`- Email found: ${input.has_email ? 'yes' : 'no'}; phone found: ${input.has_phone ? 'yes' : 'no'}`)
  linkedinLines.push(`- Location on LinkedIn: ${input.location_from_linkedin && input.location ? input.location : 'not known, do not mention where they are based'}`)
  linkedinLines.push(`- Current firm on LinkedIn: ${input.firm_from_linkedin && input.firm ? input.firm : 'not known, do not name their firm in outreach'}`)

  const timeout = Math.max(2000, context.timeoutMs ?? 8500)
  const response = await getAnthropic().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1200,
    system: `You research FCA-regulated advisers as recruitment prospects for a firm principal or network business development manager who wants to hire them. Return JSON only.
Hiring principal (signs the outreach): ${context.principalName}${recruitmentCtx}${customBlock}

SCORING (1 to 10 each, whole numbers, unique to this adviser):
- quality: years approved, whether a customer-facing function is held, seniority and stability signals (director functions, long approval history), LinkedIn headline. A long approval history with a customer function and a senior title scores high. Under two years approved or no customer function scores low.
- move_likelihood: tenure at the current firm (two to seven years scores highest, under twelve months low, ten years plus low unless the firm shows strain). One to three previous moves raises it. Firm signals raise it: appointed representative count or headcount falling, requirements or restrictions on the firm, firm status other than authorised. Nothing known scores 5.
- accessibility: LinkedIn URL found, email found, phone found, headline present, and distance from the hiring firm's target locations. All four contact signals and a matching location scores 9 to 10. Nothing but a name scores 2 to 3.
- fit: match against the recruitment profile on roles, permissions, locations and adviser type. No recruitment profile scores 5.
TIERS: A=30+, B=22-29, C=below 22.

TALKING POINTS are for the principal to use in conversation, so they follow the same rules as outreach: only what is visible on LinkedIn and the firm's proposition, never register data. KEY SIGNALS are internal notes for the principal and may use register data.

RISK FLAGS: any disciplinary history on the register is always a risk flag. Also flag: no customer-facing function, not on the register, under twelve months at the current firm, a firm with restrictions.

OUTREACH from ${context.principalName} to the adviser, peer to peer, principal to adviser. LINK Method, three steps. Step1: connection request, max 280 characters, no pitch. Step2: welcome message, max 600 characters (aim for about 400), one open question about how their current setup is working for them. Step3: value and soft CTA, max 800 characters (aim for about 550), the firm's proposition and a 15 minute conversation.
Lead with what is visible on LinkedIn (headline, role, location) and with the hiring firm's proposition from the recruitment profile.
HARD RULES for outreach, non-negotiable:
- Never mention or hint at anything from the REGISTER DATA: the FCA or the register, approval, permissions, regulation, compliance, how long they have been anywhere (never "new", "early in", "settled", "several years"), dates, move history, previous firms, firm headcount, appointed representative numbers, requirements or restrictions. If forwarded to a compliance officer, the message must read as an ordinary peer approach.
- Never disparage or compare against the adviser's current firm, network, or the appointed representative model.
- Only name the adviser's current firm if it is given as "Current firm on LinkedIn". Only mention where they are based if it is given as "Location on LinkedIn".
- Never refer to networks, appointed representatives or how their current firm is structured.
- Register functions (director, CF1, SMF, adviser functions) are register data. Describe the adviser only with the LinkedIn job title and headline, or generically as a mortgage or financial adviser.
- Do not describe ${context.principalName}'s own role or what they do, and invent nothing about them. They are simply at the hiring firm. Sign off with the first name only.
- ${hasFigures ? 'Payout, salary or performance figures may only be quoted exactly as written in the PROPOSITION above.' : 'No payout, salary or performance figures of any kind.'}
- No invented claims about the hiring firm. Only use what the recruitment profile says.
British English. Short sentences. No em dashes, use commas or full stops. No emojis. Never use the double quote character inside any string value.`,
    messages: [{
      role: 'user',
      content: `Research this adviser and return a UNIQUE analysis. Do not use default or template values.

Name: ${input.name}
LINKEDIN AND CONTACT DATA (the only facts about the adviser usable in outreach):
${linkedinLines.join('\n')}

${registerBlock}

Return only this JSON, every value filled in for this specific adviser. Be brief:
- summary: two short sentences.
- key_signals and talking_points: two items each, under 12 words each.
- risk_flags: zero to three items, under 12 words each.
- hook: the personalisation angle for that step, under 10 words.
{"summary":"","key_signals":[],"talking_points":[],"risk_flags":[],"scores":{"quality":0,"move_likelihood":0,"accessibility":0,"fit":0},"step1":{"message":"","hook":""},"step2":{"message":"","hook":""},"step3":{"message":"","hook":""}}`,
    }],
  }, { timeout, maxRetries: 0 })

  console.log(`[Adviser AI] ${input.name}: ${response.usage.input_tokens} in, ${response.usage.output_tokens} out, stop ${response.stop_reason}`)

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')

  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    throw new Error(response.stop_reason === 'max_tokens' ? 'AI response was cut off. Try again.' : 'AI response did not contain valid JSON')
  }

  let result: AdviserResearchResult
  try {
    const raw = JSON.parse(jsonMatch[0]) as Record<string, unknown>
    result = fromModelOutput(raw)
  } catch {
    console.error(`[Adviser AI] JSON parse failed (stop_reason ${response.stop_reason}):`, text.slice(-300))
    throw new Error(response.stop_reason === 'max_tokens' ? 'AI response was cut off. Try again.' : 'AI response was not valid JSON')
  }
  validateAdviserResult(result, input)
  return result
}

const SCORE_KEYS = ['quality', 'move_likelihood', 'accessibility', 'fit'] as const

// The model returns only the message and hook for each step. Titles,
// timings and limits match the client flow and are filled in here.
const STEP_META: Record<'step1' | 'step2' | 'step3', { title: string; timing: string; charLimit: number }> = {
  step1: { title: 'Connection Request', timing: 'Day 0', charLimit: 280 },
  step2: { title: 'Welcome Message', timing: '24hrs later', charLimit: 600 },
  step3: { title: 'Value + Soft CTA', timing: '5-7 days later', charLimit: 800 },
}

function fromModelOutput(raw: Record<string, unknown>): AdviserResearchResult {
  const outreach: OutreachSequence = {}
  const rawOutreach = (raw.outreach && typeof raw.outreach === 'object' ? raw.outreach : raw) as Record<string, unknown>
  for (const key of ['step1', 'step2', 'step3'] as const) {
    const step = rawOutreach[key] as Record<string, unknown> | undefined
    const message = typeof step?.message === 'string' ? step.message : ''
    if (!message) continue
    const hook = typeof step?.hook === 'string' ? step.hook : typeof step?.personalization === 'string' ? step.personalization : ''
    outreach[key] = { ...STEP_META[key], message, chars: message.length, personalization: hook }
  }
  return {
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    research_notes: '',
    key_signals: Array.isArray(raw.key_signals) ? (raw.key_signals as string[]) : [],
    talking_points: Array.isArray(raw.talking_points) ? (raw.talking_points as string[]) : [],
    risk_flags: Array.isArray(raw.risk_flags) ? (raw.risk_flags as string[]) : [],
    scores: (raw.scores || {}) as ProspectScores,
    total_score: 0,
    tier: 'C',
    outreach,
  }
}

function validateAdviserResult(result: AdviserResearchResult, input: AdviserInput): void {
  const scores: ProspectScores = {}
  for (const key of SCORE_KEYS) {
    const raw = result.scores?.[key]
    const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : 5
    scores[key] = Math.max(1, Math.min(10, Math.round(n)))
  }
  result.scores = scores
  result.total_score = SCORE_KEYS.reduce((sum, k) => sum + (scores[k] || 0), 0)
  if (result.total_score >= 30) result.tier = 'A'
  else if (result.total_score >= 22) result.tier = 'B'
  else result.tier = 'C'

  result.summary = typeof result.summary === 'string' ? result.summary : ''
  result.research_notes = typeof result.research_notes === 'string' && result.research_notes ? result.research_notes : result.summary
  result.key_signals = Array.isArray(result.key_signals) ? result.key_signals.filter((s) => typeof s === 'string' && s.trim()) : []
  result.talking_points = Array.isArray(result.talking_points) ? result.talking_points.filter((s) => typeof s === 'string' && s.trim()) : []
  result.risk_flags = Array.isArray(result.risk_flags) ? result.risk_flags.filter((s) => typeof s === 'string' && s.trim()) : []

  // Disciplinary history is always a risk flag, whatever the model did.
  if (input.fca?.disciplinary && !result.risk_flags.some((f) => /disciplinary/i.test(f))) {
    result.risk_flags.unshift('Disciplinary history on the FCA Register. Check before any approach.')
  }
  if (input.fca && !input.fca.verified && !result.risk_flags.some((f) => /register/i.test(f))) {
    result.risk_flags.push('Not matched on the FCA Register. Verify approval status before proceeding.')
  }

  result.outreach = result.outreach || {}
  const limits: [keyof OutreachSequence, number][] = [['step1', STEP_META.step1.charLimit], ['step2', STEP_META.step2.charLimit], ['step3', STEP_META.step3.charLimit]]
  for (const [key, limit] of limits) {
    const step = result.outreach[key]
    if (!step || typeof step.message !== 'string') continue
    // No em or en dashes in user-facing copy
    step.message = step.message
      .replace(/\s*[\u2014\u2013]\s*/g, ', ')
      .replace(/ - /g, ', ')
      .replace(/,(?=[A-Za-z])/g, ', ')
    step.charLimit = limit
    step.chars = step.message.length
    if (step.chars > limit) {
      step.message = step.message.slice(0, limit - 3) + '...'
      step.chars = limit
    }
  }

  if (outreachLeaksRegisterData(result.outreach, `${input.role || ''} ${input.headline || ''}`)) {
    result.risk_flags.push('Outreach mentions register data. Edit before sending.')
  }
}

export function createFailedAdviserResult(errorMessage: string): AdviserResearchResult {
  return {
    summary: `Research failed: ${errorMessage}`,
    research_notes: `Research failed: ${errorMessage}`,
    key_signals: [],
    talking_points: [],
    risk_flags: [],
    scores: { quality: 0, move_likelihood: 0, accessibility: 0, fit: 0 },
    total_score: 0,
    tier: 'C',
    outreach: {},
  }
}
