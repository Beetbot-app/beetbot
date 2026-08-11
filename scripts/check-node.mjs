/**
 * Fail fast when the tests are about to run on a Node version they cannot
 * pass on.
 *
 * jsdom declares `node: ^22.22.2 || ^24.15.0 || >=26.0.0` — it skips Node 25
 * entirely, as most of the ecosystem does with the short-lived odd-numbered
 * releases. Run the suite on one of those and jsdom's `window.localStorage` is
 * not a real Storage, so the shared `beforeEach` in test/setup.ts throws before
 * any assertion: every test in every file fails, and nothing in the output
 * mentions Node. It reads as a broken codebase rather than a wrong interpreter,
 * which is exactly how it wasted an afternoon.
 *
 * So this checks the one thing the output would never tell you, and says the
 * fix in a sentence.
 *
 * The bar is `.nvmrc` rather than jsdom's full range: it is the version this
 * repo is actually developed and tested against, `nvm use` selects it with no
 * arguments, and a one-line file beats reimplementing semver range parsing
 * here. Other supported lines (24, 26+) are legitimate — take them with
 * BEETBOT_SKIP_NODE_CHECK=1, and run the suite before trusting the result.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP_ENV = 'BEETBOT_SKIP_NODE_CHECK';
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** [major, minor, patch] from a version string, or null if it isn't one. */
function parseVersion(raw) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compare(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

if (process.env[SKIP_ENV]) process.exit(0);

let wanted = null;
try {
  wanted = parseVersion(readFileSync(join(repoRoot, '.nvmrc'), 'utf8'));
} catch {
  // No .nvmrc, or unreadable. That is a packaging problem, not the
  // contributor's, and it must never be the thing that blocks a test run.
  process.exit(0);
}
if (!wanted) process.exit(0);

const current = parseVersion(process.versions.node);
// Same major line, and at least the pinned patch — Node 22.0.0 would satisfy
// "major 22" while still falling short of jsdom's ^22.22.2 floor.
if (current && current[0] === wanted[0] && compare(current, wanted) >= 0) {
  process.exit(0);
}

const want = wanted.join('.');
process.stderr.write(
  `\nNode ${process.versions.node} cannot run this test suite.\n\n` +
    `  This repo is tested on Node ${want} (see .nvmrc). jsdom supports\n` +
    `  22.22.2+, 24.15+ and 26+, and nothing in between — on any other\n` +
    `  version every test fails at window.localStorage, with no hint that\n` +
    `  Node is the cause.\n\n` +
    `  Fix:  nvm use          (or: nvm install ${want})\n\n` +
    `  On a different supported line (24, 26+) on purpose?\n` +
    `  ${SKIP_ENV}=1 pnpm test\n\n`,
);
process.exit(1);
