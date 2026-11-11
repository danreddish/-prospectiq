// v80: HeyReach campaign sequences for the "Set up a client" button.
//
// HeyReach's Campaign API (beta, April 2026) creates a campaign from a
// sequence tree (PublicSequenceNodeDto):
//   nodeType            CONNECTION_REQUEST, MESSAGE, END, ...
//   conditionalNode     the "true" path (e.g. they accepted)
//   unconditionalNode   the next step, or the "false" path on a branch
//   actionDelay         0 to 100, with actionDelayUnit HOUR or DAY
//   payload             node settings (messages, fallbackMessage, ...)
// Every path ends in an END node. The START node is implicit.
//
// The safest sequence is a copy of one Dan already built by hand in HeyReach
// and knows works (read with GetCampaignSequence), so the msg_1 to msg_4
// variables are written exactly the way HeyReach expects. The built-in one is
// a fallback and says so. No secrets and no server-only imports here.

import { HEYREACH_MESSAGE_FIELDS } from '@/lib/heyreach-shared'

export interface SequenceNode {
  nodeType: string | number
  actionDelay?: number
  actionDelayUnit?: string | number
  payload?: Record<string, unknown>
  conditionalNode?: SequenceNode
  unconditionalNode?: SequenceNode
}

/** Nodes with a true and a false path. */
const BRANCHING = new Set(['CONNECTION_REQUEST', 'CHECK_IS_CONNECTION', 'CHECK_IS_OPEN_PROFILE', 'FIND_EMAIL'])
const MAX_DEPTH = 60

/** Weekdays 9am to 8pm, London time: the same hours as the Ulinc campaigns. */
export const CLIENT_SCHEDULE = {
  dailyStartTime: '09:00:00',
  dailyEndTime: '20:00:00',
  timeZoneId: 'Europe/London',
  enabledMonday: true,
  enabledTuesday: true,
  enabledWednesday: true,
  enabledThursday: true,
  enabledFriday: true,
  enabledSaturday: false,
  enabledSunday: false,
} as const

export const CLIENT_SCHEDULE_LABEL = 'Weekdays, 9am to 8pm London time'

/** HeyReach campaign names are 1 to 50 characters. */
export const CAMPAIGN_NAME_MAX = 50

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function typeOf(node: Record<string, unknown>): string | number | null {
  const t = node.nodeType ?? node.type ?? node.actionType
  if (typeof t === 'string' && t.trim()) return t.trim().toUpperCase()
  if (typeof t === 'number' && Number.isFinite(t)) return t
  return null
}

function child(node: Record<string, unknown>, ...keys: string[]): Record<string, unknown> | null {
  for (const k of keys) if (isObject(node[k])) return node[k] as Record<string, unknown>
  return null
}

/** A deep copy of a payload with nulls dropped, so optional fields are simply absent. */
function cleanPayload(v: unknown): Record<string, unknown> | undefined {
  if (!isObject(v)) return undefined
  const out: Record<string, unknown> = {}
  for (const [k, val] of Object.entries(v)) {
    if (val === null || val === undefined) continue
    out[k] = Array.isArray(val) ? val.filter((x) => x !== null && x !== undefined).map((x) => (isObject(x) ? cleanPayload(x) : x)) : isObject(val) ? cleanPayload(val) : val
  }
  return out
}

const END: SequenceNode = { nodeType: 'END' }

function cleanNode(raw: Record<string, unknown>, depth: number): SequenceNode {
  if (depth > MAX_DEPTH) throw new Error('The sequence is deeper than expected.')
  const nodeType = typeOf(raw)
  if (nodeType === null) throw new Error('A step in the sequence has no type.')
  // Numbered step types can't be matched to branches or END safely.
  if (typeof nodeType === 'number') throw new Error("HeyReach gave this sequence in a format ProspectIQ can't copy yet. Use the built-in sequence instead.")
  if (nodeType === 'END') return { ...END }
  const node: SequenceNode = { nodeType }
  const delay = Number(raw.actionDelay)
  if (Number.isFinite(delay) && delay > 0) node.actionDelay = Math.min(100, Math.round(delay))
  if (typeof raw.actionDelayUnit === 'string' && raw.actionDelayUnit.trim()) node.actionDelayUnit = raw.actionDelayUnit.trim().toUpperCase()
  // A numeric enum is passed back exactly as HeyReach gave it.
  else if (typeof raw.actionDelayUnit === 'number') node.actionDelayUnit = raw.actionDelayUnit
  const payload = cleanPayload(raw.payload)
  if (payload && Object.keys(payload).length) node.payload = payload

  const next = child(raw, 'unconditionalNode', 'nextNode', 'next')
  const yes = child(raw, 'conditionalNode', 'trueNode')
  // Every path must end in END. A missing step is read as "stop here".
  node.unconditionalNode = next ? cleanNode(next, depth + 1) : { ...END }
  if (BRANCHING.has(nodeType)) {
    node.conditionalNode = yes ? cleanNode(yes, depth + 1) : { ...END }
  } else if (yes) {
    // Only branching steps may have a true path. Keep it as the next step if
    // there is no other, rather than losing the rest of the sequence.
    if (!next) node.unconditionalNode = cleanNode(yes, depth + 1)
  }
  return node
}

/**
 * The sequence in a GetCampaignSequence reply, cleaned up so it can be sent
 * straight back to campaign/Create: wrappers and an explicit START node are
 * removed, ids and nulls dropped, and every path ends in END. Throws with a
 * plain reason when the reply isn't a sequence we can read.
 */
