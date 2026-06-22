'use strict';
const https = require('https');
const http = require('http');

const MAX_REDIRECTS = 5;

const REQUEST_HEADERS = {
  // Node sends no User-Agent by default, and some WAFs (e.g. openresty)
  // return 403 to header-less requests. Send an honest, non-browser UA:
  // spoofing a real browser is worse — fingerprint-aware WAFs block a
  // "Chrome" UA that lacks a real browser's TLS handshake.
  'User-Agent': 'WebStatus-Monitor/1.0 (+uptime check)',
  Accept: '*/*',
};

// Single HTTP(S) request. Resolves with { statusCode, location } or rejects.
function request(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(
      url,
      { timeout: 10000, rejectUnauthorized: false, headers: REQUEST_HEADERS },
      (res) => {
        const { statusCode } = res;
        const location = res.headers.location || null;
        res.destroy(); // we only need headers, not the body
        resolve({ statusCode, location });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timed out after 10s'));
    });
    req.on('error', reject);
  });
}

async function checkSite(site, slowThresholdMs) {
  const result = {
    name: site.name,
    url: site.url,
    expectedStatus: site.expectedStatus || 200,
    state: 'pending',
    statusCode: null,
    responseTimeMs: null,
    checkedAt: new Date().toISOString(),
    error: null,
  };

  const start = Date.now();

  try {
    let currentUrl = site.url;
    let res;

    // Follow redirects like a browser, evaluating the final response.
    for (let hops = 0; ; hops++) {
      res = await request(currentUrl);

      const isRedirect = res.statusCode >= 300 && res.statusCode < 400 && res.location;
      if (!isRedirect) break;

      if (hops >= MAX_REDIRECTS) {
        result.statusCode = res.statusCode;
        result.state = 'warn';
        result.error = `Too many redirects (> ${MAX_REDIRECTS})`;
        result.responseTimeMs = Date.now() - start;
        return result;
      }

      // Resolve relative Location headers against the current URL.
      currentUrl = new URL(res.location, currentUrl).toString();
    }

    result.statusCode = res.statusCode;
    if (res.statusCode !== result.expectedStatus) {
      result.state = 'warn';
    } else if (Date.now() - start > slowThresholdMs) {
      result.state = 'slow';
    } else {
      result.state = 'up';
    }
  } catch (err) {
    result.state = 'down';
    result.error = err.message;
  }

  result.responseTimeMs = Date.now() - start;
  return result;
}

module.exports = { checkSite };
