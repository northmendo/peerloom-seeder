// Build the Windows installer:
//   dist/pkg/PeerLoomSeeder-Setup-<version>.exe (+ .sha256), x64, unsigned
// from a staged payload (scripts/stage.js, with Node) plus NSSM, an icon and
// packaging/windows/installer.nsi, compiled with makensis on this machine
// (Fedora: dnf install mingw32-nsis).
//
// Usage: node scripts/dist-windows.js
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { stage } = require('./stage')

const root = path.join(__dirname, '..')
const version = require(path.join(root, 'package.json')).version
const outDir = path.join(root, 'dist', 'pkg')

// AppIcon.ico from the exported PNGs (scripts/icons.sh), several sizes.
function icon (dest) {
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pls-ico-'))
  const pngs = [16, 32, 48, 64, 128, 256].map((s) => {
    const f = path.join(tmp, s + '.png')
    execFileSync('magick', [path.join(root, 'assets', 'icon-1024.png'), '-resize', s + 'x' + s, f])
    return f
  })
  execFileSync('icotool', ['-c', '-o', dest, ...pngs])
  fs.rmSync(tmp, { recursive: true, force: true })
}

async function main () {
  const work = path.join(root, 'dist', 'windows')
  fs.rmSync(work, { recursive: true, force: true })
  const payload = path.join(work, 'payload')
  await stage('win32-x64', payload, { node: true })
  fs.copyFileSync(path.join(root, 'packaging', 'windows', 'nssm.exe'), path.join(payload, 'nssm.exe'))
  icon(path.join(payload, 'AppIcon.ico'))
  fs.writeFileSync(path.join(payload, 'licenses', 'nssm.txt'), 'NSSM 2.24 (nssm.exe), the Non-Sucking Service Manager by Iain Patterson, https://nssm.cc. Public domain.\n')
  fs.copyFileSync(path.join(root, 'packaging', 'windows', 'installer.nsi'), path.join(work, 'installer.nsi'))
  execFileSync('makensis', ['-V2', '-DVERSION=' + version, 'installer.nsi'], { cwd: work, stdio: 'inherit' })
  const name = 'PeerLoomSeeder-Setup-' + version + '.exe'
  fs.mkdirSync(outDir, { recursive: true })
  fs.renameSync(path.join(work, name), path.join(outDir, name))
  const file = path.join(outDir, name)
  const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  fs.writeFileSync(file + '.sha256', sha + '  ' + name + '\n')
  fs.rmSync(work, { recursive: true, force: true })
  console.log('built ' + name + ' (' + Math.round(fs.statSync(file).size / 1e6) + ' MB)')
}

main().catch((err) => { console.error(err.stack || err.message); process.exit(1) })
