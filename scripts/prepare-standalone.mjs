// Copies static assets next to the standalone server, as Next.js expects, and the eval results
// the judge page reads at request time.
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const standalone = path.join(root, 'apps/web/.next/standalone');
await cp(path.join(root, 'apps/web/public'), path.join(standalone, 'apps/web/public'), { recursive: true });
await cp(path.join(root, 'apps/web/.next/static'), path.join(standalone, 'apps/web/.next/static'), { recursive: true });
await mkdir(path.join(standalone, 'evals'), { recursive: true });
await cp(path.join(root, 'evals/results'), path.join(standalone, 'evals/results'), { recursive: true }).catch(() => {});
await cp(path.join(root, 'packages/db/migrations'), path.join(standalone, 'packages/db/migrations'), { recursive: true }).catch(() => {});
console.log('standalone assets ready');
