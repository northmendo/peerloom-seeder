// Build the macOS installers:
//   dist/pkg/PeerLoomSeeder-<version>-arm64.pkg and -x64.pkg (+ .sha256)
// Stages each payload here (scripts/stage.js, with Node), then signs,
// packages and notarizes on the Mac Mini over ssh
// (packaging/macos/build-pkg.sh).
//
// Usage: node scripts/dist-macos.js [arm64|x64]   (default both)
// Env: MAC_MINI (default Tims-Mac-mini.local); APP_SIGN_ID, PKG_SIGN_ID,
// NOTARY_PROFILE, SKIP_NOTARIZE are passed through (empty APP_SIGN_ID and
// PKG_SIGN_ID build an unsigned test package).
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { stage } = require('./stage')

const root = path.join(__dirname, '..')
const version = require(path.join(root, 'package.json')).version
const outDir = path.join(root, 'dist', 'pkg')
const mac = process.env.MAC_MINI || 'Tims-Mac-mini.local'
const remote = 'peerloom-seeder-macos'
const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"

async function build (arch) {
  const work = path.join(root, 'dist', 'macos-' + arch)
  fs.rmSync(work, { recursive: true, force: true })
  await stage('darwin-' + arch, path.join(work, 'payload'), { node: true })
  fs.cpSync(path.join(root, 'packaging', 'macos'), path.join(work, 'macos'), { recursive: true })
  fs.copyFileSync(path.join(root, 'assets', 'icon-1024.png'), path.join(work, 'icon-1024.png'))
  const tar = path.join(root, 'dist', 'macos-' + arch + '.tar.gz')
  execFileSync('tar', ['czf', tar, '-C', work, '.'])

  const dir = remote + '-' + arch
  execFileSync('scp', ['-q', tar, mac + ':' + dir + '.tar.gz'])
  const env = ['APP_SIGN_ID', 'PKG_SIGN_ID', 'NOTARY_PROFILE', 'SKIP_NOTARIZE'].filter((k) => k in process.env).map((k) => k + '=' + q(process.env[k])).join(' ')
  const script = [
    'set -e',
    'rm -rf ~/' + dir + ' && mkdir ~/' + dir,
    'tar xzf ~/' + dir + '.tar.gz -C ~/' + dir + ' && rm ~/' + dir + '.tar.gz',
    env + ' bash ~/' + dir + '/macos/build-pkg.sh ~/' + dir + '/payload ' + version + ' ' + arch + ' ~/' + dir + '/out'
  ].join('\n')
  execFileSync('ssh', [mac, 'bash -l -s'], { input: script, stdio: ['pipe', 'inherit', 'inherit'] })
  const name = 'PeerLoomSeeder-' + version + '-' + arch + '.pkg'
  fs.mkdirSync(outDir, { recursive: true })
  execFileSync('scp', ['-q', mac + ':' + dir + '/out/' + name, path.join(outDir, name)])
  const file = path.join(outDir, name)
  const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  fs.writeFileSync(file + '.sha256', sha + '  ' + name + '\n')
  fs.rmSync(tar)
  fs.rmSync(work, { recursive: true, force: true })
  console.log('built ' + name + ' (' + Math.round(fs.statSync(file).size / 1e6) + ' MB)')
}

async function main () {
  const only = process.argv[2]
  for (const arch of ['arm64', 'x64']) if (!only || only === arch) await build(arch)
}

main().catch((err) => { console.error(err.stack || err.message); process.exit(1) })
