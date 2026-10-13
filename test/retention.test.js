// "Keep the last N days" for a space: who may ask, and that the sweep clears
// only blocks the seeder held more than N days ago, and does not fetch them
// again. Time is passed to runRetention, so the test needs no waiting days.

const test = require('node:test')
const assert = require('node:assert/strict')
const b4a = require('b4a')
const createTestnet = require('@hyperswarm/testnet')
const { createSeeder, createPeering, pair, createAsker } = require('..')
const { tmpDirs, waitFor, device, sleep } = require('./helpers')

const hex = (buf) => b4a.toString(buf, 'hex')
const DAY = 24 * 3600 * 1000

test('retention', async (t) => {
  const testnet = await createTestnet(3)
  const dirs = tmpDirs()
  const open = []
  const seeder = await createSeeder({ dataDir: dirs.make(), bootstrap: testnet.bootstrap })
  t.after(async () => {
    for (const close of open.reverse()) { try { await close() } catch {} }
    try { await seeder.close() } catch {}
    await testnet.destroy()
    dirs.clean()
  })

  async function member () {
    const d = device(testnet.bootstrap, dirs.make())
    const peering = createPeering({ dht: d.swarm.dht, store: d.store, keyPair: d.swarm.keyPair, keys: [seeder.seederKey] })
    const asker = createAsker({ dht: () => d.swarm.dht, keyPair: d.swarm.keyPair })
    open.push(async () => { await peering.close(); await d.close() })
    return { ...d, peering, asker }
  }

  const A = await member()
  const B = await member()
  await pair({ swarm: A.swarm, link: seeder.openPairing().link, app: 'PearCircle' })
  seeder.closePairing()

  const core = A.store.get({ name: 'locations' })
  await core.append(['a', 'b', 'c', 'd'].map((x) => b4a.from(x)))
  A.peering.addCoreBackground(core, { target: core.key, referrer: core.key })
  const space = hex(core.key)
  const seederKey = hex(seeder.seederKey)
  const held = async () => {
    const c = seeder.peer.store.get({ key: core.key })
    await c.ready()
    const r = []
    const n = Math.max(c.length, core.length)
    for (let i = 0; i < n; i++) r.push(await c.has(i))
    await c.close()
    return r
  }
  // Opening the seeder's copy before it does would close it again with ours.
  await waitFor('the seeder takes the space', async () => seeder.allowedSpaces().includes(space) && !!(await seeder.peer.db.getCoreRecord(core.key)))
  await waitFor('the seeder holds 4 blocks', async () => (await held()).filter(Boolean).length === 4)

  await t.test('only a device that backs the space up may set it, within limits', async () => {
    await assert.rejects(B.asker.ask(seederKey, { t: 'retain', bootstrap: space, days: 1 }), /back that up|paired/)
    await assert.rejects(A.asker.ask(seederKey, { t: 'retain', bootstrap: space, days: 0 }), /whole number/)
    const r = await A.asker.ask(seederKey, { t: 'retain', bootstrap: space, days: 1 })
    assert.equal(r.days, 1)
    assert.equal(await seeder.retention(space), 1)
  })

  await t.test('the sweep clears what was held more than a day ago, and only that', async () => {
    const t0 = Date.now()
    assert.equal(await seeder.runRetention(t0), 0) // notes length 4, nothing old yet
    await core.append(['e', 'f'].map((x) => b4a.from(x)))
    await waitFor('the seeder holds 6 blocks', async () => (await held()).filter(Boolean).length === 6)
    assert.equal(await seeder.runRetention(t0 + DAY / 2), 0) // notes 6; the mark at 4 is not a day old
    assert.equal(await seeder.runRetention(t0 + DAY + 1000), 1) // the mark at 4 is
    assert.deepEqual(await held(), [false, false, false, false, true, true])
    await sleep(2000) // the member still has them; they must not come back
    assert.deepEqual(await held(), [false, false, false, false, true, true])
    assert.equal(await seeder.runRetention(t0 + DAY / 2 + DAY + 1000), 1) // now the mark at 6
    assert.deepEqual(await held(), [false, false, false, false, false, false])
  })

  await t.test('keep everything again stops clearing', async () => {
    const r = await A.asker.ask(seederKey, { t: 'retain', bootstrap: space, days: null })
    assert.equal(r.days, null)
    assert.equal(await seeder.retention(space), null)
    await core.append(b4a.from('g'))
    await waitFor('the seeder holds the new block', async () => (await held())[6] === true)
    assert.equal(await seeder.runRetention(Date.now() + 10 * DAY), 0)
    assert.equal((await held())[6], true)
  })
})
