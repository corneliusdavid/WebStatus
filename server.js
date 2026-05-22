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

// Normalize config into grouped format: [{displayName, servers:[{hostname,label}]}]
// Handles: new grouped format, flat array (intermediate), legacy single rdpServer object
function normalizeRdpConfig() {
  const raw = config.rdpServers || (config.rdpServer ? [config.rdpServer] : []);
  return raw.map((entry) => {
    if (entry.servers) return entry; // already grouped
    return { displayName: entry.displayName || entry.hostname, servers: [{ hostname: entry.hostname, label: entry.hostname }] };
  });
}
const rdpGroups = normalizeRdpConfig();
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
  rdpServers: rdpGroups.map((group) => ({
    displayName: group.displayName,
    state: 'pending',
    servers: group.servers.map((s) => ({
      hostname: s.hostname,
      label: s.label || s.hostname,
      state: 'pending',
      cpuPercent: null,
      totalMemoryMB: null,
      usedMemoryMB: null,
      activeSessions: null,
      disconnectedSessions: null,
      checkedAt: null,
      error: null,
    })),
  })),
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

  const rdpChecks = rdpGroups.flatMap((group, gi) =>
    group.servers.map((s, si) =>
      getRdpMetrics(s.hostname).then((result) => {
        status.rdpServers[gi].servers[si] = { ...result, label: s.label || s.hostname };
        // Derive group-level state from individual servers
        const states = status.rdpServers[gi].servers.map((sv) => sv.state);
        status.rdpServers[gi].state = states.every((st) => st === 'up') ? 'up'
          : states.some((st) => st === 'up') ? 'warn' : 'down';
      })
    )
  );

  await Promise.allSettled([...siteChecks, ...rdpChecks]);

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
  rdpGroups.forEach((g) => console.log(`RDP group: ${g.displayName} (${g.servers.map((s) => s.hostname).join(', ')})`));
});
