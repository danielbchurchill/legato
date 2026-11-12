# The desktop app

Every release has the desktop app for macOS, Windows and Linux on its [release page](https://github.com/danielbchurchill/legato/releases/latest). The app carries its own Legato server, with ffmpeg and fpcalc, so there's nothing else to install. It plays from your music folders natively, and serves them to your phone and other devices while it's open, or from the tray (the menu bar, on a Mac) once its window is closed.

| Computer | Download |
|---|---|
| Mac with Apple silicon (M1 and later) | `legato_<version>_aarch64.dmg` |
| Mac with an Intel processor | `legato_<version>_x64.dmg` |
| Windows, 64-bit | `legato_<version>_x64-setup.exe` |
| Linux, x86-64 | `legato_<version>_amd64.AppImage`, or `legato_<version>_amd64.deb` |
| Linux, 64-bit ARM | `legato_<version>_aarch64.AppImage`, or `legato_<version>_arm64.deb` |

Not sure which Mac you have? Choose **Apple menu → About This Mac**. A Mac that lists a **Chip** has Apple silicon; one that lists a **Processor** is Intel.

The Linux builds need glibc 2.39 or later: Ubuntu 24.04, Debian 13, Fedora 40, or newer.

## The first launch

Legato isn't signed with an Apple Developer ID or a Windows code-signing certificate yet, so macOS and Windows warn you the first time you open it. That ends once the app is signed and notarized ([#483](https://github.com/danielbchurchill/legato/issues/483)), closer to the public launch. Until then, it's one extra step per computer. Updates come through the app itself, so you only do it once.

### macOS

1. Open the `.dmg` and drag **legato** into **Applications**.
2. Open it from Applications. macOS says "legato" wasn't opened, because Apple couldn't verify that it's free of malware. Click **Done**, not **Move to Trash**.
3. Open **System Settings → Privacy & Security** and scroll down to **Security**. It says "legato" was blocked to protect your Mac. Click **Open Anyway**. When macOS asks you to confirm, click **Open Anyway** again, and enter your password or use Touch ID. Legato opens.
4. When Legato first looks for servers on your network, macOS asks whether it may find devices on your local network. Click **Allow**.

The **Open Anyway** button stays for about an hour after step 2. If it's gone, open Legato from Applications again, click **Done**, and go straight back to Privacy & Security. Since macOS 15, Control-clicking the app and choosing **Open** no longer skips the warning, so **Open Anyway** is the way.

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

It adds Legato to your applications menu, and `legato-desktop` starts it from a terminal.

## Using a server on another machine

The app plays from the server it carries, but it can use a Legato server on another computer instead: a NAS, a Raspberry Pi, or another always-on machine running a headless install ([the ways to run it](../../README.md#ways-to-run-it): Docker, Synology, Unraid, the Linux install script or Homebrew). Everything you see, the map, the library, playlists and play history, then comes from that server.

### Connecting

1. Click your picture, or your initials, at the foot of the left rail to open **Account**. Under your name it says which server you're on, for example "on 127.0.0.1:8899", with **change server** beside it. Click **change server**. The sign-in screen has the same thing as **connect to a different server** at the bottom.
2. The connect screen offers servers three ways:
   - **on this network**: servers on your home network that announce themselves. A headless server does that unless it's set not to; another computer's desktop app doesn't. On a Mac this needs the Local Network permission from the first launch; if you turned it down, allow Legato in **System Settings → Privacy & Security → Local Network**. Click **connect** beside the server.
   - **your servers**: once you sign in to legato.fm here, the servers linked to your account, each marked at home, through legato.fm, or offline.
   - **an address**: type the server's IP address, its name on your network, or your own domain, then **connect**. Without a port Legato tries 8899, so a server on another port needs it, as in `192.168.1.20:8901`. A Tailscale address works the same way: the server's `100.x.y.z` address or its MagicDNS name, for example `nas.tailnet-name.ts.net`.
3. The other server asks for its owner's password, the one set when that server was first set up, not this computer's. If you're signed in to legato.fm and the server is linked to your account, it connects without one.

The app remembers the choice, so it opens on that server from then on.

### How playback gets the files

The app plays each track natively, starting from the file's path on the server, for example `/music/Artist/Album/01 Track.flac`. If that path exists on this computer, the app reads the file directly. If it doesn't, the app streams the original file from the server instead, the same bytes at full quality. So you don't need to mount anything: a server's library plays here as long as the app can reach the server. The connection indicator in the rail says which: "This track streams from the server at its original quality, because its file isn't on this computer."

Mounting the library at the same path as the server sees it saves the stream, which helps over a slow link. The folders under **Settings → library** are the paths the server sees, and the mount has to match them exactly: a server on Linux with its music at `/mnt/music` needs `/mnt/music` here too. A file that's neither on this computer nor available from the server shows as unreachable in the player.

### This computer's own server

While the app uses another server, the server it carries keeps running. Your phone and other devices can still play from this computer, and the tray (the menu bar, on a Mac) works as before.

### Going back

Open **Account** and click **change server**, then **use this computer's server** at the bottom of the connect screen. You're still signed in there, so it opens straight away.

## Updates

Legato asks GitHub whether there's a newer release when it starts, and then once a day. A newer one downloads in the background, then a note under the search bar says so, for example "Legato 0.4.1 is available — restart to update". Nothing restarts until you click it, because restarting stops the server that your phone or other devices may be playing from. The × hides that version until the next one comes out.

The Mac app, the Windows installer and the AppImage update themselves. A `.deb` belongs to apt, so the note links to the release instead: download the new `.deb` and install it the same way.

The check sends GitHub your IP address and nothing about your library. It's the app's only request to GitHub: the server inside the app never checks for updates of its own, because the app updates both together.

To turn it off, switch off **check** under **updates** in Legato's Settings. The app then makes no request to GitHub at all, when it starts or later, until you switch it back on, and you update by downloading the next release from the release page yourself. Turning it off also takes away a note that's already showing. Switching it back on starts the checks again without restarting the app.

On a computer someone else manages, setting `LEGATO_UPDATE_CHECK=off` in the environment Legato starts in turns the check off whatever the switch says, and Settings shows it off. It's the same variable that turns off a headless server's own update check.
