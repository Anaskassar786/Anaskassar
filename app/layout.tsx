import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Trading AI AK — Position Trading Council',
  description:
    'Private multi-agent position trading decision-support system for XAU/USD and forex. No execution. No fabricated data.',
  robots: { index: false, follow: false }
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
