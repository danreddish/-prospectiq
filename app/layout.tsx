import type { Metadata } from 'next'
import { Toaster } from 'sonner'
import './globals.css'

export const metadata: Metadata = {
  title: 'ProspectIQ | AI-Powered HNW Prospect Intelligence',
  description: 'Turn any LinkedIn profile into a scored prospect dossier with personalised outreach messages in under 60 seconds.',
  openGraph: {
    title: 'ProspectIQ | AI-Powered HNW Prospect Intelligence',
    description: 'Research, score, and sequence HNW prospects in under a minute.',
    url: 'https://prospectiq.uk',
    siteName: 'ProspectIQ',
    type: 'website',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-brand-dark text-brand-cream font-body antialiased">
        {children}
        <Toaster
          theme="dark"
          toastOptions={{
            style: {
              background: '#3d3d3d',
              border: '1px solid #5d5d5d',
              color: '#f5f0ed',
            },
          }}
        />
      </body>
    </html>
  )
}
