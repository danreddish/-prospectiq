// v81: deep research, step 2. Claude reads the evidence from the registers
// and the LinkedIn profile, looks at the firm's own website through web
// search, then scores the person and writes up what was found. Every finding
// carries its source, and a finding citing a page the search never returned
// is dropped.

import type Anthropic from '@anthropic-ai/sdk'
import { getAnthropic } from '../ai-engine'
import type { ProspectScores } from '../../types'
import { evidenceLines, type Evidence } from './evidence'
import { accessibilityBounds } from './matching'

export interface Finding {
  fact: string
  /** "Companies House", "FCA Register", "LinkedIn profile" or a page address. */
  source: string
}

export interface DeepAnalysis {
  research_notes: string
  findings: Finding[]
  who_they_serve: string | null
  key_trigger: string
  fit: 'strong' | 'possible' | 'poor'
  fit_reason: string
  wealth_estimate: string
  yrs_at_sr_level: number
  scores: ProspectScores
  total_score: number
  tier: 'A' | 'B' | 'C'
  /** How many web searches ran, and whether web search was available at all. */
  searches: number
  web_search: boolean
  model: string
}

export interface AnalysisContext {
  senderName: string
  niche: string
  serviceLines: string[]
  customInstructions: string | null
}

const PRIMARY_MODEL = process.env.DEEP_RESEARCH_MODEL || 'claude-sonnet-5-5'
const FALLBACK_MODEL = 'claude-sonnet-4-20250514'
const MAX_SEARCHES = 4

function systemPrompt(ctx: AnalysisContext, webSearch: boolean): string {
  return `You research one prospect for ${ctx.senderName}, who is deciding whether to contact them. Niche: ${ctx.niche}
${ctx.serviceLines.join('\n')}${ctx.customInstructions ? `\nThe sender's instructions for this campaign: "${ctx.customInstructions}"` : ''}

You are given EVIDENCE already gathered from Companies House, the FCA Register and the person's LinkedIn profile. Each line says where it came from.
${webSearch
    ? `Then use web search, at most ${MAX_SEARCHES} searches, to read the firm's own website and anything recent and public about the firm: who it serves, any niche, the size of the team, how it describes itself, recent news or awards. Search for the firm by name and town. Prefer the firm's own site.`
    : 'Web search is not available for this run, so work from the evidence only and say so.'}
Do not search for or report anything about the person's private life: family, home, health, or personal finances.

RULES
- Report only what the evidence or a page you read actually says. Never fill a gap with a guess. If something is not known, leave it out.
- Every finding names its source: "Companies House", "FCA Register", "LinkedIn profile", or the full address of the page.
- If the web results are about a different firm with a similar name, ignore them and say the firm's site was not found.
- Never guess at retirement, succession, selling the firm, health or personal finances.
- British English. No dashes between clauses.

SCORING, 1 to 10 each. Use the whole range. Score from the evidence, and score 4 to 6 where the evidence is thin.
- accessibility: can this person say yes alone? Follow the decision-maker check in the evidence.
- timing: is there evidence the sender's service is relevant now (a stated niche or growth aim, hiring, a new firm, a recent change)? No evidence = 4 to 5.
- wealth: if the sender offers a business service to firm owners, score how well the firm fits the sender's MIN THRESHOLD and ideal client. If the sender advises wealthy individuals, score this person's likely wealth from the evidence.
- complexity: how much the firm or person stands to gain from the sender's service, from the evidence.

Finish with JSON only, no other text after your research:
{
  "research_notes": "3 to 5 sentences of facts about this person and firm, most useful first",
  "findings": [{"fact": "one specific fact", "source": "where it came from"}],
  "who_they_serve": "the firm's clients or niche in its own words, or null if not found",
  "key_trigger": "one sentence on why the sender's service could be relevant, tied to a finding. If none, exactly: No specific trigger in the details available.",
  "fit": "strong, possible or poor, against the sender's ideal client and instructions",
  "fit_reason": "one sentence",
  "wealth_estimate": "one of: Not assessed, £500K-1M, £1-3M, £3-5M, £5-10M, £10-25M, £25M+. Use Not assessed unless the evidence supports a range",
  "yrs_at_sr_level": 0,
  "scores": {"wealth": 0, "timing": 0, "accessibility": 0, "complexity": 0}
}
Give 4 to 8 findings. yrs_at_sr_level comes from the career history or the company's incorporation date, or 0 if unknown.`
}

