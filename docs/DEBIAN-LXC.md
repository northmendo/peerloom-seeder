# PeerLoom Seeder in a Debian 12 LXC

A runbook for running the seeder headless in a Debian 12 (bookworm) LXC —
a Proxmox VE container, an LXD/Incus container, or plain Debian — with the
dashboard reachable from the rest of the LAN. For the one-command Proxmox
route that builds all of this for you, see `packaging/proxmox/`.

The seeder is two processes: the dashboard host (Node, `host/server.js`)
and the seeder itself (a Bare process it spawns from `dist/`). Everything
stores encrypted data only; the seeder never receives a key that could
decrypt it.

## What you need

- A Debian 12 container (or Debian 12+ machine): 1 CPU, 1 GB RAM, 8 GB disk
  plus room for the data it will hold.
- `root` in the container (or sudo).
- Outbound HTTPS for the install (GitHub, npm, NodeSource).
- If you want peers to reach the seeder from outside the LAN, forward the
  UDP port the swarm picks (it prints none — the DHT announces a random
  port; NAT-just-client mode still works for paired devices on the LAN).

## Security model, before the bind

The dashboard can revoke any device, open a pairing window and set storage
limits, so a bind to `0.0.0.0` (every interface) is only safe behind its
password. That is enforced, not assumed:

- A **loopback** bind (`127.0.0.1`, `localhost`, `::1`) keeps today's
  behaviour: no password needed.
- **Any other bind** — `0.0.0.0`, a LAN address — *requires* a password.
  `SEEDER_PASSWORD` if you set one; otherwise one is generated on first
  start, saved mode 0600 in the data folder as `dashboard-password`, and
  printed once in the journal. The host refuses to start a password-less
  non-loopback dashboard at all (`requireSafeBind` in the vendored
  dashboard-auth). There is no path from "bound to 0.0.0.0" to "open
  dashboard": the test suite pins it
  (`test/host.test.js`: "a 0.0.0.0 bind mints and enforces a password").

The P2P swarm is separate from the dashboard: it listens on every interface
on a random UDP port (that is how Holepunch's DHT works) and speaks only
the blind-peer protocol, which stores nothing a paired device has not
registered.

## 1. Install Node

`package.json` asks for `"engines": { "node": ">=20" }` (the host uses
`fetch`, `fs.statfs` and `node --test`). Debian 12's own `nodejs` (18) is
end-of-life; use NodeSource's Node 22 LTS:

```sh
apt-get update
apt-get install -y ca-certificates curl gnupg git
mkdir -p /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
  | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
  > /etc/apt/sources.list.d/nodesource.list
apt-get update && apt-get install -y nodejs
node --version   # v22.x
```

## 2. Get the code and build

```sh
git clone https://github.com/northmendo/peerloom-seeder /opt/peerloom-seeder
cd /opt/peerloom-seeder
npm install --no-audit --no-fund
npm run build     # bundles the seeder for Bare into dist/linux-<arch>/
```

`npm run build` must come before the first start: the host spawns
`dist/linux-<arch>/bare` with `dist/linux-<arch>/seeder.bundle`.

## 3. Configure the bind

Two ways, both documented in `host/server.js`. An **environment variable
always beats** the config file, and the file beats the built-in defaults —
so the service's env file below wins.

The env file (copy the example and edit):

```sh
install -m 600 packaging/debian/peerloom-seeder.env /etc/peerloom-seeder.env
```

The defaults it carries, for an LXC:

| Setting      | Default | Meaning                                        |
| ------------ | ------- | ---------------------------------------------- |
| `SEEDER_DATA` | `/var/lib/peerloom-seeder` | where the state and the dashboard password live |
| `SEEDER_HOST` | `0.0.0.0` | listen on every interface — password required |
| `SEEDER_PORT` | `8761`  | dashboard port                                 |

To keep the dashboard on the box only, set `SEEDER_HOST=127.0.0.1` (then
the password is no longer needed).

Or a JSON config file, `SEEDER_CONFIG=/etc/peerloom-seeder.json`:

```json
{
  "host": "0.0.0.0",
  "port": 8761,
  "data": "/var/lib/peerloom-seeder"
}
```

Keys are `data`, `host`, `port`, `password`, `bootstrap` — the same
meanings as the env vars of those names. A missing or malformed file is an
error at start, never a silent fall-back to defaults.

## 4. Install the service

The unit (`packaging/debian/peerloom-seeder.service`) runs under a
`DynamicUser` — a fresh system user every start, no account to manage —
with `StateDirectory=peerloom-seeder` handing it `/var/lib/peerloom-seeder`
(kept across restarts), and sandboxing that keeps the rest of the system
read-only: `ProtectSystem=strict`, `PrivateTmp`, `PrivateDevices`,
`NoNewPrivileges`, empty capability set. `MemoryDenyWriteExecute` and
`SystemCallFilter` are deliberately not set — V8 and the Bare runtime need
their usual JIT and thread calls.

```sh
cp packaging/debian/peerloom-seeder.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now peerloom-seeder
```

## 5. First login

A password was minted on first start:

```sh
cat /var/lib/peerloom-seeder/dashboard-password
# or, it is also printed once in the journal:
journalctl -u peerloom-seeder | grep 'dashboard password'
```

Open `http://<container-ip>:8761/` from any machine on the LAN and log in
with it. (The page itself always loads and shows the login form; every API
call without a session answers 401.)

Quick health check, on the container:

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8761/api/status
# 401  <- expected: the dashboard answers and is auth-gated, not open
systemctl status peerloom-seeder
```

## 6. Where the data lives

Everything under `SEEDER_DATA` (`/var/lib/peerloom-seeder`):

- `blind-peer/` — the rocksdb store of encrypted blocks
- `seeder-state/` — the records: paired devices, spaces, limits, drops
- `dashboard-password` — the generated dashboard password (0600)

To move or back up a seeder, stop the service and copy the whole folder.
State keys keep PearOffice's layout, so an old PearOffice seeder folder
opens as is.

## 7. Updating

```sh
systemctl stop peerloom-seeder
cd /opt/peerloom-seeder
git fetch origin
git reset --hard origin/main        # or: git checkout v<newest tag>
npm install --no-audit --no-fund
npm run build
systemctl start peerloom-seeder
journalctl -u peerloom-seeder -n 20
```

The data folder is untouched; only the checkout in `/opt/peerloom-seeder`
changes. A release tarball works too (`scripts/dist-linux.js` builds one;
it unpacks with `host/`, `seeder/` and the `bare` runtime together and
needs no build step — the same unit runs it if you point
`SEEDER_BARE`/`SEEDER_BUNDLE` in the env file at the unpacked paths).

## 8. Notes for Proxmox specifically

- A **veth** container on a bridge (`vmbr0`) behaves like a normal LAN
  host: holepunching works, peers can dial in on the swarm's UDP port.
- Host networking with NAT (`lxc.net.0.type = host`) or a NAT profile can
  break inbound DHT announce (the Umbrel image hit the same thing);
  paired devices on the LAN still reach the seeder.
- Pair a device from the dashboard's QR/link; the seeder key does not
  change across restarts, so devices stay paired through updates.

## What this runbook does not cover

- The systemd unit and this page were verified with `systemd-analyze
  verify`, the full test suite and a live `0.0.0.0` launch on a
  development box — not on a fresh Proxmox container. The Proxmox script
  (`packaging/proxmox/peerloom-seeder.sh`) automates exactly these steps;
  it has been syntax- and shellcheck-checked but not run against a real
  Proxmox VE host (none was available while writing it).
