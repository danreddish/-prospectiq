import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

/**
 * /api/waitlist
 *
 * GET  → returns { count } of total signups (for the founding-member counter on the demo page)
 * POST → records a new signup in waitlist_signups table, returns { position }
 *
 * Static import only (do NOT use dynamic import — Netlify serverless functions can fail silently with it).
 */

// Server-side Supabase client (service role — bypasses RLS for inserts)
function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    throw new Error('Supabase env vars missing (NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY)')
  }
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

/* ============================================================================
   GET — total count (cheap, public, used for the live counter on /demo)
   ============================================================================ */

export async function GET() {
  try {
    const supabase = getSupabase()
    const { count, error } = await supabase
      .from('waitlist_signups')
      .select('*', { count: 'exact', head: true })

    if (error) {
      console.error('[waitlist GET] supabase error:', error.message)
      return NextResponse.json({ count: 0 }, { status: 200 })
    }

    return NextResponse.json({ count: count ?? 0 }, { status: 200 })
  } catch (err) {
    // Never break the demo page if the API can't reach Supabase — just return 0.
    console.error('[waitlist GET] unexpected:', err)
    return NextResponse.json({ count: 0 }, { status: 200 })
  }
}

/* ============================================================================
   POST — record a signup
   ============================================================================ */

interface WaitlistPayload {
  name?: string
  email?: string
  role?: string
  role_other?: string | null
  consent?: boolean
}

function validate(p: WaitlistPayload): string | null {
  if (!p.name || typeof p.name !== 'string' || p.name.trim().length < 2) {
    return 'Please add your name.'
  }
  if (
    !p.email ||
    typeof p.email !== 'string' ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)
  ) {
    return 'Please add a valid email.'
  }
  if (!p.role || typeof p.role !== 'string') {
    return 'Please select your role.'
  }
  if (p.role === 'other' && (!p.role_other || !p.role_other.trim())) {
    return 'Please tell us your role.'
  }
  if (p.consent !== true) {
    return 'Please tick the consent box.'
  }
  return null
}

export async function POST(req: NextRequest) {
  let payload: WaitlistPayload
  try {
    payload = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }

  const validationError = validate(payload)
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 })
  }

  const cleanName = payload.name!.trim()
  const cleanEmail = payload.email!.trim().toLowerCase()
  const cleanRole = payload.role!.trim()
  const cleanRoleOther = payload.role_other?.trim() || null

  let supabase
  try {
    supabase = getSupabase()
  } catch (err) {
    console.error('[waitlist POST] supabase init:', err)
    return NextResponse.json(
      { error: 'Server configuration error. Please try again later.' },
      { status: 500 }
    )
  }

  // Idempotent on email — if the same email comes back, return their existing position.
  // Schema sets email as UNIQUE, so we handle the duplicate gracefully.
  const { data: existing, error: existingError } = await supabase
    .from('waitlist_signups')
    .select('id, position')
    .eq('email', cleanEmail)
    .maybeSingle()

  if (existingError) {
    console.error('[waitlist POST] check existing:', existingError.message)
  }

  if (existing) {
    return NextResponse.json(
      {
        ok: true,
        already_registered: true,
        position: existing.position ?? null,
      },
      { status: 200 }
    )
  }

  // Insert new signup
  const { data: inserted, error: insertError } = await supabase
    .from('waitlist_signups')
    .insert({
      name: cleanName,
      email: cleanEmail,
      role: cleanRole,
      role_other: cleanRoleOther,
      consent: true,
    })
    .select('id, position')
    .single()

  if (insertError || !inserted) {
    console.error('[waitlist POST] insert:', insertError?.message)
    return NextResponse.json(
      { error: 'We could not record your signup. Please try again in a moment.' },
      { status: 500 }
    )
  }

  // Fire-and-forget sync to Brevo (do not block the response on this)
  syncToBrevo({
    email: cleanEmail,
    name: cleanName,
    role: cleanRole,
    role_other: cleanRoleOther,
    position: inserted.position ?? null,
  }).catch((err) => {
    console.error('[waitlist POST] brevo sync failed (non-fatal):', err)
  })

  return NextResponse.json(
    {
      ok: true,
      position: inserted.position ?? null,
    },
    { status: 200 }
  )
}

/* ============================================================================
   Brevo sync — fire-and-forget; failure must NOT break the signup flow
   ============================================================================ */

interface BrevoPayload {
  email: string
  name: string
  role: string
  role_other: string | null
  position: number | null
}

async function syncToBrevo(p: BrevoPayload): Promise<void> {
  const apiKey = process.env.BREVO_API_KEY
  const listIdRaw = process.env.BREVO_WAITLIST_LIST_ID

  if (!apiKey) {
    // Brevo isn't configured — that's fine, the signup is still recorded in Supabase.
    return
  }

  const listIds: number[] = []
  if (listIdRaw) {
    const parsed = parseInt(listIdRaw, 10)
    if (!isNaN(parsed)) listIds.push(parsed)
  }

  // Split name into first/last
  const nameParts = p.name.split(/\s+/)
  const firstName = nameParts[0] || ''
  const lastName = nameParts.slice(1).join(' ') || ''

  const body: Record<string, unknown> = {
    email: p.email,
    attributes: {
      FIRSTNAME: firstName,
      LASTNAME: lastName,
      ROLE: p.role,
      ROLE_OTHER: p.role_other,
      WAITLIST_POSITION: p.position,
      SOURCE: 'prospectiq_demo_waitlist',
    },
    updateEnabled: true,
  }

  if (listIds.length > 0) {
    body.listIds = listIds
  }

  const res = await fetch('https://api.brevo.com/v3/contacts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '(no body)')
    throw new Error(`Brevo API ${res.status}: ${text.slice(0, 200)}`)
  }
}
