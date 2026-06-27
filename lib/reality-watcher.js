#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const http = require('http');
const crypto = require('crypto');

const LOG_PREFIX = process.env.LOG_PREFIX || '[rw-node]';
const INTERNAL_REST_PORT = process.env.INTERNAL_REST_PORT || '61001';
const CADDY_ADMIN_SOCK = process.env.CADDY_ADMIN_SOCK || '/tmp/caddy-admin.sock';
const CADDY_BIN = process.env.CADDY_BIN || 'caddy';
const REALITY_SPLIT_INTERVAL = parseInt(process.env.REALITY_SPLIT_INTERVAL || '15', 10) * 1000;
const HTTP_FRONT_PORT = process.env.HTTP_FRONT_PORT || '3000';
const NODE_PORT = process.env.NODE_PORT || '2222';
const CADDY_HTTP_PORT = process.env.CADDY_HTTP_PORT || String(parseInt(HTTP_FRONT_PORT, 10) + 1);
const XHTTP_UPSTREAM_PORT = process.env.XHTTP_UPSTREAM_PORT || '8080';
const WS_UPSTREAM_PORT = process.env.WS_UPSTREAM_PORT || '8880';
const CADDY_SITE_DIR = process.env.CADDY_SITE_DIR || '';

const configPath = process.argv[2];
if (!configPath) {
  console.error(`${LOG_PREFIX} ERROR: reality-watcher.js requires config_path argument`);
  process.exit(1);
}

function log(msg) {
  console.log(`${LOG_PREFIX} ${msg}`);
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function extractRealityConfig(config) {
  const inbounds = config.inbounds || [];
  const realityInbounds = inbounds.filter(
    (ib) => ib.streamSettings && ib.streamSettings.security === 'reality'
  );

  if (realityInbounds.length === 0) return null;

  const port = realityInbounds[0].port;
  const allNames = new Set();
  for (const ib of realityInbounds) {
    const names = (ib.streamSettings.realitySettings || {}).serverNames || [];
    for (const n of names) allNames.add(n);
  }

  if (allNames.size === 0) return null;

  return { port, serverNames: [...allNames].sort().join(' ') };
}

function generateLayer4Block(realitySnis, realityPort) {
  if (realitySnis && realityPort) {
    return `    layer4 {
        :${HTTP_FRONT_PORT} {
            @reality tls sni ${realitySnis}
            route @reality {
                proxy 127.0.0.1:${realityPort}
            }
            @tls tls
            route @tls {
                proxy 127.0.0.1:${NODE_PORT}
            }
            route {
                proxy 127.0.0.1:${CADDY_HTTP_PORT}
            }
        }
    }`;
  }
  return `    layer4 {
        :${HTTP_FRONT_PORT} {
            @tls tls
            route @tls {
                proxy 127.0.0.1:${NODE_PORT}
            }
            route {
                proxy 127.0.0.1:${CADDY_HTTP_PORT}
            }
        }
    }`;
}

function generateCaddyConfig(realitySnis, realityPort) {
  const adminLine = `admin unix/${CADDY_ADMIN_SOCK}`;
  const layer4 = generateLayer4Block(realitySnis, realityPort);

  return `{
    ${adminLine}
    auto_https off
    persist_config off

    log {
        level WARN
    }

${layer4}

    servers :${CADDY_HTTP_PORT} {
        protocols h1
    }
}

http://:${CADDY_HTTP_PORT} {
    handle /health {
        respond "ok" 200
    }

    handle /xh-* {
        reverse_proxy 127.0.0.1:${XHTTP_UPSTREAM_PORT} {
            flush_interval -1
        }
    }

    handle /ws-* {
        reverse_proxy 127.0.0.1:${WS_UPSTREAM_PORT} {
            flush_interval -1
        }
    }

    handle /node/* {
        reverse_proxy https://127.0.0.1:${NODE_PORT} {
            transport http {
                tls_insecure_skip_verify
            }
        }
    }

    handle /vision/* {
        reverse_proxy https://127.0.0.1:${NODE_PORT} {
            transport http {
                tls_insecure_skip_verify
            }
        }
    }

    handle {
        root * "${CADDY_SITE_DIR}"
        try_files {path} {path}/ /index.html
        encode gzip
        file_server
    }
}
`;
}

function hashString(s) {
  return crypto.createHash('md5').update(s).digest('hex');
}

function caddyFmt() {
  try {
    execFileSync(CADDY_BIN, ['fmt', '--overwrite', configPath], { stdio: 'pipe', timeout: 5000 });
  } catch {
    // ignore format errors
  }
}

function caddyReload() {
  try {
    execFileSync(CADDY_BIN, [
      'reload', '--config', configPath, '--adapter', 'caddyfile',
      '--address', `unix/${CADDY_ADMIN_SOCK}`,
    ], { stdio: 'pipe', timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

function checkPort(port) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    socket.setTimeout(2000);
    socket.on('connect', () => { socket.destroy(); resolve(); });
    socket.on('error', (err) => { socket.destroy(); reject(err); });
    socket.on('timeout', () => { socket.destroy(); reject(new Error('timeout')); });
    socket.connect(parseInt(port, 10), '127.0.0.1');
  });
}

async function waitForPort(port, maxWait) {
  const end = Date.now() + maxWait;
  while (Date.now() < end) {
    try {
      await checkPort(port);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function main() {
  await waitForPort(INTERNAL_REST_PORT, 120000);

  let prevHash = '';
  let firstRun = true;

  while (true) {
    if (firstRun) {
      firstRun = false;
    } else {
      await new Promise((r) => setTimeout(r, REALITY_SPLIT_INTERVAL));
    }

    let configJson;
    try {
      const raw = await httpGet(`http://127.0.0.1:${INTERNAL_REST_PORT}/internal/get-config`);
      configJson = JSON.parse(raw);
    } catch {
      continue;
    }

    if (!configJson || Object.keys(configJson).length === 0) continue;

    const reality = extractRealityConfig(configJson);
    const realityPort = reality ? String(reality.port) : '';
    const realitySnis = reality ? reality.serverNames : '';

    const currentHash = hashString(`${realityPort}\n${realitySnis}`);
    if (currentHash === prevHash) continue;
    prevHash = currentHash;

    if (realitySnis && realityPort) {
      log(`REALITY split detected: snis=[${realitySnis}] port=${realityPort}`);
    } else {
      log('REALITY split cleared, reverting to default TLS routing');
    }

    fs.writeFileSync(configPath, generateCaddyConfig(realitySnis, realityPort));
    caddyFmt();

    if (caddyReload()) {
      log('Caddy reloaded with updated REALITY split config');
    } else {
      log('WARN: Caddy reload failed, will retry next cycle');
    }
  }
}

main().catch((err) => {
  console.error(`${LOG_PREFIX} ERROR: ${err.message}`);
  process.exit(1);
});
