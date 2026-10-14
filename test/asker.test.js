// The asker's settled(): resolves once every request sent so far has finished.
// The seeding module waits on it before closing old connections, so a request in
// flight is not lost and sent a second time.

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createAsker } = require('..')

// A DHT whose connections never open, so every request times out.
const deadDht = () => ({ connect: () => Object.assign(new EventEmitter(), { destroy () {} }) })

test('settled resolves at once with no requests', async () => {
  const asker = createAsker({ dht: deadDht, keyPair: null })
  await asker.settled()
})

test('settled waits for requests in flight, failed ones included', async () => {
  const asker = createAsker({ dht: deadDht, keyPair: null })
  const key = 'a'.repeat(64)
  let failed = false
  asker.ask(key, { t: 'drop', bootstrap: 'b'.repeat(64) }, 30).catch(() => { failed = true })
  asker.ask(key, { t: 'drop', bootstrap: 'c'.repeat(64) }, 30).catch(() => {})
  await asker.settled()
  assert.equal(failed, true)
})
