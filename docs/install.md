# Installing

There are four ways to get DeltaDeck. The desktop app (macOS, Linux) runs in
its own window and needs nothing else. The browser version runs on macOS and
Linux and needs uv or pipx. Windows is not supported; use WSL.

| Way | Platforms | You get |
|---|---|---|
| [One-line install](#one-line-install) | macOS, Linux x86_64 | The desktop app, from the latest release |
| [Build from source](#build-from-source) | macOS, Linux x86_64 | The desktop app, built on your machine |
| [uvx / uv tool / pipx](#browser-version-uvx-uv-tool-pipx) | macOS, Linux (Windows: WSL) | The server, opened in your browser |
| [Download from Releases](#download-from-releases) | macOS, Linux x86_64 | The `.dmg`, `.AppImage` or `.deb` file |

## One-line install

```sh
curl -fsSL https://raw.githubusercontent.com/dharmen8980/deltadeck/main/install.sh | bash
```

The script finds your OS and CPU, downloads the matching file from the latest
release on GitHub, checks it against the release's `SHA256SUMS.txt` and
installs it for you only (no `sudo`):

- **macOS:** `~/Applications/DeltaDeck.app`. A running DeltaDeck is quit
  first, the old app is replaced, and the new one is opened. Files fetched
  with `curl` are not quarantined, so the unsigned app opens without the
  Gatekeeper prompt.
- **Linux x86_64:** the AppImage as `~/.local/bin/deltadeck`, plus a menu
  entry in `~/.local/share/applications/deltadeck.desktop`. AppImages need
  FUSE 2 (`sudo apt install libfuse2`; `libfuse2t64` on Ubuntu 24.04+); the
  script warns if it is missing. On Ubuntu 24.04+ AppArmor can block the
  AppImage's sandbox; the `.deb` (see [below](#download-from-releases)) avoids
  that.

Options go after `bash -s --`:

```sh
curl -fsSL https://raw.githubusercontent.com/dharmen8980/deltadeck/main/install.sh | bash -s -- --version v0.2.0
curl -fsSL https://raw.githubusercontent.com/dharmen8980/deltadeck/main/install.sh | bash -s -- --help
```

| Option | |
|---|---|
| `--version vX.Y.Z` | Install that release instead of the latest (v0.2.0 and later) |
| `--build` | Build from source instead of downloading (see below) |
| `--uninstall` | Remove the app (your data is kept) |
| `--help` | Show the options |

| Environment | |
|---|---|
| `DELTADECK_PREFIX` | Install here instead of `~/Applications` (macOS) or `~/.local` (Linux) |
| `DELTADECK_SRC` | Where `--build` keeps the source (default `~/.deltadeck/src`) |
| `DELTADECK_REPO` | Another GitHub repository (`owner/name`), e.g. a fork |
| `DELTADECK_RELEASE_BASE` | A base URL holding the release files, instead of GitHub |
| `DELTADECK_NO_OPEN=1` | Do not open the app after installing (macOS) |

Without `--version` the script uses GitHub's `releases/latest/download` link,
so it makes no API calls. If no release is published yet, it says so and
points to `--build`. `--version` works for v0.2.0 and later; older releases
use the app's former name, Local Docs Viewer.
To read the script before running it:

```sh
curl -fsSLO https://raw.githubusercontent.com/dharmen8980/deltadeck/main/install.sh
less install.sh
bash install.sh
```

## Build from source

The script can do it for you:

```sh
curl -fsSL https://raw.githubusercontent.com/dharmen8980/deltadeck/main/install.sh | bash -s -- --build
```

It needs git, Node.js 23.6 or later (CI uses 24) with npm, and
[uv](https://docs.astral.sh/uv/); it checks each one and says how to install
what is missing. It clones the repository into `~/.deltadeck/src` (or
updates it with `git pull --ff-only`), runs the same build as the release
workflow and installs the result like the one-line install. Add
`--version vX.Y.Z` to build a tagged release (v0.2.0 and later). The build
takes a few minutes. On a Mac it builds for the CPU that Node runs as: a Node
running under Rosetta builds the Intel app.

By hand, from a clone:

```sh
git clone https://github.com/dharmen8980/deltadeck.git
cd deltadeck/desktop
npm ci
npm run dist:mac      # macOS: release/deltadeck-<version>-mac-<arch>.dmg
npm run dist:linux    # Linux: release/deltadeck-<version>-linux-x86_64.AppImage and .deb
```

`npm run dist` builds the web UI, freezes the server with PyInstaller and
packages the app for this machine's CPU only. Open the `.dmg` and drag the app
to Applications, or run the AppImage. A locally built app is not quarantined.
More in [Desktop app](desktop.md) and [Development](development.md).

To run the browser version from a clone instead, see [Get it](../README.md#get-it).

## Browser version: uvx, uv tool, pipx

The server alone, on macOS or Linux with Python 3.13+ (uv fetches it if
needed). Windows is not supported; run it in WSL. It
serves `http://127.0.0.1:8765/`; open that in your browser.

```sh
uvx deltadeck --root .              # run it once, without installing
uv tool install deltadeck           # or install the deltadeck command
pipx install deltadeck              # or install it with pipx
deltadeck --root ~/notes            # then run it on a folder
pipx run deltadeck --root .         # or run it once with pipx
```

Without `--root` you choose a folder in the browser. Editing is on; `--read-only`
turns it off, `--port N` picks another port; see [Configuration](configuration.md).
PDF export uses Google Chrome if it is installed (see [PDF export](pdf-export.md)).

## Download from Releases

Download from [Releases](https://github.com/dharmen8980/deltadeck/releases):

- `deltadeck-<version>-mac-arm64.dmg`: Mac with Apple Silicon.
- `deltadeck-<version>-mac-x64.dmg`: Mac with Intel.
- `deltadeck-<version>-linux-x86_64.AppImage`: any Linux x86_64.
- `deltadeck-<version>-linux-amd64.deb`: Debian, Ubuntu.
- `SHA256SUMS.txt`: the checksums. Compare with `shasum -a 256 <file>`.

**macOS.** Open the `.dmg` and drag DeltaDeck to Applications. The app is not
signed with an Apple Developer ID, so a copy downloaded with a browser is
quarantined and Gatekeeper blocks it. Remove the flag:

```sh
xattr -dr com.apple.quarantine /Applications/DeltaDeck.app
```

Or right-click the app, choose **Open**, then **Open** (macOS 15 and later:
open it once, then System Settings > Privacy & Security > **Open Anyway**).

**Linux.** AppImage: `chmod +x deltadeck-*.AppImage` and run it (needs FUSE 2,
as above). Deb: `sudo apt install ./deltadeck-*.deb`.

## Updating

- **One-line install:** run it again. It replaces the app with the latest
  release.
- **Built from source:** run `install.sh --build` again. It pulls the source
  and rebuilds.
- **uv tool / pipx:** `uv tool upgrade deltadeck` or `pipx upgrade deltadeck`.
  `uvx deltadeck` reuses the version it cached the first time;
  `uvx deltadeck@latest` gets the newest.
- **Downloaded by hand:** download the new file and replace the app.

Settings, remembered folders and history are kept across updates.

**From Local Docs Viewer (v0.1.0).** DeltaDeck is the same app under a new
name. Its settings and history are moved over on first start. On macOS it
is a separate app to the system, so it asks again for access to folders such
as Documents or Desktop. The installer warns if it finds
`Local Docs Viewer.app` or a `DeltaDeck.app` in `/Applications`; it does not
update or remove those, so delete them by hand.

## Uninstalling

```sh
curl -fsSL https://raw.githubusercontent.com/dharmen8980/deltadeck/main/install.sh | bash -s -- --uninstall
```

This removes `~/Applications/DeltaDeck.app` (macOS), or `~/.local/bin/deltadeck`
and its menu entry (Linux). Otherwise: drag `DeltaDeck.app` to the Trash;
delete the AppImage; `sudo apt remove deltadeck-desktop` for the `.deb`;
`uv tool uninstall deltadeck` or `pipx uninstall deltadeck`. The source from
`--build` stays in `~/.deltadeck/src`; delete it by hand.

## Where data lives

Uninstalling never deletes your data. Delete these folders to remove it.

- **Desktop app:** macOS `~/Library/Application Support/DeltaDeck`, Linux
  `~/.config/DeltaDeck`: settings, recent folders, the changes history, logs
  and, when editing is on, history and trash. See [Desktop app](desktop.md).
- **Browser version:** `~/.local/share/deltadeck` (or
  `$XDG_DATA_HOME/deltadeck`). In a source checkout it is `.data` next to the
  README. `--data-dir` sets another one.
