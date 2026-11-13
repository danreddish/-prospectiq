// v82: the compliance PDF on a campaign page. The adviser ticks researched
// people and gets one PDF of the messages written for each, to pass to their
// compliance team before anything is sent. Built in the browser from what is
// saved, so it matches what is on screen. No secrets here.

import type { jsPDF } from 'jspdf'

export interface CompliancePdfMessage {
  label: string
  text: string
}

export interface CompliancePdfPerson {
  name: string
  role: string | null
  company: string | null
  profileUrl: string | null
  /** 'linkedin' = the saved Send to LinkedIn sequence; 'draft' = the outreach drafted on the campaign page. */
  kind: 'linkedin' | 'draft'
  messages: CompliancePdfMessage[]
}

/**
 * The PDF's built-in font only covers Western European characters. Curly
 * quotes, long dashes and the like become their plain forms; an accented
 * letter outside the set loses its accent; anything else (emoji) is dropped.
 */
export function pdfSafe(text: string): string {
  const swapped = text
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/…/g, '...')
    .replace(/[  -  ]/g, ' ')
    .replace(/[​-‍﻿]/g, '')
    .replace(/•/g, '-')
  let out = ''
  for (const ch of Array.from(swapped)) {
    const code = ch.codePointAt(0) || 0
    if (code === 10 || (code >= 32 && code <= 255)) {
      out += ch
      continue
    }
    const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '')
    if (base && Array.from(base).every((c) => (c.codePointAt(0) || 0) < 128)) out += base
  }
  return out
}

function intro(people: CompliancePdfPerson[]): string[] {
  const total = people.reduce((n, p) => n + p.messages.length, 0)
  const linkedin = people.filter((p) => p.kind === 'linkedin').length
  const draft = people.length - linkedin
  const lines = [
    `${people.length} ${people.length === 1 ? 'person' : 'people'}, ${total} messages in all, for review before anything is sent.`,
    "The messages would be sent from the adviser's own LinkedIn account.",
  ]
  if (linkedin > 0) {
    lines.push(
      `${draft > 0 ? `${linkedin} of the people are` : 'They are'} set up for automated sending through HeyReach (a LinkedIn sending tool). Each first gets a connection request with no note. Only if they accept do the messages follow, in order, at the timings shown. If the person replies at any point, the remaining messages are not sent.`
    )
  }
  if (draft > 0) {
    lines.push(
      `${linkedin > 0 ? `${draft} of the people have` : 'These are'} draft outreach, marked as such. The adviser sends these by hand; they are not an automated sequence.`
    )
  }
  lines.push('Nothing is sent until each person is approved after this review. If any wording changes, the approved wording is exactly what is sent.')
  return lines
}

/** Draws the document. Kept apart from the download so it can be tested. */
export function buildCompliancePdf(doc: jsPDF, campaignName: string, people: CompliancePdfPerson[], today = new Date()): jsPDF {
  const pageW = doc.internal.pageSize.getWidth()
  const pageH = doc.internal.pageSize.getHeight()
  const left = 18
  const right = pageW - 18
  const width = right - left
  const top = 20
  const bottom = pageH - 20
  let y = top

  const lineH = (size: number) => size * 0.3528 * 1.4
  function need(height: number) {
    if (y + height > bottom) {
      doc.addPage()
      y = top
    }
  }
  /** Wrapped text. `keep` extra millimetres must also fit, so a label is never left alone at the foot of a page. */
  function write(text: string, size: number, opts: { bold?: boolean; grey?: boolean; indent?: number; keep?: number; after?: number } = {}) {
    doc.setFont('helvetica', opts.bold ? 'bold' : 'normal')
    doc.setFontSize(size)
    doc.setTextColor(opts.grey ? 95 : 20)
    const x = left + (opts.indent || 0)
    const lines = doc.splitTextToSize(pdfSafe(text), width - (opts.indent || 0)) as string[]
    const h = lineH(size)
    lines.forEach((line, i) => {
      need(h + (i === 0 ? opts.keep || 0 : 0))
      doc.text(line, x, y + h * 0.75)
      y += h
    })
    y += opts.after ?? 0
  }

  const date = today.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
  write('LinkedIn messages for compliance review', 17, { bold: true, after: 1 })
  write(`${campaignName} - ${date}`, 10, { grey: true, after: 5 })
  write('About this request', 12, { bold: true, after: 1.5 })
  for (const line of intro(people)) {
    need(lineH(10))
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(10)
    doc.setTextColor(20)
    doc.text('-', left + 1, y + lineH(10) * 0.75)
    write(line, 10, { indent: 5, after: 1.2 })
  }

  people.forEach((p, i) => {
    y += 6
    write(`${i + 1}. ${p.name}`, 13, { bold: true, keep: 24, after: 0.5 })
    const who = [p.role, p.company].filter(Boolean).join(', ')
    if (who) write(who, 9.5, { grey: true })
    if (p.profileUrl) write(p.profileUrl, 9.5, { grey: true })
    if (p.kind === 'draft') write('Draft outreach, sent by hand. Not an automated sequence.', 9.5, { grey: true })
    for (const m of p.messages) {
      y += 3.5
      write(m.label, 10.5, { bold: true, keep: lineH(10.5) * 2, after: 0.8 })
      const text = m.text.trim()
      if (!text) {
        write('(not written)', 10.5, { grey: true })
        continue
      }
      text.split(/\n{2,}/).forEach((para, j, all) => {
        write(para.trim(), 10.5, { after: j < all.length - 1 ? 2 : 0 })
      })
    }
  })

  const pages = doc.getNumberOfPages()
  for (let n = 1; n <= pages; n++) {
    doc.setPage(n)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8.5)
    doc.setTextColor(120)
    doc.text(pdfSafe(campaignName).slice(0, 70), left, pageH - 10)
    doc.text(`Page ${n} of ${pages}`, right, pageH - 10, { align: 'right' })
  }
  return doc
}

export function compliancePdfFileName(campaignName: string, today = new Date()): string {
  const safe = pdfSafe(campaignName).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Campaign'
  return `${safe} - LinkedIn messages for compliance - ${today.toISOString().slice(0, 10)}.pdf`
}

/** Builds the PDF and starts the download in the browser. The library loads only when asked for. */
export async function downloadCompliancePdf(campaignName: string, people: CompliancePdfPerson[]): Promise<void> {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  buildCompliancePdf(doc, campaignName, people)
  doc.save(compliancePdfFileName(campaignName))
}
