// host/vendor/peerloom-host must match ../peerloom-host. After changing that
// package, run node scripts/vendor-peerloom-host.js.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { FILES, from, to } = require('../scripts/vendor-peerloom-host')

test('vendored @peerloom/host files match the sibling checkout', { skip: !fs.existsSync(from) && 'no ../peerloom-host checkout' }, () => {
  for (const f of FILES) {
    assert.equal(fs.readFileSync(path.join(to, f), 'utf8'), fs.readFileSync(path.join(from, 'src', f), 'utf8'), f + ' is stale: run node scripts/vendor-peerloom-host.js')
  }
})
