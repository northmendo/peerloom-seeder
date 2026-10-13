// PeerLoom Seeder's host: starts the seeder as its own Bare process
// (src/bare.js --ipc, through seeder-process.js) and serves the dashboard
// (index.html) to pair a device, see what each app's devices store, name a
// device, forget it and set the storage limit per device. The same page on every
// platform. See proposals/2026-10-12-peerloom-seeder-product.md.
//
// Login is @peerloom/host's dashboard-auth (vendored in vendor/peerloom-host):
// none on 127.0.0.1, a password elsewhere. Umbrel passes its app password as
// SEEDER_PASSWORD; otherwise one is made on first start, printed once and
// saved in the data folder.
//
//   SEEDER_DATA       data folder (default ~/.peerloom-seeder)
//   SEEDER_HOST       address to listen on (default 127.0.0.1)
//   SEEDER_PORT       port (default 8761)
//   SEEDER_PASSWORD   dashboard password
//   SEEDER_BARE       the bare binary (default: next to host/ in a package,
//                     else dist/<platform>-<arch>/bare)
//   SEEDER_BUNDLE     the seeder bundle (default: seeder/ in a package, else
//                     next to bare)
//   SEEDER_BOOTSTRAP  host:port[,host:port], a test DHT

const fs = require('node:fs')
const os = require('node:os')
const http = require('node:http')
const path = require('node:path')
const { SeederProcess } = require('./seeder-process')
const { toSvg } = require('../src/qr')
const { FONT_CSS } = require('./fonts')
const { createDashboardAuth, requireSafeBind, resolveDashboardPassword, PASSWORD_FILE } = require('./vendor/peerloom-host/dashboard-auth')

const root = path.join(__dirname, '..')
const page = fs.readFileSync(path.join(__dirname, 'index.html'))
const icon = fs.readFileSync(path.join(__dirname, 'icon.png'))
const BODY_MAX = 4096
const DISK_CACHE_MS = 60 * 1000

// PeerLoom's tip jar, as in the apps' About panels.
const DONATE = {
  ln: 'peerloomllc@strike.me',
  onchain: 'bc1q0kksenz3j4u9ppe6f4krclvzwxk7sjy00cc9cf',
  usd: 'https://buymeacoffee.com/peerloomllc'
}

function readVersion () {
  for (const f of [path.join(__dirname, 'version.json'), path.join(root, 'package.json')]) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')).version || null } catch {}
  }
  return null
}

// Bytes in a folder, without following links.
async function folderBytes (dir) {
  let n = 0
  let entries
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) } catch { return 0 }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) n += await folderBytes(p)
    else if (e.isFile()) { try { n += (await fs.promises.stat(p)).size } catch {} }
  }
  return n
}

