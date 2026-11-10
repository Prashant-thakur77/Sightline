/** Public links shown on every public page. The video link appears once NEXT_PUBLIC_VIDEO_URL is set at build time. */
export const REPO_URL = 'https://github.com/Prashant-thakur77/Sightline';
export const VIDEO_URL: string | null = process.env.NEXT_PUBLIC_VIDEO_URL || null;
