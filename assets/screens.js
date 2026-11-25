// node assets/screens.js [measure folder] — regenerates the README visuals:
// - screenshots: the real rendering of vscode/extension.js (HTML + CSS in an SVG <foreignObject>, fictitious data);
// - brand fonts embedded (data URI) in the screenshots and in hero, stickers, flow and logo.
const fs = require('fs');
const path = require('path');
const { render, renderApp, fontFaces } = require('../vscode/extension.js');

const fontsCss = fontFaces((f) => 'data:font/woff2;base64,' + fs.readFileSync(path.join(__dirname, '..', 'vscode', 'media', 'fonts', f)).toString('base64'));

const t0 = new Date('2026-11-24T14:05:00').getTime();
const m = (min) => t0 + min * 60000;
const tasks = [
  { id: '1', subject: 'Read the existing code', description: 'Find the screens and services involved.', status: 'completed', mtime: m(0) },
  { id: '2', subject: 'Design the data model', status: 'completed', mtime: m(9) },
  { id: '3', subject: 'Build the settings screen', activeForm: 'Building the screen', status: 'in_progress', mtime: m(12) },
  { id: '4', subject: 'Write the tests', status: 'pending', blockedBy: ['3'], mtime: m(1) },
  { id: '5', subject: 'Review and docs', status: 'pending', blockedBy: ['4'], mtime: m(1) },
];
const files = { 2: new Set(['/demo/src/model.ts']), 3: new Set(['/demo/src/Settings.tsx', '/demo/src/api.ts']) };
const inProgress = { sid: 'demo', tasks, done: 2, total: 5, cwd: '/demo/my-project' };
const summit = { sid: 'demo', tasks: tasks.map((t, i) => ({ ...t, status: 'completed', mtime: m(i * 6) })), done: 5, total: 5, cwd: '/demo/my-project' };
const waiting = { kind: 'waiting', message: 'Claude needs your permission to use Bash' };
// fictitious history, as the hook keeps it (see loadHistory)
const roadmap = (id, title, start, steps, stopped) => {
  let at = start;
  const list = steps.map(([subject, min, files = []], i) => {
    const done = !stopped || i < stopped;
    const s = { id: String(i + 1), subject, status: done ? 'completed' : 'pending', started: at, ended: done ? at + min * 60000 : 0, files };
    if (done) at += min * 60000;
    return s;
  });
  return { id, sid: id, cwd: '/demo/my-project', here: true, title, start, end: at, steps: list, done: list.filter((x) => x.status === 'completed').length, total: list.length };
};
const history = [
  roadmap('a', 'Add a dark mode to the settings screen', m(-30), [['Read the theme and settings code', 4], ['Add the dark palette tokens', 5, ['/demo/src/tokens.css']],
    ['Wire the theme switch into the settings screen', 9, ['/demo/src/Settings.tsx', '/demo/src/useTheme.ts']], ['Remember the choice for each user', 6, ['/demo/src/prefs.ts']],
    ['Write the tests', 8, ['/demo/test/theme.test.ts']], ['Update the docs', 4, ['/demo/README.md']]]),
  roadmap('b', 'Fix the login redirect loop', m(-195), [['Reproduce the loop', 5], ['Find the faulty redirect', 6, ['/demo/src/auth.ts']], ['Fix it and add a test', 7, ['/demo/test/auth.test.ts']]]),
  roadmap('c', 'Write the release notes for 2.4', m(-1263), [['List the merged changes', 3], ['Draft the notes', 4, ['/demo/CHANGELOG.md']], ['Proofread', 1]]),
  roadmap('d', 'Move the CI to the new runners', m(-1355), [['Read the current workflows', 6], ['Switch the test job', 12, ['/demo/.github/workflows/tests.yml']],
    ['Switch the release job', 9], ['Clean up the old runners', 5]], 2),
];

// +/− per step, time left, and a plan waiting for the user's go (with a note and a step to remove)
const stats = { 1: { add: 0, del: 0 }, 2: { add: 38, del: 4 }, 3: { add: 40, del: 6 } };
const eta = 14 * 60000;
const planned = { sid: 'demo', tasks: tasks.map((x) => ({ ...x, status: 'pending' })), done: 0, total: 5, cwd: '/demo/my-project' };
const steering = { gate: 'held', items: [
  { id: 'n1', kind: 'note', step: '3', subject: tasks[2].subject, text: "Reuse the existing API client, don't add a new one.", sent: false },
  { id: 'r1', kind: 'remove', step: '5', subject: tasks[4].subject, sent: false }] };

// ponytail: fixed heights measured in a browser (embedded fonts) + margin; measure again if the design changes
const variants = [
  ['screen-light.svg', 'vscode-light', '#F3F3F3', inProgress, { files, stats, eta, now: m(24) }, 580],
  ['screen-dark.svg', 'vscode-dark', '#181818', inProgress, { files, stats, eta, signal: waiting, now: m(24) }, 635],
  ['screen-steer.svg', 'vscode-light', '#F3F3F3', planned, { steer: steering, now: m(0) }, 685],
  ['screen-history.svg', 'vscode-light', '#F3F3F3', inProgress, { tab: 'history', history, now: m(24) }, 615],
];

