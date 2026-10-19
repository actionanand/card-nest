import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
if (process.env.CAPACITOR_PLATFORM_NAME === 'android') {
  const root = 'dist/card-nest/browser';
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
    );
  const scripts = walk(root).filter((path) => path.endsWith('.js'));
  if (!scripts.some((path) => readFileSync(path, 'utf8').includes('CardNestSms')))
    throw new Error(
      'Android SMS frontend is missing. Run npm run build:android before Capacitor sync.',
    );
}
