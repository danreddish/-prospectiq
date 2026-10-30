// v78: LinkedIn pipeline from HeyReach. Pure functions, safe in the browser.
//
// HeyReach gives each lead in a campaign three statuses (from
// /campaign/GetLeadsFromCampaign):
//   leadCampaignStatus:   Pending | InSequence | Finished | Paused | Failed
//   leadConnectionStatus: None | ConnectionSent | ConnectionAccepted
//   leadMessageStatus:    None | MessageSent | MessageReply
// A lead removed from a campaign shows as Failed.
//
// The pipeline counts where each lead has got to now. HeyReach's own
// /stats/GetOverallStats counts actions in a date range; the page shows that
// separately as "activity", because the two answer different questions.

export type PipelineStage =
  | 'waiting'
  | 'request_sent'
  | 'accepted'
  | 'messaged'
  | 'replied'
  | 'finished'
  | 'paused'
  | 'already_connected'
  | 'removed'

export const STAGE_LABELS: Record<PipelineStage, string> = {
  waiting: 'Waiting to start',
  request_sent: 'Request sent',
  accepted: 'Accepted',
  messaged: 'Messaged',
  replied: 'Replied',
  finished: 'Finished, no reply',
  paused: 'Paused',
  already_connected: 'Already connected',
  removed: 'Removed or failed',
}

export interface PipelineLead {
  name: string
  profileUrl: string | null
  headline: string | null
  company: string | null
  position: string | null
  campaignStatus: string | null
  connectionStatus: string | null
  messageStatus: string | null
  lastActionTime: string | null
  creationTime: string | null
  statusMessage: string | null
}

export interface PipelineFunnel {
  inCampaign: number
  /** Removed by the user, or failed for any reason other than already being connected. */
  removed: number
  /** Stopped by HeyReach because they were already a 1st-degree connection. */
  alreadyConnected: number
  requestsSent: number
  accepted: number
  messaged: number
  replied: number
  /** accepted / requestsSent, 0 to 1, or null with nothing sent */
  acceptanceRate: number | null
  /** replied / messaged, 0 to 1, or null with nothing messaged */
  replyRate: number | null
}

export interface PipelineActivity {
  connectionsSent: number
  connectionsAccepted: number
  messagesSent: number
  messageThreadsStarted: number
  replies: number
  profileViews: number
}

/** "ConnectionAccepted", "CONNECTION_ACCEPTED" and "connection accepted" all read the same. */
export function normaliseStatus(s: string | null | undefined): string {
  return (s || '').toLowerCase().replace(/[^a-z]/g, '')
}

/**
 * HeyReach stops a lead it finds is already a 1st-degree connection when the
 * sequence starts with a connection request ("Already a connection"). That
 * isn't a dead lead: they can be messaged directly.
 */
export function isAlreadyConnected(lead: Pick<PipelineLead, 'campaignStatus' | 'statusMessage'>): boolean {
  return normaliseStatus(lead.campaignStatus) === 'failed' && /already\s+(a\s+)?connect/i.test(lead.statusMessage || '')
}

/** The furthest step this lead has reached. */
export function leadStage(lead: Pick<PipelineLead, 'campaignStatus' | 'connectionStatus' | 'messageStatus' | 'statusMessage'>): PipelineStage {
  const campaign = normaliseStatus(lead.campaignStatus)
  const connection = normaliseStatus(lead.connectionStatus)
  const message = normaliseStatus(lead.messageStatus)
  if (isAlreadyConnected(lead)) return 'already_connected'
  if (campaign === 'failed') return 'removed'
  if (message === 'messagereply') return 'replied'
  if (message === 'messagesent') return 'messaged'
  if (connection === 'connectionaccepted') return 'accepted'
  if (connection === 'connectionsent') return 'request_sent'
  if (campaign === 'finished') return 'finished'
  if (campaign === 'paused') return 'paused'
  return 'waiting'
}

function sentRequest(lead: PipelineLead): boolean {
  const c = normaliseStatus(lead.connectionStatus)
  return c === 'connectionsent' || c === 'connectionaccepted'
}

function wasMessaged(lead: PipelineLead): boolean {
  const m = normaliseStatus(lead.messageStatus)
  return m === 'messagesent' || m === 'messagereply'
}

const COMPANY_NOISE = /\b(ltd|limited|llp|plc|uk|group|the|and|&)\b/g

/**
 * True when the company on the live LinkedIn profile looks like a different
 * firm from the one ProspectIQ researched (the first live run found a
 * prospect whose LinkedIn had moved to another firm).
 */
export function companyChanged(prospectIqCompany: string | null | undefined, liveCompany: string | null | undefined): boolean {
  const clean = (c: string) => c.toLowerCase().replace(COMPANY_NOISE, ' ').replace(/[^a-z0-9]+/g, ' ').trim()
  if (!prospectIqCompany || !liveCompany) return false
  const a = clean(prospectIqCompany)
  const b = clean(liveCompany)
  if (!a || !b) return false
  return !(a === b || a.includes(b) || b.includes(a))
}

export function ratio(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null
}

/** "40%" or "–" when there's nothing to divide by. */
export function formatRate(r: number | null): string {
  return r === null ? '–' : `${Math.round(r * 100)}%`
}

/**
 * Where everyone has got to. A removed lead still counts for anything that
 * happened before it was removed (a request it was sent was still sent).
 */
export function funnelFrom(leads: PipelineLead[]): PipelineFunnel {
  const requestsSent = leads.filter(sentRequest).length
  const accepted = leads.filter((l) => normaliseStatus(l.connectionStatus) === 'connectionaccepted').length
  const messaged = leads.filter(wasMessaged).length
  const replied = leads.filter((l) => normaliseStatus(l.messageStatus) === 'messagereply').length
  return {
    inCampaign: leads.length,
    removed: leads.filter((l) => normaliseStatus(l.campaignStatus) === 'failed' && !isAlreadyConnected(l)).length,
    alreadyConnected: leads.filter(isAlreadyConnected).length,
    requestsSent,
    accepted,
    messaged,
    replied,
    acceptanceRate: ratio(accepted, requestsSent),
    replyRate: ratio(replied, messaged),
  }
}
