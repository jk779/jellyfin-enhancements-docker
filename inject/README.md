# Jellyfin injected enhancements

`playlist-menu.js` replaces the item playlist dialog with a compact checked popover, exposes the same popover from a player bookmark button, and keeps the exact `Legacy playlist overlay` entry available for the native editor. Requests use Jellyfin's current `Authorization: MediaBrowser ...` header through the logged-in web client's `ApiClient`, including Jellyfin 12.

Playlist membership is read from every accessible playlist page. Additions use the media item ID; removals use every matching `PlaylistItemId`, so duplicate entries are removed together. Each mutation is verified with a fresh playlist read. Permission failures and ambiguous mutations leave the row disabled until the menu is reopened.

`player-navigation.js` adds previous/next controls after a direct play action captures the current visible, non-filtered video cards. It also starts the next captured item when the active video naturally ends, unless Repeat One or a native queue is active. While the visible custom controls are usable, unmodified `P` and `N` keys invoke previous and next; text-entry fields, IME composition, repeats, and modified shortcuts are ignored. It does not wrap and stays hidden when Jellyfin exposes a native queue, shuffle playlist, or no compatible playback manager. The context is session-scoped and expires after 30 minutes. The controls depend on Jellyfin's current webpack playback manager and may need adjustment after a major web-client update.

`touch-thumbnail-play.js` sends a normal touch tap on a video thumbnail to Jellyfin's existing play/resume button. It only handles a short, stationary touch pointer gesture on a video thumbnail; mouse, keyboard, title, folder, and card-control interactions retain their native behavior. The thumbnail details link therefore remains available for desktop users.

These scripts are loaded by the Caddy HTML replacement. Rebuild the Caddy image and reload the Jellyfin web app after changing them.
