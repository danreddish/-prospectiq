// Admin accounts. No imports, so the Netlify scheduled functions (which are
// bundled without the "@/" path alias) can use it too.
export const ADMIN_EMAILS = ['dan.reddish@gmail.com', 'dan@aiwealthpartners.co.uk']

export function isAdmin(email: string | null | undefined): boolean {
  return !!email && ADMIN_EMAILS.includes(email.trim().toLowerCase())
}
