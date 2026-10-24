# Proxmox VE community-script for PeerLoom Seeder

`peerloom-seeder.sh` creates a Debian 12 LXC on a Proxmox VE host and
installs the seeder into it, following `docs/DEBIAN-LXC.md`: Node 22 LTS
(NodeSource), the northmendo fork in `/opt/peerloom-seeder`, the bind
config in `/etc/peerloom-seeder.env` and the hardened systemd service from
`packaging/debian/peerloom-seeder.service`. `peerloom-seeder.json` is the
metadata file in the format the community-scripts repos keep in `json/`.

Run it on the PVE host:

```sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/northmendo/peerloom-seeder/main/packaging/proxmox/peerloom-seeder.sh)"
```

Every whiptail prompt has an escape hatch — export the variable for an
unattended run:

```sh
CT_ID=110 DISK_SIZE=8 BIND_ADDR=0.0.0.0 LIMIT_GB=25 PORT=8761 STORAGE=local \
  bash peerloom-seeder.sh
```

Settings asked for: CT ID, disk size, dashboard bind address, per-device
storage limit, dashboard port. Defaults: unprivileged container, DHCP on
vmbr0, 1 core / 1 GB RAM, storage `local` (override with `STORAGE`).

## Security

The default bind is `0.0.0.0` so the dashboard is reachable from the LAN —
which is only safe because the dashboard host refuses a non-loopback bind
without a password. The installer reads the password minted on the
container's first start (also printed at the end of the run, and kept at
`/var/lib/peerloom-seeder/dashboard-password`) and uses the dashboard's own
API to set the storage limit. The test suite pins the auth-gated-on-LAN-bind
behaviour (`test/host.test.js`).

## Status: what is and is not verified

- `bash -n` clean, and shellcheck-clean (shellcheck 0.10.0). The in-container
  script the installer pipes to `bash -s` also parses clean on its own.
- The host-side orchestration (template download, `pct create` arguments,
  `lxc-attach` env passing, the wait-for-dashboard loop, the API calls and
  the final summary) was exercised end-to-end against mocked `pct`, `pveam`,
  `pvesh` and `lxc-attach` — that is how the `set -o pipefail` SIGPIPE bug
  in the CT-password generation was found and fixed.
- **NOT run against a real Proxmox VE host or a real container** — none was
  available. The container-side steps (NodeSource install, `npm install`,
  `npm run build`, the systemd unit) are the same commands the runbook
  documents and the same unit `systemd-analyze verify` passes; the unit has
  also not been started inside a real unprivileged LXC, which is where
  `DynamicUser` + `ProtectSystem=strict` would show any remaining friction.

## Submitting upstream

The community-scripts project has restructured (2026): new scripts go to
[community-scripts/DevScripts](https://github.com/community-scripts/DevScripts)
first, as two files — `ct/<app>.sh` (menu + container creation, sourcing
the shared core from community-scripts/core) and
`install/<app>-install.sh` (the in-container steps) — with the JSON in
`json/`. This repo ships one self-contained script instead (it relies only
on what a PVE host provides, no core fetch), because a seeder box is
infrastructure you may want to read in full. To upstream it, split at the
`lxc-attach … <<'INSTALL'` heredoc: everything above it becomes
`ct/peerloom-seeder.sh` and the heredoc body plus the post-install steps
become `install/peerloom-seeder-install.sh`. The JSON here already matches
the DevScripts format (category 18 matches the backup/sync group,
following `bunkerm`).
