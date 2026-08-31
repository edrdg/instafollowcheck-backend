// Installa Chrome per Puppeteer DURANTE la build di Render (gira come
// postinstall), usando l'API locale di @puppeteer/browsers e la buildId pinata
// da puppeteer-core. La cache sta in node_modules/puppeteer-cache (vedi
// puppeteer.config.cjs): siccome è dentro il progetto, Render la include
// nell'immagine di build, quindi a runtime Chrome è già presente e NON va
// riscaricato a ogni avvio di istanza (sul piano free le istanze si
// rigenerano di continuo).
//
// - Se Chrome valido esiste già, esce subito (OK) evitando riscaricamenti.
// - Pulisce download parziali/corrotti prima di reinstallare.
// - Se l'install fallisce, esce con codice !=0: la build fallisce VISIBILMENTE
//   invece di produrre un'immagine senza browser.
//
// Perché non `npx puppeteer browsers install chrome`: npx può risolvere una
// versione REMOTA di puppeteer e scaricare in un'altra posizione, lasciando
// il puppeteer locale senza browser.
const { install, resolveBuildId, computeExecutablePath, detectBrowserPlatform } = require('@puppeteer/browsers');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const cacheDir = process.env.PUPPETEER_CACHE_DIR || path.join(ROOT, 'node_modules', 'puppeteer-cache');

// buildId pinata dal puppeteer-core locale (es. 131.0.6778.204). 'latest' NON
// è un buildId valido per l'URL di download (dà 404): serve la revision esatta.
function pinnedBuildId() {
  if (process.env.PUPPETEER_CHROME_VERSION) return process.env.PUPPETEER_CHROME_VERSION;
  const candidates = [];
  try { candidates.push(require.resolve('puppeteer-core/internal/revisions.js')); } catch (_) {}
  candidates.push(path.join(ROOT, 'node_modules', 'puppeteer-core', 'lib', 'cjs', 'puppeteer', 'revisions.js'));
  candidates.push(path.join(ROOT, 'node_modules', 'puppeteer-core', 'lib', 'esm', 'puppeteer', 'revisions.js'));
  for (const rel of candidates) {
    try {
      const src = fs.readFileSync(rel, 'utf8');
      const m = src.match(/chrome\s*:\s*'([^']+)'/);
      if (m) return m[1];
    } catch (_) {}
  }
  return null;
}

async function main() {
  console.log('[install-chrome] starting');
  console.log('[install-chrome] cacheDir =', cacheDir);

  const platform = detectBrowserPlatform();
  if (!platform) throw new Error(`Piattaforma browser non supportata: ${process.platform} / ${process.arch}`);

  let buildId = pinnedBuildId();
  if (!buildId) {
    console.warn('[install-chrome] buildId non pinnato, uso latest/stable');
    buildId = await resolveBuildId('chrome', platform, 'stable');
  }
  const exe = computeExecutablePath({ browser: 'chrome', buildId, platform, cacheDir });
  console.log('[install-chrome] buildId =', buildId);
  console.log('[install-chrome] executable =', exe);

  // Già installato e valido -> niente da fare (build ripetute / caso locale).
  if (fs.existsSync(exe)) {
    console.log('[install-chrome] Chrome già presente, skip download.');
    return;
  }

  // @puppeteer/browsers install() NON riscarica se la cartella della build
  // esiste ma l'eseguibile manca (download parziale). Pulisci e riparti.
  if (fs.existsSync(cacheDir)) {
    console.log('[install-chrome] pulizia cache esistente:', cacheDir);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }

  const installed = await install({
    browser: 'chrome',
    buildId,
    cacheDir,
    baseUrl: 'https://storage.googleapis.com/chrome-for-testing-public',
  });
  console.log('[install-chrome] installato a', installed.executablePath);

  // Verifica + permesso di esecuzione (a volte l'extract perde il bit +x).
  if (!fs.existsSync(exe)) {
    try { fs.chmodSync(exe, 0o755); } catch (_) {}
  }
  if (!fs.existsSync(exe)) {
    throw new Error(`Eseguibile Chrome assente dopo l'install: ${exe}`);
  }
  try { fs.chmodSync(exe, 0o755); } catch (_) {}

  // Cross-check dal punto di vista di puppeteer (deve risolvere lo stesso file).
  let ppExe = null;
  try { ppExe = require('puppeteer').executablePath(); } catch (err) {
    throw new Error(`puppeteer.executablePath() fallito: ${String((err && err.message) || err)}`);
  }
  if (!fs.existsSync(ppExe)) {
    throw new Error(`puppeteer non trova il suo eseguibile: ${ppExe}`);
  }
  console.log('[install-chrome] puppeteer.executablePath() =', ppExe);
  console.log('[install-chrome] OK');
}

main().catch((err) => {
  console.error('[install-chrome] FAILED');
  console.error(String((err && err.stack) || err));
  process.exit(1);
});