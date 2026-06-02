<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/CreatorAris/CreatorAris/dist/github-snake-dark.svg" />
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/CreatorAris/CreatorAris/dist/github-snake.svg" />
  <img alt="github contribution snake animation" src="https://raw.githubusercontent.com/CreatorAris/CreatorAris/dist/github-snake.svg" />
</picture>

# Nephele Aura

Mobile companion for [Nephele Workshop](https://nephele.arisfusion.com) — an Expo / React Native app that connects to a running desktop session, so the artist can browse their reference library from a phone without breaking flow on the desktop.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Expo](https://img.shields.io/badge/Expo-SDK%2054-000020.svg)](https://expo.dev)
[![React Native](https://img.shields.io/badge/React%20Native-0.81-61DAFB.svg)](https://reactnative.dev)
[![Status](https://img.shields.io/badge/status-alpha-orange.svg)](#status)
[![GitHub stars](https://img.shields.io/github/stars/CreatorAris/nephele-aura.svg)](https://github.com/CreatorAris/nephele-aura/stargazers)
[![GitHub last commit](https://img.shields.io/github/last-commit/CreatorAris/nephele-aura.svg)](https://github.com/CreatorAris/nephele-aura/commits)

[中文文档](README_ZH.md) · [Nephele Workshop](https://nephele.arisfusion.com)

</div>

## What this is

Nephele Aura is the mobile half of the Nephele Workshop ecosystem. It connects to a running desktop session (PySide6 client) over a WebSocket relay hosted on Cloudflare Durable Objects, so the artist can keep drawing on the desktop while triaging the reference library from the phone.

The desktop client tree is closed source; for the auditable subset see [nephele-core-audit](https://github.com/CreatorAris/nephele-core-audit).

## Status

Alpha. Mobile builds are not on App Store / Play Store yet. Aura currently focuses on library browsing — agent chat, pipelines, and other desktop-tool surfaces have been deferred until the browsing experience is solid.

## Architecture

```
Mobile (Expo + React Native + Tamagui)
    <-- WebSocket -->
Cloudflare Durable Object (RemoteRelay, hibernation-safe)
    <-- WebSocket -->
Desktop (PySide6 + Python, core/remote_bridge.py)
    <--> Library (Eagle .library format), file server
```

Image transfer:

- **LAN** — direct HTTP from the desktop's `core/file_server.py`, Tailscale-aware (auto-detects `100.x` addresses)
- **WAN** — thumbnails inline (Pillow 200px JPEG q70 over WebSocket relay), full images via Cloudflare R2 CDN URLs

Auth: email OTP. Mobile clients declare `X-Client-Type: nephele-mobile-v1` to bypass CAPTCHA — this is a public client identifier, not a secret. Defense relies on server-side rate limiting (per-IP RPM/RPH/RPD, per-email cooldown and daily cap).

## Screens

| Screen | Contents |
|:---|:---|
| Gallery | Library folder tree + tag/rating filters + masonry waterfall + pinch-to-zoom lightbox; multi-select batch ops, phone-gallery import |
| Profile | Email OTP login, logout |

## Repository layout

| Path | Contents |
|:---|:---|
| `app/` | expo-router file-based routes (tabs, auth) |
| `components/` | Shared UI primitives (Tamagui-based) |
| `utils/` | Auth, WebSocket client, theme tokens |
| `assets/` | App icons, splash |

## Develop

```bash
npm install
npx expo start
```

You need a running Nephele Workshop desktop client (logged in to the same account) for the bridge to deliver real data.

## Reporting issues

Bugs in the mobile client — file an issue here. PRs welcome; this repository is the source of truth for the published mobile binary.

Feature requests for the broader Nephele Workshop product (the desktop client itself) — the client tree is closed source, so file them via the contact address on the [website](https://nephele.arisfusion.com), not here.

## License

MIT, see [LICENSE](LICENSE). Free to fork, audit, or repackage.

## Related repositories

- [nephele-wisp](https://github.com/CreatorAris/nephele-wisp) — browser extension companion (Chrome / Edge MV3 + Native Messaging Host)
- [nephele-core-audit](https://github.com/CreatorAris/nephele-core-audit) — auditable subset of the Nephele Workshop client (rights / packer / validator)
- [nephele-verify](https://github.com/CreatorAris/nephele-verify) — independent verification page for `.nep` evidence files
