#!/usr/bin/env node
// xfer — agent-first file transfer. Zero dependencies, JSONL output, secure defaults.
// v0.3: one process serves laptop CLI clients *and* phone/tablet browsers:
//       web landing page, short code, QR, and reverse upload (phone → this Mac).
//
// Exit codes: 0 ok · 1 runtime error · 2 usage error

import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createReadStream, createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { networkInterfaces, hostname } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { parseArgs } from 'node:util';

const VERSION = '0.3.0';
// Wire protocol. Bump ONLY when a change breaks an older peer (route, auth
// param, JSON shape). App version may move freely while proto stays put.
const PROTO = 1;

// ------------------------------------------------------------------ io ------

const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

function die(message, code = 1, extra = {}) {
  out({ event: 'error', message, ...extra });
  process.exit(code);
}

function parse(command, argv, options) {
  try {
    return parseArgs({ args: argv, allowPositionals: true, options });
  } catch (err) {
    return usageError(err.message, command);
  }
}

const usageError = (message, command) =>
  die(message, 2, { hint: `xfer ${command ?? ''} -h`.replace(/\s+/g, ' ') });

// ----------------------------------------------------------------- help -----

const HELP_TOP = `xfer ${VERSION} — agent-first file transfer

USAGE
  xfer send <file...> [options]     serve files (CLI + phone/tablet browser)
  xfer recv <url>     [options]     download (resumable, checksum-verified)
  xfer info <url>     [options]     list what a link serves, download nothing
  xfer doctor                       local install/version report (no network)
  xfer -h | --help                  this text
  xfer <command> -h                 options for one command
  xfer -V | --version

DESIGN
  Every event is one JSON object on one line; failures exit non-zero and print
  an {"event":"error"} line. Nothing is interactive: no prompts, no tty needed.
  Exit codes: 0 ok · 1 runtime error · 2 usage error.

VERSIONING
  Two numbers matter: the app version (features) and PROTO (wire format).
  A receiver refuses a sender whose PROTO it does not understand instead of
  guessing, so mixed versions fail loudly. Upgrade the sender first, then the
  receiver; both print their versions in ready/done events.

DEVICES
  Computer : xfer CLI, or a browser pointed at the same URL.
  Phone    : no install — open the short URL (or scan --qr) in Safari/Chrome.
  Tablet   : same page; drag-and-drop also works on iPadOS.
  Uploads  : --upload lets a phone send files *back* into a folder on this Mac.

SECURITY DEFAULTS
  • Binds 127.0.0.1 only. LAN exposure needs an explicit --lan.
  • Token is 128-bit random, required on every request (header X-Xfer-Token or ?t=).
  • A 6-char short code (?k=) exists for typing on a phone; same lockout applies.
  • Links are single-download and expire (--ttl, default 600s).
  • 5 wrong tokens/codes from one IP → 30s block (429), nothing logged but the IP.
  • Known secret files (~/.ssh, .env, *.pem …) are refused unless --allow-sensitive.
  • Force HTTPS with --tls-cert/--tls-key; over the internet use an SSH tunnel.

EXAMPLES
  xfer send ./report.pdf
  xfer send ./photos --lan --web --qr --upload ./inbox --ttl 900
  xfer recv "http://10.0.9.2:8792/?k=a1b2c3" --out ./inbox
`;

