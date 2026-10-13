# PeerLoom Seeder

PeerLoom Seeder keeps a copy of your PeerLoom apps' shared data, so a phone
that wakes up catches up even when nobody else is online. It stores that
data scrambled and cannot read it.

## Pair a device

1. Run the **Show password** action and copy the password.
2. Open the **Dashboard** interface and enter the password.
3. Choose **Pair a device**. A QR code and a link appear for 5 minutes.
4. In your PeerLoom app, open its seeder settings and scan the code, or
   paste the link.

The dashboard lists each paired device under its app, with what it stores.
You can rename a device, forget one, and set how much each device may store
(25 GB to start). Forgetting a device deletes, after 7 days, what no other
paired device backs up.

Phones on the same network as this server connect through the PeerLoom
relay, which passes only scrambled data along.