type Block = { type: string; text?: string; content?: unknown; name?: string }

function domainOf(url: string): string {
  try {
    return new URL(url.startsWith('http') ? url : `https://${url}`).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return ''
  }
}

const REGISTER_SOURCES = /companies house|fca register|linkedin|decision.maker/i

/** Keep a finding only if its source is a register, the profile, or a page the search really returned. */
export function checkFindings(findings: unknown, seenUrls: string[], knownSites: string[]): Finding[] {
  if (!Array.isArray(findings)) return []
  const seenDomains = new Set([...seenUrls, ...knownSites].map(domainOf).filter(Boolean))
  const out: Finding[] = []
  for (const f of findings) {
    const fact = typeof f?.fact === 'string' ? f.fact.trim() : ''
    const source = typeof f?.source === 'string' ? f.source.trim() : ''
    if (!fact || !source) continue
    if (REGISTER_SOURCES.test(source)) {
      out.push({ fact, source })
    } else if (seenDomains.has(domainOf(source))) {
      out.push({ fact, source: source.startsWith('http') ? source : `https://${source}` })
    }
  }
  return out.slice(0, 8)
}

function clamp(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : fallback
  return Math.max(min, Math.min(max, v))
}

async function callClaude(model: string, system: string, user: string, webSearch: boolean) {
  const anthropic = getAnthropic()
  const tools = webSearch
    ? [{ type: 'web_search_20250305', name: 'web_search', max_uses: MAX_SEARCHES, user_location: { type: 'approximate', country: 'GB' } }]
    : undefined
  const messages: { role: 'user' | 'assistant'; content: unknown }[] = [{ role: 'user', content: user }]
  const blocks: Block[] = []
  let usageIn = 0
  let usageOut = 0
  // A long search turn can pause. Hand the paused turn back unchanged to carry on.
  for (let turn = 0; turn < 4; turn++) {
    const response = (await anthropic.messages.create(
      // The installed SDK predates the web search tool's types.
      { model, max_tokens: 2000, temperature: 0.2, system, messages, ...(tools ? { tools } : {}) } as unknown as Anthropic.MessageCreateParamsNonStreaming,
      { maxRetries: 3, timeout: 150000 }
    )) as Anthropic.Message
    usageIn += response.usage.input_tokens
    usageOut += response.usage.output_tokens
    blocks.push(...(response.content as unknown as Block[]))
    if ((response.stop_reason as string) !== 'pause_turn') break
    messages.push({ role: 'assistant', content: response.content })
  }
  return { blocks, usageIn, usageOut }
}

function isModelNotFound(err: unknown): boolean {
  const status = (err as { status?: number })?.status
  const message = err instanceof Error ? err.message : ''
  return status === 404 || /model.*not.*found|not_found_error/i.test(message)
}

function isWebSearchOff(err: unknown): boolean {
  const message = err instanceof Error ? err.message : ''
  return (err as { status?: number })?.status === 400 && /web.?search/i.test(message)
}

