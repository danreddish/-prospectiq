import { type EmailOtpType } from '@supabase/supabase-js'
import { type NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// v75.6: server-side email link handler (token hash flow).
//
// The Supabase email templates point here instead of at {{ .ConfirmationURL }}:
//   {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email&next=/dashboard
//   {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/auth/reset-password
//
// Unlike the PKCE code flow in /auth/callback, verifying a token hash does not
// need a code verifier cookie from the browser that started the flow. So the
// link works when someone signs up on a laptop and opens the email on a phone.
// /auth/callback stays in place for Google sign-in and for emails sent with
// the default templates.

const ALLOWED_TYPES: EmailOtpType[] = ['email', 'signup', 'recovery', 'invite', 'magiclink', 'email_change']

// Only allow same-site relative paths, so the link cannot bounce people to another site.
function safeNext(raw: string | null, fallback: string): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return fallback
  return raw
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const tokenHash = searchParams.get('token_hash')
  const type = searchParams.get('type') as EmailOtpType | null
  const fallback = type === 'recovery' ? '/auth/reset-password' : '/dashboard'
  const next = safeNext(searchParams.get('next'), fallback)

  if (tokenHash && type && ALLOWED_TYPES.includes(type)) {
    const supabase = createClient()
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash })

    if (!error) {
      return NextResponse.redirect(`${origin}${next}`)
    }
  }

  // Expired, already used, or malformed link. A failed reset link goes back to
  // "forgot password" to request a new one. Anything else goes to the login
  // page, which explains what to do.
  if (type === 'recovery') {
    return NextResponse.redirect(`${origin}/auth/forgot-password`)
  }
  return NextResponse.redirect(`${origin}/auth/login?error=link_expired`)
}
