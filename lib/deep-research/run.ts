// v81: deep research, the whole job for one prospect. Runs in the Netlify
// background function (netlify/functions/deep-research-background.ts), which
// may take up to 15 minutes, so none of the 10 second limits apply here.
//
//   1. evidence   Companies House, FCA Register, LinkedIn profile
//   2. analysis   Claude reads the evidence and the firm's website, scores
//   3. outreach   the 3-step sequence, written from the verified findings
//
// Relative imports only: Netlify's function bundler does not read "@/".

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { writeOutreachSequence } from '../ai-engine'
import { voiceSampleFrom } from '../voice'
import { attachCompanyByNumber, gatherEvidence, type Evidence } from './evidence'
import { analyseProspect, reboundAccessibility, type Finding } from './analyse'
import { DEEP_RESEARCH_STAGES, type DeepResearchState } from './state'

/** An API error as one readable sentence, without the raw JSON. */
function plainError(message: string): string {
  const inner = message.match(/"message"\s*:\s*"([^"]+)"/)
  return (inner ? inner[1] : message).replace(/`/g, '').slice(0, 200)
}

function adminClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase is not configured for deep research')
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
}

type Sp = Record<string, string | null | undefined>

function serviceLines(campaignSp: Sp, accountSp: Sp): string[] {
  const pick = (k: string) => campaignSp[k] || accountSp[k] || null
  const lines: string[] = []
  if (pick('what_you_do')) lines.push(`SERVICE: ${pick('what_you_do')}`)
  if (pick('who_you_help')) lines.push(`IDEAL CLIENT: ${pick('who_you_help')}`)
  if (pick('key_outcomes')) lines.push(`OUTCOMES: ${pick('key_outcomes')}`)
  if (pick('minimum_threshold')) lines.push(`MIN THRESHOLD: ${pick('minimum_threshold')}`)
  if (pick('geographic_focus')) lines.push(`GEO FOCUS: ${pick('geographic_focus')}`)
  return lines
}

export async function runDeepResearch(prospectId: string): Promise<{ ok: boolean; error?: string }> {
  const admin = adminClient()
  const startedAt = Date.now()

  const { data: prospect, error: loadError } = await admin
    .from('prospects')
    .select('id, user_id, campaign_id, name, role, company, location, linkedin_url, headline, company_number, status, total_score, tier, deep_research')
    .eq('id', prospectId)
    .maybeSingle()
  if (loadError || !prospect) return { ok: false, error: loadError?.message || 'Prospect not found' }
  if (prospect.status !== 'completed') return { ok: false, error: 'Prospect has not had its first-pass research yet' }

  const previous = (prospect.deep_research || {}) as DeepResearchState
  // Two triggers for the same person: let the first one finish.
  if (previous.status === 'running' && previous.started_at && Date.now() - Date.parse(previous.started_at) < 10 * 60 * 1000) {
    return { ok: true }
  }

  const save = (state: DeepResearchState, extra: Record<string, unknown> = {}) =>
    admin.from('prospects').update({ deep_research: state, ...extra }).eq('id', prospectId)

  const first_pass = previous.first_pass || { total_score: prospect.total_score ?? null, tier: prospect.tier ?? null }
  const attempts = (previous.attempts || 0) + 1
  const running: DeepResearchState = { status: 'running', queued_at: previous.queued_at, started_at: new Date().toISOString(), first_pass, attempts, stage: DEEP_RESEARCH_STAGES[0] }
  await save(running)
  const stage = (n: number) => save({ ...running, stage: DEEP_RESEARCH_STAGES[n] })

  try {
    const [{ data: campaign }, { data: profile }] = await Promise.all([
      admin.from('campaigns').select('niche, sender_name, service_profile, custom_instructions').eq('id', prospect.campaign_id).maybeSingle(),
      admin.from('profiles').select('niche, sender_name, service_profile').eq('id', prospect.user_id).maybeSingle(),
    ])
    const campaignSp = (campaign?.service_profile || {}) as Sp
    const accountSp = (profile?.service_profile || {}) as Sp
    const senderName = campaign?.sender_name || profile?.sender_name || 'Financial Advisor'
    const niche = campaign?.niche || profile?.niche || 'Wealth management'
    const customInstructions = (campaign?.custom_instructions as string | null) || null

    console.log(`[DeepResearch] Starting ${prospect.name} at ${prospect.company || 'unknown'}`)
    const evidenceInput = {
      name: prospect.name,
      role: prospect.role,
      company: prospect.company,
      location: prospect.location,
      linkedin_url: prospect.linkedin_url,
      headline: prospect.headline,
      company_number: prospect.company_number,
    }
    const evidence = await gatherEvidence(evidenceInput)
    console.log(`[DeepResearch] Evidence in ${Date.now() - startedAt}ms: CH ${evidence.companies_house ? evidence.companies_house.matched_by : 'none'}, FCA ${evidence.fca ? evidence.fca.status : 'none'}, profile ${evidence.profile ? 'yes' : 'none'}, decision ${evidence.decision_maker.verdict}`)

    await stage(1)
    const analysis = await analyseProspect(
      { name: prospect.name, role: prospect.role, company: prospect.company, location: prospect.location },
      evidence,
      { senderName, niche, serviceLines: serviceLines(campaignSp, accountSp), customInstructions }
    )

    const findings: Finding[] = analysis.findings

    // The registers had no company but the web research found its number:
    // check it, and if this person is an officer, run the who-decides check.
    if (!evidence.companies_house && analysis.company_number) {
      const attached = await attachCompanyByNumber(evidenceInput, evidence, analysis.company_number)
      if (attached) {
        reboundAccessibility(analysis, evidence.decision_maker.verdict)
        console.log(`[DeepResearch] Company ${analysis.company_number} confirmed from the web research: decision ${evidence.decision_maker.verdict}`)
      }
    }

    // Messages from the verified findings. If this fails, the research still stands.
    await stage(2)
    let outreach: unknown = undefined
    let outreachError = ''
    try {
      outreach = await writeOutreachSequence(
        {
          name: prospect.name,
          role: prospect.role || undefined,
          company: prospect.company || undefined,
          location: prospect.location || undefined,
          headline: evidence.profile?.headline || prospect.headline || null,
        },
        { research_notes: analysis.research_notes, key_trigger: analysis.key_trigger, verified: true, findings: analysis.findings },
        {
          niche,
          senderName,
          serviceProfile: {
            what_you_do: campaignSp.what_you_do || accountSp.what_you_do || null,
            who_you_help: campaignSp.who_you_help || accountSp.who_you_help || null,
            key_outcomes: campaignSp.key_outcomes || accountSp.key_outcomes || null,
            minimum_threshold: campaignSp.minimum_threshold || accountSp.minimum_threshold || null,
            geographic_focus: campaignSp.geographic_focus || accountSp.geographic_focus || null,
          },
          customInstructions,
          voiceSample: voiceSampleFrom(profile?.service_profile),
        },
        { model: analysis.model, timeoutMs: 60000, maxRetries: 2 }
      )
    } catch (err) {
      outreachError = plainError(err instanceof Error ? err.message : 'Could not write the messages')
      console.error('[DeepResearch] Outreach failed, research kept:', outreachError)
    }

    const done: DeepResearchState = {
      status: 'done',
      queued_at: previous.queued_at,
      started_at: running.started_at,
      finished_at: new Date().toISOString(),
      evidence,
      findings,
      who_they_serve: analysis.who_they_serve,
      fit: analysis.fit,
      fit_reason: analysis.fit_reason,
      searches: analysis.searches,
      web_search: analysis.web_search,
      model: analysis.model,
      outreach_written: !!outreach,
      attempts,
      ...(outreachError ? { outreach_error: outreachError } : {}),
      first_pass,
    }
    const ch = evidence.companies_house
    const { error: saveError } = await save(done, {
      research_notes: analysis.research_notes,
      key_trigger: analysis.key_trigger,
      wealth_estimate: analysis.wealth_estimate,
      yrs_at_sr_level: analysis.yrs_at_sr_level,
      scores: analysis.scores,
      total_score: analysis.total_score,
      tier: analysis.tier,
      ...(evidence.age ? { est_age: String(evidence.age) } : {}),
      ...(ch ? { company_number: ch.company_number, accounts_last_filed: ch.accounts_made_up_to } : {}),
      outreach: outreach || {},
    })
    if (saveError) throw new Error(`Could not save the research: ${saveError.message}`)
    console.log(`[DeepResearch] Done ${prospect.name} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s: ${analysis.total_score}/40, ${analysis.fit} fit, ${analysis.searches} searches`)
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Deep research failed'
    console.error(`[DeepResearch] FAILED ${prospect.name}:`, message)
    await save({ status: 'failed', queued_at: previous.queued_at, started_at: running.started_at, finished_at: new Date().toISOString(), error: plainError(message), first_pass, attempts })
    return { ok: false, error: message }
  }
}

/**
 * Writes the outreach again from findings already saved, without repeating
 * the research. For when the message rules change, or a set reads badly.
 * The person shows as running, on the "Writing the messages" step, and goes
 * back to done whether or not the rewrite works.
 */
export async function rewriteMessages(prospectId: string): Promise<{ ok: boolean; error?: string }> {
  const admin = adminClient()
  const { data: prospect, error: loadError } = await admin
    .from('prospects')
    .select('id, user_id, campaign_id, name, role, company, location, headline, research_notes, key_trigger, deep_research')
    .eq('id', prospectId)
    .maybeSingle()
  if (loadError || !prospect) return { ok: false, error: loadError?.message || 'Prospect not found' }
  const state = (prospect.deep_research || null) as DeepResearchState | null
  if (!state || !state.evidence) return { ok: false, error: 'Deep research has not finished for this person' }

  // Whatever happens, the research itself is put back as done.
  const done = (extra: Partial<DeepResearchState>): DeepResearchState => {
    const next: DeepResearchState = { ...state, status: 'done', ...extra }
    delete next.stage
    return next
  }
  try {
    const [{ data: campaign }, { data: profile }] = await Promise.all([
      admin.from('campaigns').select('niche, sender_name, service_profile, custom_instructions').eq('id', prospect.campaign_id).maybeSingle(),
      admin.from('profiles').select('niche, sender_name, service_profile').eq('id', prospect.user_id).maybeSingle(),
    ])
    const campaignSp = (campaign?.service_profile || {}) as Sp
    const accountSp = (profile?.service_profile || {}) as Sp
    const outreach = await writeOutreachSequence(
      {
        name: prospect.name,
        role: prospect.role || undefined,
        company: prospect.company || undefined,
        location: prospect.location || undefined,
        headline: state.evidence.profile?.headline || prospect.headline || null,
      },
      { research_notes: prospect.research_notes, key_trigger: prospect.key_trigger, verified: true, findings: state.findings || [] },
      {
        niche: campaign?.niche || profile?.niche || 'Wealth management',
        senderName: campaign?.sender_name || profile?.sender_name || 'Financial Advisor',
        serviceProfile: {
          what_you_do: campaignSp.what_you_do || accountSp.what_you_do || null,
          who_you_help: campaignSp.who_you_help || accountSp.who_you_help || null,
          key_outcomes: campaignSp.key_outcomes || accountSp.key_outcomes || null,
          minimum_threshold: campaignSp.minimum_threshold || accountSp.minimum_threshold || null,
          geographic_focus: campaignSp.geographic_focus || accountSp.geographic_focus || null,
        },
        customInstructions: (campaign?.custom_instructions as string | null) || null,
        voiceSample: voiceSampleFrom(profile?.service_profile),
      },
      { model: state.model || process.env.DEEP_RESEARCH_MODEL || 'claude-sonnet-5-5', timeoutMs: 60000, maxRetries: 2 }
    )
    const next = done({ outreach_written: true })
    delete next.outreach_error
    const { error: saveError } = await admin.from('prospects').update({ deep_research: next, outreach }).eq('id', prospectId)
    if (saveError) throw new Error(saveError.message)
    console.log(`[DeepResearch] Messages rewritten for ${prospect.name}`)
    return { ok: true }
  } catch (err) {
    const message = plainError(err instanceof Error ? err.message : 'Could not write the messages')
    console.error(`[DeepResearch] Rewrite FAILED ${prospect.name}:`, message)
    // The old messages stay as they were.
    await admin.from('prospects').update({ deep_research: done({ outreach_error: message }) }).eq('id', prospectId)
    return { ok: false, error: message }
  }
}
