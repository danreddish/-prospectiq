import { createClient } from '@/lib/supabase/server'
import { notFound, redirect } from 'next/navigation'
import { isAdmin } from '@/lib/admin'
import { linkedInProfileSlug } from '@/lib/linkedin'
import { canOpenSendToLinkedIn } from '@/lib/heyreach-route'
import HeyReachTest, { type TestRow } from './heyreach-test'

export const dynamic = 'force-dynamic'

// v77: HeyReach test for one campaign. v79: "Send to LinkedIn", for admins and
// for users with a HeyReach campaign assigned (the API routes enforce it too).
export default async function CampaignHeyReachPage({ params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')
  const admin = isAdmin(user.email)
  if (!(await canOpenSendToLinkedIn(supabase, user.id, user.email))) notFound()

  const { data: campaign } = await supabase
    .from('campaigns')
    .select('id, name, purpose, custom_instructions')
    .eq('id', params.id)
    .eq('user_id', user.id)
    .maybeSingle()
  if (!campaign || campaign.purpose === 'advisers') notFound()

  const { data: rows } = await supabase
    .from('prospects')
    .select('id, name, role, company, location, linkedin_url, status, total_score, tier, research_notes, heyreach')
    .eq('campaign_id', campaign.id)
    .eq('user_id', user.id)
    .order('total_score', { ascending: false })
    .limit(300)

  // Who is already in the Ulinc contacts or already sent to HeyReach.
  const slugs = Array.from(new Set((rows || []).map((r) => linkedInProfileSlug(r.linkedin_url)).filter((v): v is string => !!v)))
  const excluded: Record<string, 'ulinc' | 'heyreach'> = {}
  let exclusionsError = ''
  for (let i = 0; i < slugs.length; i += 100) {
    const { data, error } = await supabase
      .from('linkedin_exclusions')
      .select('profile_slug, source')
      .eq('user_id', user.id)
      .in('profile_slug', slugs.slice(i, i + 100))
    if (error) {
      exclusionsError = error.message
      break
    }
    for (const d of data || []) {
      if (d.source === 'ulinc' || !excluded[d.profile_slug]) excluded[d.profile_slug] = d.source as 'ulinc' | 'heyreach'
    }
  }

  return (
    <HeyReachTest
      admin={admin}
      campaign={{ id: campaign.id, name: campaign.name, customInstructions: campaign.custom_instructions || null }}
      initialRows={(rows || []) as TestRow[]}
      excludedBySlug={excluded}
      exclusionsError={exclusionsError}
    />
  )
}
