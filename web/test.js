// node web/test.js — starts the universal view on a fake ~/.claude and checks the page, the live stream, selecting
// a session, and that requests not aimed at 127.0.0.1 / localhost are refused.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-web-'));
const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-project-')));
const claude = path.join(home, 'claude');
for (const [sid, subject] of [['s1', 'Write <the> code'], ['s2', 'Older request']]) {
  fs.mkdirSync(path.join(claude, 'tasks', sid), { recursive: true });
  fs.mkdirSync(path.join(claude, 'projects', 'p'), { recursive: true });
  fs.writeFileSync(path.join(claude, 'projects', 'p', sid + '.jsonl'), JSON.stringify({ type: 'user', cwd: project }) + '\n');
  fs.writeFileSync(path.join(claude, 'tasks', sid, '1.json'), JSON.stringify({ id: '1', subject, status: sid === 's1' ? 'in_progress' : 'completed' }));
}
const old = new Date(Date.now() - 3 * 86400e3);
fs.mkdirSync(path.join(claude, 'cairn', 'history'), { recursive: true });
const t0 = Date.now() / 1000 - 600;
fs.writeFileSync(path.join(claude, 'cairn', 'history', 'h1.json'), JSON.stringify({ cwd: project, roadmaps: [{ title: 'Kept roadmap',
  start: t0, end: t0 + 300, steps: [{ id: '1', subject: 'Done step', status: 'completed', created: t0, ended: t0 + 300 }] }] }));
fs.utimesSync(path.join(claude, 'tasks', 's2', '1.json'), old, old);

const port = 4900 + Math.floor(Math.random() * 500);
const server = spawn(process.execPath, [path.join(__dirname, 'serve.js'), project, '--port', String(port), '--lang', 'en'],
  { env: { ...process.env, CLAUDE_CONFIG_DIR: claude }, stdio: ['ignore', 'pipe', 'inherit'] });

const request = (route, { host = `127.0.0.1:${port}`, method = 'GET', body } = {}) => new Promise((ok, ko) => {
  const req = http.request({ host: '127.0.0.1', port, path: route, method, headers: { host, 'content-type': 'application/json' } }, (res) => {
    let data = '';
    res.on('data', (d) => {
      data += d;
      if (route === '/events' && data.includes('\n\n')) { req.destroy(); ok({ status: res.statusCode, headers: res.headers, data }); }
    });
    res.on('end', () => ok({ status: res.statusCode, headers: res.headers, data }));
  });
  req.on('error', (e) => (e.code === 'ECONNRESET' ? null : ko(e)));
  req.end(body);
});

(async () => {
  await new Promise((ok) => server.stdout.once('data', ok));
  const page = await request('/');
  assert.strictEqual(page.status, 200);
  assert(page.data.includes("connect-src 'self'") && page.data.includes('new EventSource') && page.data.includes('/fonts/BricolageGrotesque.woff2'));
  assert.strictEqual((await request('/', { host: `evil.example:${port}` })).status, 403, 'foreign host refused');
  assert.strictEqual((await request('/fonts/../../etc/passwd')).status, 404);
  assert.strictEqual((await request('/fonts/BricolageGrotesque.woff2')).headers['content-type'], 'font/woff2');

  let stream = await request('/events');
  assert(stream.data.startsWith('data: '), stream.data.slice(0, 80));
  let state = JSON.parse(stream.data.slice(6));
  assert(state.html.includes('Write &lt;the&gt; code') && !state.html.includes('<the>') && state.html.includes('Now · 0/1'));
  assert.strictEqual(state.announcement, 'In progress: Write <the> code — 0/1 steps done');

  assert.strictEqual((await request('/action', { method: 'POST', body: JSON.stringify({ type: 'select', sid: 's2' }) })).status, 204);
  stream = await request('/events');
  state = JSON.parse(stream.data.slice(6));
  assert(state.html.includes('Older request') && state.html.includes('old roadmap'));

  // history tab, then one past roadmap opened, ready to copy as Markdown
  assert.strictEqual((await request('/action', { method: 'POST', body: JSON.stringify({ type: 'tab', tab: 'history' }) })).status, 204);
  state = JSON.parse((await request('/events')).data.slice(6));
  assert(state.html.includes('data-pick="h1:0"') && state.html.includes('Kept roadmap'));
  await request('/action', { method: 'POST', body: JSON.stringify({ type: 'pick', id: 'h1:0' }) });
  state = JSON.parse((await request('/events')).data.slice(6));
  assert(state.html.includes('data-copy="### Kept roadmap') && state.html.includes('← History'));

  // steering from the browser: open a note on step 1, send it; the hook will pass it on to Claude
  await request('/action', { method: 'POST', body: JSON.stringify({ type: 'tab', tab: 'now' }) });
  await request('/action', { method: 'POST', body: JSON.stringify({ type: 'select', sid: 's1' }) });
  await request('/action', { method: 'POST', body: JSON.stringify({ type: 'compose', step: '1' }) });
  state = JSON.parse((await request('/events')).data.slice(6));
  assert(state.html.includes('class="composer"') && state.html.includes('data-step="1"'));
  await request('/action', { method: 'POST', body: JSON.stringify({ type: 'steer', kind: 'note', step: '1', text: 'Use the existing client' }) });
  const kept = JSON.parse(fs.readFileSync(path.join(claude, 'cairn', 'steer', 's1.json'), 'utf8'));
  assert.deepStrictEqual(kept.items.map((i) => [i.kind, i.step, i.subject, i.text]), [['note', '1', 'Write <the> code', 'Use the existing client']]);
  state = JSON.parse((await request('/events')).data.slice(6));
  assert(!state.html.includes('class="composer"') && state.html.includes('NOTE FOR CLAUDE'));

  server.kill();
  fs.rmSync(home, { recursive: true, force: true });
  console.log('ok');
})().catch((e) => { server.kill(); console.error(e); process.exit(1); });
