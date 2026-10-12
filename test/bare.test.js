// The Bare seeder (src/bare.js) as the host runs it: --ipc over stdio through
// host/seeder-process.js, on a local DHT. Every IPC method, the 25 GB default
// on a new folder and a PearOffice seeder folder opening as is.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const createTestnet = require('@hyperswarm/testnet')
const { createSeeder, pair } = require('..')
const { SeederProcess } = require('../host/seeder-process')
const { tmpDirs, device, bareBuild } = require('./helpers')

test('bare seeder over ipc', async (t) => {
  const { bare, bundle } = bareBuild()
  const testnet = await createTestnet(3)
  const dirs = tmpDirs()
  const open = []
  t.after(async () => {
    for (const close of open.reverse()) { try { await close() } catch {} }
    await testnet.destroy()
    dirs.clean()
  })
  const logs = []
  async function start (dataDir) {
    const p = new SeederProcess({ barePath: bare, bundlePath: bundle, dataDir, bootstrap: testnet.bootstrap, onLog: (_, l) => logs.push(l) })
    open.push(() => p.stop())
    await p.start()
    return p
  }

  const dataDir = dirs.make()
  const seeder = await start(dataDir)
  const A = device(testnet.bootstrap, dirs.make())
  open.push(() => A.close())

  await t.test('a new folder starts with 25 GB per device', async () => {
    const s = await seeder.call('status')
    assert.equal(s.seederKey, seeder.seederKey)
    assert.equal(s.stateName, 'seeder-state')
    assert.equal(s.deviceLimitBytes, 25e9)
  })

  await t.test('pair gives a peerloom link a device can use, with its label', async () => {
    const { link, expiresAt } = await seeder.call('pair')
    assert.match(link, /^peerloom:\/\/seeder\?/)
    assert.ok(expiresAt > Date.now())
    const r = await pair({ swarm: A.swarm, link, app: 'PearList' })
    assert.equal(r.seederKey, seeder.seederKey)
    const [d] = await seeder.call('devices')
    assert.equal(d.deviceKey, A.key)
    assert.equal(d.app, 'PearList')
    assert.equal(d.spaces, 0)
    assert.equal(d.bytes, 0)
  })

  await t.test('label renames a device by a start of its key', async () => {
    assert.deepEqual(await seeder.call('label', { deviceKey: A.key.slice(0, 8), app: '  Sam\'s phone ' }), { ok: true })
    assert.equal((await seeder.call('devices'))[0].app, 'Sam\'s phone')
    await seeder.call('label', { deviceKey: A.key, app: '' })
    assert.equal((await seeder.call('devices'))[0].app, null)
    await assert.rejects(seeder.call('label', { deviceKey: 'ffffffff', app: 'x' }), /No paired device/)
  })

  await t.test('limit sets, turns off and refuses junk', async () => {
    assert.deepEqual(await seeder.call('limit', { bytes: 5e9 }), { deviceLimitBytes: 5e9 })
    assert.equal((await seeder.call('status')).deviceLimitBytes, 5e9)
    assert.deepEqual(await seeder.call('limit', { bytes: null }), { deviceLimitBytes: null })
    assert.equal((await seeder.call('status')).deviceLimitBytes, null)
    await seeder.call('limit', { bytes: 7e9 })
    for (const bytes of ['abc', -1, 0, 1.5]) await assert.rejects(seeder.call('limit', { bytes }), /whole number/)
    assert.equal((await seeder.call('status')).deviceLimitBytes, 7e9)
    await seeder.call('limit', { bytes: null })
  })

  await t.test('unknown methods and short keys are errors', async () => {
    await assert.rejects(seeder.call('nope'), /unknown method/)
    await assert.rejects(seeder.call('forget', { deviceKey: 'abc' }), /No paired device/)
  })

  await t.test('forget unpairs', async () => {
    const r = await seeder.call('forget', { deviceKey: A.key })
    assert.equal(r.forgotten, true)
    assert.deepEqual(await seeder.call('devices'), [])
  })

  await t.test('a limit turned off stays off after a restart', async () => {
    await seeder.stop()
    const again = await start(dataDir)
    assert.equal(again.seederKey, seeder.seederKey)
    assert.equal((await again.call('status')).deviceLimitBytes, null)
    await again.stop()
  })

  await t.test('a PearOffice seeder folder opens as is', async () => {
    const poDir = dirs.make()
    const B = device(testnet.bootstrap, dirs.make())
    open.push(() => B.close())
    const po = await createSeeder({ dataDir: poDir, bootstrap: testnet.bootstrap, stateName: 'pearoffice-state', linkStyle: 'pearoffice' })
    const { link } = po.openPairing()
    await pair({ swarm: B.swarm, link, app: 'PearOffice' })
    const key = Buffer.from(po.seederKey).toString('hex')
    await po.close()

    const s = await start(poDir)
    assert.equal(s.seederKey, key)
    const st = await s.call('status')
    assert.equal(st.stateName, 'pearoffice-state')
    assert.equal(st.deviceLimitBytes, null) // no default forced on an existing seeder
    const [d] = await s.call('devices')
    assert.equal(d.deviceKey, B.key)
    assert.equal(d.app, 'PearOffice')
    assert.ok(!fs.existsSync(poDir + '/seeder-state'))
    assert.ok(logs.includes('opened a PearOffice seeder folder'))
  })
})
