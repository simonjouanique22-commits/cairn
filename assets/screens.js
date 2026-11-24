// node assets/screens.js — régénère les visuels du README :
// - captures : vrai rendu de vscode/extension.js (HTML + CSS dans un SVG <foreignObject>, données fictives) ;
// - polices de marque embarquées (data URI) dans les captures et dans hero, stickers, flow et logo.
const fs = require('fs');
const path = require('path');
const { render, polices } = require('../vscode/extension.js');

const fontsCss = polices((f) => 'data:font/woff2;base64,' + fs.readFileSync(path.join(__dirname, '..', 'vscode', 'media', 'fonts', f)).toString('base64'));

const t0 = new Date('2026-11-24T14:05:00').getTime();
const m = (min) => t0 + min * 60000;
const tasks = [
  { id: '1', subject: 'Lire le code existant', description: 'Repérer les écrans et services concernés.', status: 'completed', mtime: m(0) },
  { id: '2', subject: 'Concevoir le modèle de données', status: 'completed', mtime: m(9) },
  { id: '3', subject: 'Implémenter l’écran de réglage', activeForm: 'Implémentation de l’écran', status: 'in_progress', mtime: m(12) },
  { id: '4', subject: 'Écrire les tests', status: 'pending', blockedBy: ['3'], mtime: m(1) },
  { id: '5', subject: 'Relecture et documentation', status: 'pending', blockedBy: ['4'], mtime: m(1) },
];
const files = { 2: new Set(['/demo/src/modele.ts']), 3: new Set(['/demo/src/Reglage.tsx', '/demo/src/api.ts']) };
const enCours = { sid: 'demo', tasks, done: 2, total: 5, cwd: '/demo/mon-projet' };
const sommet = { sid: 'demo', tasks: tasks.map((t, i) => ({ ...t, status: 'completed', mtime: m(i * 6) })), done: 5, total: 5, cwd: '/demo/mon-projet' };
const attente = { kind: 'attente', message: 'Claude needs your permission to use Bash' };

// ponytail: hauteurs fixes mesurées dans un navigateur (polices embarquées) + marge ; à remesurer si le design change
const variantes = [
  ['screen-clair.svg', 'vscode-light', '#F3F3F3', enCours, { files, now: m(24) }, 540],
  ['screen-sombre.svg', 'vscode-dark', '#181818', enCours, { files, signal: attente, now: m(24) }, 600],
  ['screen-sommet.svg', 'vscode-light', '#F3F3F3', sommet, { files, now: m(30) }, 630],
];

for (const [nom, theme, fond, r, o, h] of variantes) {
  const html = render(r, o).replace('<style>', '<style>' + fontsCss);
  const css = html.match(/<style>([\s\S]*)<\/style>/)[1]
    .replace('body.vscode-dark,body.vscode-high-contrast{', '.vscode-dark{')
    .replace('body{', '.page{');
  const body = html.match(/<body>([\s\S]*)<\/body>/)[1];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="340" height="${h}" viewBox="0 0 340 ${h}">` +
    `<foreignObject width="340" height="${h}"><div xmlns="http://www.w3.org/1999/xhtml" class="page ${theme}" ` +
    `style="height:${h}px;padding-top:14px;background:${fond};border-radius:18px"><style>${css}</style>${body}</div></foreignObject></svg>\n`;
  fs.writeFileSync(path.join(__dirname, nom), svg);
  if (process.argv[2]) { // page de mesure : mêmes polices que le SVG
    fs.writeFileSync(path.join(process.argv[2], nom.replace('.svg', '.html')),
      html.replace("default-src 'none';", "default-src 'none'; font-src data:;").replace('<body>', `<body class="${theme}" style="background:${fond}">`));
  }
  console.log(nom, svg.length, 'octets');
}

// Visuels dessinés à la main : on (re)place le bloc de polices juste après la balise <svg …>.
for (const nom of ['hero.svg', 'stickers.svg', 'flow.svg', 'logo.svg']) {
  const f = path.join(__dirname, nom);
  const bloc = `<style id="polices">${fontsCss}</style>`;
  const src = fs.readFileSync(f, 'utf8').replace(/<style id="polices">[\s\S]*?<\/style>/, '');
  fs.writeFileSync(f, src.replace(/(<svg[^>]*>)/, `$1${bloc}`));
  console.log(nom, fs.statSync(f).size, 'octets');
}
