/**
 * Vite build for the MV3 extension.
 *
 * `@crxjs/vite-plugin` owns the extension wiring: it reads `manifest.config.ts`,
 * bundles the service worker and both content scripts with the right formats,
 * and rewrites the manifest to the emitted asset paths. Everything below is the
 * remaining project-specific work — the DevTools panel page, which the manifest
 * cannot reference, the generated icons, and a packaging check.
 */

import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { crx } from '@crxjs/vite-plugin';
import preact from '@preact/preset-vite';
import tailwind from '@tailwindcss/vite';
import { build, defineConfig, type Plugin } from 'vite';
import manifest from './manifest.config.ts';
import { ICON_SIZES, renderIcon } from './tools/icons.ts';
import { validateDist } from './tools/validate-dist.ts';

/** Rasterizes the icons into the bundle so no binaries live in the repository. */
function icons(): Plugin {
  return {
    name: 'residency:icons',
    generateBundle() {
      for (const size of ICON_SIZES) {
        this.emitFile({
          type: 'asset',
          fileName: `icons/icon${size}.png`,
          source: renderIcon(size),
        });
      }
    },
  };
}

/**
 * Builds the sandboxed test runner as one inlined classic script.
 *
 * A sandboxed page loads at an opaque origin, and a `type="module"` script is
 * always fetched with CORS — from origin `null`, against a `chrome-extension://`
 * URL, which does not resolve. Vite also marks its module scripts `crossorigin`,
 * so the page would simply never execute. Bundling to an IIFE and inlining it
 * sidesteps the fetch entirely: there is nothing left to load.
 */
function sandboxPage(outDir: string): Plugin {
  let built = false;
  return {
    name: 'residency:sandbox',
    apply: 'build',
    async closeBundle() {
      if (built) {
        return;
      }
      built = true;
      const scratch = join(outDir, '.sandbox');
      await build({
        configFile: false,
        logLevel: 'error',
        define: { 'process.env.NODE_ENV': '"production"' },
        build: {
          outDir: scratch,
          emptyOutDir: true,
          target: 'chrome111',
          lib: {
            entry: resolve('src/sandbox/main.ts'),
            formats: ['iife'],
            name: 'residencySandbox',
            fileName: () => 'sandbox.js',
          },
        },
      });
      const code = await readFile(join(scratch, 'sandbox.js'), 'utf8');
      await rm(scratch, { recursive: true, force: true });
      await writeFile(
        join(outDir, 'sandbox.html'),
        `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Residency test runner</title>
  </head>
  <body>
    <script>${code}</script>
  </body>
</html>
`,
      );
      this.info(`sandbox inlined — ${String(Math.round(code.length / 1024))} KB of runner + chai`);
    },
  };
}

/** Fails the build when `dist/` would not load as an unpacked extension. */
function verifyPackage(outDir: string): Plugin {
  return {
    name: 'residency:verify-package',
    apply: 'build',
    async closeBundle() {
      const { pages, references } = await validateDist(outDir);
      this.info(`manifest ok — ${String(references)} references, ${String(pages)} pages`);
    },
  };
}

const OUT_DIR = 'dist';

export default defineConfig({
  plugins: [
    preact(),
    tailwind(),
    crx({ manifest }),
    icons(),
    sandboxPage(OUT_DIR),
    verifyPackage(OUT_DIR),
  ],
  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    target: 'chrome111',
    sourcemap: false,
    rollupOptions: {
      // The DevTools panel is registered from `devtools.ts` at runtime, so the
      // manifest never names it and CRXJS cannot discover it.
      input: { panel: 'panel.html' },
    },
  },
});
