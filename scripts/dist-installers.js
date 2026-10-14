// Build the Linux installers (from PearCircle's seeder-launcher scripts):
//   dist/pkg/peerloom-seeder_<version>_<amd64|arm64>.deb
//   dist/pkg/PeerLoomSeeder-<version>-<x86_64|aarch64>.AppImage
// each with a .sha256. Both carry a staged package (scripts/stage.js, with
// Node) and the launcher from packaging/linux/.
//
// The .deb installs to /opt/peerloom-seeder, links /usr/bin/peerloom-seeder,
// and its postinst starts a systemd user service for the installing user and
// adds a polkit rule so `peerloom-seeder update` can install the next .deb
// without a password (updater-helper.sh). The AppImage sets up the same
// service when first opened from the desktop.
//
// Then checks the x64 builds: the .deb installs with apt in a Debian 12
// container (podman), runs and answers on its dashboard, and its updater refuses a
// wrong checksum and installs the right one; the AppImage runs and answers,
// and its `update` refuses a wrong checksum and replaces the file with a
// right one.
//
// Usage: node scripts/dist-installers.js [x64|arm64]   (default both)
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync, spawn } = require('child_process')
const { stage } = require('./stage')

const root = path.join(__dirname, '..')
const version = require(path.join(root, 'package.json')).version
const outDir = path.join(root, 'dist', 'pkg')
const linux = path.join(root, 'packaging', 'linux')
const cache = path.join(root, 'dist', 'cache')
const ARCH = {
  x64: { deb: 'amd64', appimage: 'x86_64' },
  arm64: { deb: 'arm64', appimage: 'aarch64' }
}

function sha256 (file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }
function writeSum (file) {
  const sha = sha256(file)
  fs.writeFileSync(file + '.sha256', sha + '  ' + path.basename(file) + '\n')
  return sha
}
function copy (from, to, mode) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
  if (mode) fs.chmodSync(to, mode)
}
function fail (what) { console.error('not ok - ' + what); process.exit(1) }

// The launcher, unit and README next to a staged package.
function addLauncher (dir) {
  copy(path.join(linux, 'peerloom-seeder'), path.join(dir, 'peerloom-seeder'), 0o755)
  copy(path.join(linux, 'peerloom-seeder.service'), path.join(dir, 'peerloom-seeder.service'))
  copy(path.join(linux, 'README.md'), path.join(dir, 'README.md'))
}

async function buildDeb (arch, staged) {
  const debArch = ARCH[arch].deb
  const work = path.join(outDir, 'deb-' + debArch)
  const pkg = path.join(work, 'pkgroot')
  const opt = path.join(pkg, 'opt', 'peerloom-seeder')
  fs.rmSync(work, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(opt), { recursive: true })
  fs.cpSync(staged, opt, { recursive: true })
  addLauncher(opt)
  fs.writeFileSync(path.join(opt, 'INSTALL_KIND'), 'deb\n')
  copy(path.join(linux, 'updater-helper.sh'), path.join(opt, 'updater-helper.sh'), 0o755)
  copy(path.join(linux, 'updater-helper.rules.in'), path.join(opt, 'updater-helper.rules.in'))
  fs.mkdirSync(path.join(pkg, 'usr', 'bin'), { recursive: true })
  fs.symlinkSync('/opt/peerloom-seeder/peerloom-seeder', path.join(pkg, 'usr', 'bin', 'peerloom-seeder'))
  copy(path.join(linux, 'peerloom-seeder.desktop'), path.join(pkg, 'usr', 'share', 'applications', 'peerloom-seeder.desktop'))
  copy(path.join(linux, 'com.peerloomllc.seeder.metainfo.xml'), path.join(pkg, 'usr', 'share', 'metainfo', 'com.peerloomllc.seeder.metainfo.xml'))
  for (const size of [256, 512]) copy(path.join(root, 'assets', 'icon-' + size + '.png'), path.join(pkg, 'usr', 'share', 'icons', 'hicolor', size + 'x' + size, 'apps', 'peerloom-seeder.png'))
  fs.mkdirSync(path.join(pkg, 'DEBIAN'))
  for (const s of ['postinst', 'prerm', 'postrm']) copy(path.join(linux, 'deb', s), path.join(pkg, 'DEBIAN', s), 0o755)
  const kb = execFileSync('du', ['-sk', pkg], { encoding: 'utf8' }).split('\t')[0]
  fs.writeFileSync(path.join(pkg, 'DEBIAN', 'control'), fs.readFileSync(path.join(linux, 'deb', 'control'), 'utf8')
    .replace('__VERSION__', version).replace('__ARCH__', debArch).replace('__SIZE__', kb))
  const deb = path.join(outDir, 'peerloom-seeder_' + version + '_' + debArch + '.deb')
  execFileSync('dpkg-deb', ['--build', '--root-owner-group', '-Zxz', pkg, deb], { stdio: ['ignore', 'ignore', 'inherit'] })
  fs.rmSync(work, { recursive: true, force: true })
  writeSum(deb)
  console.log('built ' + path.basename(deb) + ' (' + Math.round(fs.statSync(deb).size / 1e6) + ' MB)')
  return deb
}

