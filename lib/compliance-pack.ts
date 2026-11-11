// v80: the compliance pack on Send to LinkedIn. Every saved, unsent message
// sequence in one Word document, for a regulated adviser to pass to their
// compliance team before anything is approved. Built in the browser from
// what's saved, so it matches exactly what would be sent. No secrets here.

import { HEYREACH_MESSAGE_FIELDS, HEYREACH_MESSAGE_LABELS, type HeyReachMessages } from '@/lib/heyreach-shared'

export interface CompliancePerson {
  name: string
  role: string | null
  company: string | null
  profileUrl: string | null
  messages: Partial<HeyReachMessages>
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function para(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p.trim()).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

/** A Word-compatible (HTML) document. Opens in Word, Pages and Google Docs. */
export function compliancePackHtml(campaignName: string, people: CompliancePerson[], today = new Date()): string {
  const date = today.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
  const total = people.length * HEYREACH_MESSAGE_FIELDS.length
  const intro = [
    `${people.length} ${people.length === 1 ? 'person' : 'people'}, ${total} messages in all, for review before anything is sent.`,
    'They would be sent from the adviser’s own LinkedIn account, using HeyReach (a LinkedIn sending tool).',
    'Each person first gets a connection request with no note. Only if they accept do the messages below follow, in order, at the timings shown.',
    'If the person replies at any point, the remaining messages are not sent.',
    'Nothing is sent until each person is approved after this review. If any wording changes, the approved wording is exactly what is sent.',
  ]
  const blocks = people.map((p, i) => {
    const who = [p.role, p.company].filter(Boolean).join(', ')
    const messages = HEYREACH_MESSAGE_FIELDS.map((f, j) => {
      const text = (p.messages[f] || '').trim()
      return `<p class="label">Message ${j + 1}: ${esc(HEYREACH_MESSAGE_LABELS[f])}</p>${text ? para(text) : '<p><em>(not written)</em></p>'}`
    }).join('')
    return `<h2>${i + 1}. ${esc(p.name)}</h2>${who ? `<p class="who">${esc(who)}</p>` : ''}${p.profileUrl ? `<p class="who">${esc(p.profileUrl)}</p>` : ''}${messages}`
  })
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>${esc(campaignName)}: LinkedIn messages for compliance review</title>
<style>
body{font-family:Calibri,Arial,sans-serif;font-size:11pt;line-height:1.4}
h1{font-size:18pt;margin:0 0 4pt}
h2{font-size:13pt;margin:18pt 0 2pt}
p{margin:0 0 6pt}
.meta,.who{color:#555555}
.label{font-weight:bold;margin-top:10pt}
ul{margin:0 0 6pt 18pt}
</style></head>
<body>
<h1>LinkedIn messages for compliance review</h1>
<p class="meta">${esc(campaignName)} · ${esc(date)}</p>
<h2>About this request</h2>
<ul>${intro.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
${blocks.join('\n')}
</body></html>`
}

/** Starts the download in the browser. */
export function downloadCompliancePack(campaignName: string, people: CompliancePerson[]): void {
  const html = compliancePackHtml(campaignName, people)
  const blob = new Blob(['﻿', html], { type: 'application/msword' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const safe = campaignName.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Campaign'
  a.href = url
  a.download = `${safe} - LinkedIn messages for compliance - ${new Date().toISOString().slice(0, 10)}.doc`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}
