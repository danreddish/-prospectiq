// Force auth pages to render at request time, not build time.
// This prevents the Supabase client from being created during
// static generation when env vars are not yet available.
export const dynamic = 'force-dynamic'

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <>{children}</>
}