async function buildAppImage (arch, staged) {
  const aiArch = ARCH[arch].appimage
  const tool = path.join(cache, 'appimagetool-x86_64.AppImage')
  const runtime = path.join(cache, 'runtime-' + aiArch)
  const get = (url, file) => { if (!fs.existsSync(file)) execFileSync('curl', ['-fsSL', '-o', file, url]) }
  get('https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage', tool)
  get('https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-' + aiArch, runtime)
  fs.chmodSync(tool, 0o755)

  const appDir = path.join(outDir, 'AppDir-' + aiArch)
  const lib = path.join(appDir, 'usr', 'lib', 'peerloom-seeder')
  fs.rmSync(appDir, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(lib), { recursive: true })
  fs.cpSync(staged, lib, { recursive: true })
  addLauncher(lib)
  copy(path.join(linux, 'AppRun'), path.join(appDir, 'AppRun'), 0o755)
  copy(path.join(linux, 'peerloom-seeder.desktop'), path.join(appDir, 'peerloom-seeder.desktop'))
  copy(path.join(root, 'assets', 'icon-256.png'), path.join(appDir, 'peerloom-seeder.png'))
  copy(path.join(root, 'assets', 'icon-256.png'), path.join(appDir, '.DirIcon'))
  copy(path.join(root, 'assets', 'icon-256.png'), path.join(appDir, 'usr', 'share', 'icons', 'hicolor', '256x256', 'apps', 'peerloom-seeder.png'))
  const out = path.join(outDir, 'PeerLoomSeeder-' + version + '-' + aiArch + '.AppImage')
  fs.rmSync(out, { force: true })
  execFileSync(tool, ['--appimage-extract-and-run', '--runtime-file', runtime, appDir, out], { env: { ...process.env, ARCH: aiArch, VERSION: version }, stdio: ['ignore', 'ignore', 'pipe'] })
  fs.chmodSync(out, 0o755)
  fs.rmSync(appDir, { recursive: true, force: true })
  writeSum(out)
  console.log('built ' + path.basename(out) + ' (' + Math.round(fs.statSync(out).size / 1e6) + ' MB)')
  return out
}

// --- checks ------------------------------------------------------------------

function podman (args, opts = {}) { return execFileSync('podman', args, { encoding: 'utf8', ...opts }) }

function smokeDeb (deb) {
  const name = 'peerloom-seeder-deb-smoke-' + process.pid
  const dir = path.dirname(deb)
  podman(['run', '-d', '--name', name, '-v', dir + ':/pkg:ro,Z', 'docker.io/library/debian:12-slim', 'sleep', '600'])
  const sh = (cmd) => podman(['exec', name, 'bash', '-c', cmd])
  try {
    // As people install it: apt pulls in systemd.
    sh('apt-get update -qq >/tmp/apt.log 2>&1 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq /pkg/' + path.basename(deb) + ' >>/tmp/apt.log 2>&1 || { cat /tmp/apt.log; exit 1; }')
    const files = sh('test -x /usr/bin/peerloom-seeder && cat /opt/peerloom-seeder/INSTALL_KIND && stat -c %U:%a /opt/peerloom-seeder/updater-helper.sh')
    if (!/deb/.test(files) || !/root:755/.test(files)) fail('.deb layout: ' + files)
    sh('SEEDER_NO_UPDATE_CHECK=1 SEEDER_DATA=/root/data nohup peerloom-seeder run >/tmp/run.log 2>&1 &')
    const status = sh('for i in $(seq 1 60); do /opt/peerloom-seeder/node -e "fetch(\'http://127.0.0.1:8761/api/status\').then(r=>r.json()).then(s=>{console.log(JSON.stringify(s));process.exit(0)},()=>process.exit(1))" && exit 0; sleep 0.5; done; cat /tmp/run.log; exit 1')
    const s = JSON.parse(status.trim().split('\n').pop())
    if (s.version !== version || s.deviceLimitBytes !== 25e9) fail('.deb dashboard status: ' + status)
    console.log('ok - .deb installs in Debian 12, runs and its dashboard answers')
    const bad = (() => { try { sh('/opt/peerloom-seeder/updater-helper.sh /pkg/' + path.basename(deb) + ' ' + '0'.repeat(64) + ' root ' + version); return 'installed' } catch (e) { return String(e.stdout) } })()
    if (!bad.includes('checksum does not match')) fail('updater-helper took a wrong checksum: ' + bad)
    const good = sh('/opt/peerloom-seeder/updater-helper.sh /pkg/' + path.basename(deb) + ' ' + sha256(deb) + ' root ' + version + ' 2>&1')
    if (!good.includes('installed ' + version)) fail('updater-helper did not install: ' + good)
    console.log('ok - .deb updater refuses a wrong checksum and installs a right one')
    sh('dpkg -r peerloom-seeder >/dev/null 2>&1; test ! -e /opt/peerloom-seeder/peerloom-seeder')
    console.log('ok - .deb removes cleanly')
  } finally {
    try { podman(['rm', '-f', name], { stdio: 'ignore' }) } catch {}
  }
}

