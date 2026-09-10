# Working in this repository

## Scope and conventions

This project adds small frontend enhancements to Jellyfin Web through a Caddy
reverse proxy. Keep changes focused and preserve Jellyfin's existing login,
playback context, and native queues. Write comments and documentation in English.
Use existing tooling; do not install system-wide runtimes or dependencies unless
explicitly requested. Prefer separate injection files for independent features.

## Architecture and deployment

- `Caddyfile` proxies Jellyfin and inserts deferred `/inject/*.js` scripts into
  `/web/` and `/web/index.html`. Register new scripts there.
- `inject/` contains dependency-free browser scripts, generally guarded against
  duplicate initialization and observing Jellyfin's dynamically rendered DOM.
- `Dockerfile.caddy` copies the configuration and scripts into the image and
  includes Caddy's response-replacement module.
- `docker-compose.yml` consumes the published Caddy image
  `ghcr.io/jk779/jellyfin-enhancements-docker:latest`. Source bind mounts are
  commented out. Local edits therefore do **not** change the running website.
- Durable changes require rebuilding/publishing the image and redeploying the
  target service. Verify the actual deployment environment before running those
  operations. `make caddy-reload` only reloads configuration already inside its
  configured container; it does not copy local files or update the image.
- Injected scripts are cached for one hour by Caddy. Account for browser caching
  when validating a deployment. Distinguish local checks, temporary browser
  injection, and deployed behavior in reports.

## Feature map and compatibility contracts

- `playlist-menu.js`: checked playlist popover from item menus and the player.
  Use the logged-in `ApiClient` and its `setRequestHeaders()` for the standard
  `Authorization: MediaBrowser ...` header. On Jellyfin 12.0.0, the old
  `X-Emby-Authorization` request returned 401 while the standard header returned
  200. Never print access tokens. Preserve permission checks, pagination,
  membership verification, and removal by **every matching `PlaylistItemId`**,
  not the media item ID. Keep the `Legacy playlist overlay` fallback row.
- `player-navigation.js`: captures ordered visible video cards for previous/next
  navigation; filtered-out cards are excluded. Its session context expires after
  30 minutes. Natural completion must use the same next target as the button,
  without wrapping. Repeat One and native queues take precedence.
  The `ended` listener uses capture because Jellyfin's native handler can tear
  down the video before a bubble listener runs. Suppress the native event only
  for a valid custom transition with an available playback API. Preserve guards
  against errors and duplicate/in-flight transitions. Webpack playback-manager
  discovery and native-editor chunk IDs are version-sensitive integration points.
- `video-card-titles.js`: independent injection for two-line video titles and
  hidden secondary/year text. Confirmed Jellyfin 12 DOM: video cards use
  `.card[data-type="Video"]`, titles `.cardText-first`, and the year is another
  `.cardText` block; `.cardText-secondary` is not reliably present. Preserve the
  title block, consistent card height, and non-video cards. Do not edit server
  metadata to hide the year.
- `orientation-filter.js`: horizontal/vertical filtering for library and search
  cards. Coordinate with the orientation badges in `previews-badges.js` and
  preserve the `.tm-orientation-hidden` contract used by navigation.
- Other scripts cover previews/badges, native title context menus, search layout,
  search limits/input length, and logging. Inspect the relevant script rather
  than rediscovering the entire project. See `inject/README.md` for more detail.

## Proportionate verification

Run `node --check inject/<changed-script>.js` and `git diff --check` for script
changes. For browser-sensitive behavior, perform one focused smoke test using
the actual changed code. Reloading the live site alone does not load local edits.
Temporary browser injection is useful before deployment; disclose changes left
in the tab. Coordinate browser ownership when multiple agents are involved.

For playback changes, cover the specific affected transitions: natural end,
Repeat One, last item, and native queue precedence. Do not claim a syntax check
proves runtime playback behavior. Avoid repeated broad browser tests after a
representative test passes, especially if the user plans to test personally.

## Last verified baseline (2026-09-10)

Jellyfin 12.0.0 was inspected in Chrome. Temporary tests confirmed playlist
loading with the new auth header, automatic next playback, Repeat One, stopping
at the last item, and native queue precedence. The title layout was checked on
64 video cards: two title lines, secondary rows hidden, and aligned cards.

Feature commits: `73a0a71` (playlist auth and auto-next) and `4260384` (separate
title injection). These changes had **not been redeployed** at the end of that
implementation session. Treat this as historical evidence, not current deployment
status; check the live environment when relevant.
