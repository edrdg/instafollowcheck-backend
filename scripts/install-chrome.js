// Installa Chromium per Puppeteer DURANTE la build di Render, usando l'API
// locale di @puppeteer/browsers (dipendenza del puppeteer installato) e la
// buildId ESATTA pinnata da puppeteer-core.
//
// Perché non npx: `npx puppeteer browsers install chrome` può risolvere una
// versione REMOTA di puppeteer (più recente) che scarica un'altra build di
// Chrome in una cartella diversa, lasciando il puppeteer locale senza browser.
const { install } = require('@puppeteer/browsers');
const fs = require('fs');
const path = require('path');

async function main() {
  console.log('--- install-chrome: starting ---');
  const cacheDir = process.env.PUPPETEER_CACHE_DIR || path.join(process.cwd(), 'node_modules', '.cache', 'puppeteer');
  console.log('PUPPETEER_CACHE_DIR =', cacheDir);
  console.log('cwd =', process.cwd());

  // buildId pinned dal puppeteer locale (es. 131.0.6778.204). 'latest' NON
  // è un buildId valido per l'URL di download (dà 404): serve la revision esatta.
  let buildId = null;
  try {
    const puppeteer = require('puppeteer');
    if (puppeteer.configuration && puppeteer.configuration.browserRevision) {
      buildId = puppeteer.configuration.browserRevision;
    }
  } catch (err) {
    console.warn('puppeteer not loadable:', String(err.message));
  }
  if (!buildId) {
    // Fallback: legge la revision pinned dal puppeteer-core locale.
    const revPath = path.join(process.cwd(), 'node_modules', 'puppeteer-core', 'lib', 'cjs', 'puppeteer', 'revisions.js');
    try {
      const src = fs.readFileSync(revPath, 'utf8');
      const m = src.match(/chrome\s*:\s*'([^']+)'/);
      if (m) buildId = m[1];
    } catch (err) {
      console.warn('revisions.js not readable:', String(err.message));
    }
  }
  if (!buildId) {
    // Ultimo fallback: chiede a @puppeteer/browsers la revisione stabile nota.
    const { resolveBuildId } = require('@puppeteer/browsers');
    buildId = await resolveBuildId('chrome', 'linux', 'latest');
  }
  console.log('buildId =', buildId);

  // Pulisce download corrotti/incompleti da build precedenti (puppeteer non
  // riscarica se la cartella esiste anche senza eseguibile).
  if (fs.existsSync(cacheDir)) {
    console.log('cleaning existing puppeteer cache:', cacheDir);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }

  const installed = await install({
    browser: 'chrome',
    buildId,
    cacheDir,
    baseUrl: 'https://storage.googleapis.com/chrome-for-testing-public',
  });
  console.log('installed at =', installed.executablePath);
  console.log('exists =', fs.existsSync(installed.executablePath));

  // Verifica finale dal punto di vista del puppeteer locale.
  try {
    const puppeteer = require('puppeteer');
    const exe = puppeteer.executablePath();
    console.log('puppeteer.executablePath() =', exe);
    console.log('matches =', fs.existsSync(exe));
    if (!fs.existsSync(exe)) {
      console.error('--- install-chrome: FAILED: puppeteer cannot find its executable ---');
      process.exit(1);
    }
  } catch (err) {
    console.error('--- install-chrome: verification error ---');
    console.error(String((err && err.message) || err));
    process.exit(1);
  }

  console.log('--- install-chrome: OK ---');
}

main().catch((err) => {
  console.error('--- install-chrome: FAILED ---');
  console.error(String((err && err.message) || err));
  process.exit(1);
});
