/** Builds an offline preview of the UI pages, with an axe-core variant. */

import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import preact from '@preact/preset-vite';
import { build } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '..', '..');
const out = join(app, 'build', 'preview');
const PAGES = [
  { name: 'popup', entry: 'src/ui/popup/main.tsx', body: '' },
  { name: 'panel', entry: 'src/ui/panel/main.tsx', body: ' class="h-screen overflow-hidden"' },
  { name: 'options', entry: 'src/ui/options/main.tsx', body: '' },
];

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(join(app, 'dist'), out, { recursive: true });
await cp(join(here, 'stub.js'), join(out, 'stub.js'));
// axe-core is installed only for an audit run, so the preview still builds
// without it — the *-axe.html pages just have nothing to report with.
const axeSource = join(app, '..', '..', 'node_modules', 'axe-core', 'axe.min.js');
const hasAxe = existsSync(axeSource);
if (hasAxe) {
  await cp(axeSource, join(out, 'axe.min.js'));
}

const css = (await readdir(join(out, 'assets'))).find((file) => file.endsWith('.css'));

for (const page of PAGES) {
  await build({
    root: app,
    configFile: false,
    logLevel: 'error',
    plugins: [preact()],
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      outDir: join(out, `bundle-${page.name}`),
      emptyOutDir: true,
      target: 'chrome111',
      cssCodeSplit: false,
      lib: {
        entry: join(app, page.entry),
        formats: ['iife'],
        name: `p_${page.name}`,
        fileName: () => `${page.name}-iife.js`,
      },
    },
  });
  await cp(
    join(out, `bundle-${page.name}`, `${page.name}-iife.js`),
    join(out, `${page.name}-iife.js`),
  );
}

/*
 * These were fixed timeouts racing the render, which made the panel audit flaky
 * in the direction that hurts most: a run that scanned a half-built page and
 * called it clean. They now wait for what they need and fail loudly otherwise.
 */
const WAIT_FOR = `<script>
  window.__waitFor = (selector, label) => new Promise((resolve, reject) => {
    const deadline = Date.now() + 8000;
    const look = () => {
      const found = document.querySelector(selector);
      if (found) { resolve(found); return; }
      if (Date.now() > deadline) { reject(new Error('never rendered: ' + label)); return; }
      // A timer, not requestAnimationFrame: the audit runs headless under a
      // virtual-time budget, which advances timers but not animation frames.
      setTimeout(look, 16);
    };
    look();
  });
  window.__prepared = Promise.resolve();
</script>`;

const AXE = `
<script src="axe.min.js"></script>
<script>
  addEventListener('load', async () => {
    const pre = document.createElement('pre');
    pre.id = 'axe-out';
    try {
      await window.__prepared;
      const results = await axe.run(document, { resultTypes: ['violations'] });
      pre.textContent = 'AXE_RESULT:' + JSON.stringify(results.violations.map((v) => ({
        id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')),
      })));
    } catch (cause) {
      // Reported as a violation rather than swallowed: a page that never built
      // must not come back clean.
      pre.textContent = 'AXE_RESULT:' + JSON.stringify([
        { id: 'page-not-ready', impact: 'critical', help: String((cause && cause.message) || cause), nodes: [] },
      ]);
    }
    document.body.append(pre);
  });
</script>`;

// The panel is audited with a row selected, so the detail pane is in scope.
const SELECT = `<script>
  window.__prepared = window.__waitFor('[role="row"][tabindex]', 'a request row')
    .then((row) => { row.click(); });
</script>`;

for (const page of PAGES) {
  const shell = (extra) => `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${page.name}</title>
  <!-- An extension page is never served over http, so the browser's automatic
       /favicon.ico probe only happens in this harness — and its 404 was the
       only thing keeping the Lighthouse best-practices score off 100. -->
  <link rel="icon" href="data:," />
  <link rel="stylesheet" href="assets/${css}" /></head>
  <body${page.body}><script src="stub.js"></script><div id="root"></div>
  ${WAIT_FOR}
  <script src="${page.name}-iife.js"></script>${extra}</body>
</html>
`;
  await writeFile(join(out, `${page.name}-preview.html`), shell(''));
  if (hasAxe) {
    await writeFile(
      join(out, `${page.name}-axe.html`),
      shell(page.name === 'panel' ? SELECT + AXE : AXE),
    );
  }
  if (page.name === 'panel') {
    await writeFile(join(out, 'panel-selected.html'), shell(SELECT));
  }
}
console.log('preview ready:', out);