const HELP_SEND = `xfer send — serve files to laptops and phones

USAGE
  xfer send <file...> [options]

OPTIONS
  --lan                  listen on all interfaces (default: 127.0.0.1 only)
  --bind <addr>          explicit bind address (implies --lan if not loopback)
  --port <n>             port, 0 = pick a free one (default 0)
  --ttl <seconds>        process lifetime (default 600, 0 = no limit)
  --max-downloads <n>    full downloads per file before it stops serving
                         (default 1, 0 = unlimited)
  --web                  serve a mobile-first HTML page at / instead of JSON
  --qr                   print an ANSI QR code of the short URL to stderr
  --upload [dir]         accept uploads from the browser into dir
                         (default ./xfer-inbox when given without a value)
  --max-upload <mb>      per-file upload cap in MB (default 2048)
  --token <hex>          fixed token instead of a random 128-bit one
  --allow-cidr <list>    comma-separated IPv4 CIDRs/addresses allowed to connect
  --tls-cert <pem>       serve HTTPS with this certificate (needs --tls-key)
  --tls-key <pem>        private key for --tls-cert
  --allow-sensitive      permit serving ~/.ssh, .env, *.pem and friends
  -h, --help             this text

DEVICE NOTES
  • Phone/tablet: open the printed short URL; no client install needed.
  • The page takes ?k=<code> (6 chars, easy to type) or ?t=<token>.
  • iOS Safari saves downloads into Files.app; keep the screen awake for very
    large files (iOS suspends background downloads). Range resume is supported.
  • --upload accepts PUT per file, so the phone's file picker works with the
    camera roll, Files, and multi-select; nothing is overwritten (name-1.ext).

BEHAVIOUR
  Prints {"event":"ready",...} with token, code, urls, files[].sha256, then one
  line per transfer/upload. Exits 0 when every file reached --max-downloads or
  on --ttl.
`;

const HELP_RECV = `xfer recv — download from an xfer link

USAGE
  xfer recv <url> [options]
  xfer recv <host:port> [options]        (http:// assumed)

OPTIONS
  --out <dir>            destination directory (default .)
  --token <token>        token, if the URL does not already carry ?t=
  --code <code>          short code, if the URL carries ?k= (it usually does)
  --only <name>          download a single file from the link
  --force                re-download even if the local copy matches
  --insecure             accept self-signed HTTPS (prints a warning)
  --timeout <seconds>    per-request timeout (default 30)
  -h, --help             this text

BEHAVIOUR
  Writes <name>.part, resumes with Range if one exists, verifies sha256 from
  the server, then renames into place. On checksum mismatch the partial is
  deleted and the command exits 1 — a truncated file never looks finished.
`;

const HELP_INFO = `xfer info — inspect a link without downloading

USAGE
  xfer info <url> [options]

OPTIONS
  --token <token>   token if the URL has no ?t=
  --code <code>     short code if the URL has no ?k=
  --insecure        accept self-signed HTTPS
  -h, --help        this text

Prints {"event":"info","files":[{name,size,sha256}...]} — useful before you
commit to a multi-GB download.
`;

const HELP_DOCTOR = `xfer doctor — local install report (no network)

USAGE
  xfer doctor

Prints JSON: version, proto, node, platform/arch, installPath, installBytes,
onPath and whether onPathMatches the running file. Use it before upgrading:
compare proto on both peers, and confirm which copy a shell actually runs.
`;

const HELP = { send: HELP_SEND, recv: HELP_RECV, info: HELP_INFO, doctor: HELP_DOCTOR };

// ----------------------------------------------------------------- page -----

