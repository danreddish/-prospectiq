import Anthropic from '@anthropic-ai/sdk'
import { ProspectInput, Prospect, OutreachSequence, ProspectScores, ConversationTurn, ReplyCoachResponse } from '@/types'

let _anthropic: Anthropic | null = null

export function getAnthropic(): Anthropic {
  if (!_anthropic) {
    const key = process.env.ANTHROPIC_API_KEY
    if (!key) throw new Error('ANTHROPIC_API_KEY is not set')
    _anthropic = new Anthropic({ apiKey: key })
  }
  return _anthropic
}

interface ServiceProfile {
  what_you_do: string | null
  who_you_help: string | null
  key_outcomes: string | null
  minimum_threshold: string | null
  geographic_focus: string | null
}

// Companies House financial data passed in for HNW prospects.
// Used to apply hard wealth-score caps so the AI cannot inflate scores on
// dormant or micro-entity companies based on sector or director count alone.
export interface ProspectFinancials {
  accountsCategory: string | null
  hasFiledAccounts: boolean
  companyStatus: string | null
  dateOfCreation: string | null
  wealthCeiling: number | null         // null = no cap
  formattedCategory: string             // for the prompt and the UI
}

interface ResearchContext {
  niche: string
  senderName: string
  serviceProfile?: ServiceProfile
  customInstructions?: string | null
  financials?: ProspectFinancials | null
}

interface AIResearchResult {
  research_notes: string
  wealth_estimate: string
  est_age: string
  yrs_at_sr_level: number
  key_trigger: string
  scores: ProspectScores
  total_score: number
  tier: 'A' | 'B' | 'C'
  outreach: OutreachSequence
}

function buildServiceContext(sp?: ServiceProfile): string {
  if (!sp) return ''
  const parts: string[] = []
  if (sp.what_you_do) parts.push(`SERVICE: ${sp.what_you_do}`)
  if (sp.who_you_help) parts.push(`IDEAL CLIENT: ${sp.who_you_help}`)
  if (sp.key_outcomes) parts.push(`OUTCOMES: ${sp.key_outcomes}`)
  if (sp.minimum_threshold) parts.push(`MIN THRESHOLD: ${sp.minimum_threshold}`)
  if (sp.geographic_focus) parts.push(`GEO FOCUS: ${sp.geographic_focus}`)
  if (parts.length === 0) return ''
  return '\n' + parts.join('\n')
}

