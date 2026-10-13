# CLAUDE.md

Constitution applies. See `/home/tim/peerloomllc/CONSTITUTION.md`.

The shared blind seeder (`README.md`). Proposal:
`/home/tim/peerloomllc/proposals/2026-10-12-generic-seeder.md`.

- `src/seeder.js` - the box: blind-peer subclass with admission, storage
  limit per device, drops, keyrings, pairing and requests.
- `src/client.js` - the device side: pairing, peering, requests.
- `src/protocol.js` - names, links, topics. Both `peerloom` and the older
  `pearoffice` names.
- `src/bare.js` - the PeerLoom Seeder process (Bare): `--ipc` newline JSON
  for the host, interactive otherwise. Built by `scripts/build-bare.js`.
- `host/` - the PeerLoom Seeder host (Node): `server.js` (dashboard API and
  login), `index.html` (the page), `seeder-process.js` (the IPC client),
  `vendor/peerloom-host` (copy, never edit; `scripts/vendor-peerloom-host.js`).
- `assets/` - icon and listing copy. Product plan:
  `/home/tim/peerloomllc/proposals/2026-10-12-peerloom-seeder-product.md`.
- `src/keyringRecord.js` - keyring checks. Its namespaces say `pearoffice/` and
  must stay: they are signed into stored records.

Rules:

- Never give the seeder anything that lets it decrypt.
- State keys keep PearOffice's layout (`sheet/`, `device/`, `core/`, `drop/`,
  `keyring/`) so its existing seeders need no migration.
- blind-peer is pinned exactly: `src/seeder.js` overrides its internal
  methods. Check them before any bump.
- Consumers vendor `src/` (see README). After a change here, run each
  consumer's vendor script (PearOffice: `node scripts/vendor-peerloom-seeder.js`).

Verify: `npm test`.
