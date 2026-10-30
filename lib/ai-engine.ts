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

// v76.2: research used to be one Claude call that scored the prospect AND
// wrote the outreach. That call ran past 7.5 seconds on every prospect, so
// the 9 second research deadline fired before it finished. It is now two
// calls, each in its own request: researchProspectScores() in
// /api/prospects/research, then writeOutreachSequence() in
// /api/prospects/outreach. Each logs how long it took and how many tokens it
// produced.

export interface ClaudeCallOptions {
  /** Abort the Claude call after this long, so it ends before the route deadline. */
  timeoutMs?: number
}

export type ProspectResearch = Omit<AIResearchResult, 'outreach'>

function claudeRequestOptions(opts: ClaudeCallOptions) {
  // No automatic retries: a retry can't fit inside the deadline, and a silent
  // retry hides the real error from the logs.
  return { maxRetries: 0, ...(opts.timeoutMs ? { timeout: Math.max(opts.timeoutMs, 1000) } : {}) }
}

function logClaudeCall(label: string, startedAt: number, response: Anthropic.Message) {
  console.log(
    `[Research] Claude ${label}: ${Date.now() - startedAt}ms, ${response.usage.input_tokens} tokens in, ${response.usage.output_tokens} out, stop: ${response.stop_reason}`
  )
}

function logClaudeError(label: string, startedAt: number, err: unknown) {
  const message = err instanceof Error ? err.message : String(err)
  console.error(`[Research] Claude ${label} failed after ${Date.now() - startedAt}ms: ${message}`)
}

function responseText(response: Anthropic.Message): string {
  return response.content
    .filter((b) => b.type === 'text')
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
}

function parseJsonObject<T>(text: string, label: string): T {
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error(`AI ${label} response did not contain valid JSON`)
  return JSON.parse(jsonMatch[0]) as T
}