for (const [name, theme, bg, r, o, h] of variants) {
  // no script in a picture: the "This project" filter is drawn selected
  const html = render(r, o).replace('<style>', '<style>' + fontsCss).replace('data-scope="here"', 'data-scope="here" aria-pressed="true"');
  const css = html.match(/<style>([\s\S]*)<\/style>/)[1]
    .replace('body.vscode-dark,body.vscode-high-contrast{', '.vscode-dark{')
    .replace('body{', '.page{');
  const body = html.match(/<body>([\s\S]*)<\/body>/)[1].replace(/<input([^>]*)>/g, '<input$1/>'); // SVG is XML
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="340" height="${h}" viewBox="0 0 340 ${h}">` +
    `<foreignObject width="340" height="${h}"><div xmlns="http://www.w3.org/1999/xhtml" class="page ${theme}" ` +
    `style="height:${h}px;padding-top:14px;background:${bg};border-radius:18px"><style>${css}</style>${body}</div></foreignObject></svg>\n`;
  fs.writeFileSync(path.join(__dirname, name), svg);
  if (process.argv[2]) { // measure page: same fonts as the SVG
    fs.writeFileSync(path.join(process.argv[2], name.replace('.svg', '.html')),
      html.replace("default-src 'none';", "default-src 'none'; font-src data:;").replace('<body>', `<body class="${theme}" style="background:${bg}">`));
  }
  console.log(name, svg.length, 'bytes');
}

// Animated demo: four states of the real rendering, looping (3 s each); the "in progress" card,
// the "Claude is waiting for you" sticker and "Summit reached" arrive with their animation.
{
  const t4 = tasks.map((t) => (t.id === '3' ? { ...t, status: 'completed', mtime: m(18) } : t.id === '4' ? { ...t, status: 'in_progress', activeForm: 'Writing the tests', mtime: m(18) } : t));
  const f4 = { ...files, 4: new Set(['/demo/test/settings.test.ts']) };
  const states = [
    renderApp(inProgress, { files, stats, eta, now: m(16) }),
    renderApp({ ...inProgress, tasks: t4, done: 3 }, { files: f4, stats, eta: eta / 2, now: m(19) }),
    renderApp({ ...inProgress, tasks: t4, done: 3 }, { files: f4, stats, eta: eta / 2, signal: waiting, now: m(21) }),
    renderApp(summit, { files: f4, stats, now: m(30) }),
  ];
  const h = 630;
  const css = render(null).match(/<style>([\s\S]*)<\/style>/)[1].replace('body{', '.page{') + `
.page{position:relative;overflow:hidden}.state{position:absolute;top:14px;left:8px;right:14px;opacity:0;animation:demo 12s infinite}
.e2{animation-delay:3s}.e3{animation-delay:6s}.e4{animation-delay:9s}
@keyframes demo{0%{opacity:0}3%{opacity:1}23%{opacity:1}25%{opacity:0}100%{opacity:0}}
.state .card,.state .signal{animation:demopop 12s infinite}.state .summit{animation:demostamp 12s infinite}
.e2 .card{animation-delay:3s}.e3 .card,.e3 .signal{animation-delay:6s}.e4 .summit{animation-delay:9s}
@keyframes demopop{0%{opacity:0;transform:rotate(-6deg) scale(.85)}5%{opacity:1;transform:rotate(-1.5deg) scale(1)}100%{transform:rotate(-1.5deg)}}
@keyframes demostamp{0%{opacity:0;transform:rotate(-14deg) scale(1.6)}5%{opacity:1;transform:rotate(-4deg) scale(1)}100%{transform:rotate(-4deg)}}
@media (prefers-reduced-motion:reduce){.e4{opacity:1}}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="340" height="${h}" viewBox="0 0 340 ${h}">` +
    `<foreignObject width="340" height="${h}"><div xmlns="http://www.w3.org/1999/xhtml" class="page vscode-light" ` +
    `style="height:${h}px;background:#F3F3F3;border-radius:18px"><style>${fontsCss}${css}</style>` +
    states.map((e, i) => `<div class="state e${i + 1}"><div id="app">${e}</div></div>`).join('') + '</div></foreignObject></svg>\n';
  fs.writeFileSync(path.join(__dirname, 'demo.svg'), svg);
  console.log('demo.svg', svg.length, 'bytes');
}

// Hand-drawn visuals: the font block is (re)placed right after the <svg …> tag.
for (const name of ['hero.svg', 'stickers.svg', 'flow.svg', 'logo.svg']) {
  const f = path.join(__dirname, name);
  const block = `<style id="fonts">${fontsCss}</style>`;
  const src = fs.readFileSync(f, 'utf8').replace(/<style id="fonts">[\s\S]*?<\/style>/, '');
  fs.writeFileSync(f, src.replace(/(<svg[^>]*>)/, `$1${block}`));
  console.log(name, fs.statSync(f).size, 'bytes');
}
