// Build the Linux download:
//   dist/pkg/peerloom-seeder-<version>-linux-<arch>.tar.gz   (x64 and arm64)
// each a staged package (scripts/stage.js, with Node) plus the launcher,
// the systemd user unit and a README from packaging/linux/. Then unpacks the
// x64 one where nothing from the checkout is around and checks it (from
// PearOffice's dist-seeder.js): it starts, its dashboard answers, it says a
// newer (fake, local) release is out, `update` refuses a download whose
// checksum does not match and installs one that does.
//
// Usage: node scripts/dist-linux.js [x64|arm64]   (default both)
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync, spawn } = require('child_process')
const { stage } = require('./stage')

const root = path.join(__dirname, '..')
const version = require(path.join(root, 'package.json')).version
const outDir = path.join(root, 'dist', 'pkg')

async function pack (arch) {
  const name = 'peerloom-seeder-' + version + '-linux-' + arch
  const dir = path.join(outDir, name)
  await stage('linux-' + arch, dir, { node: true })
  for (const f of ['peerloom-seeder', 'peerloom-seeder.service', 'README.md']) fs.copyFileSync(path.join(root, 'packaging', 'linux', f), path.join(dir, f))
  fs.chmodSync(path.join(dir, 'peerloom-seeder'), 0o755)
  execFileSync('tar', ['czf', name + '.tar.gz', name], { cwd: outDir })
  fs.rmSync(dir, { recursive: true, force: true })
  const file = path.join(outDir, name + '.tar.gz')
  const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  fs.writeFileSync(file + '.sha256', sha + '  ' + name + '.tar.gz\n')
  console.log('built ' + name + '.tar.gz (' + Math.round(fs.statSync(file).size / 1e6) + ' MB)')
  return { name, file, sha }
}

function fail (what) { console.error('not ok - ' + what); process.exit(1) }

async function smoke ({ name, file }) {
  const { serveRelease } = require('./serve-local-release')
  const next = version.replace(/\d+$/, (n) => String(Number(n) + 1))
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'peerloom-seeder-pkg-'))
  const unpack = (into) => { fs.mkdirSync(into, { recursive: true }); execFileSync('tar', ['xzf', file], { cwd: into }); return path.join(into, name) }

  // The fake release: this build, relabelled as the next version.
  const releaseDir = path.join(scratch, 'release')
  const nextName = name.replace(version, next)
  fs.renameSync(unpack(path.join(scratch, 'build')), path.join(scratch, 'build', nextName))
  fs.writeFileSync(path.join(scratch, 'build', nextName, 'VERSION'), next + '\n')
  fs.mkdirSync(releaseDir)
  execFileSync('tar', ['czf', path.join(releaseDir, nextName + '.tar.gz'), nextName], { cwd: path.join(scratch, 'build') })
  const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(releaseDir, nextName + '.tar.gz'))).digest('hex')
  const writeSum = (hex) => fs.writeFileSync(path.join(releaseDir, nextName + '.tar.gz.sha256'), hex + '  ' + nextName + '.tar.gz\n')

  const server = await serveRelease({ version: next, dir: releaseDir })
  const env = { ...process.env, SEEDER_UPDATE_LATEST_URL: 'http://127.0.0.1:' + server.address().port + '/latest', SEEDER_UPDATE_DELAY: '0' }
  delete env.SEEDER_NO_UPDATE_CHECK
  writeSum(digest)
  try {
    const app = unpack(path.join(scratch, 'run'))
    const port = 18761 + Math.floor(Math.random() * 1000)
    await new Promise((resolve) => {
      const proc = spawn(path.join(app, 'peerloom-seeder'), [], { env: { ...env, SEEDER_DATA: path.join(scratch, 'data'), SEEDER_PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] })
      let out = ''
      let answered = false
      let done = false
      const timer = setTimeout(() => { proc.kill(); fail('packaged seeder did not start its dashboard and say ' + next + ' is out:\n' + out) }, 45000)
      proc.stdout.on('data', async (d) => {
        out += d
        if (!answered && out.includes('dashboard on')) {
          const s = await (await fetch('http://127.0.0.1:' + port + '/api/status')).json()
          if (s.deviceLimitBytes !== 25e9 || !/^[0-9a-f]{64}$/.test(s.seederKey) || s.version !== version) fail('dashboard status is wrong: ' + JSON.stringify(s))
          answered = true
        }
        if (answered && !done && out.includes('PeerLoom Seeder ' + next + ' is out')) {
          done = true
          clearTimeout(timer)
          proc.kill()
          resolve()
        }
      })
    })
    console.log('ok - packaged seeder (linux-x64) starts, its dashboard answers and it says ' + next + ' is out')

    const run = (dir) => new Promise((resolve) => {
      const p = spawn(path.join(dir, 'peerloom-seeder'), ['update'], { env })
      let out = ''
      p.stdout.on('data', (d) => { out += d })
      p.on('exit', (code) => resolve({ code, out }))
    })
    const readVersion = (dir) => fs.readFileSync(path.join(dir, 'VERSION'), 'utf8').trim()
    writeSum('0'.repeat(64))
    const bad = await run(app)
    if (bad.code === 0 || !bad.out.includes('checksum does not match') || readVersion(app) !== version) fail('update with a wrong checksum was not refused:\n' + bad.out)
    writeSum(digest)
    const good = await run(app)
    if (good.code !== 0 || readVersion(app) !== next) fail('update did not install ' + next + ':\n' + good.out)
    execFileSync(path.join(app, 'node'), ['-e', '0'])
    execFileSync(path.join(app, 'bare'), ['-e', '0'])
    const again = await run(app)
    if (!again.out.includes('already up to date')) fail('a second update did not say up to date:\n' + again.out)
    console.log('ok - packaged seeder updates itself to ' + next + ' and refuses a bad checksum')
  } finally {
    server.close()
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

async function main () {
  const only = process.argv[2]
  fs.mkdirSync(outDir, { recursive: true })
  const built = {}
  for (const arch of ['x64', 'arm64']) {
    if (only && only !== arch) continue
    built[arch] = await pack(arch)
  }
  if (built.x64 && process.platform === 'linux' && process.arch === 'x64') await smoke(built.x64)
}

main().catch((err) => fail(err.stack || err.message))
