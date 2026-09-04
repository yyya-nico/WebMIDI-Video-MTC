import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'MTC SYNC — Web MIDI Video Synchronizer',
  description: 'MIDI Time Codeに動画を同期し、ミリ秒単位でタイミングを調整できるブラウザーツール。',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
