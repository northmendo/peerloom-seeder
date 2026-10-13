// Lay out one PeerLoom Seeder package for a platform, the payload every
// installer and image copies:
//
//   <dir>/bare, seeder/seeder.bundle   the seeder (Bare) with its addons
//   <dir>/host/server.js               the host, one esbuild file, with
//                                      index.html, icon.png and version.json
//   <dir>/node                         a pinned Node binary (node: true;
//                                      the Docker image has its own)
//   <dir>/VERSION, LICENSE.txt, THIRD-PARTY-NOTICES.txt, licenses/
//
// On Linux the rocksdb-native addon gets its own libatomic.so.1, which
// servers and minimal installs often lack (from PearOffice's dist-seeder.js).
//
// Usage: node scripts/stage.js <platform-arch> <dir> [--node]
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { build, runtimeDir } = require('./build-bare')
const { notices } = require('./third-party-notices')

const root = path.join(__dirname, '..')
const version = require(path.join(root, 'package.json')).version
const cache = path.join(root, 'dist', 'cache')
const NODE_VERSION = '22.20.0'

const LIBATOMIC = {
  'linux-x64': { deb: 'libatomic1_12.2.0-14+deb12u1_amd64.deb', sha256: 'fbd4e154a6b444229ea002cc209df099209c0adc09102e5fd21239a3d2b55e2d', lib: 'usr/lib/x86_64-linux-gnu/libatomic.so.1.2.0' },
  'linux-arm64': { deb: 'libatomic1_12.2.0-14+deb12u1_arm64.deb', sha256: '1693aa13ce2b30d061a519fc28b77b9bab8c8e45804ced5969d99821e1bc2159', lib: 'usr/lib/aarch64-linux-gnu/libatomic.so.1.2.0' }
}

function download (url, file, sha256) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (!fs.existsSync(file)) execFileSync('curl', ['-fsSL', '-o', file, url])
  if (!sha256) return file
  const got = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  if (got !== sha256) { fs.rmSync(file); throw new Error(path.basename(file) + ': checksum ' + got + ', expected ' + sha256) }
  return file
}

function addLibatomic (target, dir) {
  const { deb, sha256, lib } = LIBATOMIC[target]
  const file = download('https://deb.debian.org/debian/pool/main/g/gcc-12/' + deb, path.join(cache, deb), sha256)
  const x = fs.mkdtempSync(path.join(os.tmpdir(), 'libatomic-'))
  execFileSync('ar', ['x', file], { cwd: x })
  const data = fs.readdirSync(x).find((n) => n.startsWith('data.tar'))
  execFileSync('tar', ['xf', data, './' + lib], { cwd: x })
  const addon = path.join(dir, 'seeder', 'node_modules', 'rocksdb-native', 'prebuilds', target)
  if (!fs.existsSync(path.join(addon, 'rocksdb-native.bare'))) throw new Error('rocksdb-native.bare not at ' + addon)
  fs.mkdirSync(path.join(addon, 'rocksdb-native'), { recursive: true })
  fs.copyFileSync(path.join(x, lib), path.join(addon, 'rocksdb-native', 'libatomic.so.1'))
  fs.rmSync(x, { recursive: true, force: true })
}

// Node's official build, checked against its published SHASUMS256.txt.
function addNode (target, dir) {
  const [platform, arch] = target.split('-')
  const name = 'node-v' + NODE_VERSION + '-' + platform + '-' + arch
  const base = 'https://nodejs.org/dist/v' + NODE_VERSION + '/'
  const sums = fs.readFileSync(download(base + 'SHASUMS256.txt', path.join(cache, 'node-v' + NODE_VERSION + '-SHASUMS256.txt')), 'utf8')
  const sha = (sums.split('\n').find((l) => l.endsWith('  ' + name + '.tar.xz')) || '').split(' ')[0]
  if (!sha) throw new Error('no checksum for ' + name)
  const tar = download(base + name + '.tar.xz', path.join(cache, name + '.tar.xz'), sha)
  execFileSync('tar', ['xJf', tar, '-C', dir, '--strip-components=2', name + '/bin/node'])
  execFileSync('tar', ['xJf', tar, '-C', dir, '--strip-components=1', name + '/LICENSE'])
  fs.renameSync(path.join(dir, 'LICENSE'), path.join(dir, 'licenses', 'node-LICENSE'))
}

async function stage (target, dir, { node = false } = {}) {
  fs.rmSync(dir, { recursive: true, force: true })
  // The Bare runtime and bundle, with the bundle and addons under seeder/.
  const bare = build(target, path.join(dir, 'seeder'))
  fs.renameSync(bare.bare, path.join(dir, path.basename(bare.bare)))
  // The runtime ships with symbols (about 90 MB); strip can only read this
  // machine's own architecture.
  if (target === process.platform + '-' + process.arch && process.platform === 'linux') {
    try { execFileSync('strip', ['--strip-unneeded', path.join(dir, 'bare')]) } catch {}
  }

  const hostDir = path.join(dir, 'host')
  fs.mkdirSync(hostDir, { recursive: true })
  const esbuild = require('esbuild')
  const meta = await esbuild.build({
    entryPoints: [path.join(root, 'host', 'server.js')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: path.join(hostDir, 'server.js'),
    metafile: true,
    logLevel: 'warning'
  })
  for (const f of ['index.html', 'icon.png']) fs.copyFileSync(path.join(root, 'host', f), path.join(hostDir, f))
  fs.writeFileSync(path.join(hostDir, 'version.json'), JSON.stringify({ version }) + '\n')

  fs.mkdirSync(path.join(dir, 'licenses'), { recursive: true })
  if (target.startsWith('linux-')) {
    addLibatomic(target, dir)
    for (const f of fs.readdirSync(path.join(root, 'packaging', 'licenses'))) fs.copyFileSync(path.join(root, 'packaging', 'licenses', f), path.join(dir, 'licenses', f))
  }
  if (node) addNode(target, dir)

  const metaFile = path.join(os.tmpdir(), 'peerloom-seeder-host-meta-' + process.pid + '.json')
  fs.writeFileSync(metaFile, JSON.stringify(meta.metafile))
  const runtime = [runtimeDir(target), path.join(root, 'node_modules', 'bare-runtime')]
  const n = notices([path.join(dir, 'seeder', 'seeder.bundle'), metaFile], { extraDirs: runtime, font: true })
  fs.rmSync(metaFile)
  fs.writeFileSync(path.join(dir, 'THIRD-PARTY-NOTICES.txt'), n.text)
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(dir, 'LICENSE.txt'))
  fs.writeFileSync(path.join(dir, 'VERSION'), version + '\n')
  return dir
}

if (require.main === module) {
  const [target, dir] = process.argv.slice(2)
  if (!target || !dir) { console.error('usage: node scripts/stage.js <platform-arch> <dir> [--node]'); process.exit(2) }
  stage(target, path.resolve(dir), { node: process.argv.includes('--node') })
    .then((d) => console.log('staged ' + path.relative(root, d)))
    .catch((e) => { console.error(e.message); process.exit(1) })
}

module.exports = { stage, NODE_VERSION }
