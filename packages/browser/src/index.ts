/**
 * Read-only page reads for listings: quoted text spans, an archived snapshot and an axe audit.
 * Runs on KERNEL cloud browsers when KERNEL_API_KEY is set. Never clicks buy buttons, never
 * submits forms, respects robots.txt and identifies itself honestly.
 */
export interface PageRead {
  url: string;
  fetchedAt: string;
  title: string;
  /** Visible text, used to verify quoted spans verbatim. */
  text: string;
  /** Quotes that answer the questions asked, each found verbatim in `text`. */
  answers: { question: string; quote: string | null }[];
  axe?: { violations: { id: string; impact: string | null; nodes: number }[] };
  archive?: { screenshotPng?: Uint8Array; html?: string };
}

export interface PageReader {
  read(url: string, questions: string[]): Promise<PageRead>;
}

export class BrowserNotConfiguredError extends Error {
  constructor() {
    super('KERNEL_API_KEY is not configured');
    this.name = 'BrowserNotConfiguredError';
  }
}

export const USER_AGENT = 'SightlineReader/0.1 (accessibility; read-only)';
