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

> **Bring your own audio.** Beetbot never downloads or streams from a third‑party service.
> Every track plays from a file you added yourself.

## Download

### [⬇ Get the latest release →](https://github.com/Beetbot-app/beetbot/releases/latest)

Download the `.zip`, unzip it, and drag **Beetbot** into your **Applications** folder.

> **First launch:** Beetbot isn't notarized yet, so macOS will double‑check with you the
> first time. **Right‑click Beetbot → Open → Open.** After that it's a normal double‑click.
> *(macOS 12+, Apple Silicon.)*

## What it does

- **A library worth looking at** — import the audio you own (`m4a`, `mp3`, `flac`, `wav`,
  `aac`, and more); Beetbot cleans it up, tags it, and dresses it in cover art.
- **Bring your own audio** — a track with no file? Hit **Add audio file**, point it at the
  one you own, and play.
- **Playlists, your way** — build them locally, or import track lists from Spotify, an
  [Exportify](https://exportify.net) CSV, or an Apple Music link, then attach your files.
- **Smart metadata** — album art, genres, and release info filled in automatically
  (optional Spotify / Last.fm for even more).
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

- **Spotify** — import and sync playlist metadata.
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