export async function researchProspect(
  input: ProspectInput,
  context: ResearchContext
): Promise<AIResearchResult> {
  const serviceCtx = buildServiceContext(context.serviceProfile)

  // Financial constraints block (only present for HNW UK prospects with CH data)
  let financialsBlock = ''
  if (context.financials) {
    const fin = context.financials
    financialsBlock = `\n\nVERIFIED COMPANIES HOUSE DATA for ${input.company}:`
    financialsBlock += `\n- Company status: ${fin.companyStatus || 'unknown'}`
    financialsBlock += `\n- Accounts category: ${fin.formattedCategory}`
    if (fin.dateOfCreation) financialsBlock += `\n- Incorporated: ${fin.dateOfCreation}`
    if (!fin.hasFiledAccounts) financialsBlock += `\n- WARNING: company has not filed any accounts yet`

    if (fin.wealthCeiling !== null) {
      financialsBlock += `\n\nHARD WEALTH SCORING CAP: The wealth score for this prospect MUST NOT exceed ${fin.wealthCeiling}/10. This is based on verified Companies House filings. Do not inflate the wealth score above this ceiling regardless of sector, director count, location, or other soft signals. A ${fin.formattedCategory.toLowerCase()} company is by legal definition below certain financial thresholds — overscoring damages user trust. Pick a wealth score from 1 to ${fin.wealthCeiling}.`
    }
  }

  // Custom instructions block (user-supplied per campaign)
  let customBlock = ''
  if (context.customInstructions && context.customInstructions.trim()) {
    customBlock = `\n\nUSER INSTRUCTIONS FOR THIS CAMPAIGN (apply to scoring and outreach personalisation): "${context.customInstructions.trim()}"`
  }

  const response = await getAnthropic().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1200,
    system: `Research prospects for a financial services professional. Return JSON only.
Sender: ${context.senderName} | Niche: ${context.niche}${serviceCtx}${customBlock}${financialsBlock}

SCORING (1-10 each):
- wealth: Infer from role seniority, company type/size, and location. CEO of a family office = 9-10. Mid-level at a large firm = 4-5.${context.financials?.wealthCeiling !== null && context.financials?.wealthCeiling !== undefined ? ` CRITICAL: hard cap is ${context.financials.wealthCeiling}/10 based on verified accounts data above.` : ''}
- timing: How likely they need services NOW. Approaching retirement (50-65) = high. New in role = high. Established and settled = lower.
- accessibility: How easy to reach. Owner-managers and partners = high. C-suite at large corporates = lower.
- complexity: Multiple companies, cross-border, property portfolios = high. Single simple role = low.
TIERS: A=30+, B=22-29, C=below 22.${serviceCtx ? '\nScore HIGHER if prospect matches the IDEAL CLIENT description. Score timing HIGHER if prospect likely needs the stated OUTCOMES.' : ''}

WEALTH ESTIMATE: You MUST estimate uniquely for each prospect based on their specific role, company, and location. Do NOT default to the same range for everyone.${context.serviceProfile?.minimum_threshold ? ` The sender targets clients with ${context.serviceProfile.minimum_threshold} minimum — calibrate relative to that threshold.` : ''}${context.financials?.wealthCeiling !== null && context.financials?.wealthCeiling !== undefined ? ` Verified accounts data caps this prospect at ${context.financials.formattedCategory.toLowerCase()} — adjust the wealth estimate accordingly. A micro-entity director rarely has £5M+ personal wealth from this company alone.` : ''} Ranges: £500K-1M, £1-3M, £3-5M, £5-10M, £10-25M, £25-50M, £50-100M, £100M+. A CIO at a family office is very different from a director at a small consultancy.

AGE ESTIMATE: Infer from career length implied by seniority. Do NOT default to 50-60 for everyone. A VP might be 35-45. A founder with 20+ years could be 55-65.

YEARS AT SENIOR LEVEL: Estimate based on role seniority and typical career progression. Vary this — not everyone has 12 years.

OUTREACH from ${context.senderName} to prospect.${serviceCtx ? ' Reference the sender\'s specific SERVICE and OUTCOMES in step 2 and 3, not generic wealth management language.' : ''} Step1: connection request max 280 chars, no pitch. Step2: welcome msg max 600 chars, pivotal question relevant to their situation. Step3: value+CTA max 800 chars, proof story+15min invite.
British English. No financial advice. No guarantees. Peer tone.`,
    messages: [{
      role: 'user',
      content: `Research this prospect and return a UNIQUE analysis. Do NOT use default/template values.

Name: ${input.name}
Role: ${input.role || 'Director'}
Company: ${input.company || 'Unknown'}
Location: ${input.location || 'Unknown'}

Return this exact JSON structure (fill in ALL values uniquely for this specific person):
{
  "research_notes": "2-3 sentences about THIS person specifically",
  "wealth_estimate": "use the appropriate range for THIS person",
  "est_age": "estimate based on THIS person's likely career stage",
  "yrs_at_sr_level": 0,
  "key_trigger": "one sentence about why they might need services NOW",
  "scores": {"wealth": 0, "timing": 0, "accessibility": 0, "complexity": 0},
  "total_score": 0,
  "tier": "A or B or C",
  "outreach": {
    "step1": {"title": "Connection Request", "timing": "Day 0", "charLimit": 280, "message": "...", "chars": 0, "personalization": "..."},
    "step2": {"title": "Welcome Message", "timing": "24hrs later", "charLimit": 600, "message": "...", "chars": 0, "personalization": "..."},
    "step3": {"title": "Value + Soft CTA", "timing": "5-7 days later", "charLimit": 800, "message": "...", "chars": 0, "personalization": "..."}
  }
}`
    }],
  })

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')

  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('AI response did not contain valid JSON')

  const result = JSON.parse(jsonMatch[0]) as AIResearchResult

  // Enforce hard cap server-side too, in case the model ignored the prompt.
  if (context.financials?.wealthCeiling !== null && context.financials?.wealthCeiling !== undefined) {
    const cap = context.financials.wealthCeiling
    if (result.scores.wealth && result.scores.wealth > cap) {
      console.log(`[Research] Enforcing wealth cap: ${result.scores.wealth} -> ${cap} for ${input.name} (${context.financials.formattedCategory})`)
      result.scores.wealth = cap
    }
  }

  validateResult(result)
  return result
}

