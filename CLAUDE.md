# Shiur Controller — notes for Claude

Moshe's own app for his nightly Daf Yomi shiur (in English, at Chevras Shas, 8:05–9:00pm). About 8 people sit in the
room facing him; 5–8 more join on Zoom (open link, mostly muted, cameras off). He sits at a small table with his back
to the wall. A TV on the wall behind him shows material to the room; Zoom sees the same material with him beside it.
Rule from Moshe: **nothing fancy, nothing complicated** — big buttons, simple words.

## How Moshe likes to work

- Short, simple, non-technical instructions, **one step at a time**. Wait for him to say "done" before the next step.
- He prefers step-by-step or video over reading material.
- Only change what was agreed. Ask before changing anything else (settings, accounts, design).
- Don't factor Claude usage costs into advice; recommend best practice.
- Hebrew material must run **right to left** (calendars, days, month rows, timelines).
- He works in the Claude desktop app, which drives his Chrome (GitHub, Render) through the Claude extension.

## What it does

Three modes, chosen in the Shiur app:

| Mode   | Zoom sees                                   | Wall TV sees            | Shiur app on the laptop       |
|--------|---------------------------------------------|-------------------------|-------------------------------|
| ME     | Moshe's camera, full                         | Title card (list title) | Big: fills the screen         |
| SHOW   | The list item, large, with Moshe beside it   | The list item, full     | Big                           |
| SCREEN | The laptop screen (above the strip), with Moshe beside it | The laptop screen | Small: a strip along the bottom |

- **Tonight's list**: pictures, videos, Claude charts (.html), PDFs, web links. Pictures/videos are SHOWn through
  OBS. Charts, PDFs and web pages **open live** in the browser on the laptop and switch to SCREEN, so he can click
  through them step by step.
- **Find something**: buttons for MDY, Claude, Google Images, Sefaria (editable) and "My downloads" (newest files in
  Downloads). They open on the laptop with the app as the strip; nobody sees it until he presses SCREEN.
- **Zoom tiles** are shown live inside the app (big in the big app, small at the end of the strip) using a DWM
  thumbnail. The real Zoom window is parked out of sight: behind the full-screen wall picture on the TV, or off
  screen. Tap the tiles to bring Zoom up big (switches away from SCREEN first); tap again to tuck it back.
- If Moshe opens or clicks another window while the big app shows, the app becomes the strip automatically.
- One tap on the **Shiur** desktop icon starts everything: engine hidden, OBS in the tray, wall projector on the TV,
  Zoom meeting (from the saved link), the app. **End shiur** (tap twice) stops recording, closes OBS cleanly, closes
  the app and brings Zoom forward so he can end the meeting.

## Files

- `server.js` — the engine (Node 22+, no dependencies). HTTP + Server-Sent Events on port 8080. Talks to OBS via
  obs-websocket v5 (built-in WebSocket). Data in `data/` (config.json, list.json, media/) — never committed.
  - `--launch` (from Shiur.exe): starts OBS hidden, opens the Zoom meeting once. `--no-zoom`: restart without Zoom.
  - Test env vars: `SHIUR_DATA_DIR`, `SHIUR_DOWNLOADS`, `SHIUR_NO_BROWSER`, `SHIUR_NO_OPEN`.
