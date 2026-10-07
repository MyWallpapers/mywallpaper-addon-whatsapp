# WhatsApp · MyWallpaper

A local WhatsApp widget for MyWallpaper, using Baileys and the existing
`canvas-native-v1` / `process-v2` runtime. The Canvas renders a compact chat UI;
one native companion per layer owns the WhatsApp connection. No extra browser,
hosted backend, or change to the MyWallpaper application is required.

## First version

- Link a phone by QR from **WhatsApp → Linked devices → Link a device**.
- Search recent conversations, including groups, and read/send text messages.
- Small widgets show a list or a conversation; larger widgets show both.
- Reconnect automatically after short interruptions and restore the local session.
- English/French, adjustable glass opacity/blur, optional hidden chat previews.
- Read receipts are off by default and require the device setting to be enabled.
- Disconnect from the options menu. This logs out the linked device and clears
  the widget's local session/history; it does not delete conversations in WhatsApp.

This is an unofficial community client. The first version shows attachment
labels, but attachments and calls remain in WhatsApp. It retains at most 150
chats, 120 messages per chat, and 1,200 messages in total. The first sync is the
recent history supplied by WhatsApp, not a complete account backup. View-once
and disappearing messages are excluded from the durable cache.

## Local preview

Prerequisites: Node 22.22 or later and pnpm 10.33.0.

```sh
pnpm install --frozen-lockfile --ignore-scripts
npm ci --prefix native --ignore-scripts

# Keep these commands running in two terminals:
pnpm preview
npm --prefix native run preview
```

Open <http://localhost:5190/> for real QR pairing. The preview companion binds
only to `127.0.0.1:5191` and accepts connections from the local preview origin.
Its profile is separate from Desktop profiles.

For visual review without an account, open
<http://localhost:5190/?demo=1> or <http://localhost:5190/?demo=1&wide=1>.
These pages are visibly labelled as fictional. Sending there stays in memory
and never contacts WhatsApp. Thumbnail mode also uses this isolated data and
never starts a companion.

## Build and verification

```sh
pnpm build
npm --prefix native run typecheck
npm --prefix native test
node native/build.mjs
```

The web entry exports synchronous `mount(context)` and its stylesheet bootstrap
follows the established MyWallpaper add-on pattern. The native build produces
`native/out/windows-x86_64/bin/whatsapp.exe` and the licences of its dependencies.
It bundles the locked Baileys dependencies and a checksum-pinned Node 22.22.3
runtime as a Windows x64 single executable. It needs no separately installed
Node runtime. Build on Windows x64 or Linux x64; central admission rebuilds the
committed source independently. Generated binaries are not committed.

On Windows, validate the actual executable with:

```sh
node native/test/sea-smoke.mjs
```

This exercises `ready`, snapshot, shutdown, and Windows-protected storage using
an isolated disposable profile, without linking an account or sending a message.

## Local storage and lifecycle

On Windows, profiles live under
`%LOCALAPPDATA%/MyWallpaper/Addons/WhatsApp/<addon-hash>/<layer-hash>/`.
The existing host's stable layer scope determines the profile. Settings never
contain tokens, message history, phone credentials, or encryption keys.
Interface and Wallpaper share their layer's connection through the host.

Authentication and recent history are encrypted with AES-256-GCM. Windows DPAPI
protects the wrapping key for the current Windows user. This is local storage
protection, not an OS sandbox or protection from another process running as that
same user. The standalone Linux development preview uses private directory/file
permissions and an unwrapped local key; it is not the Windows distribution.

Files are written atomically. An active profile is locked to one companion;
shutdown closes the socket and flushes storage without logging out the phone.
Only an explicit logout clears its own stored authentication/history.

## Maintenance and publication

The WhatsApp adapter is `native/src/session.ts`. Protocol and cryptography are
delegated to the pinned upstream Baileys package rather than copied into a fork.
Upgrade the dependency and its lockfile together, then verify QR pairing and
text messaging. WhatsApp protocol compatibility still depends on upstream
maintenance; using the library does not eliminate that dependency.

This repository starts as a local preview. Creating the public repository,
release tag, and DEV catalogue submission requires the owner's approval and
the normal central native admission checks. No publication is implied by a
successful local build. A live account must be paired by its owner to verify
receiving/sending against real conversations.

## Licences

MyWallpaper widget source: MIT. Outfit font: SIL OFL 1.1 (`assets/OFL.txt`).
Baileys and the bundled dependencies retain their own licence notices; the
native build includes Node's complete notices and dependency attributions in
`THIRD-PARTY-NOTICES.txt`. The web third-party notices are in
`assets/THIRD-PARTY-NOTICES.txt`.
