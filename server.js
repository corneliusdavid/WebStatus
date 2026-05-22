'use strict';
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const configPath = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const { checkSite } = require('./lib/checker');
const { getRdpMetrics } = require('./lib/rdpserver');

// Strip trailing slash so redirects like base + '/dashboard' are always clean
const base = (config.basePath || '').replace(/\/$/, '');
const baseHref = base ? base + '/' : '/';

function sendHtml(res, filename) {
  const html = fs.readFileSync(path.join(__dirname, 'public', filename), 'utf8');
  res.setHeader('Content-Type', 'text/html');
  res.send(html.replace('<head>', `<head>\n  <base href="${baseHref}">`));
}

const app = express();

// ── In-memory status state ──────────────────────────────────────────────────

const status = {
  sites: config.sites.map((s) => ({
    name: s.name,
    url: s.url,
    expectedStatus: s.expectedStatus || 200,
    state: 'pending',
    statusCode: null,
    responseTimeMs: null,
    checkedAt: null,
    error: null,
  })),
  rdpServer: {
    hostname: config.rdpServer.hostname,
    displayName: config.rdpServer.displayName || config.rdpServer.hostname,
    state: 'pending',
    cpuPercent: null,
    totalMemoryMB: null,
    usedMemoryMB: null,
    activeSessions: null,
    disconnectedSessions: null,
    checkedAt: null,
    error: null,
  },
  nextCheckAt: null,
  checkIntervalSeconds: config.checkIntervalSeconds || 60,
};

// ── Middleware ──────────────────────────────────────────────────────────────

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(
  session({
    secret: config.sessionSecret || 'webstatus-default-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 8 * 60 * 60 * 1000 }, // 8-hour session
  })
);

function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect(base + '/');
}

// ── Routes ──────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  if (req.session.authenticated) return res.redirect(base + '/dashboard');
  sendHtml(res, 'login.html');
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (username !== config.auth.username) {
    return res.redirect(base + '/?error=1');
  }

  let valid = false;
  if (config.auth.passwordHash) {
    valid = bcrypt.compareSync(password, config.auth.passwordHash);
  } else {
    // Fallback: plaintext comparison — only used before set-password.js is run
    valid = password === (config.auth.password || 'admin');
  }

  if (valid) {
    req.session.authenticated = true;
    res.redirect(base + '/dashboard');
  } else {
    res.redirect(base + '/?error=1');
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy();
  res.redirect(base + '/');
});

app.get('/dashboard', requireAuth, (req, res) => {
  sendHtml(res, 'dashboard.html');
});

app.get('/api/status', requireAuth, (req, res) => {
  res.json(status);
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Background checker ───────────────────────────────────────────────────────

async function runChecks() {
  const slowMs = config.slowResponseThresholdMs || 3000;

  const siteChecks = config.sites.map((site, i) =>
    checkSite(site, slowMs).then((result) => {
      status.sites[i] = result;
    })
  );

  const rdpCheck =
    config.rdpServer.enabled
      ? getRdpMetrics(config.rdpServer.hostname).then((result) => {
          status.rdpServer = {
            ...result,
            displayName: config.rdpServer.displayName || config.rdpServer.hostname,
          };
        })
      : Promise.resolve();

  await Promise.allSettled([...siteChecks, rdpCheck]);

  const intervalMs = (config.checkIntervalSeconds || 60) * 1000;
  status.nextCheckAt = new Date(Date.now() + intervalMs).toISOString();
}

const intervalMs = (config.checkIntervalSeconds || 60) * 1000;

// Run immediately on startup, then on schedule
runChecks().catch((err) => console.error('Initial check failed:', err));
setInterval(() => runChecks().catch((err) => console.error('Check failed:', err)), intervalMs);

// ── Start server ─────────────────────────────────────────────────────────────

const port = config.port || 3001;
app.listen(port, () => {
  if (!config.auth.passwordHash) {
    console.warn(
      '[WARN] No passwordHash set — login uses plaintext password or default "admin".\n' +
      '       Run: node set-password.js  to set a proper password.'
    );
  }
  if (config.sessionSecret === 'replace-with-a-long-random-string-here') {
    console.warn('[WARN] Using default sessionSecret — update config.json before production use.');
  }
  console.log(`WebStatus running at http://localhost:${port}`);
  console.log(`Checking ${config.sites.length} site(s) every ${config.checkIntervalSeconds}s`);
  if (config.rdpServer.enabled) {
    console.log(`RDP server: ${config.rdpServer.hostname}`);
  }
});
