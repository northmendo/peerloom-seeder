# PeerLoom Seeder

Keeps your PeerLoom apps in sync while your phones sleep. Run it on a
computer that stays on, pair your phones with it once, and it keeps a copy
of their shared lists, files and spaces, so a phone that wakes up catches up
even when nobody else is online. It stores that data scrambled and cannot
read it.

For 64-bit Linux on x64 or arm64. Everything it needs comes in the
download; `update` also uses `curl`.

## Install

    tar xzf peerloom-seeder-*-linux-*.tar.gz
    mv peerloom-seeder-*-linux-* ~/peerloom-seeder
    ~/peerloom-seeder/peerloom-seeder install-service

That runs it in the background from now on, also after a reboot. To try it
first without installing anything, run `~/peerloom-seeder/peerloom-seeder`
and stop it with Ctrl+C.

## Pair a phone

Open http://127.0.0.1:8761 on this computer and choose **Pair a device**. In
your PeerLoom app, open its seeder settings (in PearList: Settings, Connection,
Seeder backup) and scan the code or paste the link. The code works for 5
minutes.

The dashboard lists each paired device with its app and how much it stores.
You can rename a device, forget one, and set how much each device may store
(25 GB to start).

To open the dashboard from another computer, set `SEEDER_HOST=0.0.0.0` in
the service (`systemctl --user edit peerloom-seeder`, then add
`Environment=SEEDER_HOST=0.0.0.0` under `[Service]`). It then asks for a
password, which is printed in the log once
(`journalctl --user -u peerloom-seeder`) and kept in the data folder.

## Data

In `~/.local/share/peerloom-seeder` unless `SEEDER_DATA` says otherwise.
If you ran the PearOffice seeder before, point `SEEDER_DATA` at its folder
(`~/.pearoffice-seeder`): PeerLoom Seeder opens it as it is, with the same
paired devices and files.

## Updates

A minute after it starts, and then once a day, it checks for a newer
release and prints a line when there is one. To install it:

    ~/peerloom-seeder/peerloom-seeder update

That downloads the release for this machine, checks it against its
published checksum, replaces the program and restarts the service if it is
running. Your data is not touched. Set `SEEDER_NO_UPDATE_CHECK=1` to turn the
check off.

## Remove it

    ~/peerloom-seeder/peerloom-seeder remove-service
    rm -rf ~/peerloom-seeder

Add `~/.local/share/peerloom-seeder` to remove its data too.

## What it stores

Only spaces that a device paired with this seeder has registered, plus the
other members' copies of those spaces. Anything else is refused. It never
gets the keys to read any of it. A new phone or member still needs someone
already in the space to be online once to let them in.

## Licence

MIT, see `LICENSE.txt`. `THIRD-PARTY-NOTICES.txt` and `licenses/` cover the
libraries in the download.
