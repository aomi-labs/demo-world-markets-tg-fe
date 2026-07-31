import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'World Markets → Telegram agent (aomi handover demo)',
  description:
    'Reference frontend for the aomi partner web → Telegram agent handover.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
