import Anthropic from '@anthropic-ai/sdk'
import type { ProspectInput, Prospect, OutreachSequence, ProspectScores, ConversationTurn, ReplyCoachResponse } from '../types'

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
  /** v81: messages the sender has really written, for style only */
  voiceSample?: string | null
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
  /** v81: deep research runs in the background, so it can afford a stronger model and retries. */
  model?: string
  maxRetries?: number
}

export type ProspectResearch = Omit<AIResearchResult, 'outreach'>

function claudeRequestOptions(opts: ClaudeCallOptions) {
  // No automatic retries: a retry can't fit inside the deadline, and a silent
  // retry hides the real error from the logs.
  return { maxRetries: opts.maxRetries ?? 0, ...(opts.timeoutMs ? { timeout: Math.max(opts.timeoutMs, 1000) } : {}) }
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
// v81: what the app actually knows about a person. It has their name, role,
// company, location, sometimes their LinkedIn headline and Companies House
// filings. It has not read their profile, posts or website. These blocks stop
// guesses being written up as findings and then repeated in messages.

const NO_GUESSING = `WHAT YOU KNOW: only the details given for this person. You have not read their profile, posts or website. Do not state as fact anything that is not in those details: no claims about who their clients are, how big or established the firm is, how it wins business, or what problems it has.
NEVER guess at or mention: their age or career stage, retirement, succession, selling or valuing the firm, their health, or their personal finances.`

// v81: after deep research the app does have findings, each with a source.
const VERIFIED_ONLY = `WHAT YOU KNOW: the verified findings given for this person, each from Companies House, the FCA Register, their LinkedIn profile or the firm's own website. You may refer to them accurately. Do not add to them, stretch them or infer problems from them.
NEVER guess at or mention: their age or career stage, retirement, succession, selling or valuing the firm, their health, or their personal finances. Never mention Companies House, the FCA Register, their accounts, or that they were researched.`

/** The line for the person's own headline, or nothing when there isn't one. */
function headlineLine(input: ProspectInput): string {
  const h = (input.headline || '').trim()
  return h ? `\nTheir LinkedIn headline (their own words): ${h.slice(0, 300)}` : ''
}

/**
 * Cuts a message back to whole sentences that fit the limit. A backstop for
 * when the model overruns: better a shorter message than one over the limit.
 */
export function fitToLimit(text: string, limit: number): string {
  if (text.length <= limit) return text
  const cut = text.slice(0, limit)
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '), cut.lastIndexOf('.\n'), cut.lastIndexOf('?\n'))
  return end > limit * 0.5 ? cut.slice(0, end + 1).trim() : cut.slice(0, limit - 3).trim() + '...'
}

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
USE THE WHOLE RANGE. A list where everyone scores within a few points of each other is useless to the sender. Give 8-10 only where the details given clearly support it, and 4-6 where you are assuming.
HARD REQUIREMENTS: if the IDEAL CLIENT, MIN THRESHOLD or the user's instructions set a requirement (for example the person must be the sole owner or the decision-maker) and this person's role or headline fails it or leaves it in doubt (for example chairman, part-owner, co-owner, partner, or a firm that looks larger than asked for), score accessibility 1-4 and say why in research_notes.${serviceCtx ? '\nIf the sender is offering a business service to firm owners or professionals, not personal wealth advice, then score wealth on how well the firm fits the MIN THRESHOLD and complexity on how much the firm stands to gain. Do not let assumed personal wealth raise either score.' : ''}

${NO_GUESSING}
The wealth_estimate, est_age and yrs_at_sr_level fields below are still required: they are your rough estimates for the sender's eyes only. Keep them out of research_notes and key_trigger.

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
Location: ${input.location || 'Unknown'}${headlineLine(input)}

Return this exact JSON structure (fill in ALL values uniquely for this specific person):
{
  "research_notes": "2-3 sentences on what the details given show about THIS person and how well they fit, using their headline if there is one. Facts first. Mark anything assumed with 'likely'. Say plainly if a hard requirement is in doubt",
  "wealth_estimate": "use the appropriate range for THIS person",
  "est_age": "estimate based on THIS person's likely career stage",
  "yrs_at_sr_level": 0,
  "key_trigger": "one sentence on why the sender's service could be relevant to them, tied to something in the details given. If nothing specific supports one, write exactly: No specific trigger in the details available.",
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
  /** v81: true once deep research has run, so the notes are findings, not guesses. */
  verified?: boolean
  findings?: { fact: string; source: string }[] | null
}

// v81: the message playbook. How a first conversation with a stranger is
// earned, distilled from the direct-response and selling books Dan works
// from (Schwartz on awareness, Cialdini on influence, Sugarman on first
// lines, Blount on prospecting, Rackham on questions) and the LINK Method.
// Principles in plain words, applied to every message the app writes.
const MESSAGE_PLAYBOOK = `HOW TO WRITE THESE MESSAGES
1. Start where they are. A new connection does not know the sender and is not thinking about the sender's subject. Early messages are about their world, in their words. The sender's solution stays out until they have shown interest.
2. Work with what they already want. Do not try to create a want. Take it from what they say about themselves: their headline, who their firm says it serves, what it says it is building.
3. Specific beats clever. One true detail about them is worth more than any general remark. With no specific detail, write a shorter message. Never pad.
4. Give before asking. Offer one useful observation or a question worth thinking about, with nothing attached to it.
5. Ask for a small yes. The only thing a message asks for is a reply to one easy question. Never a call, never a meeting.
6. Ask about their situation. Never describe their problem to them. People believe what they say themselves, not what a stranger tells them.
7. Proof only from people like them, and only real. If the sender's details give a result, it may be used once, late in the sequence, as one person's result. Otherwise no proof at all.
8. Write as an equal. Plain, warm, sincere. No praise, no selling words, no urgency or scarcity.
9. One idea per message. The first line has to earn the second: no warm-up such as "I hope you are well" or "I wanted to reach out".
10. Make no an easy answer. The last message lets them go gracefully and leaves the door open.`

function voiceBlock(sample: string | null | undefined): string {
  const text = (sample || '').trim()
  if (!text) return ''
  return `\n\nTHE SENDER'S VOICE. These are messages the sender has really written. Write in this voice: their rhythm, sentence length, greetings, sign-off and how formal they are. Use it for style only. Do not copy their sentences, and take no facts, names, offers or claims from them. Where their style breaks a rule below, the rule wins.\n"""\n${text.slice(0, 3000)}\n"""`
}

/**
 * Research notes and the trigger are the app's own read of a name and a job
 * title, not findings. Handed to the message writer as that, so they shape
 * the angle without being quoted back to the person as fact.
 */
function backgroundLines(research: OutreachResearchContext | null): string[] {
  const lines: string[] = []
  if (research?.verified) {
    if (research.research_notes) lines.push(`Research summary (verified): ${research.research_notes}`)
    const findings = (research.findings || []).filter((f) => f?.fact).slice(0, 8)
    if (findings.length) lines.push(`Verified findings you may refer to:\n${findings.map((f) => `- ${f.fact} (${f.source})`).join('\n')}`)
    if (research.key_trigger && !/^no specific trigger/i.test(research.key_trigger.trim())) {
      lines.push(`Suggested angle, raise it as a question, not a statement: ${research.key_trigger}`)
    }
    return lines
  }
  if (research?.research_notes) lines.push(`Background, unverified, never state it to them as fact: ${research.research_notes}`)
  if (research?.key_trigger && !/^no specific trigger/i.test(research.key_trigger.trim())) {
    lines.push(`Possible angle, an assumption, never tell them this is their situation: ${research.key_trigger}`)
  }
  return lines
}

// v81: the whole sequence is written before the first message is sent.
const NO_REPLY_YET = `They have not replied to anything. Every message is written in advance, before any reply exists, and is sent whether or not they answered the one before. Never thank them for sharing, answering or replying. Never refer to something they said or to a conversation. Thanking them for connecting, once, in the first message after they accept, is fine. Each message must make sense on its own.
- Never say how you came across them (no "in my feed", "a mutual connection", "came recommended") and never claim anything about yourself that the sender's details do not give.`

// v81: rules shared by every message the app writes.
const messageRules = (verified: boolean) => `RULES FOR EVERY MESSAGE:
- ${(verified ? VERIFIED_ONLY : NO_GUESSING).replace(/\n/g, '\n- ')}
- ${NO_REPLY_YET}
- Ask, never tell. Do not tell them what their problem is ("trapped in", "struggling with", "dependent on") or what matters to them ("clearly matters to you"). If you raise a topic, raise it as a question.
- At most ONE question per message.
- NEVER invent or imply past clients, case studies, examples or results: no "a couple of others I've worked with", no "advisers in similar positions found". Only mention a result if the sender's details above give it.
- No compliments and no flattery.
- Never use dashes between words or clauses: no em dashes, no en dashes, no " - ". Use commas or full stops instead.
- No words in capitals for emphasis.
- The length limits are hard limits. Shorter is better.`

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

  const known = backgroundLines(research)

  const startedAt = Date.now()
  let response: Anthropic.Message
  try {
    response = await getAnthropic().messages.create({
      model: opts.model || 'claude-haiku-4-5-20251001',
      // The fast route keeps 900 to stay inside 10 seconds. The background job
      // has time, and the stronger model was cut off mid-answer at 900.
      max_tokens: opts.model ? 3000 : 900,
      system: `Write LinkedIn outreach for a financial services professional. Return JSON only.
Sender: ${context.senderName} | Niche: ${context.niche}${serviceCtx}${customBlock}

OUTREACH from ${context.senderName} to prospect. Write a LINK Method sequence that EARNS a conversation. It does not chase a call. These are senior, wealthy, heavily-pitched people: a stranger asking for 15 minutes reads as a sales script and gets ignored. The sequence must feel like a credible peer reaching out, not a funnel.${serviceCtx ? ' Reference the sender\'s specific SERVICE and OUTCOMES in step 2 and 3, not generic wealth management language.' : ''}
Step1 (Connection Request, hard limit 280 chars, aim for under 200): NO pitch, NO ask, NO mention of a call or meeting. One plain, specific reason for connecting, taken from their role, company, headline or a verified finding. No compliments: never "impressed by", "love what you're doing" or similar. The only goal is that they accept.
Step2 (Welcome Message, hard limit 600 chars, aim for under 450): thank them for connecting. Stay curious and human. Ask ONE open question about their firm or role that they could answer in a line. Do not assume the answer or tell them what their problem is. NO pitch and NO call ask here either.
Step3 (Value + Soft Door, hard limit 800 chars, aim for under 650): lead with one useful observation relevant to their kind of firm. You may say in ONE line what the sender works on, kept directional. Do not list the steps or parts of the sender's method. End with a soft, optional door-opener the prospect can take or ignore with zero friction (e.g. "if it is ever useful, happy to share more, no pressure"). Do NOT propose a call, a 15-minute slot, or specific days. The call happens later, in the live reply, once they have engaged, not in this pre-written sequence.

${MESSAGE_PLAYBOOK}${voiceBlock(context.voiceSample)}

${messageRules(!!research?.verified)}
British English. No financial advice. No guarantees. Peer tone.`,
      messages: [{
        role: 'user',
        content: `Write the outreach sequence for this prospect. Make it specific to THIS person.

Name: ${input.name}
Role: ${input.role || 'Director'}
Company: ${input.company || 'Unknown'}
Location: ${input.location || 'Unknown'}${headlineLine(input)}${known.length ? `\n${known.join('\n')}` : ''}

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
    const message = removeDashes((raw[step.key]?.message || '').trim())
    if (!message) throw new Error(`AI outreach response is missing ${step.key}`)
    // v81: every step is held to its limit, cut back to whole sentences.
    // LinkedIn rejects a connection note over 280 characters.
    const finalMessage = fitToLimit(message, step.charLimit)
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
//   msg_4 Exit                 (5 to 7 days later): a gracious close. Any
//                              final offer (e.g. Dan's audit) comes from the
//                              campaign's own instructions, not the app.
// At about 80 tokens a second, four messages in one call take around seven
// seconds, too close to the 10 second limit. So they are written in two
// requests: part 1 writes msg_1 and msg_2, part 2 writes msg_3 and msg_4
// with the first two in view so the sequence reads as one.

const HEYREACH_MESSAGE_BRIEF = `msg_1 (Engage in dialogue, sent 24 hours after they accept, max 300 chars): thank them for connecting, using their first name. Stay curious and human. Ask ONE light question about their firm or role that invites a reply. NO pitch, NO mention of the sender's services, NO call ask.
msg_2 (Build the relationship, 5-7 days later, max 600 chars): give something genuinely useful: an insight, observation or trend relevant to THEIR firm, role or clients. Reference their context. NO pitch, NO service mention, NO ask.
msg_3 (Build the relationship, 5-7 days later, max 600 chars): a second, different piece of value that builds on msg_2. You may say in one line what the sender works on, kept directional (e.g. "helping owner-run firms win more of the right clients"), never figures. NO ask.
msg_4 (Exit, 5-7 days later, max 400 chars): a short, gracious close. Acknowledge they are busy, say you won't keep messaging, and leave the door open for them to get in touch if it ever becomes relevant. No hard sell, no call ask, no guilt, no "just bumping this". Never suggest times or include a calendar link. No promised results.`

/**
 * The brief, with the sender's instructions bound into msg_4 when there are
 * any. In the first live run the model left a requested final offer out of
 * 3 of 5 exit messages when the instruction sat apart from the msg_4 brief.
 */
function heyReachBrief(instructions: string): string {
  if (!instructions) return HEYREACH_MESSAGE_BRIEF
  return `${HEYREACH_MESSAGE_BRIEF}
msg_4 MUST also follow the sender's instructions for this campaign: "${instructions}". If they say what to offer or include in the final message, include it as one light, optional offer they can take up by replying, named the way the sender names it.`
}

const heyReachRules = (verified: boolean) => `RULES FOR EVERY MESSAGE:
- The connection request was sent BLANK. They accepted. Nothing has been said yet, so msg_1 is the first thing they read.
- ${NO_REPLY_YET}
- Do not say "following up" or "just checking in".
- Equal footing in tone, warm and specific to THIS person. No salesy language, no flattery, no compliments, no "I hope this finds you well".
- NEVER invent or imply figures, case studies, past clients, examples or statistics: no "a couple of others I've worked with", no "advisers in similar positions found". Directional language only.
- ${(verified ? VERIFIED_ONLY : NO_GUESSING).replace(/\n/g, '\n- ')}
- Ask, never tell. Do not tell them what their problem is. If you raise a topic, raise it as a question.
- At most ONE question per message.
- Never list the steps or parts of the sender's method.
- No financial advice. No guarantees. British English.
- Never use dashes between words or clauses: no em dashes, no en dashes, no " - ". Use commas or full stops instead.
- No words in capitals for emphasis.
- Use their first name at most once per message, and only where it reads naturally.
- The sender is NOT one of the prospect's peers unless the sender's details above say so. Never call them "fellow", never say "another practice like ours", and never claim the sender is local to them or has been talking to firms in their area. Describe the sender only from the sender's details above.`

/**
 * Replaces dashes used as punctuation with commas, per house style: em
 * dashes, spaced en dashes, and a hyphen with a space either side. Hyphens
 * inside words ("owner-run") and unspaced ranges ("2009-2024") stay.
 */
export function removeDashes(text: string): string {
  return text
    .replace(/\s*\u2014\s*/g, ', ')
    .replace(/\s+\u2013\s+/g, ', ')
    .replace(/\s+-\s+/g, ', ')
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
  const instructions = context.customInstructions?.trim() || ''
  // The sender's own instructions for this campaign. They are followed, not
  // treated as a hint, unless they clash with the RULES. They also go in the
  // user message, next to the task, because the model skipped them in 3 of 5
  // final messages when they sat only in the system prompt.
  const customBlock = instructions
    ? `\n\nTHE SENDER'S INSTRUCTIONS FOR THIS CAMPAIGN (follow them wherever they apply to the messages you are writing, unless they break the RULES below): "${instructions}"`
    : ''
  const keys = part === 1 ? (['msg_1', 'msg_2'] as const) : (['msg_3', 'msg_4'] as const)
  const reminder = instructions
    ? `\n\nBefore you answer, re-read the sender's instructions for this campaign and make sure ${keys.join(' and ')} follow them where they apply: "${instructions}"`
    : ''

  const known: string[] = []
  if (input.first_name) known.push(`First name: ${input.first_name}`)
  known.push(...backgroundLines(research))

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
      // Lower than the default 1.0 so the brief and the sender's
      // instructions are followed more consistently.
      temperature: 0.4,
      system: `Write LinkedIn messages for the sender's LinkedIn sequence. Return JSON only.
Sender: ${context.senderName} | Who the sender is targeting: ${context.niche}${serviceCtx}${customBlock}

THE FULL SEQUENCE (LINK Method order). You are writing ${keys.join(' and ')} only.
${heyReachBrief(instructions)}

${MESSAGE_PLAYBOOK}${voiceBlock(context.voiceSample)}

${heyReachRules(!!research?.verified)}`,
      messages: [{
        role: 'user',
        content: `Write ${keys.join(' and ')} for this prospect.

Name: ${input.name}
Role: ${input.role || 'Director'}
Company: ${input.company || 'Unknown'}
Location: ${input.location || 'Unknown'}${headlineLine(input)}${known.length ? `\n${known.join('\n')}` : ''}${earlierBlock}${reminder}

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