const PAGE = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#0b0d12">
<title>xfer</title>
<style>
:root{--bg:#0b0d12;--fg:#e9edf6;--muted:#8b93a7;--card:#151a24;--line:#232a38;--accent:#4c6fff;--ok:#2bb673;--err:#ff5d5d}
@media (prefers-color-scheme:light){:root{--bg:#f5f6fa;--fg:#14171f;--muted:#5b6478;--card:#fff;--line:#e3e6ef;--accent:#3355ff}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--fg)}
body{font:16px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC",system-ui,sans-serif;
     padding:calc(20px + env(safe-area-inset-top)) 16px calc(28px + env(safe-area-inset-bottom));max-width:720px;margin:0 auto}
h1{font-size:20px;margin:0 0 4px}
.sub{color:var(--muted);font-size:13px;margin:0 0 20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;margin-bottom:14px}
.file{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--line)}
.file:last-child{border-bottom:0}
.file .n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.file .m{color:var(--muted);font-size:12px;white-space:nowrap}
a.dl{background:var(--accent);color:#fff;text-decoration:none;padding:10px 16px;border-radius:10px;font-size:15px;font-weight:600}
a.dl:active{opacity:.8}
.drop{border:1.5px dashed var(--line);border-radius:14px;padding:22px 14px;text-align:center;color:var(--muted)}
.drop.on{border-color:var(--accent);color:var(--accent)}
button.pick{background:var(--accent);color:#fff;border:0;border-radius:10px;padding:12px 18px;font-size:15px;font-weight:600;margin-top:12px}
.up{margin-top:10px;font-size:13px}
.bar{height:6px;background:var(--line);border-radius:99px;overflow:hidden;margin-top:6px}
.bar>i{display:block;height:100%;width:0;background:var(--accent);transition:width .15s}
.ok{color:var(--ok)}.err{color:var(--err)}
footer{color:var(--muted);font-size:12px;text-align:center;margin-top:18px}
</style></head><body>
<h1>文件传输</h1>
<p class="sub" id="sub"></p>
<div class="card" id="files"></div>
<div class="card" id="upbox" hidden>
  <div class="drop" id="drop">
    <div>把文件拖到这里，或从相册/文件中选择</div>
    <button class="pick" id="pick">选择文件</button>
    <input id="input" type="file" multiple hidden>
  </div>
  <div id="ups"></div>
</div>
<footer>连接会在倒计时结束后自动关闭</footer>
<script>
const X = __XFER__;
const auth = X.auth;
const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x !== undefined) e.textContent = x; return e; };
const size = (n) => n > 1073741824 ? (n/1073741824).toFixed(1)+' GB' : n > 1048576 ? (n/1048576).toFixed(1)+' MB' : n > 1024 ? (n/1024).toFixed(0)+' KB' : n+' B';

document.getElementById('sub').textContent = X.files.length ? X.files.length + ' 个文件 · 有效期 ' + Math.round(X.ttl/60) + ' 分钟' : '等待文件';

const box = document.getElementById('files');
if (!X.files.length) box.append(el('div', 'sub', '这个链接没有可下载的文件'));
for (const f of X.files) {
  const row = el('div', 'file');
  row.append(el('div', 'n', f.name));
  row.append(el('div', 'm', size(f.size)));
  const a = el('a', 'dl', '下载');
  a.href = '/f/' + encodeURIComponent(f.name) + '?' + auth;
  a.setAttribute('download', f.name);
  row.append(a);
  box.append(row);
}

if (X.upload) {
  const upbox = document.getElementById('upbox'); upbox.hidden = false;
  const drop = document.getElementById('drop'), input = document.getElementById('input');
  document.getElementById('pick').onclick = () => input.click();
  input.onchange = () => { upload([...input.files]); input.value = ''; };
  ['dragenter','dragover'].forEach(e => drop.addEventListener(e, ev => { ev.preventDefault(); drop.classList.add('on'); }));
  ['dragleave','drop'].forEach(e => drop.addEventListener(e, ev => { ev.preventDefault(); drop.classList.remove('on'); }));
  drop.addEventListener('drop', ev => upload([...(ev.dataTransfer?.files || [])]));
}

function upload(files) {
  for (const f of files) {
    const row = el('div', 'up');
    const label = el('div', '', f.name + ' · ' + size(f.size));
    const bar = el('div', 'bar'); const fill = el('i');
    bar.append(fill);
    row.append(label, bar);
    document.getElementById('ups').append(row);
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', '/u/' + encodeURIComponent(f.name) + '?' + auth);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) fill.style.width = Math.round(e.loaded / e.total * 100) + '%'; };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { fill.style.width = '100%'; label.className = 'up ok'; label.textContent += ' ✓ 已保存'; }
      else { label.className = 'up err'; label.textContent += ' ✗ ' + xhr.status + ' ' + (xhr.responseText || ''); }
    };
    xhr.onerror = () => { label.className = 'up err'; label.textContent += ' ✗ 网络中断'; };
    xhr.send(f);
  }
}
</script></body></html>`;

// -------------------------------------------------------------- helpers -----

const sha256File = (file) =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });

const lanAddresses = () => {
  const found = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) found.push(net.address);
    }
  }
  return found;
};

const isLoopback = (bind) => ['127.0.0.1', '::1', 'localhost'].includes(bind);

const shortCode = () => {
  const alphabet = '23456789abcdefghjkmnpqrstuvwxyz'; // no 0/o/1/l/i
  const bytes = randomBytes(6);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
};

const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
};

const SENSITIVE = [
  /(^|\/)\.ssh\//,
  /(^|\/)\.gnupg\//,
  /(^|\/)\.aws\//,
  /(^|\/)\.docker\/config\.json$/,
  /(^|\/)\.git-credentials$/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.kube\/config$/,
  /(^|\/)\.env(\.|$)/,
  /\.(pem|key|p12|pfx|kdbx|keystore|jks)$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)$/,
];

const looksSensitive = (file) => SENSITIVE.some((re) => re.test(file));

const safeName = (raw) => {
  const decoded = decodeURIComponent(raw);
  const base = path.basename(decoded.replace(/\\/g, '/')).replace(/[\u0000-\u001f]/g, '').trim();
  if (!base || base === '.' || base === '..') return null;
  return base.length > 120 ? base.slice(-120) : base;
};

const ipAllowed = (ip, rules) => {
  if (rules.length === 0) return true;
  const clean = String(ip ?? '').replace(/^::ffff:/, '');
  const toInt = (s) => s.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
  return rules.some((rule) => {
    if (!rule.includes('/')) return rule === clean;
    const [base, bitsRaw] = rule.split('/');
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(base) || !/^\d+\.\d+\.\d+\.\d+$/.test(clean)) return false;
    const bits = Number(bitsRaw);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (toInt(base) & mask) === (toInt(clean) & mask);
  });
};

const normalizeUrl = (raw) => (raw.includes('://') ? raw : `http://${raw}`);
const isHelp = (argv) => argv.includes('-h') || argv.includes('--help');

const uniquePath = async (dir, name) => {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let i = 1; i < 1000; i += 1) {
    const exists = await fs.access(candidate).then(() => true, () => false);
    if (!exists) return candidate;
    candidate = path.join(dir, `${stem}-${i}${ext}`);
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`);
};

const printQr = (text) =>
  new Promise((resolve) => {
    let child;
    try {
      child = spawn('qrencode', ['-t', 'ANSIUTF8', '-o', '-', '-m', '1'], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      resolve(false);
      return;
    }
    child.on('error', () => resolve(false));
    child.stdout.on('data', (chunk) => process.stderr.write(chunk));
    child.on('close', (code) => resolve(code === 0));
    child.stdin.end(text);
  });

// ---------------------------------------------------------------- send ------

async function send(rawArgv) {
  const argv = [...rawArgv];
  const uploadFlag = argv.indexOf('--upload');
  if (uploadFlag !== -1) {
    const next = argv[uploadFlag + 1];
    if (next === undefined || next.startsWith('-')) argv[uploadFlag] = '--upload=./xfer-inbox';
  }
  const { values, positionals } = parse('send', argv, {
    lan: { type: 'boolean', default: false },
    bind: { type: 'string' },
    port: { type: 'string', default: '0' },
    ttl: { type: 'string', default: '600' },
    'max-downloads': { type: 'string', default: '1' },
    once: { type: 'boolean', default: false },
    web: { type: 'boolean', default: false },
    qr: { type: 'boolean', default: false },
    upload: { type: 'string' },
    'max-upload': { type: 'string', default: '2048' },
    token: { type: 'string' },
    'allow-cidr': { type: 'string' },
    'tls-cert': { type: 'string' },
    'tls-key': { type: 'string' },
    'allow-sensitive': { type: 'boolean', default: false },
  });

  if (positionals.length === 0 && values.upload === undefined) usageError('send needs at least one file (or --upload)', 'send');

  const bind = values.bind ?? (values.lan ? '0.0.0.0' : '127.0.0.1');
  const ttl = Number(values.ttl);
  if (!Number.isFinite(ttl) || ttl < 0) usageError('--ttl must be a number >= 0', 'send');
  let maxDownloads = Number(values['max-downloads']);
  if (!Number.isFinite(maxDownloads) || maxDownloads < 0) usageError('--max-downloads must be >= 0', 'send');
  if (values.once) maxDownloads = Math.max(1, maxDownloads);
  const maxUploadBytes = Number(values['max-upload']) * 1024 * 1024;
  if (!Number.isFinite(maxUploadBytes) || maxUploadBytes <= 0) usageError('--max-upload must be > 0', 'send');

  if (Boolean(values['tls-cert']) !== Boolean(values['tls-key'])) {
    usageError('--tls-cert and --tls-key must be given together', 'send');
  }
  if (values.token && !/^[0-9a-zA-Z]{8,128}$/.test(values.token)) {
    usageError('--token must be 8..128 alphanumeric characters', 'send');
  }

  const files = [];
  for (const raw of positionals) {
    const file = path.resolve(raw);
    const st = await fs.stat(file).catch(() => null);
    if (!st?.isFile()) die(`not a file: ${file}`, 1, { file: raw });
    if (looksSensitive(file) && !values['allow-sensitive']) {
      die(`refusing to serve a secret-looking file: ${file}`, 1, {
        hint: 'pass --allow-sensitive if this is intentional',
        file: raw,
      });
    }
    files.push({ file, name: path.basename(file), size: st.size, sha256: await sha256File(file), served: 0 });
  }
  const names = new Set();
  for (const f of files) {
    if (names.has(f.name)) die(`two files share the basename ${f.name}; serve them from separate commands`, 1);
    names.add(f.name);
  }
  const byName = new Map(files.map((f) => [f.name, f]));

  const uploadDir = values.upload === undefined ? null : path.resolve(values.upload || './xfer-inbox');
  if (uploadDir) await fs.mkdir(uploadDir, { recursive: true });

  const token = values.token ?? randomBytes(16).toString('hex'); // 128-bit
  const code = shortCode();
  const allowRules = (values['allow-cidr'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const secure = Boolean(values['tls-cert']);
  const web = values.web || uploadDir !== null;

  const blocked = new Map();
  const MAX_FAILS = 5;
  const BLOCK_MS = 30_000;

  const handler = async (req, res) => {
    const ip = req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    const state = blocked.get(ip);
    if (state && state.until > now) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30' });
      res.end(JSON.stringify({ error: 'too many attempts' }));
      return;
    }

    const url = new URL(req.url ?? '/', 'http://xfer.invalid');
    if (!ipAllowed(ip, allowRules)) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'address not allowed' }));
      out({ event: 'denied', ip, reason: 'cidr' });
      return;
    }

    const givenToken = req.headers['x-xfer-token'] ?? url.searchParams.get('t') ?? '';
    const givenCode = url.searchParams.get('k') ?? '';
    const authed = safeEqual(givenToken, token) || safeEqual(givenCode, code);
    if (!authed) {
      const fails = (state?.fails ?? 0) + 1;
      blocked.set(ip, { fails, until: fails >= MAX_FAILS ? now + BLOCK_MS : 0 });
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad token' }));
      out({ event: 'denied', ip, reason: 'bad-token', fails });
      if (fails >= MAX_FAILS) out({ event: 'blocked', ip, seconds: BLOCK_MS / 1000 });
      return;
    }
    blocked.delete(ip);

    const securityHeaders = {
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'self'",
    };

    // ---- upload (phone/tablet → this machine) -----------------------------
    if (req.method === 'PUT' && url.pathname.startsWith('/u/')) {
      if (!uploadDir) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('uploads are not enabled (start with --upload <dir>)');
        return;
      }
      const name = safeName(url.pathname.slice(3));
      if (!name) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('bad filename');
        return;
      }
      const dest = await uniquePath(uploadDir, name);
      const part = `${dest}.part`;
      let bytes = 0;
      let tooBig = false;
      const ws = createWriteStream(part);
      req.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maxUploadBytes && !tooBig) {
          tooBig = true;
          // answer before the upload finishes, then cut the stream: a 2 GB file
          // must not be drained just to be rejected
          res.writeHead(413, { 'content-type': 'application/json', connection: 'close' });
          res.end(JSON.stringify({ error: `larger than ${values['max-upload']} MB` }));
          out({ event: 'denied', ip, reason: 'upload-size', bytes });
          req.destroy();
        }
      });
      try {
        await pipeline(req, ws);
      } catch {
        await fs.rm(part, { force: true }).catch(() => {});
        return;
      }
      if (tooBig) {
        await fs.rm(part, { force: true }).catch(() => {});
        return;
      }
      await fs.rename(part, dest);
      const sha = await sha256File(dest);
      out({ event: 'upload', file: path.basename(dest), bytes, sha256: sha, ip });
      res.writeHead(201, { 'content-type': 'application/json', ...securityHeaders });
      res.end(JSON.stringify({ ok: true, file: path.basename(dest), bytes, sha256: sha }));
      return;
    }

    // ---- page --------------------------------------------------------------
    if ((url.pathname === '/' || url.pathname === '/index.html') && web) {
      const auth = url.searchParams.get('k') ? `k=${encodeURIComponent(code)}` : `t=${encodeURIComponent(token)}`;
      const data = {
        auth,
        ttl,
        upload: uploadDir !== null,
        maxUpload: values['max-upload'],
        files: files.map((f) => ({ name: f.name, size: f.size, sha256: f.sha256 })),
      };
      const html = PAGE.replace('__XFER__', () => JSON.stringify(data));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...securityHeaders });
      res.end(html);
      return;
    }

    if (url.pathname === '/' || url.pathname === '/index.json') {
      res.writeHead(200, { 'content-type': 'application/json', ...securityHeaders });
      res.end(
        JSON.stringify({
          proto: PROTO,
          app: VERSION,
          files: files.map((f) => ({ name: f.name, size: f.size, sha256: f.sha256 })),
          max_downloads: maxDownloads,
          upload: uploadDir !== null,
        }),
      );
      return;
    }

    // ---- download ----------------------------------------------------------
    const match = url.pathname.match(/^\/f\/(.+)$/);
    const entry = match ? byName.get(decodeURIComponent(match[1])) : undefined;
    if (!entry) {
      res.writeHead(404, { 'content-type': 'application/json', ...securityHeaders });
      res.end(JSON.stringify({ error: 'no such file' }));
      return;
    }
    if (maxDownloads > 0 && entry.served >= maxDownloads) {
      res.writeHead(410, { 'content-type': 'application/json', ...securityHeaders });
      res.end(JSON.stringify({ error: 'download limit reached' }));
      out({ event: 'denied', ip, reason: 'limit', file: entry.name });
      return;
    }

    const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    let start = 0;
    let end = entry.size - 1;
    if (range) {
      start = Number(range[1]);
      if (range[2] !== '') end = Math.min(Number(range[2]), entry.size - 1);
      if (start > end) {
        res.writeHead(416, { 'content-range': `bytes */${entry.size}`, ...securityHeaders });
        res.end();
        return;
      }
    }

    const headers = {
      ...securityHeaders,
      'content-type': 'application/octet-stream',
      'content-length': String(end - start + 1),
      'accept-ranges': 'bytes',
      'x-sha256': entry.sha256,
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(entry.name)}`,
    };
    if (range) headers['content-range'] = `bytes ${start}-${end}/${entry.size}`;
    res.writeHead(range ? 206 : 200, headers);
    out({ event: 'transfer', file: entry.name, ip, range: range ? `${start}-${end}` : 'full' });

    try {
      await pipeline(createReadStream(entry.file, { start, end }), res);
    } catch {
      res.destroy();
      return;
    }
    if (end === entry.size - 1) {
      entry.served += 1;
      out({ event: 'served', file: entry.name, count: entry.served, of: maxDownloads || 'unlimited' });
      if (maxDownloads > 0 && files.every((f) => f.served >= maxDownloads)) {
        out({ event: 'done', reason: 'max-downloads' });
        server.close();
        process.exit(0);
      }
    }
  };

  let server;
  if (secure) {
    const [cert, key] = await Promise.all([
      fs.readFile(values['tls-cert']),
      fs.readFile(values['tls-key']),
    ]).catch((err) => die(`cannot read TLS material: ${err.message}`, 1));
    server = createHttpsServer({ cert, key }, handler);
  } else {
    server = createHttpServer(handler);
  }
  server.on('error', (err) => die(err.message));

  server.listen(Number(values.port), bind, async () => {
    const { port } = server.address();
    const scheme = secure ? 'https' : 'http';
    const hosts = isLoopback(bind) ? ['127.0.0.1'] : lanAddresses();
    const bases = hosts.map((h) => `${scheme}://${h}:${port}/`);
    const mdns = `${scheme}://${hostname().replace(/\.local$/, '')}.local:${port}/`;
    const ready = {
      event: 'ready',
      version: VERSION,
      proto: PROTO,
      token,
      code,
      port,
      bind,
      tls: secure,
      web,
      upload: uploadDir,
      maxUploadMB: Number(values['max-upload']),
      expiresInSec: ttl,
      maxDownloads: maxDownloads || 'unlimited',
      allowCidr: allowRules,
      files: files.map((f) => ({ name: f.name, size: f.size, sha256: f.sha256 })),
      urls: bases.map((b) => `${b}f/${encodeURIComponent(files[0]?.name ?? '')}?t=${encodeURIComponent(token)}`),
      baseUrls: bases.map((b) => `${b}?t=${encodeURIComponent(token)}`),
      // what a phone should open: short code, no 32-char token to type
      phoneUrl: `${bases[0] ?? ''}?k=${code}`,
      phoneUrls: bases.map((b) => `${b}?k=${code}`),
      mdnsUrl: `${mdns}?k=${code}`,
      hint: 'phones/tablets: open phoneUrl (or scan --qr); computers: xfer recv with baseUrls',
    };
    if (!isLoopback(bind)) {
      out({ event: 'warn', message: 'listening on the LAN; anyone with the link can download until it expires', tls: secure });
    }
    if (!secure && !isLoopback(bind)) {
      out({ event: 'warn', message: 'plain HTTP over the LAN; use --tls-cert or an SSH tunnel for sensitive data' });
    }
    if (uploadDir) out({ event: 'warn', message: `upload enabled: files land in ${uploadDir}` });
    out(ready);

    if (values.qr) {
      const shown = ready.phoneUrl || ready.mdnsUrl;
      const okQr = await printQr(shown);
      if (!okQr) process.stderr.write(`[xfer] qrencode not found; open this instead: ${shown}\n`);
    }
  });

  if (ttl > 0) {
    setTimeout(() => {
      out({ event: 'done', reason: 'ttl' });
      server.close();
      process.exit(0);
    }, ttl * 1000).unref();
  }
}

