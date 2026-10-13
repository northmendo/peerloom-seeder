// The PeerLoom seeder: Holepunch's blind-peer, plus the rule that it stores
// only spaces a paired device registered (proposals/2026-10-12-generic-seeder.md
// in the suite root; first built as PearOffice's seeder).
//
// A space is whatever an app shares as one Autobase: a sheet, a list, a
// group. The seeder never receives a space's encryption key or topic key. It
// gets core keys and lengths through blind-peering, stores the encrypted
// blocks and serves them. It can check blocks but not read them, and it does
// not know which app a space belongs to.
//
// Which cores it accepts:
//   - from a paired device: any, and the core's referrer (the space's
//     bootstrap key) is added to the allowed list, unless the device is over
//     its storage limit;
//   - from anyone else: only cores whose referrer is already on the list, so
//     the other members of a paired person's spaces can back up too.
// Strangers would need a registered space's bootstrap key, which only members
// and the seeder hold.
//
// It also keeps keyrings: a person's encrypted list of their spaces, put by
// their paired devices, handed to anyone who knows its locator, and announced
// on its topic so a device restored from a recovery phrase can find it. A
// device that proves the keyring's sign key counts as paired
// (keyringRecord.js, claims). The seeder cannot open a keyring.
//
// blind-peer is pinned to an exact version in package.json because this file
// wraps two of its internal methods (_onaddcore, _onaddcores) and reads its
// core records for the storage limit.

const BlindPeer = require('blind-peer')
const Corestore = require('corestore')
const Hyperbee = require('hyperbee')
const Protomux = require('protomux')
const c = require('compact-encoding')
const b4a = require('b4a')
const sodium = require('sodium-universal')
const IdEnc = require('hypercore-id-encoding')
const { NAMES, PAIR_WINDOW_MS, DROP_MAX_MS, DROP_GRACE_MS, pairTopic, seederLink, cleanLabel } = require('./protocol')
const { checkSealed, checkClaim, topicOf } = require('./keyringRecord')

const DROP_SWEEP_MS = 60 * 60 * 1000
const KEYRINGS_PER_DEVICE = 4
const USAGE_CACHE_MS = 60 * 1000
const STYLES = Object.keys(NAMES)

// State keys. A space is stored under `sheet/`: the seeder was PearOffice's
// first, and keeping its layout means existing seeders need no migration.
const DEVICE = 'device/'
const SPACE = 'sheet/'
const CORE = 'core/'
const DROP = 'drop/'
const KEYRING = 'keyring/'
const CONFIG_LIMIT = 'config/deviceLimitBytes'

const hex = (buf) => b4a.toString(buf, 'hex')

class Seeder extends BlindPeer {
  constructor (dataDir, opts = {}) {
    super(dataDir + '/blind-peer', opts)
    this.rules = opts.rules
  }

  async _onaddcore (stream, record) {
    const space = await this.rules.admit(stream, record.referrer)
    await this.rules.track(space, [record.key])
    return super._onaddcore(stream, record)
  }

  async _onaddcores (stream, request) {
    const space = await this.rules.admit(stream, request.referrer)
    await this.rules.track(space, (request.cores || []).map((c) => c.key))
    return super._onaddcores(stream, request)
  }
}

