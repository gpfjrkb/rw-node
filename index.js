#!/usr/bin/env node
'use strict';

const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const PREFIX = '[node-starter]';
const REPO = 'x-dora/rw-node-go';
const CWD = process.cwd();
const INSTALL_DIR = path.join(CWD, '.rw-node-go');
const BIN_DIR = path.join(INSTALL_DIR, 'bin');
const ASSET_DIR = path.join(INSTALL_DIR, 'share', 'xray');
const CONF_DIR = path.join(INSTALL_DIR, 'conf', 'haproxy');
const APP_BIN = path.join(BIN_DIR, 'rw-node-go');
const VERSION_FILE = path.join(INSTALL_DIR, '.rw-node-go-version');
const HAPROXY_CONF = path.join(CONF_DIR, 'haproxy.cfg');

let haproxyProcess = null;
let appProcess = null;
let shuttingDown = false;

function log(message) {
  console.log(`${PREFIX} ${message}`);
}

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || CWD,
    env: options.env || process.env,
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    fail(`${command} ${args.join(' ')} failed${output ? `:\n${output}` : ''}`);
  }

  return result;
}

function commandExists(command) {
  const result = spawnSync('sh', ['-c', `command -v ${quoteShell(command)} >/dev/null 2>&1`], {
    encoding: 'utf8',
  });
  return result.status === 0;
}

