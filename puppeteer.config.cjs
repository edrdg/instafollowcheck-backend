// Puppeteer config per Render: la cache di Chromium deve stare DENTRO la
// cartella del progetto, così il browser scaricato in build viene incluso
// nell'immagine dell'istanza (Render non persiste ~/.cache tra build e runtime).
const path = require('path');

module.exports = {
  cacheDirectory: path.join(__dirname, '.cache', 'puppeteer'),
};
