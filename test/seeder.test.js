// The seeder with plain cores, no app: pairing under both sets of names, app
// labels, who may store what, requests, the storage limit per device and
// forgetting a device. PearOffice's own tests cover a real app on top.

const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const Hyperswarm = require('hyperswarm')
const Corestore = require('corestore')
const createTestnet = require('@hyperswarm/testnet')
const { createSeeder, createPeering, pair, createAsker, protocol } = require('..')

const hex = (buf) => b4a.toString(buf, 'hex')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const dirs = []
function tmpDir () {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'peerloom-seeder-'))
  dirs.push(d)
  return d
}

async function waitFor (what, fn, { timeout = 20000 } = {}) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await fn()) return
    await sleep(100)
  }
  throw new Error('timed out waiting for ' + what)
}

async function seederHas (seeder, key, length) {
  const core = seeder.peer.store.get({ key })
  await core.ready()
  const ok = core.contiguousLength >= length
  await core.close()
  return ok
}

test('seeder', async (t) => {
  const testnet = await createTestnet(3)
  const open = []
  const seeder = await createSeeder({ dataDir: tmpDir(), bootstrap: testnet.bootstrap })
  t.after(async () => {
    for (const close of open.reverse()) { try { await close() } catch {} }
    try { await seeder.close() } catch {}
    await testnet.destroy()
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
  })

  async function device () {
    const store = new Corestore(tmpDir())
    const swarm = new Hyperswarm({ bootstrap: testnet.bootstrap })
    swarm.on('connection', (conn) => store.replicate(conn))
    const peering = createPeering({ dht: swarm.dht, store, keyPair: swarm.keyPair, keys: [seeder.seederKey] })
    const styles = new Map()
    const asker = createAsker({ dht: () => swarm.dht, keyPair: swarm.keyPair, styleOf: (k) => styles.get(k) || 'peerloom' })
    open.push(async () => { await peering.close(); await swarm.destroy(); await store.close() })
    return { store, swarm, peering, styles, asker, key: hex(swarm.keyPair.publicKey) }
  }

  async function space (d, name) {
    const core = d.store.get({ name })
    await core.append([b4a.from(name + ' 1'), b4a.from(name + ' 2')])
    return core
  }

  const A = await device()
  const B = await device()
  const C = await device()

  await t.test('pairs with a peerloom link and keeps the app label', async () => {
    const { link } = seeder.openPairing()
    assert.match(link, /^peerloom:\/\/seeder\?/)
    const r = await pair({ swarm: A.swarm, link, app: 'PearList' })
    assert.equal(r.seederKey, hex(seeder.seederKey))
    assert.equal(r.style, 'peerloom')
    A.styles.set(r.seederKey, r.style)
    assert.ok(seeder.isPaired(A.swarm.keyPair.publicKey))
    const dev = (await seeder.devices()).find((x) => x.deviceKey === A.key)
    assert.equal(dev.app, 'PearList')
  })

  await t.test('pairs with a pearoffice link to the same window', async () => {
    const { rv, seederKey } = protocol.parseSeederLink((await seeder.status()).pairing.link)
    const link = protocol.seederLink({ rv, seederKey, style: 'pearoffice' })
    const r = await pair({ swarm: B.swarm, link })
    assert.equal(r.style, 'pearoffice')
    B.styles.set(r.seederKey, r.style)
    const dev = (await seeder.devices()).find((x) => x.deviceKey === B.key)
    assert.equal(dev.app, null)
    seeder.closePairing()
  })

  await t.test('a pairing link from a closed window is refused', async () => {
    const { link } = seeder.openPairing(60000)
    seeder.closePairing()
    await assert.rejects(pair({ swarm: C.swarm, link, timeoutMs: 3000 }))
    assert.ok(!seeder.isPaired(C.swarm.keyPair.publicKey))
  })

  let shared
  await t.test('stores a space a paired device registers', async () => {
    shared = await space(A, 'shared')
    A.peering.addCoreBackground(shared, { target: shared.key, referrer: shared.key })
    await waitFor('seeder allows the space', () => seeder.allowedSpaces().includes(hex(shared.key)))
    await waitFor('seeder has the blocks', () => seederHas(seeder, shared.key, 2))
    assert.ok((await seeder.usedBy(A.key, { fresh: true })) > 0)
  })

  await t.test('a member who is not paired may add cores to a known space only', async () => {
    const theirs = await space(C, 'c-writer')
    C.peering.addCoreBackground(theirs, { target: shared.key, referrer: shared.key })
    await waitFor('seeder has the member core', () => seederHas(seeder, theirs.key, 2))

    const junk = await space(C, 'junk')
    const before = seeder.peer.stats.coresAdded
    C.peering.addCoreBackground(junk, { target: junk.key, referrer: junk.key })
    await sleep(3000)
    assert.equal(seeder.peer.stats.coresAdded, before)
    assert.ok(!seeder.allowedSpaces().includes(hex(junk.key)))
  })

  await t.test('requests work under both sets of names', async () => {
    const bootstrap = hex(shared.key)
    const seederKey = hex(seeder.seederKey)
    const r = await A.asker.ask(seederKey, { t: 'drop', bootstrap, afterMs: 3600000 })
    assert.equal(r.t, 'ok')
    assert.ok(r.due > Date.now())
    assert.equal((await seeder.drops()).length, 1)
    // B registers nothing here, so it may keep (which registers it) but not
    // drop before that.
    const k = await B.asker.ask(seederKey, { t: 'keep', bootstrap })
    assert.equal(k.cancelled, true)
    assert.equal((await seeder.drops()).length, 0)
    await assert.rejects(C.asker.ask(seederKey, { t: 'drop', bootstrap, afterMs: 0 }), (e) => e.answered === true)
  })

  await t.test('a device over its storage limit cannot add a new space', async () => {
    await seeder.setDeviceLimit(1)
    // Wait for blind-peer to record the bytes, then read them fresh.
    await waitFor('usage recorded', async () => (await seeder.usedBy(A.key, { fresh: true })) >= 1)
    const extra = await space(A, 'extra')
    A.peering.addCoreBackground(extra, { target: extra.key, referrer: extra.key })
    await sleep(3000)
    assert.ok(!seeder.allowedSpaces().includes(hex(extra.key)))
    assert.equal((await seeder.status()).deviceLimitBytes, 1)
    await seeder.setDeviceLimit(null)
    assert.equal((await seeder.status()).deviceLimitBytes, null)
  })

  await t.test('the dashboard can rename a device', async () => {
    assert.ok(await seeder.setDeviceLabel(B.key, 'PearOffice'))
    assert.equal((await seeder.devices()).find((x) => x.deviceKey === B.key).app, 'PearOffice')
  })

  await t.test('forgetting a device keeps spaces another paired device registered', async () => {
    const r = await seeder.forgetDevice(A.key)
    assert.deepEqual(r, { forgotten: true, dropping: 0 })
    assert.ok(!seeder.isPaired(A.swarm.keyPair.publicKey))
    const r2 = await seeder.forgetDevice(B.key)
    assert.deepEqual(r2, { forgotten: true, dropping: 1 })
    assert.equal((await seeder.drops()).length, 1)
  })
})

test('labels are cleaned', () => {
  assert.equal(protocol.cleanLabel('  PearList\n'), 'PearList')
  assert.equal(protocol.cleanLabel(''), null)
  assert.equal(protocol.cleanLabel(42), null)
  assert.equal(protocol.cleanLabel('x'.repeat(100)).length, protocol.APP_LABEL_MAX)
})

test('links parse in both styles', () => {
  const rv = b4a.alloc(32, 1)
  const seederKey = b4a.alloc(32, 2)
  for (const style of ['peerloom', 'pearoffice']) {
    const p = protocol.parseSeederLink(protocol.seederLink({ rv, seederKey, style }))
    assert.equal(p.style, style)
    assert.ok(b4a.equals(p.rv, rv))
    assert.ok(b4a.equals(p.seederKey, seederKey))
  }
  assert.throws(() => protocol.parseSeederLink('https://example.com'))
  assert.notDeepEqual(protocol.pairTopic(rv, 'peerloom'), protocol.pairTopic(rv, 'pearoffice'))
})
