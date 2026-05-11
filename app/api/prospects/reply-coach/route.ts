import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { generateReplyCoach } from '@/lib/ai-engine'
import { z } from 'zod'
import { ConversationTurn } from '@/types'

const ReplyCoachSchema = z.object({
  prospect_id: z.string().uuid(),
  prospect_reply: z.string().min(1).max(5000),
})

export async function POST(req: NextRequest) {
  const supabase = createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  }

  const body = await req.json()
  const parsed = ReplyCoachSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input' }, { status: 400 })
  }

  const { prospect_id, prospect_reply } = parsed.data

  // Fetch prospect with campaign context
  const { data: prospect, error: prospectError } = await supabase
    .from('prospects')
    .select('*, campaigns!inner(niche, sender_name, service_profile)')
    .eq('id', prospect_id)
    .eq('user_id', user.id)
    .single()

  if (prospectError || !prospect) {
    return NextResponse.json({ error: 'Prospect not found' }, { status: 404 })
  }

  // Get user profile for service profile fallback
  const { data: profile } = await supabase
    .from('profiles')
    .select('sender_name, service_profile')
    .eq('id', user.id)
    .single()

  // Merge service profiles (campaign overrides account)
  const accountSP = (profile?.service_profile || {}) as Record<string, string | null>
  const campaignSP = ((prospect as Record<string, unknown>).campaigns as Record<string, unknown>)?.service_profile as Record<string, string | null> || {}
  const serviceProfile = {
    what_you_do: campaignSP.what_you_do || accountSP.what_you_do || null,
    who_you_help: campaignSP.who_you_help || accountSP.who_you_help || null,
    key_outcomes: campaignSP.key_outcomes || accountSP.key_outcomes || null,
    minimum_threshold: campaignSP.minimum_threshold || accountSP.minimum_threshold || null,
    geographic_focus: campaignSP.geographic_focus || accountSP.geographic_focus || null,
  }

  const campaignData = (prospect as Record<string, unknown>).campaigns as Record<string, unknown>
  const senderName = (campaignData?.sender_name as string) || profile?.sender_name || 'Financial Advisor'

  // Get existing conversation history
  const existingConversations = (prospect.conversations || []) as ConversationTurn[]

  try {
    const result = await generateReplyCoach({
      prospect: {
        name: prospect.name,
        role: prospect.role,
        company: prospect.company,
        location: prospect.location,
        wealth_estimate: prospect.wealth_estimate,
        tier: prospect.tier,
        total_score: prospect.total_score,
        research_notes: prospect.research_notes,
        key_trigger: prospect.key_trigger,
        outreach: prospect.outreach || {},
      },
      prospectReply: prospect_reply,
      conversationHistory: existingConversations,
      senderName,
      serviceProfile,
    })

    // Save the prospect's reply to conversation history
    const newTurn: ConversationTurn = {
      from: 'prospect',
      message: prospect_reply,
      timestamp: new Date().toISOString(),
      step: 'reply',
    }

    const updatedConversations = [...existingConversations, newTurn]

    await supabase
      .from('prospects')
      .update({ conversations: updatedConversations })
      .eq('id', prospect_id)

    return NextResponse.json({
      ...result,
      conversation_count: updatedConversations.length,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Reply generation failed'
    console.error(`[ReplyCoach] FAILED for prospect ${prospect.name}:`, message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// Save a chosen reply to conversation history
export async function PUT(req: NextRequest) {
  const supabase = createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  }

  const body = await req.json()
  const { prospect_id, message } = body

  if (!prospect_id || !message) {
    return NextResponse.json({ error: 'Missing prospect_id or message' }, { status: 400 })
  }

  const { data: prospect } = await supabase
    .from('prospects')
    .select('conversations')
    .eq('id', prospect_id)
    .eq('user_id', user.id)
    .single()

  if (!prospect) {
    return NextResponse.json({ error: 'Prospect not found' }, { status: 404 })
  }

  const existingConversations = (prospect.conversations || []) as ConversationTurn[]
  const newTurn: ConversationTurn = {
    from: 'user',
    message,
    timestamp: new Date().toISOString(),
    step: 'reply',
  }

  const updatedConversations = [...existingConversations, newTurn]

  await supabase
    .from('prospects')
    .update({ conversations: updatedConversations })
    .eq('id', prospect_id)

  return NextResponse.json({
    success: true,
    conversation_count: updatedConversations.length,
  })
}
