import type { NextConfig } from 'next';
import path from 'node:path';

const config: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  outputFileTracingRoot: path.join(import.meta.dirname, '../../'),
  transpilePackages: [
    '@sightline/agent',
    '@sightline/catalog',
    '@sightline/core',
    '@sightline/db',
    '@sightline/evidence',
    '@sightline/gate',
    '@sightline/paypal',
  ],
  serverExternalPackages: ['pg', 'pg-boss', 'sharp'],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(self), geolocation=()' },
        ],
      },
    ];
  },
};

export default config;
