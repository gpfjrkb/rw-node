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
const CADDY_REPO = 'caddyserver/caddy';
const CONF_DIR = path.join(INSTALL_DIR, 'conf', 'caddy');
const CADDY_DATA_DIR = path.join(INSTALL_DIR, 'caddy', 'data');
const CADDY_CONFIG_DIR = path.join(INSTALL_DIR, 'caddy', 'config');
const APP_BIN = path.join(BIN_DIR, 'rw-node-go');
const CADDY_BIN = path.join(BIN_DIR, 'caddy');
const VERSION_FILE = path.join(INSTALL_DIR, '.rw-node-go-version');
const CADDY_VERSION_FILE = path.join(INSTALL_DIR, '.caddy-version');
const CADDYFILE = path.join(CONF_DIR, 'Caddyfile');

let caddyProcess = null;
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

function detectCaddyAssetPattern() {
  const arch = os.arch();
  if (arch === 'x64') return /^caddy_.*_linux_amd64\.tar\.gz$/;
  if (arch === 'arm64') return /^caddy_.*_linux_arm64\.tar\.gz$/;
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

function buildCaddyEnv(env) {
  return {
    ...env,
    HOME: CWD,
    XDG_DATA_HOME: CADDY_DATA_DIR,
    XDG_CONFIG_HOME: CADDY_CONFIG_DIR,
  };
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

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch (_) {
    return false;
  }
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
    const request = https.get(url, {
      headers: { 'User-Agent': 'rw-node-go-starter' },
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        downloadFile(response.headers.location, destination).then(resolve, reject);
        return;
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        reject(new Error(`download failed with status ${response.statusCode}: ${url}`));
        return;
      }

      const file = fs.createWriteStream(destination);
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', (error) => {
        fs.rmSync(destination, { force: true });
        reject(error);
      });
    });
    request.on('error', (error) => {
      fs.rmSync(destination, { force: true });
      reject(error);
    });
  });
}

function assertDownloadedFile(file, label) {
  if (!fs.existsSync(file)) {
    fail(`${label} download did not create expected archive: ${file}`);
  }
  if (fs.statSync(file).size === 0) {
    fs.rmSync(file, { force: true });
    fail(`${label} download created an empty archive: ${file}`);
  }
}

async function resolveCaddyRelease() {
  const version = process.env.CADDY_VERSION;
  const url = version
    ? `https://api.github.com/repos/${CADDY_REPO}/releases/tags/${version}`
    : `https://api.github.com/repos/${CADDY_REPO}/releases/latest`;
  const release = await httpsGetJson(url);
  if (!release.tag_name || !Array.isArray(release.assets)) {
    fail('unable to resolve Caddy release assets');
  }
  return release;
}

function findCaddyDownloadUrl(release) {
  const pattern = detectCaddyAssetPattern();
  const asset = release.assets.find(item => pattern.test(item.name || ''));
  if (!asset || !asset.browser_download_url) {
    fail(`Caddy ${release.tag_name} does not provide a supported Linux asset for ${os.arch()}`);
  }
  return asset.browser_download_url;
}

async function ensureCaddy() {
  if (process.env.CADDY_BIN) {
    if (!fs.existsSync(process.env.CADDY_BIN)) {
      fail(`CADDY_BIN does not exist: ${process.env.CADDY_BIN}`);
    }
    return process.env.CADDY_BIN;
  }

  if (fs.existsSync(CADDY_BIN) && isExecutable(CADDY_BIN)) {
    log('Caddy already installed; skipping download');
    return CADDY_BIN;
  }

  const release = await resolveCaddyRelease();
  const url = findCaddyDownloadUrl(release);
  const assetName = path.basename(new URL(url).pathname);
  const tmpDir = path.join(INSTALL_DIR, 'tmp');
  const archive = path.join(tmpDir, assetName);
  const stageDir = path.join(tmpDir, 'caddy-stage');

  log(`installing Caddy ${release.tag_name}`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  fs.mkdirSync(BIN_DIR, { recursive: true });

  await downloadFile(url, archive);
  assertDownloadedFile(archive, 'Caddy');
  run('tar', ['-xzf', archive, '-C', stageDir]);

  const stagedBin = path.join(stageDir, 'caddy');
  if (!fs.existsSync(stagedBin)) {
    fail('Caddy release asset is missing caddy');
  }

  fs.copyFileSync(stagedBin, CADDY_BIN);
  fs.chmodSync(CADDY_BIN, 0o755);
  fs.writeFileSync(CADDY_VERSION_FILE, `${release.tag_name}\n`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return CADDY_BIN;
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
  assertDownloadedFile(archive, 'rw-node-go');
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

function writeCaddyfile(env) {
  fs.mkdirSync(CONF_DIR, { recursive: true });
  fs.writeFileSync(CADDYFILE, `{
    admin localhost:2019
    auto_https off
}

http://:${env.HTTP_FRONT_PORT} {
    handle /health {
        respond "ok\\n" 200
    }

    handle /xh-* {
        reverse_proxy 127.0.0.1:${env.XHTTP_UPSTREAM_PORT}
    }

    handle /ws-* {
        reverse_proxy 127.0.0.1:${env.WS_UPSTREAM_PORT}
    }

    handle /node/* {
        reverse_proxy https://127.0.0.1:${env.NODE_PORT} {
            transport http {
                tls_insecure_skip_verify
            }
        }
    }

    handle /vision/* {
        reverse_proxy https://127.0.0.1:${env.NODE_PORT} {
            transport http {
                tls_insecure_skip_verify
            }
        }
    }

    handle {
        respond 404
    }
}
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

  const children = [appProcess, caddyProcess].filter(Boolean);
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
  const caddyEnv = buildCaddyEnv(env);

  const caddyBin = await ensureCaddy();
  await ensureRwNodeGo();
  writeCaddyfile(env);
  fs.mkdirSync(CADDY_DATA_DIR, { recursive: true });
  fs.mkdirSync(CADDY_CONFIG_DIR, { recursive: true });

  run(caddyBin, ['validate', '--config', CADDYFILE, '--adapter', 'caddyfile'], { env: caddyEnv });

  log(`starting Caddy on port ${env.HTTP_FRONT_PORT}`);
  caddyProcess = spawnManaged(caddyBin, ['run', '--config', CADDYFILE, '--adapter', 'caddyfile'], caddyEnv);

  log('starting rw-node-go');
  appProcess = spawnManaged(APP_BIN, [], env);

  const handleExit = (name) => (code, signal) => {
    if (shuttingDown) return;
    log(`${name} exited with ${signal || code}`);
    terminate(1);
  };

  caddyProcess.on('exit', handleExit('caddy'));
  appProcess.on('exit', handleExit('rw-node-go'));
}

process.on('SIGINT', () => terminate(0));
process.on('SIGTERM', () => terminate(0));

main().catch((error) => {
  console.error(`${PREFIX} ERROR: ${error.message}`);
  terminate(1);
});