export async function researchBatch(
  inputs: ProspectInput[],
  context: ResearchContext,
  onProgress?: (completed: number, total: number) => void
): Promise<AIResearchResult[]> {
  const results: AIResearchResult[] = []
  for (let i = 0; i < inputs.length; i++) {
    try {
      results.push(await researchProspect(inputs[i], context))
    } catch {
      results.push(createFailedResult('Research failed'))
    }
    onProgress?.(i + 1, inputs.length)
  }
  return results
}

function validateResult(result: AIResearchResult): void {
  for (const [key, value] of Object.entries(result.scores)) {
    if (typeof value === 'number') {
      result.scores[key] = Math.max(1, Math.min(10, Math.round(value)))
    }
  }
  const scoreValues = Object.values(result.scores).filter((v): v is number => typeof v === 'number')
  result.total_score = scoreValues.reduce((sum, v) => sum + v, 0)
  if (result.total_score >= 30) result.tier = 'A'
  else if (result.total_score >= 22) result.tier = 'B'
  else result.tier = 'C'
  if (result.outreach.step1) {
    result.outreach.step1.chars = result.outreach.step1.message.length
    if (result.outreach.step1.chars > 280) {
      result.outreach.step1.message = result.outreach.step1.message.slice(0, 277) + '...'
      result.outreach.step1.chars = 280
    }
  }
}

function createFailedResult(errorMessage: string): AIResearchResult {
  return {
    research_notes: `Research failed: ${errorMessage}`,
    wealth_estimate: 'Unknown',
    est_age: 'Unknown',
    yrs_at_sr_level: 0,
    key_trigger: 'Research incomplete',
    scores: { wealth: 0, timing: 0, accessibility: 0, complexity: 0 },
    total_score: 0,
    tier: 'C',
    outreach: {},
  }
}

// ── Reply Coach ─────────────────────────────────

interface ReplyCoachInput {
  prospect: {
    name: string
    role: string | null
    company: string | null
    location: string | null
    wealth_estimate: string | null
    tier: string | null
    total_score: number
    research_notes: string | null
    key_trigger: string | null
    outreach: OutreachSequence
  }
  prospectReply: string
  conversationHistory: ConversationTurn[]
  senderName: string
  serviceProfile?: ServiceProfile
}