- `public/bar.html` — the Shiur app's controls (big layout, and strip layout when the window is under 170px tall).
- `public/setup.html` — one-time setup (OBS password, scenes, camera, laptop screen, wall screen, Zoom link).
- `public/start.html` — edit the "Find something" buttons. `public/controller.html` — optional iPad/phone remote.
- `app/Shiur.cs` — the Windows app (C# 5 / .NET Framework 4.x, compiled with the csc.exe that ships with Windows).
  Reserves the bottom strip as an AppBar, hosts the controls in WebView2 (falls back to a Chrome/Edge `--app`
  window), shows the Zoom tiles, parks Zoom, reports the free screen area to the engine (`POST /api/bar`) so OBS
  crops the screen capture to it, polls `GET /api/ping` (panel size, mode, window jobs, ended), restarts the engine
  if it stops, and **updates itself** from GitHub releases (see below). Logs to `data/panel-log.txt`.
- `app/*.ps1` — installer helpers (WebView2 download, shortcuts, carrying settings over, backup start).
- `Install Shiur.bat` — installs to `%LOCALAPPDATA%\Shiur`, keeps `data/`, makes the desktop/Start icons.
- `test/` — `mock-obs.js` (pretend OBS, password `secret123`) and `run-tests.js`.

## Testing

```
npm ci
npm test
```

Runs the engine against the pretend OBS: scenes, modes, app size, crop, list, live charts, Zoom link, ending.
The Windows-only parts (AppBar, WebView2, Zoom thumbnail, window moving) can only be tried on Moshe's laptop —
`data/panel-log.txt` and `data/engine-log.txt` in `%LOCALAPPDATA%\Shiur` show what happened.

C# must stay **C# 5** (no `$""`, `?.`, `=>` members, `nameof`). Check with mono if available:
`mcs -langversion:5 -target:winexe -r:System.Windows.Forms.dll -r:System.Drawing.dll -r:System.IO.Compression.dll -r:System.IO.Compression.FileSystem.dll app/Shiur.cs`

## Releasing and updating

- Every push to `main` runs `.github/workflows/release.yml` on Windows: tests, downloads WebView2, builds
  `Shiur.exe` with csc, zips everything as `shiur-app.zip` with `version.txt` (`v1.<run number>`), and publishes a
  GitHub release.
- `app/update.json` names the repository (`"repo": "owner/shiur-controller"`). The repository must be **public**
  (the app downloads releases without a token; nothing secret is in the code — passwords and the Zoom link live in
  `data/` on the laptop only).
- Each time the Shiur app starts and no shiur is running, it checks the latest release. If the tag differs from
  `version.txt`, it shows "Updating Shiur...", downloads the zip, swaps the files (keeping `data/`) and restarts.
  Never mid-shiur.
- First install on a laptop: download `shiur-app.zip` from the latest release, extract, run `Install Shiur.bat`.

## Known facts and gotchas

- OBS 32+ removed `--disable-shutdown-check`. The engine clears `%APPDATA%\obs-studio\.sentinel` before starting OBS,
  and the app closes OBS with WM_CLOSE after stopping the virtual camera, so the "Safe Mode" question doesn't appear.
- Zoom must use **OBS Virtual Camera** as its camera (Zoom settings → Video). Turn off "Always show video preview
  dialog when joining"; turn on "Automatically join audio by computer". Zoom mirrors self-view only.
- Zoom meeting window class: `ZPContentViewWndClass`; home window: `ZPPTMainFrmWndClassEx`. Other Zoom windows
  (questions/dialogs) are brought onto the laptop screen when not in SCREEN mode.
- A zip downloaded in a browser marks its files "from the internet" (Windows warns before running them). `Install Shiur.bat`
  clears the mark on the installed files with `Unblock-File`. The updater downloads with WebClient, which adds no mark.
- The laptop camera is soft; a 1080p USB webcam on a small stand is planned. The engine sets the camera to its best
  resolution and OBS output to at least 1280x720.

## Status and next steps

- Home test in progress on Moshe's Lenovo laptop (Windows 11), with his extra screens standing in for the wall TV.
- After the home test: a shopping list with prices (Windows tablet with Intel/AMD chip, not Snapdragon — OBS's
  virtual camera is still experimental on Arm; 50–55" TV on a bracket; wireless HDMI kit; 1080p USB webcam; wireless
  clip-on mic with USB receiver).
- Later: recording (switch in Setup), the MDY button's web address (Moshe to supply), a fixed design for Claude-made
  shiur cards.
