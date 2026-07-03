import type { ReactNode } from 'react';

export const metadata = {
  title: 'Agentic Turtles — Operator Oversight',
  description: 'SME operator oversight: Andon reviews, workloads, runs',
};

const nav: [string, string][] = [
  ['/', 'Inbox'],
  ['/workloads', 'Workloads'],
  ['/runs', 'Runs'],
  ['/backlog', 'Backlog'],
  ['/evidence', 'Evidence'],
];

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, color: '#1a202c' }}>
        <header style={{ display: 'flex', gap: '1.5rem', padding: '0.9rem 1.5rem', borderBottom: '1px solid #e2e8f0', alignItems: 'baseline' }}>
          <strong>🐢 Agentic Turtles</strong>
          <nav style={{ display: 'flex', gap: '1rem' }}>
            {nav.map(([href, label]) => (
              <a key={href} href={href} style={{ color: '#2b6cb0', textDecoration: 'none' }}>
                {label}
              </a>
            ))}
          </nav>
        </header>
        <main style={{ padding: '1.5rem', maxWidth: 900 }}>{children}</main>
      </body>
    </html>
  );
}
