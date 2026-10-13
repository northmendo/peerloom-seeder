// Copy the parts of @peerloom/host that the seeder dashboard uses into
// host/vendor/peerloom-host/, from the sibling checkout ../peerloom-host.
// They use only Node built-ins and z32, so the host carries these files and
// not the whole package. Committed, so builds need no sibling checkout;
// test/vendor.test.js fails when they fall out of step with ../peerloom-host.
//
// Usage: node scripts/vendor-peerloom-host.js
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const from = path.join(root, '..', 'peerloom-host')
const to = path.join(root, 'host', 'vendor', 'peerloom-host')
const FILES = ['dashboard-auth.js', 'tighten.js', 'update-check.js', 'update-apply.js']

function vendor () {
  fs.rmSync(to, { recursive: true, force: true })
  fs.mkdirSync(to, { recursive: true })
  for (const f of FILES) fs.copyFileSync(path.join(from, 'src', f), path.join(to, f))
  fs.copyFileSync(path.join(from, 'LICENSE'), path.join(to, 'LICENSE'))
  const commit = (() => { try { return require('child_process').execFileSync('git', ['-C', from, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim() } catch { return 'unknown' } })()
  fs.writeFileSync(path.join(to, 'README.md'), 'Copied from peerloom-host (' + commit + ') by scripts/vendor-peerloom-host.js. Do not edit here.\n')
}

if (require.main === module) { vendor(); console.log('vendored ' + FILES.join(', ') + ' from ' + from) }

module.exports = { FILES, from, to }
