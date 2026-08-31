// Puppeteer config per Render: la cache di Chromium deve stare DENTRO
// node_modules (directory che Render include sempre nell'immagine build),
// così il browser scaricato in build arriva a runtime. Render non persiste
// ~/.cache tra build e runtime. Niente dot-folder: usiamo puppeteer-cache.
const path = require('path');

module.exports = {
  cacheDirectory: path.join(__dirname, 'node_modules', 'puppeteer-cache'),
};
