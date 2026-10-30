'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { parseCsv } from '@/lib/csv'
import { linkedInProfileSlug } from '@/lib/linkedin'
import { HEYREACH_TEST_CAMPAIGN } from '@/lib/heyreach-shared'

interface CampaignCheck {
  keySet: boolean
  keyValid?: boolean
  campaign?: { id: number; name: string; status: string; accountIds: number[]; pushable: boolean } | null
  problem?: string | null
}

export default function HeyReachSetup({
  exclusionCount,
  campaigns,
}: {
  exclusionCount: number
  campaigns: { id: string; name: string }[]
}) {
  const [total, setTotal] = useState(exclusionCount)
  const [uploading, setUploading] = useState(false)
  const [uploadNote, setUploadNote] = useState('')
  const [check, setCheck] = useState<CampaignCheck | null>(null)
  const [checking, setChecking] = useState(false)

  async function runCheck() {
    setChecking(true)
    try {
      const res = await fetch('/api/heyreach/campaign', { cache: 'no-store' })
      setCheck(await res.json())
    } catch {
      setCheck({ keySet: false, problem: 'Could not reach ProspectIQ. Try again.' })
    } finally {
      setChecking(false)
    }
  }

  useEffect(() => {
    runCheck()
  }, [])

  async function handleFile(file: File) {
    setUploading(true)
    setUploadNote('Reading the file...')
    try {
      const text = await file.text()
      const rows = parseCsv(text)
      if (rows.length < 2) throw new Error('The file has no rows.')
      const header = rows[0].map((h) => h.trim().toLowerCase())
      // Ulinc calls it "LinkedIn profile". Otherwise use the column with the most /in/ links.
      let col = header.findIndex((h) => h === 'linkedin profile')
      if (col === -1) {
        let best = -1
        let bestCount = 0
        for (let c = 0; c < header.length; c++) {
          const n = rows.slice(1, 200).filter((r) => linkedInProfileSlug(r[c])).length
          if (n > bestCount) {
            best = c
            bestCount = n
          }
        }
        col = best
      }

      const slugs = new Set<string>()
      let noProfile = 0
      if (col !== -1) {
        for (const r of rows.slice(1)) {
          const slug = linkedInProfileSlug(r[col])
          if (slug) slugs.add(slug)
          else noProfile++
        }
      }
      // Belt and braces: also take every /in/ link anywhere in the file, in
      // case a stray quote shifted columns. Excluding a few extra is safe.
      const fromColumn = slugs.size
      const linkRe = /linkedin\.com\/in\/[^\s,"'<>]+/gi
      let m: RegExpExecArray | null
      while ((m = linkRe.exec(text)) !== null) {
        const slug = linkedInProfileSlug(m[0])
        if (slug) slugs.add(slug)
      }
      if (slugs.size === 0) throw new Error('No LinkedIn /in/ profile links found in the file.')

      // Member-ID links (/in/ACwAA..., /in/ACoAA...) can't be matched with
      // the profile links Apollo returns, so those people may slip through.
      const memberIds = Array.from(slugs).filter((s) => /^ac[wo]aa/.test(s)).length

      const all = Array.from(slugs)
      let uploadId: string | undefined
      let saved = 0
      let removed = 0
      for (let i = 0; i < all.length; i += 5000) {
        setUploadNote(`Saving ${Math.min(i + 5000, all.length).toLocaleString('en-GB')} of ${all.length.toLocaleString('en-GB')}...`)
        const res = await fetch('/api/heyreach/exclusions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slugs: all.slice(i, i + 5000), upload_id: uploadId, final: i + 5000 >= all.length }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(`${data.error || 'Upload failed'} Your previous list is unchanged.`)
        uploadId = data.upload_id
        saved += data.saved
        removed = data.removed || 0
        setTotal(data.ulinc ?? data.total)
      }
      const parts = [
        `Saved ${saved.toLocaleString('en-GB')} LinkedIn profiles from ${(rows.length - 1).toLocaleString('en-GB')} rows.`,
        slugs.size > fromColumn ? `${(slugs.size - fromColumn).toLocaleString('en-GB')} more were found elsewhere in the file.` : '',
        noProfile > 0 ? `${noProfile.toLocaleString('en-GB')} rows had no usable /in/ link (for example Sales Navigator links), so they can't be matched.` : '',
        memberIds > 0 ? `${memberIds.toLocaleString('en-GB')} are member-ID links that won't match Apollo's profile links.` : '',
        removed > 0 ? `${removed.toLocaleString('en-GB')} no longer in the export were removed.` : '',
      ]
      setUploadNote(parts.filter(Boolean).join(' '))
      toast.success('Ulinc contacts saved')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload failed'
      setUploadNote(message)
      toast.error(message)
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="p-8 max-w-3xl space-y-8">
      <div>
        <p className="text-brand-rose-gold text-[10px] font-bold tracking-[2px] uppercase mb-1">Admin</p>
        <h1 className="text-2xl font-display text-brand-cream">HeyReach</h1>
        <p className="text-brand-beige text-sm mt-1">
          Send approved prospects and their four LinkedIn messages into HeyReach. Admin only for now.
        </p>
        <Link href="/dashboard/heyreach/pipeline" className="text-brand-rose-gold text-xs font-semibold hover:underline inline-block mt-2">
          See the LinkedIn pipeline &rarr;
        </Link>
      </div>

      <section className="border border-brand-charcoal rounded-lg p-5">
        <h2 className="text-brand-cream font-semibold">1. Your Ulinc contacts</h2>
        <p className="text-brand-beige text-sm mt-1">
          Upload your Ulinc contact export (CSV). Find skips anyone on it, and HeyReach approval and sending refuse them, so nobody is contacted twice. A new upload replaces the old list once it has fully saved. People already sent to HeyReach stay excluded either way.
        </p>
        <p className="text-brand-cream text-sm mt-3">
          Ulinc profiles on your list now: <span className="font-semibold">{total.toLocaleString('en-GB')}</span>
        </p>
        <label className={`btn-primary text-sm inline-block mt-4 cursor-pointer ${uploading ? 'opacity-50 pointer-events-none' : ''}`}>
          {uploading ? 'Uploading...' : 'Upload Ulinc export'}
          <input
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            disabled={uploading}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) handleFile(f)
              e.target.value = ''
            }}
          />
        </label>
        {uploadNote && <p className="text-brand-beige text-xs mt-3">{uploadNote}</p>}
      </section>

      <section className="border border-brand-charcoal rounded-lg p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-brand-cream font-semibold">2. HeyReach connection</h2>
          <button onClick={runCheck} disabled={checking} className="btn-secondary text-xs px-3 py-1.5">
            {checking ? 'Checking...' : 'Check again'}
          </button>
        </div>
        {!check ? (
          <p className="text-brand-beige text-sm mt-2">Checking...</p>
        ) : (
          <div className="text-sm mt-3 space-y-1">
            <p className="text-brand-cream">API key: {check.keySet ? (check.keyValid === false ? 'set, but rejected' : 'set') : 'not set'}</p>
            {check.campaign && (
              <p className="text-brand-cream">
                Campaign &ldquo;{check.campaign.name}&rdquo;: {check.campaign.status || 'unknown status'}, {check.campaign.accountIds.length} sender account
                {check.campaign.accountIds.length === 1 ? '' : 's'}
              </p>
            )}
            {check.problem ? (
              <p className="text-red-400">{check.problem}</p>
            ) : (
              <p className="text-green-400">Ready. New leads will go into &ldquo;{HEYREACH_TEST_CAMPAIGN}&rdquo;.</p>
            )}
          </div>
        )}
      </section>

      <section className="border border-brand-charcoal rounded-lg p-5">
        <h2 className="text-brand-cream font-semibold">3. Run a test from a campaign</h2>
        <p className="text-brand-beige text-sm mt-1">Pick the campaign whose researched prospects you want to send.</p>
        <div className="mt-3 divide-y divide-brand-charcoal border border-brand-charcoal rounded-lg">
          {campaigns.length === 0 && <p className="p-4 text-brand-beige text-sm">No campaigns yet.</p>}
          {campaigns.map((c) => (
            <Link key={c.id} href={`/dashboard/campaigns/${c.id}/heyreach`} className="flex justify-between p-3 text-sm hover:bg-brand-charcoal-deep/40">
              <span className="text-brand-cream">{c.name}</span>
              <span className="text-brand-rose-gold text-xs font-semibold">Open HeyReach test</span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  )
}
