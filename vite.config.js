import { defineConfig } from 'vite';
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

// Fills the service worker's precache list with every built file (all vendored, nothing external).
function precachePlugin() {
  let outDir;
  return {
    name: 'oa-precache',
    apply: 'build',
    configResolved(c) { outDir = join(c.root, c.build.outDir); },
    closeBundle() {
      const files = walk(outDir).map((p) => relative(outDir, p).split('\\').join('/')).filter((f) => f !== 'sw.js');
      const hash = createHash('sha256');
      for (const f of files.sort()) hash.update(f).update(readFileSync(join(outDir, f)));
      const urls = ['./', ...files.map((f) => './' + f)];
      const swPath = join(outDir, 'sw.js');
      writeFileSync(
        swPath,
        readFileSync(swPath, 'utf8')
          .replace('__PRECACHE__', JSON.stringify(urls))
          .replace('__VERSION__', hash.digest('hex').slice(0, 12)),
      );
    },
  };
}

export default defineConfig({
  base: './',
  build: { target: 'es2022', modulePreload: { polyfill: false }, assetsInlineLimit: 0 },
  plugins: [precachePlugin()],
});
