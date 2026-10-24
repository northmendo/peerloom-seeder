// The dashboard host (host/server.js) with the real Bare seeder on a local
// DHT: the login, then every API route the page uses, with a device pairing
// from the link the dashboard shows.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const createTestnet = require('@hyperswarm/testnet')
const { pair } = require('..')
const { createHost, folderBytes } = require('../host/server')
const { tmpDirs, device, waitFor, bareBuild } = require('./helpers')

test('dashboard host', async (t) => {
  const { bare, bundle } = bareBuild()
  const testnet = await createTestnet(3)
  const dirs = tmpDirs()
  const open = []
  t.after(async () => {
    for (const close of open.reverse()) { try { await close() } catch {} }
    await testnet.destroy()
    dirs.clean()
  })

  const dataDir = dirs.make()
  const host = await createHost({ dataDir, port: 0, password: 'correct horse', barePath: bare, bundlePath: bundle, bootstrap: testnet.bootstrap })
  open.push(() => host.close())

  let cookie = ''
  async function api (method, route, body) {
    const res = await fetch(host.url + route, {
      method,
      headers: { 'content-type': 'application/json', cookie },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    const set = res.headers.get('set-cookie')
    if (set) cookie = set.split(';')[0]
    const type = res.headers.get('content-type') || ''
    return { status: res.status, body: type.includes('json') ? await res.json() : await res.text(), type }
  }

  await t.test('the page, icon and fonts load without a login; the API does not', async () => {
    const page = await api('GET', '/')
    assert.equal(page.status, 200)
    assert.match(page.body, /<title>PeerLoom Seeder<\/title>/)
    assert.equal((await api('GET', '/icon.png')).type, 'image/png')
    assert.match((await api('GET', '/fonts.css')).body, /Manrope/)
    assert.equal((await api('GET', '/api/status')).status, 401)
    assert.equal((await api('POST', '/api/pair')).status, 401)
  })

  await t.test('a wrong password is refused, the right one lets you in', async () => {
    assert.equal((await api('POST', '/api/login', { password: 'nope' })).status, 401)
    assert.equal((await api('POST', '/api/login', { password: 'correct horse' })).status, 200)
    assert.ok(cookie)
  })

  await t.test('status has the seeder, version, limit and disk use', async () => {
    const { status, body } = await api('GET', '/api/status')
    assert.equal(status, 200)
    assert.equal(body.seederKey, host.seederKey)
    assert.equal(body.version, require('../package.json').version)
    assert.equal(body.deviceLimitBytes, 25e9)
    assert.ok(body.disk.used > 0)
    assert.ok(body.uptime >= 0)
  })

  const A = device(testnet.bootstrap, dirs.make())
  open.push(() => A.close())

  await t.test('pairing from the dashboard link, with a QR code', async () => {
    const { body } = await api('POST', '/api/pair')
    assert.match(body.link, /^peerloom:\/\/seeder\?/)
    assert.match(body.svg, /^<svg /)
    assert.ok(body.expiresAt > body.now)
    await pair({ swarm: A.swarm, link: body.link, app: 'PearList' })
    await waitFor('the device listed', async () => (await api('GET', '/api/devices')).body.length === 1)
    const [d] = (await api('GET', '/api/devices')).body
    assert.equal(d.deviceKey, A.key)
    assert.equal(d.app, 'PearList')
  })

  await t.test('name a device; it stays under its app', async () => {
    assert.equal((await api('POST', '/api/rename', { deviceKey: A.key, name: 'Kitchen tablet' })).status, 200)
    const [d] = (await api('GET', '/api/devices')).body
    assert.equal(d.name, 'Kitchen tablet')
    assert.equal(d.app, 'PearList')
    await api('POST', '/api/rename', { deviceKey: A.key, name: '' })
    assert.equal((await api('GET', '/api/devices')).body[0].name, null)
  })

  await t.test('storage limit: set, refuse junk, turn off', async () => {
    assert.deepEqual((await api('POST', '/api/limit', { bytes: 10e9 })).body, { deviceLimitBytes: 10e9 })
    const bad = await api('POST', '/api/limit', { bytes: 'lots' })
    assert.equal(bad.status, 400)
    assert.match(bad.body.error, /whole number/)
    assert.equal((await api('GET', '/api/status')).body.deviceLimitBytes, 10e9)
    assert.deepEqual((await api('POST', '/api/limit', { bytes: null })).body, { deviceLimitBytes: null })
  })

  await t.test('forget a device', async () => {
    assert.equal((await api('POST', '/api/forget', { deviceKey: A.key })).body.forgotten, true)
    assert.deepEqual((await api('GET', '/api/devices')).body, [])
    assert.equal((await api('POST', '/api/forget', { deviceKey: A.key })).status, 400)
  })

  await t.test('donate QR codes, unknown routes and logout', async () => {
    assert.match((await api('GET', '/api/donate')).body.ln.svg, /^<svg /)
    const upd = (await api('GET', '/api/update')).body
    assert.equal(upd.available, false, 'no release check unless asked')
    assert.equal((await api('POST', '/api/update')).status, 400)
    assert.equal((await api('GET', '/api/nope')).status, 404)
    await api('POST', '/api/logout')
    assert.equal((await api('GET', '/api/status')).status, 401)
  })

  await t.test('no login on 127.0.0.1 without a password', async () => {
    const dir = dirs.make()
    const local = await createHost({ dataDir: dir, port: 0, barePath: bare, bundlePath: bundle, bootstrap: testnet.bootstrap })
    open.push(() => local.close())
    const res = await fetch(local.url + '/api/status')
    assert.equal(res.status, 200)
    assert.ok(!fs.readdirSync(dir).some((f) => /password/i.test(f)))
  })

  // The LXC case (docs/DEBIAN-LXC.md): the dashboard bound to every interface.
  // No request gets in without a session, whoever it comes from — a non-
  // loopback bind must never be unauthenticated (requireSafeBind fails closed).
  await t.test('a 0.0.0.0 bind mints and enforces a password', async () => {
    const dir = dirs.make()
    let printed = ''
    const lan = await createHost({
      dataDir: dir,
      host: '0.0.0.0',
      port: 0,
      barePath: bare,
      bundlePath: bundle,
      bootstrap: testnet.bootstrap,
      log: (line) => { printed += line + '\n' }
    })
    open.push(() => lan.close())
    const url = 'http://127.0.0.1:' + lan.server.address().port

    // The API answers 401 without a session; the page loads and shows the
    // login form. Nothing is served unauthenticated but the page itself.
    assert.equal((await fetch(url + '/api/status')).status, 401)
    assert.equal((await fetch(url + '/api/devices')).status, 401)
    assert.equal((await fetch(url + '/')).status, 200)

    // A password was minted, persisted in the data folder and printed once.
    const minted = fs.readFileSync(path.join(dir, 'dashboard-password'), 'utf8').trim()
    assert.ok(minted.length >= 16)
    assert.ok(printed.includes(minted))
    assert.ok(!printed.slice(printed.indexOf(minted) + 1).includes(minted), 'printed exactly once')

    // The wrong password is refused; the minted one opens a session that works.
    const wrong = await fetch(url + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'nope' }) })
    assert.equal(wrong.status, 401)
    const login = await fetch(url + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: minted }) })
    assert.equal(login.status, 200)
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0]
    assert.ok(cookie)
    assert.equal((await fetch(url + '/api/status', { headers: { cookie } })).status, 200)
    assert.equal((await fetch(url + '/api/status')).status, 401, 'still 401 without the session')
  })

  await t.test('folderBytes counts nested files', async () => {
    const dir = dirs.make()
    fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'a', 'one'), 'x'.repeat(10))
    fs.writeFileSync(path.join(dir, 'a', 'b', 'two'), 'y'.repeat(5))
    assert.equal(await folderBytes(dir), 15)
  })
})
