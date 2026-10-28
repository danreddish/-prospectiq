// Daily alerts digest (v76.1). Each user with unread alerts from the last
// 24 hours gets one plain summary email through the Brevo transactional API.
// Runs only when BREVO_API_KEY and RECRUITMENT_DIGEST_FROM_EMAIL are both
// set; otherwise it skips silently.
//
// Relative imports only: bundled by Netlify's function bundler.

import { createServiceClient, usersWithRecruitment } from './watchlist-check'

interface AlertRow {
  user_id: string
  title: string
  alert_type: string
  created_at: string
}

export interface DigestResult {
  skipped: boolean
  reason?: string
  users: number
  sent: number
  failed: number
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export async function runAlertsDigest(now: Date = new Date()): Promise<DigestResult> {
  const apiKey = process.env.BREVO_API_KEY
  const fromEmail = process.env.RECRUITMENT_DIGEST_FROM_EMAIL
  if (!apiKey || !fromEmail) {
    console.log('[Digest] Skipped: BREVO_API_KEY or RECRUITMENT_DIGEST_FROM_EMAIL not set')
    return { skipped: true, reason: 'Brevo not configured', users: 0, sent: 0, failed: 0 }
  }

  const supabase = createServiceClient()
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()

  const { data: alerts, error } = await supabase
    .from('alerts')
    .select('user_id, title, alert_type, created_at')
    .is('read_at', null)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(2000)
  if (error) throw new Error(`Could not read alerts: ${error.message}`)

  const byUser = new Map<string, AlertRow[]>()
  for (const a of (alerts || []) as AlertRow[]) {
    const list = byUser.get(a.user_id) || []
    list.push(a)
    byUser.set(a.user_id, list)
  }
  if (byUser.size === 0) return { skipped: false, users: 0, sent: 0, failed: 0 }

  // Only users who still have Recruitment get the email.
  const userIds = Array.from(await usersWithRecruitment(supabase, Array.from(byUser.keys())))
  if (userIds.length === 0) return { skipped: false, users: 0, sent: 0, failed: 0 }
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, email, full_name')
    .in('id', userIds)

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || 'https://prospectiq.aiwealthpartners.co.uk').replace(/\/$/, '')
  const alertsUrl = `${appUrl}/dashboard/recruitment/alerts`
  let sent = 0
  let failed = 0

  for (const profile of profiles || []) {
    const list = byUser.get(profile.id) || []
    if (!profile.email || list.length === 0) continue
    const firstName = (profile.full_name || '').split(' ')[0] || 'there'
    const shown = list.slice(0, 20)
    const more = list.length - shown.length
    const subject = `${list.length} watchlist alert${list.length === 1 ? '' : 's'} from ProspectIQ`

    const textContent = [
      `Hi ${firstName},`,
      '',
      `Your recruitment watchlist picked up ${list.length} change${list.length === 1 ? '' : 's'} on the FCA Register in the last 24 hours.`,
      '',
      ...shown.map((a) => `- ${a.title}`),
      ...(more > 0 ? [`- and ${more} more`] : []),
      '',
      `See them all: ${alertsUrl}`,
      '',
      'ProspectIQ',
    ].join('\n')

    const htmlContent = `<p>Hi ${escapeHtml(firstName)},</p>
<p>Your recruitment watchlist picked up ${list.length} change${list.length === 1 ? '' : 's'} on the FCA Register in the last 24 hours.</p>
<ul>${shown.map((a) => `<li>${escapeHtml(a.title)}</li>`).join('')}${more > 0 ? `<li>and ${more} more</li>` : ''}</ul>
<p><a href="${alertsUrl}">See them all in ProspectIQ</a></p>
<p>ProspectIQ</p>`

    try {
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          sender: { email: fromEmail, name: 'ProspectIQ' },
          to: [{ email: profile.email, name: profile.full_name || undefined }],
          subject,
          textContent,
          htmlContent,
        }),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`Brevo ${res.status}: ${body.slice(0, 200)}`)
      }
      sent++
    } catch (err) {
      failed++
      console.error(`[Digest] send failed for ${profile.id}:`, err instanceof Error ? err.message : err)
    }
  }

  console.log(`[Digest] users ${byUser.size}, sent ${sent}, failed ${failed}`)
  return { skipped: false, users: byUser.size, sent, failed }
}
