# @peerloom/seeder

One blind seeder for every PeerLoom app. An always-on box stores the encrypted
data of the spaces its paired devices register, and serves it to the other
members, so a space still syncs when everyone else is offline. It never gets a
space's encryption key and does not know which app a space belongs to.

Built on Holepunch's [`blind-peer`](https://github.com/holepunchto/blind-peer).
First built as PearOffice's seeder. The plan is in the suite root,
`proposals/2026-10-12-generic-seeder.md`.

## What it adds to blind-peer

- **Pairing.** The seeder shows a 5-minute link and QR code. A device that
  opens it proves its swarm key and is trusted from then on.
- **Admission.** Stock blind-peer stores anything for anyone. This one stores
  cores only from paired devices, plus cores from other members of a space a
  paired device registered.
- **A storage limit per device**, set by whoever runs the seeder. Over it, a
  device cannot register new spaces.
- **Drops.** A paired device can ask for a space to be deleted after a delay
  (at most 30 days) or cancel that. Forgetting a device drops, after 7 days,
  every space no other paired device registered.
- **Keyrings.** A small sealed record per person, so a device restored from a
  recovery phrase can find its spaces again. Optional.
- **App labels.** A device can send a label ("PearList") for the dashboard.
  Apps for sensitive data send none.

## Use

The box:

```js
const { createSeeder } = require('@peerloom/seeder')
const seeder = await createSeeder({ dataDir, log: console.log })
const { link } = seeder.openPairing()   // show as text and QR
await seeder.devices()                  // paired devices, labels, bytes used
await seeder.setDeviceLimit(10e9)       // or null for no limit
await seeder.forgetDevice(deviceKey)
```

A phone:

```js
const { pair, createPeering, createAsker } = require('@peerloom/seeder')
const { seederKey } = await pair({ swarm, link, app: 'PearList' })
const peering = createPeering({ dht: swarm.dht, store, keyPair: swarm.keyPair })
peering.addAutobaseBackground(base, { keys: [seederKey], pick: 1 })
const { ask } = createAsker({ dht: () => swarm.dht, keyPair: swarm.keyPair })
await ask(seederKey, { t: 'drop', bootstrap, afterMs })
```

The app decides which spaces go to which seeders. The phone sends every
writer and view core of an Autobase (blind-peering's `addAutobase` reads the
system core, which the seeder cannot), and must send them again when a writer
joins.

## What it cannot do

- Admit a new member. Adding a writer needs a member online.
- Read anything. Its operator can see how many spaces a device has, how big
  they are, when they change and the IP addresses that send them.

## Consuming it

Dependencies are peers. Apps that bundle for Bare should copy `src/` in with a
vendor script (PearOffice: `scripts/vendor-peerloom-seeder.js`) rather than
use a `file:` dependency, so the bundle has one copy of hypercore and each
native addon.

## Protocol names

`peerloom://seeder` links, `peerloom/seeder-pair/1` and `peerloom/seeder/1`.
The seeder also answers PearOffice's older names (`pearoffice://seeder`,
`pearoffice/seeder-pair/1`, `pearoffice/seeder/1`), so PearOffice versions from
before the shared seeder keep working. `src/protocol.js` has the exchange.

## PeerLoom Seeder (the product)

The seeder people install: one package for Umbrel, Start9, Linux, macOS and
Windows (plan: suite `proposals/2026-10-12-peerloom-seeder-product.md`).
Two processes:

- **The seeder**, `src/bare.js`, run by the Bare runtime from a `bare-pack`
  bundle, so the native addons and hypercore patches match the apps.
  `node scripts/build-bare.js [platform-arch]` puts the runtime and bundle in
  `dist/<platform>-<arch>/`. With `--ipc` it answers newline JSON
  `{ id, method, args }` on stdio: `status`, `pair`, `devices`,
  `forget { deviceKey }`, `limit { bytes | null }` and
  `label { deviceKey, app }`, plus `ready` and `log` events.
- **The host**, `host/server.js` (Node): starts the seeder
  (`host/seeder-process.js`) and serves the dashboard (`host/index.html`) on
  port 8761: pairing link and QR code, paired devices with their app label,
  spaces and bytes, rename, forget, the storage limit, the seeder key,
  version, peers and disk use. Login is `@peerloom/host`'s dashboard-auth,
  copied into `host/vendor/` by `node scripts/vendor-peerloom-host.js`: none
  on 127.0.0.1, `SEEDER_PASSWORD` or a generated password elsewhere.
  Settings are environment variables, listed at the top of the file.

A new data folder starts with a storage limit of 25 GB per device. A folder
a PearOffice seeder set up (`pearoffice-state/`) opens as is: same seeder
key, devices and files, and no limit added.

`npm run dashboard` builds and runs it with data in `~/.peerloom-seeder`.
Branding is in `assets/`: `icon.svg` (exported by `scripts/icons.sh`) and
`listing.md` (store and website copy).

## Run one from Node

`node bin/peerloom-seeder.js --data <folder>` prints a pairing link and takes
`pair`, `status`, `devices`, `limit <bytes|off>` and `forget <key>` on stdin.
For development; the product runs the Bare build.

## Test

`npm test` builds the Bare bundle, then runs, over a local DHT testnet:
the library (pairing under both names, labels, admission, requests, the
storage limit and forgetting), the Bare seeder over `--ipc` (every method,
the 25 GB default, a PearOffice folder opening as is) and the dashboard host
(login and every API route, with a device pairing from its link).
