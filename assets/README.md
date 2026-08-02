# Plugin assets

This directory holds the static assets the plugin needs at install time. The current build of `kimi-memory` ships:

- `icon.svg` — a three-node knowledge-graph display icon. Used as the plugin's display icon in the Installed tab; safe to drop a custom replacement here as long as the file is still a valid SVG.

The directory is kept under version control (even if the only contents are the icon) so the manifest and test suite can rely on a stable relative path. See `kimi.plugin.json` for the active tool/hook surface.