async function smokeAppImage (appImage) {
  const { serveRelease } = require('./serve-local-release')
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'peerloom-seeder-appimage-'))
  const app = path.join(scratch, 'PeerLoomSeeder.AppImage')
  fs.copyFileSync(appImage, app)
  fs.chmodSync(app, 0o755)
  const env = { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1', SEEDER_DATA: path.join(scratch, 'data'), SEEDER_NO_UPDATE_CHECK: '1' }
  const port = 19761 + Math.floor(Math.random() * 1000)
  try {
    await new Promise((resolve) => {
      // Its own process group: the AppImage runtime starts the seeder as a
      // child, and killing only the runtime left that seeder running and this
      // script waiting on its output forever.
      const proc = spawn(app, ['run'], { env: { ...env, SEEDER_PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'], detached: true })
      const stop = () => { try { process.kill(-proc.pid, 'SIGTERM') } catch {} }
      let out = ''
      let done = false
      const timer = setTimeout(() => { stop(); fail('AppImage did not start:\n' + out) }, 60000)
      proc.stdout.on('data', async (d) => {
        out += d
        if (done || !out.includes('dashboard on')) return
        done = true
        const s = await (await fetch('http://127.0.0.1:' + port + '/api/status')).json()
        if (s.version !== version) fail('AppImage status: ' + JSON.stringify(s))
        clearTimeout(timer)
        stop()
        resolve()
      })
    })
    console.log('ok - AppImage runs and its dashboard answers')

    // A fake next release holding a marked copy, so a replaced file shows.
    const next = version.replace(/\d+$/, (n) => String(Number(n) + 1))
    const rel = path.join(scratch, 'release')
    fs.mkdirSync(rel)
    const nextName = 'PeerLoomSeeder-' + next + '-x86_64.AppImage'
    fs.copyFileSync(appImage, path.join(rel, nextName))
    fs.appendFileSync(path.join(rel, nextName), 'next')
    const server = await serveRelease({ version: next, dir: rel })
    const run = () => new Promise((resolve) => {
      const p = spawn(app, ['update'], { env: { ...env, SEEDER_UPDATE_LATEST_URL: 'http://127.0.0.1:' + server.address().port + '/latest' } })
      let out = ''
      p.stdout.on('data', (d) => { out += d })
      p.on('exit', (code) => resolve({ code, out }))
    })
    try {
      fs.writeFileSync(path.join(rel, nextName + '.sha256'), '0'.repeat(64) + '  ' + nextName + '\n')
      const bad = await run()
      if (bad.code === 0 || !bad.out.includes('checksum does not match') || sha256(app) !== sha256(appImage)) fail('AppImage update took a wrong checksum:\n' + bad.out)
      writeSum(path.join(rel, nextName))
      const good = await run()
      if (good.code !== 0 || sha256(app) !== sha256(path.join(rel, nextName))) fail('AppImage update did not replace the file:\n' + good.out)
      console.log('ok - AppImage update refuses a wrong checksum and replaces itself with a right one')
    } finally { server.close() }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

async function main () {
  const only = process.argv[2]
  fs.mkdirSync(outDir, { recursive: true })
  for (const arch of ['x64', 'arm64']) {
    if (only && only !== arch) continue
    const staged = path.join(outDir, 'stage-linux-' + arch)
    await stage('linux-' + arch, staged, { node: true })
    const deb = await buildDeb(arch, staged)
    const appImage = await buildAppImage(arch, staged)
    fs.rmSync(staged, { recursive: true, force: true })
    if (arch === 'x64' && process.platform === 'linux' && process.arch === 'x64') {
      smokeDeb(deb)
      await smokeAppImage(appImage)
    }
  }
}

main().then(() => process.exit(0), (err) => fail(err.stack || err.message))
