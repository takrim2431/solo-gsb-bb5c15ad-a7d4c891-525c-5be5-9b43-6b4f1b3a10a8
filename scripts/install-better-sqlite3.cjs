#!/usr/bin/env node
/**
 * better-sqlite3 安装兜底：
 * 1. 正常 npm 安装时会先运行 prebuild-install，成功则直接结束；
 * 2. 网络较慢导致预编译包下载超时、又无法现场编译时，
 *    本脚本直接从 GitHub Release 下载对应 ABI 的预编译产物放入 build/Release。
 *
 * 可通过环境变量 BETTER_SQLITE3_BINARY_URL 指定下载地址。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { execFileSync } = require('child_process');

const pkgDir = path.join(__dirname, '..', 'node_modules', 'better-sqlite3');
const version = require('better-sqlite3/package.json').version;

function existingBinaryWorks() {
  const target = path.join(pkgDir, 'build', 'Release', 'better_sqlite3.node');
  if (!fs.existsSync(target)) return false;
  try {
    require('better-sqlite3');
    return true;
  } catch {
    return false;
  }
}

if (existingBinaryWorks()) process.exit(0);

const abi = process.versions.modules;
const platform = process.platform;
const arch = process.arch;
let libc = '';
if (platform === 'linux') {
  try {
    libc = require('detect-libc').familySync() === 'musl' ? 'musl' : '';
  } catch {
    libc = ''; // 默认按 gnu（Debian slim 等）处理
  }
}
// better-sqlite3 v11 的预编译包命名
const fileName =
  platform === 'darwin'
    ? `better-sqlite3-v${version}-darwin-${arch === 'arm64' ? 'arm64' : 'x64'}.tar.gz`
    : `better-sqlite3-v${version}-node-v${abi}-${platform}-${arch}${libc === 'musl' ? '-musl' : ''}.tar.gz`;

const url =
  process.env.BETTER_SQLITE3_BINARY_URL ||
  `https://github.com/WiseLibs/better-sqlite3/releases/download/v${version}/${fileName}`;

function download(fileUrl, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    https
      .get(fileUrl, { headers: { 'User-Agent': 'node-install-script' }, timeout: 60000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(download(new URL(res.headers.location, fileUrl).toString(), dest, redirects + 1));
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${fileUrl}`));
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on('finish', () => out.close(resolve));
        out.on('error', reject);
      })
      .on('timeout', function () { this.destroy(new Error('download timeout')); })
      .on('error', reject);
  });
}

(async () => {
  const tmp = path.join(os.tmpdir(), fileName);
  if (url.startsWith('file://')) {
    fs.copyFileSync(new URL(url), tmp);
  } else {
    console.log(`[sqlite] 获取预编译包: ${url}`);
    await download(url, tmp);
  }
  // 包内顶层就是 build/...，直接解到包目录
  execFileSync('tar', ['xzf', tmp], { cwd: pkgDir, stdio: 'inherit' });
  if (!existingBinaryWorks()) throw new Error('预编译产物下载后仍无法加载');
  console.log('[sqlite] better-sqlite3 就绪');
})().catch((err) => {
  console.error('[sqlite] 预编译包安装失败:', err.message);
  console.error('[sqlite] 请确认可访问 github.com，或设置 BETTER_SQLITE3_BINARY_URL 指向离线包');
  process.exit(1);
});
