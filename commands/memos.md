---
name: memos
description: Open the kimi-memos-dashboard in the default browser. The dashboard is a read-only web view of every kimi-memory SQLite database.
---

# /kimi-memory:memos

Open the local kimi-memos-dashboard in the user's default browser. The dashboard
runs as a standalone companion app under `~/.kimi-code/plugins/managed/kimi-memos-dashboard/`
and is intentionally NOT a Kimi plugin (per its own AGENTS.md) — this slash
command is a thin integration, not a control surface.

Steps:

1. Probe whether `http://127.0.0.1:8765/` is responding (HEAD request via Bash
   - curl with a 2-second timeout, or `Test-NetConnection 127.0.0.1 -Port 8765`
     on PowerShell).
2. If **not responding**, tell the user:
   `kimi-memos-dashboard is not running. Start it with:`
   `cd ~/.kimi-code/plugins/managed/kimi-memos-dashboard && npm start`
   and then re-run `/memos`. Do not start it for them — the dashboard binds a
   port and the user should opt in.
3. If **responding**, open the dashboard URL in the default browser:
   - Windows (Git Bash / cmd): `start "" "http://127.0.0.1:8765/"`
   - Windows (PowerShell): `Start-Process "http://127.0.0.1:8765/"`
   - macOS: `open "http://127.0.0.1:8765/"`
   - Linux: `xdg-open "http://127.0.0.1:8765/"`
4. Report the URL back to the user.

Notes:

- The dashboard reads the same SQLite files that this plugin writes to, with
  `PRAGMA query_only=ON` enforced, so opening it cannot mutate memory data.
- The dashboard binds `127.0.0.1` by default; LAN exposure is not provided here.
- Optional bearer-token auth is respected by the dashboard itself; this command
  does not bypass it.
- The default port (`127.0.0.1:8765`) and token scheme are owned by
  `kimi-memos-dashboard`, not by this plugin. If the dashboard re-binds or
  changes its auth, the probe in step 1 will return a connection error and
  the user must adjust the URL or restart the dashboard before re-running
  `/kimi-memory:memos`.
