# TizenTube — Old Tizen

[![Downloads](https://img.shields.io/github/downloads/numbereleven-a/TizenTube-old-tizen/total?label=Downloads)](https://github.com/numbereleven-a/TizenTube-old-tizen/releases)

[README на русском](README_RU.md)

This is a fork of [reisxd/TizenTube](https://github.com/reisxd/TizenTube), based on **TizenTube Standalone v2.1.1** and adapted for older Samsung TVs. Its main difference is **YouTube playback with SponsorBlock on Tizen 2.4.0**. Later upstream module changes are also retained.

The app runs entirely on the TV. It loads the YouTube TV interface directly and adds TizenTube modifications through a launcher adapted to the older WebKit engine. No computer, external proxy or local service is needed during viewing.

**Tested devices:**

| TV | Tizen | Firmware | Confirmed operation |
|---|---|---|---|
| Samsung UE50KU6000 (KU6000 series) | 2.4.0 | T-JZL6DEUC-1260.1 | YouTube playback over TLS 1.3 |
| Samsung UE32M5550AU (M5550 series) | 3.0 | T-KTSDEUC family | Application operation and YouTube playback over TLS 1.3 |

| | |
|---|---|
| App name | TizenTube-old-tizen |
| Package version | 2.4.1 |
| Upstream base | [TizenTube Standalone v2.1.1](https://github.com/reisxd/TizenTube/releases/tag/v2.1.1) |
| License | GPL-3.0-only; see [LICENSE](LICENSE) and [third-party notices](legacy/THIRD_PARTY_NOTICES.txt) |
| Release | [Download the installation package](https://github.com/numbereleven-a/TizenTube-old-tizen/releases/latest) |
| Changes | [Changelog](CHANGELOG.md) |

## Install

The release ZIP contains an unsigned WGT. Sign it with a Samsung certificate profile that includes your TV's DUID before installation. Personal certificates and device-specific signatures are not included in the download.

1. Download `TizenTube-old-tizen-v2.4.1.zip` from the [latest release](https://github.com/numbereleven-a/TizenTube-old-tizen/releases/latest) and extract `TizenTube-old-tizen-v2.4.1-resign-required.wgt`.
2. Install Tizen Studio with Samsung TV Extension and Certificate Manager.
3. Enable Developer Mode, connect the TV, and create a Samsung certificate profile for it. See Samsung's [certificate guide](https://developer.samsung.com/smarttv/develop/getting-started/setting-up-sdk/creating-certificates.html) and [TV connection guide](https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/tv-device.html).
4. [Import the WGT as a Tizen project](https://developer.samsung.com/smarttv/develop/getting-started/creating-tv-applications/importing-tv-applications.html), select your certificate profile, and package it again.
5. Install the newly signed WGT on the connected TV and launch **TizenTube-old-tizen** from Apps.

The app opens YouTube with the modifications enabled. It is not distributed through Samsung Apps. Building from source is described below.

### Updating an existing installation

The release retains the application identifiers from the final local test builds. Sign updates with the same author certificate and install over the existing application to retain its account and settings. An expired or revoked authorization can still require signing in again. Uninstalling the application clears its local data.

## SponsorBlock and playback

- **SponsorBlock:** skips known sponsored segments and shows their marks on the progress bar, including while seeking. [SponsorBlock](https://sponsor.ajay.app/) uses community-submitted timestamps for sponsorships embedded in the video; an unreported segment cannot be skipped automatically.
- **YouTube account:** the standard QR authorization flow is retained. Account sign-in, saved sessions and watch history synchronization were confirmed on the tested TV.
- **Playback:** video, audio, pause, seeking, SponsorBlock marks and relaunch were verified on the configuration above.

Upstream ad-blocking and other TizenTube features remain in the source. Full compatibility of every upstream feature is not claimed.

## Controls and diagnostics

The player has a **Go to beginning** button beside Previous video, seeking the current video to 0:00.

### Problematic CDN journal

Enable **Collect problematic GGC domains** in settings to keep up to 50 Googlevideo hostnames with repeated connection failures. Collection is disabled by default and works without a PC or Web Inspector. Open **Problematic CDNs** in settings for a full-screen list with wrapped hostnames, failure details, individual deletion and confirmed clearing. Entries persist across app restarts. A listed domain indicates repeated failures, not a confirmed block.

Under **Player indicators**, the optional problematic-GGC counter is shown with player controls only when greater than zero. Newly listed domains trigger a brief notification while collection is enabled.

### Remote control and logs

| Button | Action |
|---|---|
| Arrows / Enter / Return | Normal YouTube navigation |
| Yellow / 3 | Skip the current manual SponsorBlock segment with the player menu closed |
| Green | TizenTube settings |
| Red or 1 | Show or hide the in-memory log |
| 2 | Reload YouTube with the current mode |
| Blue or 4 | Open diagnostics and stop playback |

Diagnostics offers **Restart TizenTube** and **Try without modifications**. The latter is a comparison mode for the current session; the next app launch enables TizenTube again. Return in diagnostics closes the app.

Logs remain in memory, are hidden by default and are cleared when the app closes. Extended diagnostics are disabled by default and can be enabled in settings; saved preferences are retained. Basic errors and TLS status remain available when extended diagnostics are off. Tokens, cookies and full request URLs are not intentionally recorded; diagnostic strings are redacted. Web Inspector requires a separate debug launch and is not enabled by a normal launch from Apps. See the [build and debugging guide](legacy/README.md).

## Requirements and compatibility

Operation has been confirmed on the KU6000/Tizen 2.4.0 above and on another TV running Tizen 3. The app needs the Samsung Tizen Web Application runtime, working media playback/MSE, supported video and audio decoders, and network access to YouTube, its media hosts and SponsorBlock.

The manifest's Tizen 2.4 minimum is an installation requirement, not proof of compatibility with every Tizen 2.4 or newer TV. The tests above do not cover all models, firmware versions, codecs or video resolutions. YouTube can change its interface and scripts independently of this project.

On the tested setup, QR sign-in sometimes required a second attempt in the YouTube mobile app. That phone-side behavior has not been resolved. A connection failure opens diagnostics so the load can be retried manually.

HTTPS API and MSE video requests use a bundled ARM NaCl module. Green -> Network / TLS offers Auto (default, TLS 1.2-1.3 negotiation), TLS 1.2 only, and TLS 1.3 only. TLS 1.3 playback has been tested on the Tizen 2.4 and Tizen 3 TVs listed above. Modes can be changed in settings; saved selections are retained. Forced modes permit only the selected TLS version. Certificate and hostname verification remain enabled in every mode. The negotiated version is shown separately for API and video. DOM resources use the system stack, whose TLS version is unknown. See the [TLS guide](legacy/README.md).

## Upstream project

The base is [TizenTube Standalone v2.1.1](https://github.com/reisxd/TizenTube/releases/tag/v2.1.1). This fork replaces the service-based launcher for the tested Tizen 2.4.0 runtime, supplies ES5-compatible bundles and adapts playback and SponsorBlock seeking. Upstream copyright and license notices are retained.

## Build

Install Node.js and Tizen Studio with Samsung TV Extension and certificate tools. From the repository root:

```text
npm --prefix mods install
npm --prefix legacy install
npm --prefix legacy test
npm --prefix legacy run build
```

The build checks packaged JavaScript for ES5 compatibility and produces `artifacts/2.4.0/TizenTube-old-tizen-v2.4.1.zip`. Sign the staged widget with your own certificate profile:

```text
tizen package -t wgt -s YOUR_CERTIFICATE_PROFILE -o artifacts/2.4.0/signed -- legacy/dist/widget-2.4.0
```

The `legacy/widget` launcher is the released application. The older `standalone` and service sources are retained from upstream and are not included in this WGT.
