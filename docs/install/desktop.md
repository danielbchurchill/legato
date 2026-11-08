# The desktop app

Every release has the desktop app for macOS, Windows and Linux on its [release page](https://github.com/danielbchurchill/legato/releases/latest). The app carries its own Legato server, with ffmpeg and fpcalc, so there's nothing else to install. It plays from your music folders natively, and serves them to your phone and other devices while it's open, or from the tray once its window is closed.

| Computer | Download |
|---|---|
| Mac with Apple silicon (M1 and later) | `legato_<version>_aarch64.dmg` |
| Mac with an Intel processor | `legato_<version>_x64.dmg` |
| Windows, 64-bit | `legato_<version>_x64-setup.exe` |
| Linux, x86-64 | `legato_<version>_amd64.AppImage`, or `legato_<version>_amd64.deb` |
| Linux, 64-bit ARM | `legato_<version>_aarch64.AppImage`, or `legato_<version>_arm64.deb` |

The Linux builds need glibc 2.39 or later: Ubuntu 24.04, Debian 13, Fedora 40, or newer.

## The first launch

Legato isn't signed with an Apple Developer ID or a Windows code-signing certificate yet, so macOS and Windows warn you the first time you open it. That ends once the app is signed and notarized ([#483](https://github.com/danielbchurchill/legato/issues/483)), closer to the public launch. Until then, it's one extra step per computer. Updates come through the app itself, so you only do it once.

### macOS

1. Open the `.dmg` and drag **legato** into **Applications**.
2. Open it from Applications. macOS says it can't verify that "legato" is free of malware. Click **Done**.
3. Open **System Settings → Privacy & Security** and scroll down to **Security**. It says "legato" was blocked. Click **Open Anyway**, enter your password or use Touch ID, then click **Open**.
4. When Legato first looks for servers on your network, macOS asks whether it may find devices on your local network. Click **Allow**.

Since macOS 15, Control-clicking the app and choosing **Open** no longer skips the warning. **Open Anyway** is the way.

Every update is signed with the same certificate, so macOS doesn't ask again, and Legato keeps its Local Network permission. The first update signed with Apple's certificate (#483) changes the app's identity once, so macOS asks for that permission one more time.

### Windows

1. Your browser may say the installer isn't commonly downloaded. Choose **Keep**.
2. Run `legato_<version>_x64-setup.exe`. Windows SmartScreen says "Windows protected your PC". Click **More info**, then **Run anyway**.
3. The installer sets Legato up for your account, without asking for an administrator.
4. The first time Legato's server starts, Windows Firewall may ask whether `legato-server` may use private networks. Allow it if you want your phone or other computers at home to play from this one.

### Linux

Linux doesn't check signatures on either format, so there's no warning to get past.

**AppImage.** Make it executable and run it:

```sh
chmod +x legato_<version>_amd64.AppImage
./legato_<version>_amd64.AppImage
```

AppImages need FUSE 2. On Ubuntu 24.04 that's `sudo apt install libfuse2t64`. The tray icon needs `libayatana-appindicator3-1`, and on stock GNOME the AppIndicator extension.

**.deb.** Install it with apt, which brings in WebKitGTK and the tray library:

```sh
sudo apt install ./legato_<version>_amd64.deb
```

## Updates

Legato asks GitHub whether there's a newer release when it starts, and then once a day. A newer one downloads in the background, then a note under the search bar says "Legato 0.3.0 is available — restart to update". Nothing restarts until you click it, because restarting stops the server that your phone or other devices may be playing from. The × hides that version until the next one comes out.

The Mac app, the Windows installer and the AppImage update themselves. A `.deb` belongs to apt, so the note links to the release instead: download the new `.deb` and install it the same way.

The check sends GitHub your IP address and nothing about your library. There's no setting to turn it off yet.
