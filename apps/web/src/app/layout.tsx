import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'DegenCage',
  description: 'A trading constitution you write while calm.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          padding: '3rem 1.5rem',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          background: '#0b0b0f',
          color: '#e6e6ea',
        }}
      >
        {children}
      </body>
    </html>
  );
}
