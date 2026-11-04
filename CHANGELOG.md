# Changelog

## v2.5.0

### Playback and memory

- Released binary-response buffers and reported XHR errors when final response assembly fails.
- Cleared stale buffering feedback when buffered playback continues or recovers.

### Startup

- Kept the startup watchdog active until the YouTube application initializes, with a restart screen if initialization times out.

## v2.4.1

### Performance

- Accelerated byte-array constructor copies on legacy WebKit while preserving compatibility for other input types.
- Used native parsing for absolute HTTP(S) request URLs to reduce synchronous work in media and statistics handlers.
- Removed redundant playback-request JSON serialization while preserving custom serialization behavior.

### Network and memory

- Filled binary responses with a known content length incrementally to reduce temporary buffering.
- Released response buffers and cleared response metadata when aborting a completed XHR.
- Fixed query-only and fragment-only redirect resolution.

### Playback and queue

- Reattached quality and queue handlers after player replacement and applied saved speed to each current video without permanent polling.
- Fixed queued-video IDs and selected-card tracking for both supported card formats.
- Cancelled stale automatic queue transitions and prevented duplicate transitions after repeated end events.

### SponsorBlock

- Applied enable/disable and category changes immediately, cancelling obsolete pending skips.
- Validated response and segment data before marking SponsorBlock as available, while retaining valid highlight markers.

### Settings and subtitles

- Validated saved settings and recovered invalid values without sharing mutable defaults.
- Kept settings effective for the current session and showed a notification when TV storage could not save them.
- Applied each custom setting in a batch once while preserving native YouTube setting commands.
- Preferred the selected interface language for subtitles and added a fallback for engines without Intl.Locale.

## v2.4.0

- Improved media-response performance on legacy WebKit by restoring native byte-array copying.
- Bounded DeArrow background work, added queue-inclusive timeouts and cancelled pending requests when navigating away.
- Reduced transport queue processing overhead while preserving existing connection limits.
- Fixed SponsorBlock cleanup when leaving playback and reattachment after video-element replacement, while preserving PiP playback.
- Prevented repeated SponsorBlock seeks when the player lands before the requested segment boundary.
- Reduced unnecessary player layout work, constructor searches, skip-timer updates and storyboard observation.

## v2.3.26

- Added a Go to beginning button beside Previous video, seeking the current video to 0:00.
- Aligned binary XHR response buffers with the requesting frame for compatibility with legacy WebKit.
- Added an optional persistent journal of up to 50 problematic Googlevideo domains. Collection is disabled by default and works without a PC or Web Inspector.
- Added a full-screen CDN list with wrapped hostnames, failure details, individual deletion and confirmed clearing.
- Added an optional player counter shown only when the problematic-domain count is greater than zero, plus notifications for newly listed domains.

## v2.3.21

- Disabled extended diagnostics by default while retaining saved user preferences and the live settings toggle.
- Fixed automatic SponsorBlock skipping when segment data arrives late or playback resumes inside a segment.
- Replaced response-order-dependent manual SponsorBlock actions with an independent skip prompt (Yellow / 3 while the player menu is closed).
- Fixed the watched-video filter ignoring its disabled setting and failing to filter lockupViewModel cards.
- Restored Auto, TLS 1.2 only, and TLS 1.3 only modes, with TLS 1.2 as the default.

## v2.3.20 (beta)

- Added correlated XHR completion timings for response assembly and slow synchronous event handlers to investigate playback hitches after media downloads.

## v2.3.19 (beta)

- Added a saved Extended diagnostics toggle, currently enabled by default, with live disabling of detailed network and playback measurements.
- Added correlated network request IDs, track and endpoint labels, native connection-stage timings and completion/cancellation diagnostics.
- Added active-request snapshots during buffering and media pause, seek and rate-change events to diagnostics.

## v2.3.18 (beta)

- Fixed delayed SponsorBlock unavailability reporting by limiting segment requests to 10 seconds instead of the shared 120-second network timeout.
- Canceled unfinished SponsorBlock segment requests when switching videos.

## v2.3.17 (beta)

- Set TLS 1.2 as the default connection mode.
- Fixed the custom playback-speed menu for YouTube's new speed icon while retaining support for the previous icon.
- Reduced network response copying and improved incremental UTF-8 text decoding.
- Improved XHR loading and progress event handling.
- Fixed preferred-quality fallback to the nearest available lower resolution and restored adaptive quality when selecting Auto.
- Reduced duplicate DeArrow requests with caching, lower request priority and cancellation on navigation.
- Fixed the default preferred-codec setting.

## v2.3.16 (beta)

- Fixed premature SponsorBlock skips during buffering and adjusted skip scheduling for playback speed changes.
- Prevented pending telemetry requests from blocking playback and watch-history requests.
- Fixed DeArrow title and thumbnail updates for both supported video card formats.

## v2.3.9

- Added the actual googlevideo TLS protocol in the upper-right corner of the player controls, with an option to hide it.
- Added SponsorBlock availability display modes: hidden, only when unavailable (default), or always.
- Set player indicator defaults to show the TLS protocol and display SponsorBlock status only when unavailable; Auto remains the default TLS mode.

## v2.3.8 — 2026-10-11

- Added TLS 1.3 support for YouTube API requests and video playback on older Tizen TVs.
- Added Auto, TLS 1.2 only, and TLS 1.3 only connection modes.
- Added separate negotiated TLS version indicators for API and video connections.
- Added gzip response decoding and a limited retry for connection resets during the TLS handshake.

## v2.2.0 — 2026-10-10

First release of the Old Tizen fork, based on TizenTube Standalone v2.1.1 with later upstream module changes retained.

- Added standalone YouTube playback with SponsorBlock for the tested Tizen 2.4.0 TV, without a viewing-time computer, proxy or local service.
- Adapted JavaScript and browser APIs to the legacy WebKit runtime; packaged scripts are checked for ES5 compatibility.
- Adapted SponsorBlock seeking to the YouTube player API and retained segment marks during seeking.
- Packaged the release without personal certificates or device-specific signatures; installation requires signing for the target TV.

Tested device: Samsung UE50KU6000 (KU6000 series), Tizen 2.4.0, firmware T-JZL6DEUC-1260.1. No other TV model has been confirmed.
