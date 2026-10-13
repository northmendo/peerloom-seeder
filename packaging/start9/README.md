# PeerLoom Seeder for StartOS 0.4

A native StartOS 0.4 package (id `peerloom-seeder`), from PearOffice's
`start9/seeder`. It runs the Umbrel image,
`ghcr.io/peerloomllc/peerloom-seeder:<version>`, built by
`scripts/build-umbrel-image.sh` (`ARCHS=amd64` builds the one this package
uses; the package build reads the local image of that tag). Update checks are
off: StartOS updates the package. Devices on the same network as the Start9
reach it through the PeerLoom blind relay, which `src/client.js` asks for on
the dialling side.

Build: `npm install && make` (needs `start-cli-1.1.0` and a signing workspace
in `../.startos`, gitignored; PearOffice's `start9/.startos` works). Install
on a box the CLI is logged in to:
`start-cli-1.1.0 -H https://<box>.local package install -s peerloom-seeder_x86_64.s9pk`.
