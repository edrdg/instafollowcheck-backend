// Installa Chromium per Puppeteer durante la build di Render, con output
// verboso e verifica finale. Se fallisce, la build fallisce con un messaggio
// chiaro nei log (invece di passare silenziosamente senza Chrome).
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('--- install-chrome: starting ---');
console.log('PUPPETEER_CACHE_DIR =', process.env.PUPPETEER_CACHE_DIR || '(not set)');
console.log('cwd =', process.cwd());
console.log('puppeteer config =', fs.existsSync(path.join(process.cwd(), 'puppeteer.config.cjs')) ? 'present' : 'MISSING');

try {
  const out = execSync('npx puppeteer browsers install chrome', {
    stdio: 'inherit',
    env: process.env,
    cwd: process.cwd(),
  });
  console.log('--- install-chrome: command finished ---');
} catch (err) {
  console.error('--- install-chrome: FAILED ---');
  console.error(err.stderr ? String(err.stderr) : String(err.message));
  process.exit(1);
}

// Verifica: il path dell'eseguibile esiste davvero?
try {
  const puppeteer = require('puppeteer');
  const exe = puppeteer.executablePath();
  const ok = fs.existsSync(exe);
  console.log('executablePath =', exe);
  console.log('exists =', ok);
  if (!ok) {
    console.error('--- install-chrome: executable missing after install ---');
    process.exit(1);
  }
} catch (err) {
  console.error('--- install-chrome: verification error ---');
  console.error(String((err && err.message) || err));
  process.exit(1);
}

console.log('--- install-chrome: OK ---');
