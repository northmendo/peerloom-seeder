// The dashboard's update check (host/updates.js) against a fake release
// (scripts/serve-local-release.js): it sees a newer version, picks this
// machine's installer, says how to update where the dashboard cannot, and
// ignores a release that has no new build for this platform.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { serveRelease } = require('../scripts/serve-local-release')
const { createUpdates, CONFIG } = require('../host/updates')
const { selectAsset } = require('../host/vendor/peerloom-host/update-apply')

const NAMES = (v) => [
  'PeerLoomSeeder-Setup-' + v + '.exe',
  'PeerLoomSeeder-' + v + '-arm64.pkg',
  'PeerLoomSeeder-' + v + '-x64.pkg',
  'peerloom-seeder_' + v + '_amd64.deb',
  'peerloom-seeder_' + v + '_arm64.deb',
  'PeerLoomSeeder-' + v + '-x86_64.AppImage',
  'PeerLoomSeeder-' + v + '-aarch64.AppImage',
  'peerloom-seeder-' + v + '-linux-x64.tar.gz'
]

async function release (version, names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pls-release-'))
  for (const n of names) { fs.writeFileSync(path.join(dir, n), n); fs.writeFileSync(path.join(dir, n + '.sha256'), '0'.repeat(64) + '  ' + n + '\n') }
  const server = await serveRelease({ version, dir })
  return { url: 'http://127.0.0.1:' + server.address().port + '/latest', close: () => { server.close(); fs.rmSync(dir, { recursive: true, force: true }) } }
}

async function settle (u) {
  for (let i = 0; i < 50; i++) { const s = u.state(); if (s.checkedAt) return s; await new Promise((r) => setTimeout(r, 100)) }
  throw new Error('no check happened')
}

test('each platform gets its own installer', () => {
  const assets = NAMES('0.2.0').map((name) => ({ name, browser_download_url: 'x' }))
  const pick = (platform, arch) => (selectAsset(assets, { config: CONFIG, platform, arch }) || {}).name
  assert.equal(pick('win32', 'x64'), 'PeerLoomSeeder-Setup-0.2.0.exe')
  assert.equal(pick('darwin', 'arm64'), 'PeerLoomSeeder-0.2.0-arm64.pkg')
  assert.equal(pick('darwin', 'x64'), 'PeerLoomSeeder-0.2.0-x64.pkg')
})

test('a newer release shows, with how to install it', async () => {
  const r = await release('0.2.0', NAMES('0.2.0'))
  const u = createUpdates({ version: '0.1.0', packaged: true, env: { SEEDER_UPDATE_LATEST_URL: r.url, SEEDER_UPDATE_DELAY: '0' } })
  try {
    const s = await settle(u)
    assert.equal(s.available, true)
    assert.equal(s.latest, '0.2.0')
    assert.equal(s.current, '0.1.0')
    assert.equal(s.assets, undefined, 'assets stay out of what the page polls')
    if (process.platform === 'linux') {
      assert.equal(s.canApply, false)
      assert.equal(s.how, 'peerloom-seeder update')
      assert.throws(() => u.start(), /cannot update itself/)
    }
    assert.equal(s.apply.status, 'idle')
  } finally { u.stop(); r.close() }
})

test('not packaged (a checkout): told, never applied', async () => {
  const r = await release('0.2.0', NAMES('0.2.0'))
  const u = createUpdates({ version: '0.1.0', packaged: false, env: { SEEDER_UPDATE_LATEST_URL: r.url, SEEDER_UPDATE_DELAY: '0' } })
  try {
    const s = await settle(u)
    assert.equal(s.available, true)
    assert.equal(s.canApply, false)
    assert.equal(s.how, null)
  } finally { u.stop(); r.close() }
})

test('a release that carried this platform\'s old build forward is not offered', async () => {
  const names = NAMES('0.1.0')
  const r = await release('0.2.0', names)
  const u = createUpdates({ version: '0.1.0', packaged: true, env: { SEEDER_UPDATE_LATEST_URL: r.url, SEEDER_UPDATE_DELAY: '0' } })
  try {
    const s = await settle(u)
    if (process.platform === 'linux' && process.arch === 'x64') assert.equal(s.available, false)
  } finally { u.stop(); r.close() }
})

test('SEEDER_NO_UPDATE_CHECK turns it off', () => {
  const u = createUpdates({ version: '0.1.0', packaged: true, env: { SEEDER_NO_UPDATE_CHECK: '1' } })
  const s = u.state()
  assert.equal(s.available, false)
  assert.equal(s.off, 'SEEDER_NO_UPDATE_CHECK')
  u.stop()
})