export async function generateReplyCoach(input: ReplyCoachInput): Promise<ReplyCoachResponse> {
  const serviceCtx = buildServiceContext(input.serviceProfile)

  // Build conversation thread for context
  const threadLines = input.conversationHistory.map(turn => {
    const label = turn.from === 'user' ? input.senderName : input.prospect.name
    return `[${label}]: ${turn.message}`
  }).join('\n')

  // Determine which outreach steps were sent
  const sentSteps: string[] = []
  if (input.prospect.outreach?.step1?.message) sentSteps.push(`Connection request: "${input.prospect.outreach.step1.message}"`)
  if (input.prospect.outreach?.step2?.message) sentSteps.push(`Welcome message: "${input.prospect.outreach.step2.message}"`)
  if (input.prospect.outreach?.step3?.message) sentSteps.push(`Value + CTA: "${input.prospect.outreach.step3.message}"`)

  const response = await getAnthropic().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1200,
    system: `You are a LinkedIn conversation coach trained on proven social selling methodologies. You help financial services professionals (wealth managers, IFAs, mortgage brokers) navigate LinkedIn conversations with HNW prospects.

Sender: ${input.senderName}${serviceCtx}

PROSPECT PROFILE:
Name: ${input.prospect.name}
Role: ${input.prospect.role || 'Unknown'}
Company: ${input.prospect.company || 'Unknown'}
Location: ${input.prospect.location || 'Unknown'}
Wealth estimate: ${input.prospect.wealth_estimate || 'Unknown'}
Tier: ${input.prospect.tier || 'Unknown'} (Score: ${input.prospect.total_score}/40)
Research: ${input.prospect.research_notes || 'None'}
Key trigger: ${input.prospect.key_trigger || 'None'}

OUTREACH SENT:
${sentSteps.join('\n') || 'None recorded'}

${threadLines ? `CONVERSATION SO FAR:\n${threadLines}` : ''}

TRAINED METHODOLOGY (follow these principles strictly):

1. THE LINK METHOD FRAMEWORK:
The conversation follows 5 stages: Find Prospects > Make First Contact > Engage in Dialogue > Build Relationship > Move Conversation Offline.
Identify which stage this conversation is at based on the thread history. Your replies must advance to the NEXT stage, not skip ahead. If they just accepted a connection, you are at "Engage in Dialogue" not "Move Offline".

2. CONVERSATIONAL RULES (from Predictable Revenue LinkedIn research):
- LinkedIn is a SOCIAL platform. Messages must be personal and conversational, never salesy. No bait and switch.
- CTAs must be temperature checks ("Is this even a priority for you right now?") not hard asks ("Let's book a call").
- Find the first acceptable piece of personalisation from their profile or previous messages that naturally leads into your value proposition.
- TIMING = RELEVANCE = PERSONALISATION. Reference something specific and current about them.

3. ILLUMINATION OVER INTERROGATION (from Josh Braun / LinkedIn Sales Stars):
- Ask illumination questions, not meeting questions. An illumination question speaks about a specific problem the prospect may not be aware of.
- BAD: "What are your top financial goals?" (meeting question, too broad)
- GOOD: "Have you noticed how the new pension allowance changes are catching a lot of business owners off guard?" (illumination question, specific, educates)
- Add value in every message. If you are taking more withdrawals (selling) than deposits (adding value), the relationship will fail.

4. PROGRESS TO MEETING APPROACH (from Predictable Revenue):
- When the prospect shows clear interest, ask for their business email to move the conversation offline. LinkedIn is informal; email is business.
- Template principle: "Sounds great, {name}. Do you mind providing a business email so we can solidify a time, perhaps later this week or early next?"
- Do NOT send placeholder calendar invites. Research shows prospects find this assumptive and intrusive. Let them choose the time.
- Frame the meeting around THEIR benefit: sharing insights, comparing approaches, exploring whether there is a fit. Never frame it as a sales call.

5. NURTURE APPROACH (from LINK Method + Hormozi):
- Share a resource, insight, or observation that is genuinely useful to them. Not your marketing material. Something about their industry, role, or situation.
- Ask whether they know someone well enough for an introduction (warm intro tactic).
- The relationship-building message template: personal connection + relevant resource/stat + why it matters to them specifically.
- Give before you ask. The ratio should be 3 value-adds for every 1 ask.

6. TONE AND STYLE:
- Peer to peer. You are a fellow professional, not a salesperson.
- Short sentences. No walls of text. LinkedIn messages should feel like texts between colleagues.
- British English throughout.
- Never promise returns, performance, or specific outcomes. No financial advice.
- Never be pushy. An angry "no" is better than being ignored, but with HNW prospects, respect and patience win.
- Mirror the prospect's tone. If they are brief, be brief. If they are warm, be warm.
- No emojis unless the prospect uses them first.

7. WHAT TO NEVER DO:
- Never mention tangible results or ROI in early conversation. Research shows this lowers conversion.
- Never pitch in a reply to a simple "thanks for connecting".
- Never use generic phrases like "I help people like you" without specifics.
- Never ask more than one question per message.
- Never send a message longer than 600 characters.

Generate exactly 2 reply options. Analyse the prospect's reply sentiment in 1 sentence.

Return JSON only.`,
    messages: [{
      role: 'user',
      content: `The prospect just replied:
"${input.prospectReply}"

Return this exact JSON structure:
{
  "sentiment": "brief 1-sentence read on their tone and intent",
  "replies": [
    {
      "label": "Progress to Meeting",
      "intent": "progress",
      "message": "your suggested reply under 600 chars",
      "chars": 0,
      "reasoning": "why this approach works for this specific prospect"
    },
    {
      "label": "Nurture",
      "intent": "nurture",
      "message": "your suggested reply under 600 chars",
      "chars": 0,
      "reasoning": "why this approach works for this specific prospect"
    }
  ]
}`
    }],
  })

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')

  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('AI response did not contain valid JSON')

  const result = JSON.parse(jsonMatch[0]) as ReplyCoachResponse

  // Validate and fix char counts
  for (const reply of result.replies) {
    reply.chars = reply.message.length
    if (reply.chars > 600) {
      reply.message = reply.message.slice(0, 597) + '...'
      reply.chars = 600
    }
  }

  return result
}
