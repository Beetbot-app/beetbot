<p align="center">
  <img src="assets/beetbot-logo.svg" alt="Beetbot" width="96" height="102">
</p>

<h1 align="center">Beetbot</h1>

<p align="center"><strong>Your music. Your files. Playing anywhere in the house.</strong></p>

<p align="center">
  A bold, local-first music player and personal media server for macOS. Bring your own
  audio — Beetbot turns it into a gorgeous library and streams it to every screen you own.
</p>

---

No subscriptions. No third-party streaming. Just the music you actually own — organized
beautifully, playing instantly on your Mac, and streaming to any phone, tablet, or TV on
your Wi‑Fi. Cast it to AirPlay or Chromecast. Reach it from the road when you want to.

> **Bring your own audio.** Full tracks always play from a file you added yourself — Beetbot
> never streams them from a third‑party service. (Optional 30‑second preview clips are the
> only audio that comes from outside.)

## Download

### [⬇ Get the latest release →](https://github.com/Beetbot-app/beetbot/releases/latest)

Download `Beetbot-macos-<version>.zip`, unzip it, and drag **Beetbot** into your
**Applications** folder — then open it once using the steps below.

## Opening Beetbot the first time (macOS)

The first time you open Beetbot, macOS asks you to confirm it — a quick, one-time step.
After that, Beetbot opens with a normal double-click.

**macOS 15 (Sequoia) or newer**

1. Double-click **Beetbot**. macOS shows a prompt that it can't be opened yet — click **Done**.
2. Open **System Settings → Privacy & Security**.
3. Scroll down to **Security** and click **Open Anyway** next to Beetbot.
4. Confirm with Touch ID or your password, then click **Open**.

**macOS 12–14 (Monterey / Ventura / Sonoma)**

- **Control-click (right-click) Beetbot → Open**, then click **Open** in the dialog.

**Prefer Terminal?** One command does the same thing — then just double-click Beetbot:

```sh
xattr -dr com.apple.quarantine /Applications/Beetbot.app
```

*Requires macOS 12+ on Apple Silicon.*


## What it does

- **A library worth looking at** — import the audio you own (`m4a`, `mp3`, `flac`, `wav`,
  `aac`, and more); Beetbot cleans it up, tags it, and dresses it in cover art.
- **Bring your own audio** — a track with no file? Hit **Add audio file**, point it at the
  one you own, and play.
- **Playlists, your way** — build them locally, or import track lists from Spotify (via
  [Exportify](https://exportify.net)), Apple Music, or SoundCloud, then attach your files.
- **Smart metadata** — album art, genres, and release info filled in automatically, no
  account needed.
- **Play it anywhere at home** — a built‑in web player streams your library to any phone or
  tablet on your Wi‑Fi; pairing codes keep it yours.
- **Cast it** — send playback to Chromecast and AirPlay.
- **Profiles** — Netflix‑style local profiles, each with its own playlists over one shared
  library.
- **Browse & radio** — genre‑accurate charts and tag‑based radio for what to play next.
- **Remote access (optional, off by default)** — reach your library from outside the house
  over automatic HTTPS.

## Optional accounts

Everything below stays **off until you add your own credentials**, which never leave your Mac:

- **Last.fm** — power browse charts and tag‑based radio.

## Build it yourself

Beetbot is open source. To run the open build from this repository:

```sh
# prerequisites: Node 20+, pnpm, Rust (stable), and Tauri's macOS build deps
pnpm install
pnpm tauri:dev      # run it
pnpm tauri:build    # build a .app
```

## License

[MIT](LICENSE) © Beetbot
