// host/server.js readConfig: env vars beat the SEEDER_CONFIG file, the file
// beats the defaults. The LXC setup (docs/DEBIAN-LXC.md) sets SEEDER_HOST
// through the service's EnvironmentFile; a JSON config file can hold the
// same settings for an operator who prefers one file over env vars.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { readConfig, parseBootstrap } = require('../host/server')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'peerloom-config-'))
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

const write = (obj) => {
  const file = path.join(tmp, 'config.json')
  fs.writeFileSync(file, JSON.stringify(obj))
  return file
}

test('defaults without a config file: loopback, 8761, home data folder', () => {
  const cfg = readConfig({})
  assert.equal(cfg.host, '127.0.0.1')
  assert.equal(cfg.port, 8761)
  assert.equal(cfg.password, null)
  assert.equal(cfg.bootstrap, null)
  assert.equal(cfg.dataDir, path.join(os.homedir(), '.peerloom-seeder'))
})

test('the config file sets what no env var does', () => {
  const file = write({ host: '0.0.0.0', port: 9000, data: '/var/lib/peerloom-seeder', password: 'pw', bootstrap: '10.0.0.1:10001,10.0.0.2:10002' })
  const cfg = readConfig({ SEEDER_CONFIG: file })
  assert.equal(cfg.host, '0.0.0.0')
  assert.equal(cfg.port, 9000)
  assert.equal(cfg.dataDir, '/var/lib/peerloom-seeder')
  assert.equal(cfg.password, 'pw')
  assert.deepEqual(cfg.bootstrap, [{ host: '10.0.0.1', port: 10001 }, { host: '10.0.0.2', port: 10002 }])
})

test('an env var beats the config file, the file beats the defaults', () => {
  const file = write({ host: '0.0.0.0', port: 9000 })
  const cfg = readConfig({ SEEDER_CONFIG: file, SEEDER_HOST: '127.0.0.1' })
  assert.equal(cfg.host, '127.0.0.1', 'the env var wins')
  assert.equal(cfg.port, 9000, 'the file wins where no env var is set')
})

test('an empty env var falls back to the file (a systemd env file left blank)', () => {
  const file = write({ host: '0.0.0.0' })
  assert.equal(readConfig({ SEEDER_CONFIG: file, SEEDER_HOST: '' }).host, '0.0.0.0')
})

test('a missing or bad SEEDER_CONFIG is an error, never a silent default', () => {
  assert.throws(() => readConfig({ SEEDER_CONFIG: path.join(tmp, 'nope.json') }), /ENOENT/)
  const junk = path.join(tmp, 'junk.json')
  fs.writeFileSync(junk, '{oops')
  assert.throws(() => readConfig({ SEEDER_CONFIG: junk }), /JSON/)
  const list = path.join(tmp, 'list.json')
  fs.writeFileSync(list, '["0.0.0.0"]')
  assert.throws(() => readConfig({ SEEDER_CONFIG: list }), /JSON object/)
})

test('junk values are refused rather than guessed', () => {
  const file = write({ port: 'not a port' })
  assert.throws(() => readConfig({ SEEDER_CONFIG: file }), /port/)
  assert.throws(() => readConfig({ SEEDER_PORT: 'lots' }), /SEEDER_PORT/)
  assert.throws(() => readConfig({ SEEDER_PORT: 99999 }), /SEEDER_PORT/)
  assert.throws(() => readConfig({ SEEDER_PORT: '99.5' }), /SEEDER_PORT/)
  assert.throws(() => readConfig({ SEEDER_HOST: '  ' }), /SEEDER_HOST/)
  const bootstrap = write({ bootstrap: 'no-port-here' })
  assert.throws(() => readConfig({ SEEDER_CONFIG: bootstrap }), /bootstrap/)
})

test('parseBootstrap takes the env var shape', () => {
  assert.deepEqual(parseBootstrap('127.0.0.1:10001'), [{ host: '127.0.0.1', port: 10001 }])
  assert.equal(parseBootstrap(''), null)
  assert.equal(parseBootstrap(null), null)
})
