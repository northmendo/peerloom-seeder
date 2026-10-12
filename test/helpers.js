// Shared by the Bare and host tests: a throwaway folder, a test device on a
// local DHT, waiting, and where the Bare bundle for this machine is.

const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const Hyperswarm = require('hyperswarm')
const Corestore = require('corestore')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function tmpDirs () {
  const dirs = []
  return {
    make () {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), 'peerloom-seeder-'))
      dirs.push(d)
      return d
    },
    clean () { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }) }
  }
}

async function waitFor (what, fn, { timeout = 20000 } = {}) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await fn()) return
    await sleep(100)
  }
  throw new Error('timed out waiting for ' + what)
}

// A device: its own store and swarm on the test DHT.
function device (bootstrap, dir) {
  const store = new Corestore(dir)
  const swarm = new Hyperswarm({ bootstrap })
  swarm.on('connection', (conn) => store.replicate(conn))
  return {
    store,
    swarm,
    key: b4a.toString(swarm.keyPair.publicKey, 'hex'),
    async close () { await swarm.destroy(); await store.close() }
  }
}

// npm test builds it first (scripts/build-bare.js); the test files run in
// parallel, so none of them may rebuild it.
function bareBuild () {
  const dir = path.join(__dirname, '..', 'dist', process.platform + '-' + process.arch)
  const out = { dir, bare: path.join(dir, process.platform === 'win32' ? 'bare.exe' : 'bare'), bundle: path.join(dir, 'seeder.bundle') }
  if (!fs.existsSync(out.bundle)) throw new Error('no Bare build: run node scripts/build-bare.js (npm test does)')
  return out
}

module.exports = { sleep, tmpDirs, waitFor, device, bareBuild }
