// Static checks on the UI wiring. They catch the classic regressions (a renamed id, an inline style the CSP would block)
// without needing a browser. The browser behaviour itself was exercised separately with a headless browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const dir = join(fileURLToPath(new URL('..', import.meta.url)), 'public');
const html = readFileSync(join(dir, 'index.html'), 'utf8'), app = readFileSync(join(dir, 'app.js'), 'utf8'), css = readFileSync(join(dir, 'styles.css'), 'utf8');
const ids = new Set([...html.matchAll(/\sid="([\w-]+)"/g)].map((m) => m[1]));

test('every element id the app looks up exists in the page, and ids are unique', () => {
  const used = new Set([...app.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]).concat([...app.matchAll(/\$\(`view-\$\{[^}]+\}`\)/g)].length ? ['view-workspace', 'view-compare', 'view-models', 'view-settings'] : []));
  const missing = [...used].filter((id) => !ids.has(id));
  assert.deepEqual(missing, []);
  const all = [...html.matchAll(/\sid="([\w-]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(all).size, all.length);
});

test('navigation: every nav item and data-go target is a real view', () => {
  const views = [...html.matchAll(/<section id="view-(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(views.sort(), ['compare', 'models', 'settings', 'workspace']);
  for (const m of html.matchAll(/data-view="(\w+)"/g)) assert.ok(views.includes(m[1]), m[1]);
  for (const m of app.matchAll(/data-go="(\w+)"/g)) assert.ok(views.includes(m[1]), m[1]);
  for (const key of ['workspace', 'compare', 'models', 'settings']) assert.match(app, new RegExp(`${key}: \\[`));
});

test('CSP-safe markup: no inline styles, inline scripts or inline event handlers anywhere', () => {
  for (const [name, src] of [['index.html', html], ['app.js', app]]) {
    assert.ok(!/\sstyle\s*=/.test(src), `${name} has an inline style attribute`);
    assert.ok(!/\son\w+\s*=\s*["']/.test(src.replace(/\$\('[\w-]+'\)\.on\w+\s*=/g, '')), `${name} has an inline handler`);
  }
  assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html), 'inline <script>');
  assert.match(html, /<script type="module" src="app\.js">/);
});

test('accessibility basics: language, skip link, labelled controls, live regions, reduced motion, focus style', () => {
  assert.match(html, /<html lang="en">/); assert.match(html, /class="skip"/); assert.match(html, /<main id="main"/);
  for (const id of ['target-model', 'ai-provider', 'calls', 'outtok', 'input']) assert.match(html, new RegExp(`for="${id}"`), `no <label for=${id}>`);
  assert.ok((html.match(/role="status"/g) || []).length >= 3); assert.match(html, /aria-live="polite"/);
  assert.match(css, /prefers-reduced-motion:reduce/); assert.match(css, /:focus-visible/); assert.match(css, /prefers-color-scheme:dark/);
  for (const bp of ['1100px', '820px', '700px']) assert.match(css, new RegExp(`max-width:${bp}`), bp);
});

test('honest labelling is present in the markup: estimates vs measured, optional AI, data-sharing disclosure', () => {
  assert.match(app, /Estimated/); assert.match(app, /Measured ·/); assert.match(app, /AI suggestion/);
  assert.match(app, /Nothing is sent until you press the button/); assert.match(html, /Nothing is sent anywhere/);
  assert.match(app, /sends prompt to \$\{p\.label\}/);
});

test('the Optimize button applies the recommended edits by default (not just the "safe" ones)', () => {
  assert.match(app, /state\.chosen = recommendedIds\(state\.result\.findings\)/);
  assert.ok(!/f\.safe && !f\.advisory/.test(app), 'a default selection still uses the old safe-only rule');
  assert.match(app, /Recommended edits/); assert.match(app, /Select recommended/);
  for (const reason of ['already_lean', 'review_only', 'nothing_selected', 'all_skipped']) assert.match(app, new RegExp(reason));
});
