import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { NotificationIslandProvider } from '@/components/notification-island';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'InstantCap | Movie project workspace',
  description: 'Upload video projects, view server-reported processing status, and inspect saved outputs.',
  other: {
    'page-type': 'software',
    'site-kind': 'software',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="my" data-type="software" data-radius="round" data-buttons="solid" data-motion="quiet">
      <body className={inter.className}><NotificationIslandProvider>{children}</NotificationIslandProvider></body>
    </html>
  );
}