// ---------------------------------------------------------------- recv ------

async function fetchIndex(rawUrl, token, insecure, code) {
  const url = new URL(normalizeUrl(rawUrl));
  const auth = token ?? code;
  if (auth && !url.searchParams.get('t') && !url.searchParams.get('k')) {
    url.searchParams.set(token ? 't' : 'k', auth);
  }
  if (insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const headers = token ? { 'x-xfer-token': token } : {};
  // always ask the JSON endpoint: '/' may be the HTML page
  const indexUrl = new URL('/index.json', url);
  indexUrl.search = url.search;
  const res = await fetch(indexUrl, { headers });
  if (!res.ok) throw new Error(`index ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { url, index: await res.json() };
}

async function info(argv) {
  const { values, positionals } = parse('info', argv, {
    token: { type: 'string' },
    code: { type: 'string' },
    insecure: { type: 'boolean', default: false },
  });
  if (!positionals[0]) usageError('info needs a url', 'info');
  if (values.insecure) out({ event: 'warn', message: 'TLS verification disabled (--insecure)' });
  try {
    const { index } = await fetchIndex(positionals[0], values.token, values.insecure, values.code);
    out({ event: 'info', files: index.files, upload: index.upload, peer: index.app ?? 'unknown', peerProto: Number(index.proto ?? 1) });
  } catch (err) {
    die(err.message);
  }
}

async function recv(argv) {
  const { values, positionals } = parse('recv', argv, {
    out: { type: 'string', default: '.' },
    token: { type: 'string' },
    code: { type: 'string' },
    only: { type: 'string' },
    force: { type: 'boolean', default: false },
    insecure: { type: 'boolean', default: false },
    timeout: { type: 'string', default: '30' },
  });
  if (!positionals[0]) usageError('recv needs a url', 'recv');
  if (values.insecure) out({ event: 'warn', message: 'TLS verification disabled (--insecure)' });

  const { url, index } = await fetchIndex(positionals[0], values.token, values.insecure, values.code).catch((err) =>
    die(err.message),
  );
  const peerProto = Number(index.proto ?? 1); // pre-0.4 peers behaved like proto 1
  if (peerProto !== PROTO) {
    die(`protocol mismatch: peer speaks proto ${peerProto}, this xfer speaks ${PROTO}`, 1, {
      hint: 'upgrade one side; upgrading the sender first is safest',
      peerApp: index.app ?? 'unknown',
    });
  }

  const authQuery = url.searchParams.get('t')
    ? `t=${encodeURIComponent(url.searchParams.get('t'))}`
    : url.searchParams.get('k')
      ? `k=${encodeURIComponent(url.searchParams.get('k'))}`
      : '';
  const outDir = path.resolve(values.out);
  await fs.mkdir(outDir, { recursive: true });
  const timeoutMs = Number(values.timeout) * 1000;
  const wanted = index.files.filter((f) => !values.only || f.name === values.only);
  if (wanted.length === 0) {
    die(`no file named ${values.only} on that link`, 1, { files: index.files.map((f) => f.name) });
  }

  const results = [];
  for (const file of wanted) {
    const dest = path.join(outDir, file.name);
    const part = `${dest}.part`;

    if (!values.force) {
      const have = await fs.stat(dest).catch(() => null);
      if (have?.size === file.size && (await sha256File(dest)) === file.sha256) {
        results.push({ name: file.name, ok: true, skipped: 'already-complete', path: dest, sha256: file.sha256 });
        out({ event: 'skip', file: file.name, reason: 'already-complete' });
        continue;
      }
    }

    const existing = await fs.stat(part).catch(() => null);
    let offset = existing?.size ?? 0;
    if (offset > file.size) offset = 0;
    if (offset === 0) await fs.rm(part, { force: true });

    const fileUrl = new URL(`f/${encodeURIComponent(file.name)}?${authQuery}`, url);
    const res = await fetch(fileUrl, {
      headers: {
        ...(values.token ? { 'x-xfer-token': values.token } : {}),
        ...(offset > 0 ? { range: `bytes=${offset}-` } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs * 10),
    });
    if (!res.ok) die(`download ${file.name}: ${res.status}`, 1, { file: file.name });
    if (offset > 0 && res.status !== 206) offset = 0;

    out({ event: 'download', file: file.name, resumedFrom: offset, size: file.size });
    await pipeline(Readable.fromWeb(res.body), createWriteStream(part, { flags: offset > 0 ? 'a' : 'w' }));

    const sum = await sha256File(part);
    if (sum !== file.sha256) {
      await fs.rm(part, { force: true });
      die(`checksum mismatch for ${file.name}`, 1, {
        expected: file.sha256,
        actual: sum,
        hint: 'the partial file was deleted; retry the whole download',
      });
    }
    await fs.rename(part, dest);
    results.push({ name: file.name, ok: true, path: dest, bytes: file.size, sha256: sum });
    out({ event: 'verified', file: file.name, path: dest, sha256: sum });
  }
  out({ event: 'done', out: outDir, peer: index.app ?? 'unknown', peerProto, files: results });
}

// -------------------------------------------------------------- doctor ------

async function doctor() {
  const self = path.resolve(process.argv[1] ?? 'xfer.mjs');
  const st = await fs.stat(self).catch(() => null);
  let onPath = null;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, process.platform === 'win32' ? 'xfer.cmd' : 'xfer');
    const found = await fs.stat(candidate).catch(() => null);
    if (found) {
      onPath = candidate;
      break;
    }
  }
  out({
    event: 'doctor',
    version: VERSION,
    proto: PROTO,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    installPath: self,
    installBytes: st?.size ?? null,
    onPath,
    onPathMatches: onPath ? (await fs.realpath(onPath).catch(() => onPath)) === (await fs.realpath(self).catch(() => self)) : false,
  });
}

// ---------------------------------------------------------------- main ------

const argv = process.argv.slice(2);
const command = argv[0];

if (!command || command === '-h' || command === '--help' || command === 'help') {
  process.stdout.write(HELP_TOP);
  process.exit(0);
}
if (command === '-V' || command === '--version') {
  out({ event: 'version', version: VERSION, proto: PROTO, node: process.version, platform: process.platform });
  process.exit(0);
}
if (!HELP[command]) usageError(`unknown command: ${command}`);

if (isHelp(argv.slice(1))) {
  process.stdout.write(HELP[command]);
  process.exit(0);
}

const run = { send, recv, info, doctor }[command];
await run(argv.slice(1)).catch((err) => die(err?.message ?? String(err)));