// dataDir: where everything is kept. stateName: the Corestore folder for the
// seeder's own records ('pearoffice-state' on seeders PearOffice set up).
// linkStyle: which names the pairing link uses, 'peerloom' or 'pearoffice'.
async function createSeeder ({ dataDir, bootstrap = null, log = () => {}, stateName = 'seeder-state', linkStyle = 'peerloom' }) {
  const stateStore = new Corestore(dataDir + '/' + stateName)
  const state = new Hyperbee(stateStore.get({ name: 'state' }), { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await state.ready()

  const paired = new Set()
  const allowed = new Set()
  // Which paired devices registered each space. Older records kept only the
  // first, as a string.
  const registrants = new Map() // bootstrap -> Set of device keys
  for await (const { key } of state.createReadStream({ gt: DEVICE, lt: DEVICE + '~' })) paired.add(key.slice(DEVICE.length))
  for await (const { key, value } of state.createReadStream({ gt: SPACE, lt: SPACE + '~' })) {
    const space = key.slice(SPACE.length)
    allowed.add(space)
    const by = value && value.by
    registrants.set(space, new Set(Array.isArray(by) ? by : by ? [by] : []))
  }
  let deviceLimitBytes = (await state.get(CONFIG_LIMIT))?.value?.bytes ?? null

  // locator -> { signKey, seq, by: Set of device keys that put or claimed it }
  const keyrings = new Map()
  for await (const { key, value } of state.createReadStream({ gt: KEYRING, lt: KEYRING + '~' })) {
    if (value && value.rec) keyrings.set(key.slice(KEYRING.length), { signKey: value.rec.signKey, seq: value.rec.seq, by: new Set(value.by || []) })
  }

  async function addRegistrant (space, device) {
    const set = registrants.get(space) || new Set()
    if (allowed.has(space) && set.has(device)) return
    set.add(device)
    registrants.set(space, set)
    allowed.add(space)
    await state.put(SPACE + space, { by: [...set], at: Date.now() })
  }

  // --- storage limit per paired device -------------------------------------
  //
  // A device's use is the bytes held for every space it registered, shared
  // spaces counted in full for each. Over the limit, it cannot register a new
  // space. Spaces it already has keep syncing, and blind-peer's own maxBytes
  // and clearing still cap the whole seeder.

  const usage = new Map() // device -> { at, bytes }

  async function bytesOf (space) {
    let n = 0
    const prefix = CORE + space + '/'
    for await (const { key } of state.createReadStream({ gt: prefix, lt: prefix + '~' })) {
      const rec = await peer.db.getCoreRecord(b4a.from(key.slice(prefix.length), 'hex'))
      if (rec) n += rec.bytesAllocated || 0
    }
    return n
  }

  async function usedBy (device, { fresh = false } = {}) {
    const cached = usage.get(device)
    if (!fresh && cached && Date.now() - cached.at < USAGE_CACHE_MS) return cached.bytes
    let bytes = 0
    for (const [space, set] of registrants) if (set.has(device)) bytes += await bytesOf(space)
    usage.set(device, { at: Date.now(), bytes })
    return bytes
  }

  async function setDeviceLimit (bytes) {
    deviceLimitBytes = Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null
    if (deviceLimitBytes === null) await state.del(CONFIG_LIMIT)
    else await state.put(CONFIG_LIMIT, { bytes: deviceLimitBytes })
    log(deviceLimitBytes === null ? 'no storage limit per device' : 'storage limit per device: ' + deviceLimitBytes + ' bytes')
    return deviceLimitBytes
  }

  // blind-peering sends an Autobase in batches: writer cores with the space's
  // bootstrap key as referrer, then view cores with no referrer. A connection
  // that has already shown an allowed referrer may send the follow-ups.
  const vouched = new WeakMap() // stream -> the allowed space it vouched for

  const rules = {
    async admit (stream, referrer) {
      const remote = hex(stream.remotePublicKey)
      const ref = referrer ? hex(referrer) : null
      if (paired.has(remote)) {
        if (ref && !(registrants.get(ref) || new Set()).has(remote)) {
          if (deviceLimitBytes !== null && (await usedBy(remote)) >= deviceLimitBytes) {
            log('refused a new space from ' + remote.slice(0, 8) + ' (over its storage limit)')
            throw new Error('This device has used all its space on this seeder')
          }
          if (!allowed.has(ref)) log('allowed space ' + ref.slice(0, 8) + ' (registered by a paired device)')
          await addRegistrant(ref, remote)
        }
        if (ref) vouched.set(stream, ref)
        return ref || vouched.get(stream) || null
      }
      if (ref && allowed.has(ref)) { vouched.set(stream, ref); return ref }
      if (!ref && vouched.has(stream)) return vouched.get(stream)
      log('refused cores from ' + remote.slice(0, 8))
      throw new Error('This seeder only stores data registered by a paired device')
    },

    // Remember which cores belong to which space, so a drop and the storage
    // limit can find them.
    async track (space, keys) {
      if (!space) return
      const batch = state.batch()
      for (const key of keys) if (key) await batch.put(CORE + space + '/' + hex(key), {})
      await batch.flush()
    }
  }

  // --- drops ----------------------------------------------------------------

  async function scheduleDrop (space, afterMs) {
    const due = Date.now() + Math.max(0, Math.min(DROP_MAX_MS, Number(afterMs) || 0))
    const existing = (await state.get(DROP + space))?.value
    if (!existing || existing.due > due) await state.put(DROP + space, { due })
    log('drop of space ' + space.slice(0, 8) + ' due ' + new Date(due).toISOString())
    if (due <= Date.now()) runDrops().catch((e) => log('drop failed: ' + e.message))
    return due
  }

  // Clear and forget every core of each space whose drop is due, through
  // blind-peer's own delete path (it also stops announcing and replicating).
  async function runDrops (now = Date.now()) {
    const due = []
    for await (const { key, value } of state.createReadStream({ gt: DROP, lt: DROP + '~' })) {
      if (value && value.due <= now) due.push(key.slice(DROP.length))
    }
    for (const space of due) {
      const self = { remotePublicKey: peer.publicKey, rawStream: { remoteHost: '127.0.0.1' } }
      peer.addTrustedPubKey(peer.publicKey)
      let n = 0
      const prefix = CORE + space + '/'
      for await (const { key } of state.createReadStream({ gt: prefix, lt: prefix + '~' })) {
        const coreKey = b4a.from(key.slice(prefix.length), 'hex')
        try { if (await peer._ondeletecore(self, { key: coreKey })) n++ } catch (e) { log('could not delete a core: ' + e.message) }
        await state.del(key)
      }
      allowed.delete(space)
      registrants.delete(space)
      await state.del(SPACE + space)
      await state.del(DROP + space)
      usage.clear()
      log('dropped space ' + space.slice(0, 8) + ' (' + n + ' cores)')
    }
    return due.length
  }

  // A paired device still wants the space: cancel a pending drop.
  async function keep (space, device) {
    await addRegistrant(space, device)
    const pending = (await state.get(DROP + space))?.value
    if (pending) { await state.del(DROP + space); log('drop of space ' + space.slice(0, 8) + ' cancelled') }
    return !!pending
  }

  // Forget a paired device: refuse it from now on and drop, after the grace
  // period, every space no other paired device registered.
  async function forgetDevice (deviceKey) {
    if (!paired.has(deviceKey)) return { forgotten: false, dropping: 0 }
    paired.delete(deviceKey)
    usage.delete(deviceKey)
    await state.del(DEVICE + deviceKey)
    peer.trustedPubKeys.delete(IdEnc.normalize(b4a.from(deviceKey, 'hex')))
    for (const conn of peer.swarm.connections) {
      if (conn.remotePublicKey && hex(conn.remotePublicKey) === deviceKey) conn.destroy()
    }
    let dropping = 0
    for (const [space, set] of registrants) {
      if (!set.delete(deviceKey)) continue
      await state.put(SPACE + space, { by: [...set], at: Date.now() })
      if (![...set].some((d) => paired.has(d))) { await scheduleDrop(space, DROP_GRACE_MS); dropping++ }
    }
    for (const [locator, k] of keyrings) {
      if (!k.by.delete(deviceKey)) continue
      if ([...k.by].some((d) => paired.has(d))) {
        const rec = (await state.get(KEYRING + locator))?.value?.rec
        await state.put(KEYRING + locator, { rec, by: [...k.by] })
      } else {
        await dropKeyring(locator)
      }
    }
    log('forgot device ' + deviceKey.slice(0, 8) + ', dropping ' + dropping + ' space(s)')
    return { forgotten: true, dropping }
  }

  // `sheets` repeats `spaces` for dashboards written for PearOffice's seeder.
  async function devices () {
    const out = []
    for await (const { key, value } of state.createReadStream({ gt: DEVICE, lt: DEVICE + '~' })) {
      const deviceKey = key.slice(DEVICE.length)
      let spaces = 0
      for (const set of registrants.values()) if (set.has(deviceKey)) spaces++
      out.push({ deviceKey, pairedAt: value && value.at, app: (value && value.app) || null, name: (value && value.name) || null, spaces, sheets: spaces, bytes: await usedBy(deviceKey) })
    }
    return out
  }

  // The label the dashboard shows for a device. The person running the
  // seeder can change it; a later pairing from the device replaces it.
  async function setDeviceLabel (deviceKey, app) {
    const row = (await state.get(DEVICE + deviceKey))?.value
    if (!row) return false
    await state.put(DEVICE + deviceKey, { ...row, app: cleanLabel(app) })
    return true
  }

  // A name the person running the seeder gives a device ("Sam's phone"). The
  // dashboard groups devices by `app` and shows this inside the group; a later
  // pairing keeps it.
  async function setDeviceName (deviceKey, name) {
    const row = (await state.get(DEVICE + deviceKey))?.value
    if (!row) return false
    const clean = cleanLabel(name)
    const next = { ...row }
    if (clean) next.name = clean
    else delete next.name
    await state.put(DEVICE + deviceKey, next)
    return true
  }

  const dropTimer = setInterval(() => runDrops().catch((e) => log('drop sweep failed: ' + e.message)), DROP_SWEEP_MS)
  if (dropTimer.unref) dropTimer.unref()

  const peer = new Seeder(dataDir, { bootstrap, rules, trustedPubKeys: [...paired].map((k) => b4a.from(k, 'hex')) })
  await peer.listen()
  const seederKey = peer.publicKey

  // --- keyrings ---------------------------------------------------------------

  for (const locator of keyrings.keys()) announce(locator)

  function announce (locator) {
    peer.swarm.join(topicOf(b4a.from(locator, 'hex')), { server: true, client: false })
  }

  async function dropKeyring (locator) {
    keyrings.delete(locator)
    await state.del(KEYRING + locator)
    peer.swarm.leave(topicOf(b4a.from(locator, 'hex'))).catch(() => {})
    log('dropped keyring ' + locator.slice(0, 8))
  }

  function keyringsOf (device) {
    let n = 0
    for (const k of keyrings.values()) if (k.by.has(device)) n++
    return n
  }

  // Puts and claims run one at a time, so two devices writing at once
  // cannot both pass the seq check.
  let keyringLock = Promise.resolve()
  function locked (fn) {
    const run = keyringLock.then(fn)
    keyringLock = run.catch(() => {})
    return run
  }

  function putKeyring (rec, device) {
    return locked(async () => {
      if (!paired.has(device)) return { reason: 'Only paired devices can back up a file list' }
      if (!checkSealed(rec)) return { reason: 'This file list does not check out' }
      const have = keyrings.get(rec.locator)
      if (have && have.signKey !== rec.signKey) return { reason: 'This file list belongs to someone else' }
      if (have && rec.seq <= have.seq) return { reason: 'A newer file list is already here', seq: have.seq }
      if (!(have && have.by.has(device)) && keyringsOf(device) >= KEYRINGS_PER_DEVICE) return { reason: 'This device has backed up too many file lists here' }
      const by = new Set(have ? have.by : [])
      by.add(device)
      const clean = { locator: rec.locator, seq: rec.seq, nonce: rec.nonce, ciphertext: rec.ciphertext, signKey: rec.signKey, sig: rec.sig }
      await state.put(KEYRING + rec.locator, { rec: clean, by: [...by] })
      keyrings.set(rec.locator, { signKey: rec.signKey, seq: rec.seq, by })
      if (!have) { announce(rec.locator); log('keeping keyring ' + rec.locator.slice(0, 8)) }
      return { seq: rec.seq }
    })
  }

  async function getKeyring (locator) {
    if (typeof locator !== 'string' || !keyrings.has(locator)) return null
    return (await state.get(KEYRING + locator))?.value?.rec || null
  }

  // A restored device proves the keyring's sign key: pair it.
  function claimKeyring (m, conn) {
    return locked(async () => {
      const device = hex(conn.remotePublicKey)
      const k = typeof m.locator === 'string' && keyrings.get(m.locator)
      if (!k || !checkClaim(m, k.signKey, hex(seederKey), device)) return { reason: 'This claim does not check out' }
      if (!k.by.has(device)) {
        if (keyringsOf(device) >= KEYRINGS_PER_DEVICE) return { reason: 'This device has backed up too many file lists here' }
        k.by.add(device)
        const rec = (await state.get(KEYRING + m.locator))?.value?.rec
        await state.put(KEYRING + m.locator, { rec, by: [...k.by] })
      }
      if (!paired.has(device)) {
        paired.add(device)
        await state.put(DEVICE + device, { at: Date.now(), via: 'keyring' })
        peer.addTrustedPubKey(conn.remotePublicKey)
        log('paired device ' + device.slice(0, 8) + ' (it proved keyring ' + m.locator.slice(0, 8) + ')')
      }
      return { paired: true }
    })
  }

  // --- pairing ----------------------------------------------------------------
  //
  // One rendezvous, met under both sets of names, so a device pairs whichever
  // link style it was given.

  let windowState = null // { rv, topics, timer, link, expiresAt }

  function openPairing (ms = PAIR_WINDOW_MS) {
    closePairing()
    const rv = b4a.alloc(32)
    sodium.randombytes_buf(rv)
    const topics = STYLES.map((style) => pairTopic(rv, style))
    for (const topic of topics) peer.swarm.join(topic, { server: true, client: false })
    const link = seederLink({ rv, seederKey, style: linkStyle })
    windowState = { rv, topics, link, expiresAt: Date.now() + ms }
    windowState.timer = setTimeout(closePairing, ms)
    if (windowState.timer.unref) windowState.timer.unref()
    for (const conn of peer.swarm.connections) listenOn(conn)
    log('pairing open for ' + Math.round(ms / 60000) + ' min')
    return { link, expiresAt: windowState.expiresAt }
  }

  function closePairing () {
    if (!windowState) return
    clearTimeout(windowState.timer)
    for (const topic of windowState.topics) peer.swarm.leave(topic).catch(() => {})
    windowState = null
  }

  function listenOn (conn) {
    if (!windowState) return
    const mux = Protomux.from(conn)
    const rv = windowState.rv
    for (const style of STYLES) {
      const protocol = NAMES[style].pairProtocol
      mux.pair({ protocol, id: rv }, () => openChannel(conn, mux, rv, protocol))
    }
  }

  function openChannel (conn, mux, rv, protocol) {
    const ch = mux.createChannel({ protocol, id: rv })
    if (!ch) return
    const msg = ch.addMessage({
      encoding: c.json,
      onmessage: async (m) => {
        if (!m || m.t !== 'trust') return
        if (!windowState || !b4a.equals(windowState.rv, rv)) return msg.send({ t: 'no', reason: 'The pairing window has closed. Open a new one on the seeder.' })
        // The device can only ask to trust the key it is connected with.
        if (m.deviceKey !== hex(conn.remotePublicKey)) return msg.send({ t: 'no', reason: 'Key mismatch' })
        const app = cleanLabel(m.app)
        const row = (await state.get(DEVICE + m.deviceKey))?.value
        if (!row) {
          paired.add(m.deviceKey)
          await state.put(DEVICE + m.deviceKey, { at: Date.now(), app })
          peer.addTrustedPubKey(conn.remotePublicKey)
          log('paired device ' + m.deviceKey.slice(0, 8) + (app ? ' (' + app + ')' : ''))
        } else if (app && row.app !== app) {
          await state.put(DEVICE + m.deviceKey, { ...row, app })
        }
        msg.send({ t: 'ok' })
      }
    })
    ch.open()
  }

  // Requests from paired devices, on every connection, under either name.
  function listenRequests (conn) {
    const mux = Protomux.from(conn)
    for (const style of STYLES) {
      const protocol = NAMES[style].seederProtocol
      mux.pair({ protocol }, () => openRequests(conn, mux, protocol))
    }
  }

  function openRequests (conn, mux, protocol) {
    const ch = mux.createChannel({ protocol })
    if (!ch) return
    const msg = ch.addMessage({
      encoding: c.json,
      onmessage: async (m) => {
        if (!m) return
        const remote = hex(conn.remotePublicKey)
        const reply = (r) => msg.send(r.reason ? { t: 'no', reason: r.reason } : { t: 'ok', ...r })
        if (m.t === 'keyring-put') return reply(await putKeyring(m.rec, remote))
        if (m.t === 'keyring-get') return reply({ rec: await getKeyring(m.locator) })
        if (m.t === 'keyring-claim') return reply(await claimKeyring(m, conn))
        if (m.t !== 'drop' && m.t !== 'keep') return
        if (!paired.has(remote)) return msg.send({ t: 'no', reason: 'Only paired devices can ask for that' })
        if (typeof m.bootstrap !== 'string' || !allowed.has(m.bootstrap)) return msg.send({ t: 'no', reason: 'This seeder does not hold that' })
        if (m.t === 'keep') return msg.send({ t: 'ok', cancelled: await keep(m.bootstrap, remote) })
        // Only a device that backs the space up here may drop it.
        if (!(registrants.get(m.bootstrap) || new Set()).has(remote)) return msg.send({ t: 'no', reason: 'This device does not back that up here' })
        msg.send({ t: 'ok', due: await scheduleDrop(m.bootstrap, m.afterMs) })
      }
    })
    ch.open()
  }

  peer.swarm.on('connection', (conn) => { listenOn(conn); listenRequests(conn) })
  runDrops().catch(() => {}) // any that came due while the seeder was off

  // `sheets` repeats `spaces` for dashboards written for PearOffice's seeder.
  async function status () {
    return {
      seederKey: hex(seederKey),
      pairedDevices: paired.size,
      spaces: allowed.size,
      sheets: allowed.size,
      keyrings: keyrings.size,
      deviceLimitBytes,
      coresAdded: peer.stats.coresAdded,
      peers: peer.swarm.connections.size,
      pairing: windowState ? { link: windowState.link, expiresAt: windowState.expiresAt } : null
    }
  }

  async function close () {
    clearInterval(dropTimer)
    closePairing()
    await peer.close()
    await state.close()
    await stateStore.close()
  }

  async function drops () {
    const out = []
    for await (const { key, value } of state.createReadStream({ gt: DROP, lt: DROP + '~' })) {
      const space = key.slice(DROP.length)
      out.push({ space, sheet: space, due: value.due })
    }
    return out
  }

  const allowedSpaces = () => [...allowed]

  return {
    seederKey,
    peer,
    openPairing,
    closePairing,
    status,
    close,
    runDrops,
    scheduleDrop,
    drops,
    keep,
    forgetDevice,
    devices,
    setDeviceLabel,
    setDeviceName,
    setDeviceLimit,
    usedBy,
    isPaired: (k) => paired.has(hex(k)),
    allowedSpaces,
    allowedSheets: allowedSpaces
  }
}

module.exports = { createSeeder }