function resolveCommand(command) {
  const result = spawnSync('sh', ['-c', `command -v ${quoteShell(command)}`], {
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : '';
}

function quoteShell(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function ensureLinux() {
  if (process.platform !== 'linux') {
    fail(`unsupported platform: ${process.platform}; only Linux x64/arm64 is supported`);
  }
}

function detectAssetName() {
  const arch = os.arch();
  if (arch === 'x64') return 'rw-node-go-linux-64.tar.gz';
  if (arch === 'arm64') return 'rw-node-go-linux-arm64-v8a.tar.gz';
  fail(`unsupported architecture: ${arch}; only x64/arm64 is supported`);
}

function isPort(value) {
  return /^[0-9]+$/.test(String(value)) && Number(value) >= 1 && Number(value) <= 65535;
}

function buildEnv() {
  const env = { ...process.env };
  env.NODE_PORT = env.NODE_PORT || '2222';
  env.NODE_TLS_CLIENT_AUTH = env.NODE_TLS_CLIENT_AUTH || 'none';
  env.INTERNAL_REST_PORT = env.INTERNAL_REST_PORT || '61001';
  env.REQUIRE_SECRET_KEY = env.REQUIRE_SECRET_KEY || 'true';
  env.RW_NODE_DIR = env.RW_NODE_DIR || CWD;
  env.XRAY_LOCATION_ASSET = env.XRAY_LOCATION_ASSET || ASSET_DIR;
  env.HTTP_FRONT_PORT = env.HTTP_FRONT_PORT || env.PORT || '3000';
  env.XHTTP_UPSTREAM_PORT = env.XHTTP_UPSTREAM_PORT || '8080';
  env.WS_UPSTREAM_PORT = env.WS_UPSTREAM_PORT || '8880';
  return env;
}

function validatePorts(env) {
  const names = ['HTTP_FRONT_PORT', 'NODE_PORT', 'XHTTP_UPSTREAM_PORT', 'WS_UPSTREAM_PORT'];
  for (const name of names) {
    if (!isPort(env[name])) {
      fail(`${name} must be a valid TCP port`);
    }
  }

  if (env.HTTP_FRONT_PORT === env.NODE_PORT) {
    fail('HTTP_FRONT_PORT must differ from NODE_PORT');
  }
}

function ensureHaproxy() {
  if (process.env.HAPROXY_BIN) {
    if (!fs.existsSync(process.env.HAPROXY_BIN)) {
      fail(`HAPROXY_BIN does not exist: ${process.env.HAPROXY_BIN}`);
    }
    return process.env.HAPROXY_BIN;
  }

  const existing = resolveCommand('haproxy');
  if (existing) {
    return existing;
  }

  log('haproxy not found; attempting system package install');
  if (commandExists('apk')) {
    run('apk', ['add', '--no-cache', 'haproxy'], { stdio: 'inherit' });
  } else if (commandExists('apt-get')) {
    run('apt-get', ['update'], { stdio: 'inherit' });
    run('apt-get', ['install', '-y', 'haproxy'], { stdio: 'inherit' });
  } else if (commandExists('dnf')) {
    run('dnf', ['install', '-y', 'haproxy'], { stdio: 'inherit' });
  } else if (commandExists('yum')) {
    run('yum', ['install', '-y', 'haproxy'], { stdio: 'inherit' });
  } else {
    fail('haproxy not found and no supported package manager was detected; install haproxy or set HAPROXY_BIN');
  }

  const installed = resolveCommand('haproxy');
  if (!installed) {
    fail('haproxy installation finished but haproxy is still not available; install haproxy or set HAPROXY_BIN');
  }
  return installed;
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'rw-node-go-starter',
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        data += chunk;
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`GET ${url} failed with status ${res.statusCode}: ${data}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function downloadFile(url, destination) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destination);
    const request = https.get(url, {
      headers: { 'User-Agent': 'rw-node-go-starter' },
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close(() => fs.rmSync(destination, { force: true }));
        downloadFile(response.headers.location, destination).then(resolve, reject);
        return;
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        file.close(() => fs.rmSync(destination, { force: true }));
        reject(new Error(`download failed with status ${response.statusCode}: ${url}`));
        return;
      }

      response.pipe(file);
      file.on('finish', () => file.close(resolve));
    });
    request.on('error', (error) => {
      file.close(() => fs.rmSync(destination, { force: true }));
      reject(error);
    });
  });
}

async function resolveRwNodeGoVersion() {
  if (process.env.RW_NODE_GO_VERSION) {
    return process.env.RW_NODE_GO_VERSION;
  }

  const release = await httpsGetJson(`https://api.github.com/repos/${REPO}/releases/latest`);
  if (!release.tag_name) {
    fail('unable to resolve latest rw-node-go release');
  }
  return release.tag_name;
}

function hasRwNodeGoInstall() {
  return fs.existsSync(APP_BIN)
    && fs.existsSync(path.join(ASSET_DIR, 'geoip.dat'))
    && fs.existsSync(path.join(ASSET_DIR, 'geosite.dat'));
}

async function ensureRwNodeGo() {
  if (hasRwNodeGoInstall()) {
    log('rw-node-go already installed; skipping download');
    return;
  }

  const assetName = detectAssetName();
  const version = await resolveRwNodeGoVersion();
  const url = `https://github.com/${REPO}/releases/download/${version}/${assetName}`;
  const tmpDir = path.join(INSTALL_DIR, 'tmp');
  const archive = path.join(tmpDir, assetName);
  const stageDir = path.join(tmpDir, 'stage');

  log(`installing rw-node-go ${version}`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.mkdirSync(ASSET_DIR, { recursive: true });

  await downloadFile(url, archive);
  run('tar', ['-xzf', archive, '-C', stageDir]);

  const stagedBin = path.join(stageDir, 'rw-node-go');
  const stagedGeoip = path.join(stageDir, 'geoip.dat');
  const stagedGeosite = path.join(stageDir, 'geosite.dat');
  if (!fs.existsSync(stagedBin)) fail('rw-node-go release asset is missing rw-node-go');
  if (!fs.existsSync(stagedGeoip) || !fs.existsSync(stagedGeosite)) {
    fail('rw-node-go release asset is missing geoip.dat or geosite.dat');
  }

  fs.copyFileSync(stagedBin, APP_BIN);
  fs.chmodSync(APP_BIN, 0o755);
  fs.copyFileSync(stagedGeoip, path.join(ASSET_DIR, 'geoip.dat'));
  fs.copyFileSync(stagedGeosite, path.join(ASSET_DIR, 'geosite.dat'));
  fs.writeFileSync(VERSION_FILE, `${version}\n`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function writeHaproxyConfig(env) {
  fs.mkdirSync(CONF_DIR, { recursive: true });
  fs.writeFileSync(HAPROXY_CONF, `global
    maxconn 1024
    nbthread 1
    log stdout format raw local0 warning

defaults
    mode http
    log global
    option dontlognull
    timeout connect 5s
    timeout client 1h
    timeout server 1h
    timeout tunnel 1h

frontend http_front
    bind *:${env.HTTP_FRONT_PORT}
    acl is_health path -i /health
    acl is_xh path_beg -i /xh-
    acl is_ws path_beg -i /ws-
    acl is_node_api path_beg -i /node/
    acl is_vision_api path_beg -i /vision/

    http-request return status 200 content-type text/plain string "ok\\n" if is_health
    http-request return status 404 if !is_health !is_xh !is_ws !is_node_api !is_vision_api
    use_backend xhttp_backend if is_xh
    use_backend ws_backend if is_ws
    use_backend node_api_backend if is_node_api
    use_backend node_api_backend if is_vision_api

backend xhttp_backend
    option http-no-delay
    server xhttp 127.0.0.1:${env.XHTTP_UPSTREAM_PORT}

backend ws_backend
    option http-server-close
    timeout tunnel 1h
    server ws 127.0.0.1:${env.WS_UPSTREAM_PORT}

backend node_api_backend
    option http-server-close
    server node_api 127.0.0.1:${env.NODE_PORT} ssl verify none
`);
}

function spawnManaged(command, args, env) {
  return spawn(command, args, {
    cwd: CWD,
    env,
    stdio: 'inherit',
  });
}

function terminate(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  const children = [appProcess, haproxyProcess].filter(Boolean);
  if (children.length === 0) {
    process.exit(code);
  }

  for (const child of children) {
    if (child && child.exitCode === null && !child.killed) {
      child.kill('SIGTERM');
    }
  }

  setTimeout(() => {
    for (const child of children) {
      if (child && child.exitCode === null && !child.killed) {
        child.kill('SIGKILL');
      }
    }
    process.exit(code);
  }, 5000);
}

async function main() {
  ensureLinux();
  const env = buildEnv();
  validatePorts(env);

  const haproxyBin = ensureHaproxy();
  await ensureRwNodeGo();
  writeHaproxyConfig(env);

  run(haproxyBin, ['-c', '-f', HAPROXY_CONF], { env });

  log(`starting HAProxy on port ${env.HTTP_FRONT_PORT}`);
  haproxyProcess = spawnManaged(haproxyBin, ['-W', '-db', '-f', HAPROXY_CONF], env);

  log('starting rw-node-go');
  appProcess = spawnManaged(APP_BIN, [], env);

  const handleExit = (name) => (code, signal) => {
    if (shuttingDown) return;
    log(`${name} exited with ${signal || code}`);
    terminate(1);
  };

  haproxyProcess.on('exit', handleExit('haproxy'));
  appProcess.on('exit', handleExit('rw-node-go'));
}

process.on('SIGINT', () => terminate(0));
process.on('SIGTERM', () => terminate(0));

main().catch((error) => {
  console.error(`${PREFIX} ERROR: ${error.message}`);
  terminate(1);
});