export async function analyseProspect(
  input: { name: string; role: string | null; company: string | null; location: string | null },
  evidence: Evidence,
  ctx: AnalysisContext
): Promise<DeepAnalysis> {
  const user = `PROSPECT
Name: ${input.name}${evidence.decision_maker.registeredName ? ` (Companies House: ${evidence.decision_maker.registeredName})` : ''}
Role: ${input.role || 'Unknown'}
Company: ${input.company || 'Unknown'}
Location: ${input.location || 'Unknown'}

EVIDENCE
${evidenceLines(evidence).join('\n')}`

  const startedAt = Date.now()
  let model = PRIMARY_MODEL
  let webSearch = true
  let result: Awaited<ReturnType<typeof callClaude>> | null = null
  // Two things can be unavailable on an account: the newer model, and web search.
  for (let attempt = 0; attempt < 3 && !result; attempt++) {
    try {
      result = await callClaude(model, systemPrompt(ctx, webSearch), user, webSearch)
    } catch (err) {
      if (model !== FALLBACK_MODEL && isModelNotFound(err)) {
        console.warn(`[DeepResearch] Model ${model} is not available on this key; using ${FALLBACK_MODEL}`)
        model = FALLBACK_MODEL
      } else if (webSearch && isWebSearchOff(err)) {
        console.warn('[DeepResearch] Web search is not enabled for this Anthropic key; researching from the registers and profile only')
        webSearch = false
      } else {
        throw err
      }
    }
  }
  if (!result) throw new Error('Claude could not be reached for deep research')

  const searches = result.blocks.filter((b) => b.type === 'server_tool_use' && b.name === 'web_search').length
  const seenUrls: string[] = []
  let lastResultAt = -1
  result.blocks.forEach((b, i) => {
    if (b.type !== 'web_search_tool_result') return
    lastResultAt = i
    if (Array.isArray(b.content)) for (const r of b.content as { url?: string }[]) if (r?.url) seenUrls.push(r.url)
  })
  // The answer is the text after the last search.
  const answer = result.blocks.slice(lastResultAt + 1).filter((b) => b.type === 'text').map((b) => b.text || '').join('')
  const json = answer.match(/\{[\s\S]*\}/)
  if (!json) throw new Error('Deep research did not return a result that could be read')
  const raw = JSON.parse(json[0]) as Record<string, unknown>
  console.log(`[DeepResearch] Claude ${model}: ${Date.now() - startedAt}ms, ${result.usageIn} tokens in, ${result.usageOut} out, ${searches} searches`)

  const knownSites = [evidence.fca?.website, evidence.profile?.firm_website].filter((s): s is string => !!s)
  const findings = checkFindings(raw.findings, seenUrls, knownSites)

  const rawScores = (raw.scores || {}) as Record<string, unknown>
  const bounds = accessibilityBounds(evidence.decision_maker.verdict)
  const scores: ProspectScores = {
    wealth: clamp(rawScores.wealth, 1, 10, 5),
    timing: clamp(rawScores.timing, 1, 10, 5),
    // The decision-maker check decides this range, not the AI.
    accessibility: clamp(rawScores.accessibility, bounds.min, bounds.max, bounds.min),
    complexity: clamp(rawScores.complexity, 1, 10, 5),
  }
  const total_score = (scores.wealth || 0) + (scores.timing || 0) + (scores.accessibility || 0) + (scores.complexity || 0)
  const fit = raw.fit === 'strong' || raw.fit === 'poor' ? raw.fit : 'possible'
  const str = (v: unknown, fallback = '') => (typeof v === 'string' && v.trim() ? v.trim() : fallback)

  return {
    research_notes: str(raw.research_notes, evidence.decision_maker.summary),
    findings,
    who_they_serve: str(raw.who_they_serve) && !/^null$/i.test(str(raw.who_they_serve)) ? str(raw.who_they_serve) : null,
    key_trigger: str(raw.key_trigger, 'No specific trigger in the details available.'),
    fit,
    fit_reason: str(raw.fit_reason),
    wealth_estimate: str(raw.wealth_estimate, 'Not assessed'),
    yrs_at_sr_level: clamp(raw.yrs_at_sr_level, 0, 60, 0),
    scores,
    total_score,
    tier: total_score >= 30 ? 'A' : total_score >= 22 ? 'B' : 'C',
    searches,
    web_search: webSearch,
    model,
  }
}
