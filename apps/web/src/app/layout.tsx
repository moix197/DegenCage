import { Geist } from 'next/font/google';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

import './globals.css';

const geist = Geist({ subsets: ['latin'], variable: '--font-sans' });

export const metadata: Metadata = {
  title: 'DegenCage',
  description: 'A trading constitution you write while calm.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={cn('dark font-sans', geist.variable)}>
      <body className="bg-background text-foreground px-6 py-12">{children}</body>
    </html>
  );
}
