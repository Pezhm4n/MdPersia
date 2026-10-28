# Windows desktop distribution

The Windows installer packages the existing React workspace in Tauri 2. The
installed app does not start Vite, a local HTTP server, system Python, or system
Node. The same Python Markdown/BiDi, Word and PDF implementations run through a
private frozen executable. Editing and reading share a lazily started worker;
conversion starts its own process tree, which is terminated on cancel or exit.

## Build

Use Windows x64, Python 3.11 x64, Node 22, Rust/MSVC, and the Windows SDK.
These are build requirements, not end-user prerequisites.

```powershell
py -3.11 -m venv output/release-venv
output/release-venv/Scripts/python.exe -m pip install -r requirements-release.lock
output/release-venv/Scripts/python.exe scripts/build-windows.py
cd desktop-tauri
npm ci
npm test
npm run tauri build -- --bundles nsis
```

The `Windows installer` GitHub workflow performs the same build on Windows 2022.
It saves the NSIS Setup, the native directory used for testing, Cargo.lock, and
a frozen-engine test receipt as artifacts. Branch builds do not publish releases.

`output/release/staging` contains `engine`, `assets`, and `browsers`. Keep this
layout intact. PyInstaller uses directory mode to avoid unpacking the engine
every time a Markdown file opens. Chromium headless shell and Mermaid are local;
the Playwright version and browser revision must be updated together.
Playwright's private driver includes its own Node binary. It does not use or
require a Node installation on the user's computer.

The offline Setup embeds the Microsoft Evergreen WebView2 installer. It installs
WebView2 when necessary, so first installation does not depend on a download.
The app uses the shared Evergreen runtime for normal reading. Bundled Chromium
starts only for PDF generation and Mermaid images in Word output.

## Install and file associations

Run the Setup normally. Installation is for the current user. Python, npm, Rust,
and browser-download commands are never part of the installation instructions.
The installer registers `MdPersia.Markdown`, the native application icon, and an
Open With entry for `.md` and `.markdown` under HKCU. Existing Windows UserChoice
settings are respected. Choose MdPersia once through **Open with > Choose another
app > Always use this app** if another reader is currently the default.

Uninstall removes the handler only when its command still points at this
installation. Documents are never removed. There is no automatic updater in
this beta: install the next Setup to upgrade. Do not change the app identifier
between releases; it identifies the installation and persistent preferences.

## Acceptance before sharing

```powershell
py -3.11 scripts/verify-frozen-engine.py <installed-directory> --output output/installed-engine-qa
```

This test removes developer runtimes from the child PATH, starts outside the
source tree, opens a Persian filename, previews, reads/saves with BOM preserved,
and actually creates PDF and Word files containing Mermaid. It is not a clean
Windows virtual-machine test and must not be reported as one.

Also run native UI acceptance on Windows 10: cold launch, concurrent opens into
one queue, editor save/conflict handling, local images/fonts/Mermaid, folder
scans, conversion, watch cancellation, close guards, settings persistence, and
installation/uninstallation. Record the Windows build, artifact hash and actual
result. A successful CI build alone does not establish runtime correctness.

## Signing and release trust

The current beta Setup is unsigned unless a real publisher signing identity is
configured by the maintainer. Never represent an unsigned installer as a
verified publisher release. Windows SmartScreen can show a warning for it.
Before a stable public release, sign the executable and installer using a valid
Authenticode certificate and timestamp, then repeat acceptance on those exact
bits. A Tauri updater signing key is a different mechanism and does not establish
Windows publisher trust. Keep all private keys outside the repository.

Distribute the Setup together with its SHA-256 checksum. Preserve the resource
manifest and CI revision for diagnosing mismatched or incomplete installations.