export function sequenceFromReply(body: unknown): SequenceNode {
  let node: unknown = body
  for (let i = 0; i < 4 && isObject(node) && typeOf(node) === null; i++) {
    const o = node as Record<string, unknown>
    node = o.sequence ?? o.result ?? o.data ?? o.rootNode ?? o.root ?? o.node
  }
  if (!isObject(node)) throw new Error("HeyReach didn't return a sequence for that campaign.")
  let root = node as Record<string, unknown>
  if (typeOf(root) === 'START') {
    const first = child(root, 'unconditionalNode', 'conditionalNode', 'nextNode')
    if (!first) throw new Error("That campaign's sequence has no steps.")
    root = first
  }
  const cleaned = cleanNode(root, 0)
  if (cleaned.nodeType === 'END') throw new Error("That campaign's sequence has no steps.")
  return cleaned
}

/**
 * The built-in sequence: a connection request with no note, then msg_1 a day
 * after they accept and msg_2 to msg_4 five days apart. Pending requests are
 * withdrawn after 21 days. Untested against HeyReach's variable syntax, so the
 * page says to check it in HeyReach before anyone is sent.
 */
export function standardSequence(): SequenceNode {
  const fallbacks = ['Thanks for connecting.', 'Hope the week is going well.', 'Hope all is well.', 'All the best.']
  let next: SequenceNode = { ...END }
  for (let i = HEYREACH_MESSAGE_FIELDS.length - 1; i >= 0; i--) {
    next = {
      nodeType: 'MESSAGE',
      actionDelay: i === 0 ? 1 : 5,
      actionDelayUnit: 'DAY',
      payload: { messages: [`{${HEYREACH_MESSAGE_FIELDS[i]}}`], fallbackMessage: fallbacks[i] },
      unconditionalNode: next,
    }
  }
  return {
    nodeType: 'CONNECTION_REQUEST',
    payload: { messages: [], toBeWithdrawnAfterDays: 21 },
    conditionalNode: next,
    unconditionalNode: { ...END },
  }
}

function short(text: unknown, max = 90): string {
  const s = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function wait(node: SequenceNode): string {
  if (!node.actionDelay) return ''
  const unit = node.actionDelayUnit === 'HOUR' ? 'hour' : 'day'
  return `after ${node.actionDelay} ${unit}${node.actionDelay === 1 ? '' : 's'}, `
}

function firstMessage(payload: Record<string, unknown> | undefined): string {
  const messages = payload?.messages
  if (!Array.isArray(messages) || messages.length === 0) return ''
  const m = messages[0]
  return typeof m === 'string' ? m : isObject(m) ? String(m.message ?? m.subject ?? '') : ''
}

/** The sequence as plain lines, indented by branch, for the page to show before anything is created. */
export function describeSequence(root: SequenceNode): string[] {
  const lines: string[] = []
  const walk = (node: SequenceNode | undefined, indent: string, depth: number) => {
    if (!node || depth > MAX_DEPTH) return
    const type = node.nodeType
    if (type === 'END') {
      lines.push(`${indent}Stop`)
      return
    }
    if (type === 'CONNECTION_REQUEST') {
      const note = firstMessage(node.payload)
      const withdraw = Number(node.payload?.toBeWithdrawnAfterDays)
      lines.push(
        `${indent}${cap(`${wait(node)}connection request ${note ? `with a note: “${short(note)}”` : 'with no note'}`)}${Number.isFinite(withdraw) && withdraw > 0 ? ` (withdrawn after ${withdraw} days if not accepted)` : ''}`
      )
      lines.push(`${indent}  If they accept:`)
      walk(node.conditionalNode, `${indent}    `, depth + 1)
      lines.push(`${indent}  If they don't:`)
      walk(node.unconditionalNode, `${indent}    `, depth + 1)
      return
    }
    if (type === 'MESSAGE' || type === 'INMAIL') {
      const text = firstMessage(node.payload)
      const fallback = node.payload?.fallbackMessage
      const fb = typeof fallback === 'string' ? fallback : isObject(fallback) ? String(fallback.message ?? '') : ''
      lines.push(`${indent}${cap(`${wait(node)}${type === 'INMAIL' ? 'InMail' : 'message'}: “${short(text) || '(empty)'}”${fb ? ` (fallback: “${short(fb, 50)}”)` : ''}`)}`)
      walk(node.unconditionalNode, indent, depth + 1)
      return
    }
    const label = typeof type === 'string' ? type.toLowerCase().replace(/_/g, ' ') : `step type ${type}`
    lines.push(`${indent}${cap(`${wait(node)}${label}`)}`)
    if (node.conditionalNode) {
      lines.push(`${indent}  If yes:`)
      walk(node.conditionalNode, `${indent}    `, depth + 1)
      lines.push(`${indent}  If not:`)
      walk(node.unconditionalNode, `${indent}    `, depth + 1)
    } else {
      walk(node.unconditionalNode, indent, depth + 1)
    }
  }
  walk(root, '', 0)
  return lines
}

/** Which of msg_1 to msg_4 the sequence's messages use, so the page can warn if one is missing. */
export function messageFieldsUsed(root: SequenceNode): string[] {
  const found = new Set<string>()
  const walk = (node: SequenceNode | undefined, depth: number) => {
    if (!node || depth > MAX_DEPTH) return
    const text = JSON.stringify(node.payload || {})
    for (const f of HEYREACH_MESSAGE_FIELDS) if (text.includes(f)) found.add(f)
    walk(node.conditionalNode, depth + 1)
    walk(node.unconditionalNode, depth + 1)
  }
  walk(root, 0)
  return HEYREACH_MESSAGE_FIELDS.filter((f) => found.has(f))
}
