import type { Metadata, Viewport } from 'next'
import { DM_Sans, Fraunces, Source_Serif_4 } from 'next/font/google'
import './globals.css'
import { Shell } from '@/components/shell'

const dmSans = DM_Sans({ subsets: ['latin'], variable: '--font-dm-sans' })
const fraunces = Fraunces({ subsets: ['latin'], variable: '--font-fraunces' })
const sourceSerif = Source_Serif_4({ subsets: ['latin'], variable: '--font-source-serif' })

export const metadata: Metadata = {
  title: 'Rennet',
  description: 'Agent coding harness for reviewing large agent-written changes.',
  generator: 'v0.app',
  icons: {
    icon: [{ url: '/icon.svg', type: 'image/svg+xml' }],
  },
}

export const viewport: Viewport = {
  colorScheme: 'dark',
  themeColor: '#0a0a0a',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      className={`dark bg-background ${dmSans.variable} ${fraunces.variable} ${sourceSerif.variable}`}
    >
      <body className="antialiased font-sans">
        <Shell>{children}</Shell>
      </body>
    </html>
  )
}
