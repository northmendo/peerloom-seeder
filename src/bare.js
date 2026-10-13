// PeerLoom Seeder, run with the Bare runtime (bundled by scripts/build-bare.js):
//
//   bare seeder.bundle --data <folder>          interactive: prints the key and a
//                                               pairing link with a QR code; type
//                                               `pair`, `status`, `devices`,
//                                               `limit <bytes|off>` or `forget <key>`
//   bare seeder.bundle --data <folder> --ipc    for the dashboard host: newline JSON
//                                               { id, method, args } over stdio, see
//                                               METHODS below and host/seeder-process.js
//   --bootstrap host:port[,host:port]           a test DHT instead of the public one
//
// A folder a PearOffice seeder set up (it has pearoffice-state/) opens as is:
// same seeder key, paired devices and stored files. A new folder starts with
// a storage limit of 25 GB per device, which the owner can change or turn off.
//
// Stores encrypted data only. It never receives a space's key.

const b4a = require('b4a')
require('./patches/hypercoreSnapshot').applySnapshotFlushFix(require('hypercore/lib/session-state'))

const fs = require('bare-fs')
const { createSeeder } = require('./seeder')
const { toTerminal } = require('./qr')

const DEFAULT_DEVICE_LIMIT = 25e9

const argv = Bare.argv.slice(2)
const opt = (name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1] || null }
const dataDir = opt('--data')
const ipc = argv.includes('--ipc')
const bootstrap = opt('--bootstrap')
  ? opt('--bootstrap').split(',').map((hp) => { const [host, port] = hp.split(':'); return { host, port: Number(port) } })
  : null
if (!dataDir) {
  console.error('usage: bare seeder.bundle --data <folder> [--ipc] [--bootstrap host:port]')
  Bare.exit(2)
}

const send = (obj) => fs.writeSync(1, JSON.stringify(obj) + '\n')
const say = ipc ? (line) => send({ event: 'log', data: line }) : (line) => console.log('[peerloom-seeder] ' + line)
const exists = (p) => { try { fs.statSync(p); return true } catch { return false } }

// Which state folder to open: a PearOffice seeder's if that is what is here.
function stateNameOf (dir) {
  if (!exists(dir + '/seeder-state') && exists(dir + '/pearoffice-state')) return 'pearoffice-state'
  return 'seeder-state'
}

async function main () {
  fs.mkdirSync(dataDir, { recursive: true })
  const stateName = stateNameOf(dataDir)
  const fresh = !exists(dataDir + '/' + stateName)
  const seeder = await createSeeder({ dataDir, bootstrap, log: say, stateName })
  if (stateName === 'pearoffice-state') say('opened a PearOffice seeder folder')
  if (fresh) await seeder.setDeviceLimit(DEFAULT_DEVICE_LIMIT)

  // A device by its full key or a unique start of it.
  async function deviceKeyOf (prefix) {
    const p = String(prefix || '').trim().toLowerCase()
    const matches = p.length >= 6 ? (await seeder.devices()).filter((d) => d.deviceKey.startsWith(p)) : []
    if (matches.length !== 1) throw new Error(matches.length ? 'More than one device starts with that' : 'No paired device starts with that')
    return matches[0].deviceKey
  }

  const METHODS = {
    status: async () => ({ ...await seeder.status(), stateName }),
    pair: () => seeder.openPairing(),
    devices: () => seeder.devices(),
    forget: async ({ deviceKey }) => seeder.forgetDevice(await deviceKeyOf(deviceKey)),
    // bytes: a positive whole number, or null for no limit
    limit: async ({ bytes }) => {
      const n = bytes == null ? null : Number(bytes)
      if (n !== null && !(Number.isSafeInteger(n) && n > 0)) throw new Error('The limit must be a whole number of bytes, or off')
      return { deviceLimitBytes: await seeder.setDeviceLimit(n) }
    },
    // app: the label the dashboard shows; empty clears it
    label: async ({ deviceKey, app }) => {
      if (!await seeder.setDeviceLabel(await deviceKeyOf(deviceKey), app)) throw new Error('No paired device starts with that')
      return { ok: true }
    }
  }

  const stdin = require('bare-process').stdin
  let buf = ''
  const lines = (fn) => stdin.on('data', (chunk) => {
    buf += chunk.toString()
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      fn(line)
    }
  })

  if (ipc) {
    lines(async (line) => {
      let msg
      try { msg = JSON.parse(line) } catch { return }
      const fn = Object.hasOwn(METHODS, msg.method) ? METHODS[msg.method] : null
      if (!fn) return send({ id: msg.id, error: 'unknown method' })
      try { send({ id: msg.id, result: await fn(msg.args || {}) }) } catch (err) { send({ id: msg.id, error: err.message }) }
    })
    stdin.on('end', stop) // the host went away
    send({ event: 'ready', data: { seederKey: b4a.toString(seeder.seederKey, 'hex'), stateName } })
  } else {
    say('seeder key ' + b4a.toString(seeder.seederKey, 'hex'))
    const show = () => {
      const { link, expiresAt } = seeder.openPairing()
      say('pair a device within 5 minutes: scan this, or paste the link in the app\'s seeder settings')
      console.log(toTerminal(link))
      console.log(link)
      say('window closes at ' + new Date(expiresAt).toISOString())
    }
    show()
    lines(async (line) => {
      const [cmd, arg] = line.trim().split(/\s+/)
      try {
        if (cmd === 'pair') show()
        else if (cmd === 'status') say(JSON.stringify(await METHODS.status()))
        else if (cmd === 'devices') {
          const list = await seeder.devices()
          if (!list.length) say('no paired devices')
          for (const d of list) say(d.deviceKey + '  ' + (d.app || '-') + '  ' + d.spaces + ' space(s)  ' + d.bytes + ' bytes')
        } else if (cmd === 'limit') say('limit: ' + (await METHODS.limit({ bytes: arg === 'off' ? null : arg })).deviceLimitBytes)
        else if (cmd === 'forget') {
          const r = await METHODS.forget({ deviceKey: arg })
          say('forgot that device; ' + r.dropping + ' space(s) will be deleted in 7 days')
        } else if (cmd) say('commands: pair, status, devices, limit <bytes|off>, forget <device key>')
      } catch (err) { say(err.message) }
    })
  }

  async function stop () {
    say('stopping')
    try { await seeder.close() } catch {}
    Bare.exit(0)
  }
  try {
    const signals = require('bare-signals')
    for (const name of ['SIGINT', 'SIGTERM']) { const s = new signals.Signal(name); s.on('signal', stop); s.start(); s.unref() }
  } catch {}
}

main().catch((err) => {
  console.error('[peerloom-seeder] failed:', err && err.message)
  Bare.exit(1)
})
