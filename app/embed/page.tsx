import type { Metadata, Viewport } from 'next'
import PhoneDemo from '@/components/demo/PhoneDemo'

export const metadata: Metadata = {
  title: 'ProspectIQ Demo',
  robots: { index: false, follow: false },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
  themeColor: '#0a0a0a',
}

export default function EmbedPage() {
  return (
    <main className="fixed inset-0 h-full w-full overflow-hidden bg-[#0a0a0a]">
      <PhoneDemo variant="embed" />
    </main>
  )
}