async function createHost ({
  dataDir,
  host = '127.0.0.1',
  port = 8761,
  password = null,
  barePath,
  bundlePath,
  bootstrap = null,
  log = () => {}
}) {
  fs.mkdirSync(dataDir, { recursive: true })
  const resolved = resolveDashboardPassword({ password, bind: host, dataDir })
  requireSafeBind(host, resolved.password, { envVar: 'SEEDER_PASSWORD' })
  const auth = createDashboardAuth({ app: 'peerloom_seeder', password: resolved.password, envVar: 'SEEDER_PASSWORD' })
  if (resolved.source === 'generated') log('dashboard password ' + resolved.password + ' (saved in ' + path.join(dataDir, PASSWORD_FILE) + ')')

  const version = readVersion()
  const startedAt = Date.now()
  const seeder = new SeederProcess({ barePath, bundlePath, dataDir, bootstrap, onLog: (_, line) => log(line) })
  const { seederKey } = await seeder.start()
  log('seeder key ' + seederKey)

  let disk = null
  async function diskUse () {
    if (disk && Date.now() - disk.at < DISK_CACHE_MS) return disk.value
    const value = { used: await folderBytes(dataDir), free: null }
    try { const s = await fs.promises.statfs(dataDir); value.free = s.bavail * s.bsize } catch {}
    disk = { at: Date.now(), value }
    return value
  }

  const key = (body) => String(body.deviceKey || '')
  const routes = {
    'GET /api/status': async () => ({ ...await seeder.call('status'), uptime: Date.now() - startedAt, version, disk: await diskUse() }),
    'GET /api/devices': () => seeder.call('devices'),
    'POST /api/pair': async () => {
      const p = await seeder.call('pair')
      return { ...p, svg: toSvg(p.link, 240), now: Date.now() }
    },
    'POST /api/forget': (body) => seeder.call('forget', { deviceKey: key(body) }),
    'POST /api/rename': (body) => seeder.call('rename', { deviceKey: key(body), name: typeof body.name === 'string' ? body.name : '' }),
    'POST /api/limit': (body) => {
      const bytes = body.bytes == null ? null : Number(body.bytes)
      if (bytes !== null && !(Number.isSafeInteger(bytes) && bytes > 0)) throw new Error('The limit must be a whole number of bytes, or off')
      return seeder.call('limit', { bytes })
    },
    'GET /api/donate': () => Object.fromEntries(Object.entries(DONATE).map(([k, value]) => [k, { value, svg: toSvg(value, 200) }]))
  }

  const server = http.createServer((req, res) => {
    const parsed = new URL(req.url, 'http://localhost')
    const url = parsed.pathname
    const send = (code, type, body) => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      res.end(body)
    }
    if (req.method === 'GET' && url === '/fonts.css') return send(200, 'text/css', FONT_CSS)
    if (req.method === 'GET' && url === '/icon.png') return send(200, 'image/png', icon)
    // Answers /api/login and /api/logout, and 401 for anything else without a
    // session. The page itself always loads and shows the login form on a 401.
    if (auth.handle(req, res, parsed)) return
    if (req.method === 'GET' && url === '/') return send(200, 'text/html; charset=utf-8', page)
    const route = routes[req.method + ' ' + url]
    if (!route) return send(404, 'application/json', JSON.stringify({ error: 'not found' }))
    let raw = ''
    req.on('data', (c) => { raw += c; if (raw.length > BODY_MAX) req.destroy() })
    req.on('end', async () => {
      try {
        const body = raw ? JSON.parse(raw) : {}
        send(200, 'application/json', JSON.stringify(await route(body)))
      } catch (err) {
        send(400, 'application/json', JSON.stringify({ error: err.message }))
      }
    })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve) })
  const url = 'http://' + (host.includes(':') ? '[' + host + ']' : host) + ':' + server.address().port
  log('dashboard on ' + url)

  async function close () {
    server.close()
    seeder.removeAllListeners('exit')
    await seeder.stop()
  }

  return { url, seeder, seederKey, server, close }
}

async function main () {
  const env = process.env
  const exe = process.platform === 'win32' ? 'bare.exe' : 'bare'
  // A package (scripts/stage.js) has bare and seeder/ next to host/; a
  // checkout has them in dist/<platform>-<arch>/.
  const packaged = fs.existsSync(path.join(__dirname, '..', exe)) && fs.existsSync(path.join(__dirname, '..', 'seeder', 'seeder.bundle'))
  const barePath = env.SEEDER_BARE || (packaged ? path.join(__dirname, '..', exe) : path.join(root, 'dist', process.platform + '-' + process.arch, exe))
  const bundlePath = env.SEEDER_BUNDLE || (packaged ? path.join(__dirname, '..', 'seeder', 'seeder.bundle') : path.join(path.dirname(barePath), 'seeder.bundle'))
  const log = (line) => console.log('[peerloom-seeder] ' + line)
  const h = await createHost({
    dataDir: env.SEEDER_DATA || path.join(os.homedir(), '.peerloom-seeder'),
    host: env.SEEDER_HOST || '127.0.0.1',
    port: Number(env.SEEDER_PORT || 8761),
    password: env.SEEDER_PASSWORD || null,
    barePath,
    bundlePath,
    bootstrap: env.SEEDER_BOOTSTRAP ? env.SEEDER_BOOTSTRAP.split(',').map((hp) => { const [host, port] = hp.split(':'); return { host, port: Number(port) } }) : null,
    log
  })
  // A service manager or Docker restarts the host if the seeder dies.
  h.seeder.on('exit', (code) => { log('seeder exited (' + code + ')'); process.exit(1) })
  // Once, however many signals arrive.
  let stopping = null
  const stop = () => stopping || (stopping = (async () => { log('stopping'); await h.close(); process.exit(0) })())
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[peerloom-seeder] failed:', err && err.message)
    process.exit(1)
  })
}

module.exports = { createHost, folderBytes }
