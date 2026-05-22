'use strict';
const https = require('https');
const http = require('http');

function checkSite(site, slowThresholdMs) {
  return new Promise((resolve) => {
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
    const lib = site.url.startsWith('https') ? https : http;

    let settled = false;
    function finish() {
      if (settled) return;
      settled = true;
      result.responseTimeMs = Date.now() - start;
      resolve(result);
    }

    const req = lib.get(
      site.url,
      { timeout: 10000, rejectUnauthorized: false },
      (res) => {
        result.statusCode = res.statusCode;
        if (res.statusCode !== result.expectedStatus) {
          result.state = 'warn';
        } else if (Date.now() - start > slowThresholdMs) {
          result.state = 'slow';
        } else {
          result.state = 'up';
        }
        res.destroy();
        finish();
      }
    );

    req.on('timeout', () => {
      result.state = 'down';
      result.error = 'Timed out after 10s';
      req.destroy();
      finish();
    });

    req.on('error', (err) => {
      result.state = 'down';
      result.error = err.message;
      finish();
    });
  });
}

module.exports = { checkSite };
