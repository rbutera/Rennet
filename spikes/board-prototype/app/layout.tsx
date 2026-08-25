import type { Metadata, Viewport } from 'next'
import { Fraunces, Geist, Geist_Mono, Newsreader } from 'next/font/google'
import './globals.css'
import { Shell } from '@/components/shell'

const geist = Geist({ subsets: ['latin'], variable: '--font-geist-sans' })
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono' })
const fraunces = Fraunces({ subsets: ['latin'], variable: '--font-fraunces' })
const newsreader = Newsreader({ subsets: ['latin'], variable: '--font-newsreader' })

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
      data-scheme="dark"
      className={`dark bg-background ${geist.variable} ${geistMono.variable} ${fraunces.variable} ${newsreader.variable}`}
    >
      <body className="antialiased font-sans">
        <Shell>{children}</Shell>
      </body>
    </html>
  )
}