/** Step 1 of research: notes, estimates and the four scores. No outreach. */
export async function researchProspectScores(
  input: ProspectInput,
  context: ResearchContext,
  opts: ClaudeCallOptions = {}
): Promise<ProspectResearch> {
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

  const startedAt = Date.now()
  let response: Anthropic.Message
  try {
    response = await getAnthropic().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
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
  "scores": {"wealth": 0, "timing": 0, "accessibility": 0, "complexity": 0}
}`
      }],
    }, claudeRequestOptions(opts))
  } catch (err) {
    logClaudeError('research', startedAt, err)
    throw err
  }
  logClaudeCall('research', startedAt, response)

  const result = parseJsonObject<ProspectResearch>(responseText(response), 'research')
  if (!result.scores) result.scores = {}

  // Enforce hard cap server-side too, in case the model ignored the prompt.
  if (context.financials?.wealthCeiling !== null && context.financials?.wealthCeiling !== undefined) {
    const cap = context.financials.wealthCeiling
    if (result.scores.wealth && result.scores.wealth > cap) {
      console.log(`[Research] Enforcing wealth cap: ${result.scores.wealth} -> ${cap} for ${input.name} (${context.financials.formattedCategory})`)
      result.scores.wealth = cap
    }
  }

  validateScores(result)
  return result
}

/** What the outreach call knows from step 1. */
export interface OutreachResearchContext {
  research_notes?: string | null
  key_trigger?: string | null
}

const OUTREACH_STEPS = [
  { key: 'step1', title: 'Connection Request', timing: 'Day 0', charLimit: 280 },
  { key: 'step2', title: 'Welcome Message', timing: '24hrs later', charLimit: 600 },
  { key: 'step3', title: 'Value + Soft Door', timing: '5-7 days later', charLimit: 800 },
] as const

/** Step 2 of research: the LINK Method sequence (v75.4 rules, unchanged). */
export async function writeOutreachSequence(
  input: ProspectInput,
  research: OutreachResearchContext | null,
  context: Omit<ResearchContext, 'financials'>,
  opts: ClaudeCallOptions = {}
): Promise<OutreachSequence> {
  const serviceCtx = buildServiceContext(context.serviceProfile)
  let customBlock = ''
  if (context.customInstructions && context.customInstructions.trim()) {
    customBlock = `\n\nUSER INSTRUCTIONS FOR THIS CAMPAIGN (apply to scoring and outreach personalisation): "${context.customInstructions.trim()}"`
  }

  const known: string[] = []
  if (research?.research_notes) known.push(`What we know: ${research.research_notes}`)
  if (research?.key_trigger) known.push(`Why now: ${research.key_trigger}`)

  const startedAt = Date.now()
  let response: Anthropic.Message
  try {
    response = await getAnthropic().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 900,
      system: `Write LinkedIn outreach for a financial services professional. Return JSON only.
Sender: ${context.senderName} | Niche: ${context.niche}${serviceCtx}${customBlock}

OUTREACH from ${context.senderName} to prospect. Write a LINK Method sequence that EARNS a conversation. It does not chase a call. These are senior, wealthy, heavily-pitched people: a stranger asking for 15 minutes reads as a sales script and gets ignored. The sequence must feel like a credible peer reaching out, not a funnel.${serviceCtx ? ' Reference the sender\'s specific SERVICE and OUTCOMES in step 2 and 3, not generic wealth management language.' : ''}
Step1 (Connection Request, max 280 chars): NO pitch, NO ask, NO mention of a call or meeting. One genuine, specific reason for connecting tied to something real about them or their company. The only goal is that they accept.
Step2 (Welcome Message, max 600 chars): thank them for connecting. Stay curious and human. Ask ONE thoughtful question relevant to their situation. NO pitch and NO call ask here either.
Step3 (Value + Soft Door, max 800 chars): lead with something genuinely useful. You may include ONE short illustrative example of how someone in a similar position handled this, but keep it DIRECTIONAL, never fake-precise: say things like "saved a meaningful amount in tax and a lot of admin", NEVER invented exact figures like "£47k" or "saved £24k a year". Precise numbers from a near-stranger read as a script and destroy trust. End with a soft, optional door-opener the prospect can take or ignore with zero friction (e.g. "if it is ever useful, happy to share how a couple of others approached it, no pressure"). Do NOT propose a call, a 15-minute slot, or specific days. The call happens later, in the live reply, once they have engaged, not in this pre-written sequence.
British English. No financial advice. No guarantees. Peer tone.`,
      messages: [{
        role: 'user',
        content: `Write the outreach sequence for this prospect. Make it specific to THIS person.

Name: ${input.name}
Role: ${input.role || 'Director'}
Company: ${input.company || 'Unknown'}
Location: ${input.location || 'Unknown'}${known.length ? `\n${known.join('\n')}` : ''}

Return this exact JSON structure:
{
  "step1": {"message": "...", "personalization": "the detail this message uses, under 15 words"},
  "step2": {"message": "...", "personalization": "..."},
  "step3": {"message": "...", "personalization": "..."}
}`
      }],
    }, claudeRequestOptions(opts))
  } catch (err) {
    logClaudeError('outreach', startedAt, err)
    throw err
  }
  logClaudeCall('outreach', startedAt, response)

  const raw = parseJsonObject<Record<string, { message?: string; personalization?: string } | undefined>>(
    responseText(response),
    'outreach'
  )

  const sequence: OutreachSequence = {}
  for (const step of OUTREACH_STEPS) {
    const message = (raw[step.key]?.message || '').trim()
    if (!message) throw new Error(`AI outreach response is missing ${step.key}`)
    let finalMessage = message
    // Same rule as before v76.2: only the connection request is hard-trimmed,
    // because LinkedIn rejects a note over 280 characters.
    if (step.key === 'step1' && finalMessage.length > 280) {
      finalMessage = finalMessage.slice(0, 277) + '...'
    }
    sequence[step.key] = {
      title: step.title,
      timing: step.timing,
      charLimit: step.charLimit,
      message: finalMessage,
      chars: finalMessage.length,
      personalization: (raw[step.key]?.personalization || '').trim(),
    }
  }
  return sequence
}

// ── v77: HeyReach sequence (blank request, then msg_1 to msg_4) ──────────
//
// For the HeyReach test. The connection request goes out blank. Four
// messages follow once the person accepts, in LINK Method order:
//   msg_1 Engage in dialogue   (24 hours after they accept)
//   msg_2 Build relationship   (5 to 7 days later)
//   msg_3 Build relationship   (5 to 7 days later)
//   msg_4 Move it forward      (5 to 7 days later): offers a short audit
// At about 80 tokens a second, four messages in one call take around seven
// seconds, too close to the 10 second limit. So they are written in two
// requests: part 1 writes msg_1 and msg_2, part 2 writes msg_3 and msg_4
// with the first two in view so the sequence reads as one.

const HEYREACH_MESSAGE_BRIEF = `msg_1 (Engage in dialogue, sent 24 hours after they accept, max 300 chars): thank them for connecting, using their first name. Stay curious and human. Ask ONE light question about their firm or role that invites a reply. NO pitch, NO mention of the sender's services, NO call ask.
msg_2 (Build the relationship, 5-7 days later, max 600 chars): give something genuinely useful: an insight, observation or trend relevant to THEIR firm, role or clients. Reference their context. NO pitch, NO service mention, NO ask.
msg_3 (Build the relationship, 5-7 days later, max 600 chars): a second, different piece of value that builds on msg_2. You may say in one line what the sender works on, kept directional (e.g. "helping owner-run firms win more of the right clients"), never figures. NO ask.
msg_4 (Move it forward, 5-7 days later, max 500 chars): offer the prospect a short audit as a no-pressure next step: a prospecting audit, a marketing audit or a market audit, whichever fits them best. Say briefly what it would look at, tied to something from msg_2 or msg_3. ONE clear offer they can accept by replying. Do NOT ask for a call, suggest times, or include a calendar link. No promised results.`

const HEYREACH_RULES = `RULES FOR EVERY MESSAGE:
- The connection request was sent BLANK. They accepted. Nothing has been said yet, so msg_1 is the first thing they read.
- Each message must make sense on its own if they never replied to the one before. Do not say "following up" or "just checking in".
- Peer to peer, warm and specific to THIS person. No salesy language, no flattery, no "I hope this finds you well".
- NEVER invent figures, case studies, client names or statistics. Directional language only.
- No financial advice. No guarantees. British English.
- Never use em dashes or en dashes. Use commas or full stops instead.
- Use their first name at most once per message, and only where it reads naturally.`

/** Replaces em dashes (and spaced en dashes) with commas, per house style. */
export function removeDashes(text: string): string {
  return text
    .replace(/\s*\u2014\s*/g, ', ')
    .replace(/\s+\u2013\s+/g, ', ')
    .replace(/,\s*([,.!?])/g, '$1')
    .trim()
}

export async function writeHeyReachMessages(
  input: ProspectInput & { first_name?: string | null },
  research: OutreachResearchContext | null,
  context: Omit<ResearchContext, 'financials'>,
  part: 1 | 2,
  earlier: { msg_1?: string; msg_2?: string } | null,
  opts: ClaudeCallOptions = {}
): Promise<Partial<Record<'msg_1' | 'msg_2' | 'msg_3' | 'msg_4', string>>> {
  const serviceCtx = buildServiceContext(context.serviceProfile)
  let customBlock = ''
  if (context.customInstructions && context.customInstructions.trim()) {
    customBlock = `\n\nUSER INSTRUCTIONS FOR THIS CAMPAIGN (apply to outreach personalisation): "${context.customInstructions.trim()}"`
  }
  const keys = part === 1 ? (['msg_1', 'msg_2'] as const) : (['msg_3', 'msg_4'] as const)

  const known: string[] = []
  if (input.first_name) known.push(`First name: ${input.first_name}`)
  if (research?.research_notes) known.push(`What we know: ${research.research_notes}`)
  if (research?.key_trigger) known.push(`Why now: ${research.key_trigger}`)

  const earlierBlock =
    part === 2 && earlier?.msg_1 && earlier?.msg_2
      ? `\n\nALREADY WRITTEN (do not repeat them, build on them):\nmsg_1: ${earlier.msg_1}\nmsg_2: ${earlier.msg_2}`
      : ''

  const startedAt = Date.now()
  let response: Anthropic.Message
  try {
    response = await getAnthropic().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: `Write LinkedIn messages for a financial services professional's LinkedIn sequence. Return JSON only.
Sender: ${context.senderName} | Niche: ${context.niche}${serviceCtx}${customBlock}

THE FULL SEQUENCE (LINK Method order). You are writing ${keys.join(' and ')} only.
${HEYREACH_MESSAGE_BRIEF}

${HEYREACH_RULES}`,
      messages: [{
        role: 'user',
        content: `Write ${keys.join(' and ')} for this prospect.

Name: ${input.name}
Role: ${input.role || 'Director'}
Company: ${input.company || 'Unknown'}
Location: ${input.location || 'Unknown'}${known.length ? `\n${known.join('\n')}` : ''}${earlierBlock}

Return this exact JSON structure:
{${keys.map((k) => `"${k}": "..."`).join(', ')}}`
      }],
    }, claudeRequestOptions(opts))
  } catch (err) {
    logClaudeError(`HeyReach part ${part}`, startedAt, err)
    throw err
  }
  logClaudeCall(`HeyReach part ${part}`, startedAt, response)

  const raw = parseJsonObject<Record<string, unknown>>(responseText(response), `HeyReach part ${part}`)
  const out: Partial<Record<'msg_1' | 'msg_2' | 'msg_3' | 'msg_4', string>> = {}
  for (const k of keys) {
    const value = typeof raw[k] === 'string' ? removeDashes(raw[k] as string) : ''
    if (!value) throw new Error(`AI response is missing ${k}`)
    out[k] = value
  }
  return out
}

/**
 * Scores and outreach in one go. Only the admin debug route uses this; the
 * live flow calls the two steps in separate requests.
 */
export async function researchProspect(
  input: ProspectInput,
  context: ResearchContext
): Promise<AIResearchResult> {
  const research = await researchProspectScores(input, context)
  const outreach = await writeOutreachSequence(input, research, context)
  return { ...research, outreach }
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

function validateScores(result: ProspectResearch): void {
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
