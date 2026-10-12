#!/usr/bin/env node
// Run a seeder from the command line (Node).
//
//   node bin/peerloom-seeder.js --data <folder>
//
// Prints a pairing link, then reads commands from stdin:
//   pair              a fresh 5-minute pairing link
//   status            counts
//   devices           paired devices, labels and bytes used
//   limit <bytes|off> the storage limit per device
//   forget <key>      forget a device (by its key or a unique start of it)
const path = require('path')
const readline = require('readline')
const { createSeeder } = require('../src/seeder')

const argv = process.argv.slice(2)
const at = argv.indexOf('--data')
const dataDir = at !== -1 ? argv[at + 1] : null
if (!dataDir) { console.error('usage: node bin/peerloom-seeder.js --data <folder>'); process.exit(2) }

async function main () {
  const seeder = await createSeeder({ dataDir: path.resolve(dataDir), log: (l) => console.log('[seeder] ' + l) })
  const show = () => { const { link, expiresAt } = seeder.openPairing(); console.log('pair link (until ' + new Date(expiresAt).toLocaleTimeString() + '):\n' + link) }
  console.log('seeder key ' + (await seeder.status()).seederKey)
  show()
  const rl = readline.createInterface({ input: process.stdin })
  rl.on('line', async (line) => {
    const [cmd, arg] = line.trim().split(/\s+/)
    try {
      if (cmd === 'pair') show()
      else if (cmd === 'status') console.log(JSON.stringify(await seeder.status(), null, 2))
      else if (cmd === 'devices') console.log(JSON.stringify(await seeder.devices(), null, 2))
      else if (cmd === 'limit') console.log('limit: ' + await seeder.setDeviceLimit(arg === 'off' ? null : Number(arg)))
      else if (cmd === 'forget') {
        const match = (await seeder.devices()).filter((d) => arg && arg.length >= 6 && d.deviceKey.startsWith(arg))
        if (match.length !== 1) console.log(match.length ? 'more than one device starts with that' : 'no paired device starts with that')
        else console.log(JSON.stringify(await seeder.forgetDevice(match[0].deviceKey)))
      } else if (cmd) console.log('commands: pair, status, devices, limit <bytes|off>, forget <key>')
    } catch (e) { console.log('error: ' + e.message) }
  })
  const stop = async () => { rl.close(); await seeder.close(); process.exit(0) }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
main().catch((e) => { console.error(e); process.exit(1) })
