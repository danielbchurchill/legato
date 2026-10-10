<!--
Screenshot capture checklist (issue #106). Every "[Screenshot N]" block below
marks where an image goes, and none has been captured yet. They need a real
NAS on DSM 7.2 or later. Save each one as
docs/install/images/synology/<NN>-<name>.png, at the browser's normal zoom,
cropped to the DSM window. Blur the NAS's name, IP, serial number and
usernames. Then replace the placeholder block with ![alt](images/synology/<NN>-<name>.png).

  [ ] 01-package-center.png       Package Center, Container Manager search result with its Install/Open button
  [ ] 02-ssh-enable.png           Control Panel → Terminal & SNMP, "Enable SSH service" ticked
  [ ] 03-task-view-result.png     Task Scheduler → Action → View Result, showing `id` output (also confirms that menu exists on your DSM)
  [ ] 04-shared-folder-perms.png  Control Panel → Shared Folder → music → Edit → Permissions, the Legato user set to Read only
  [ ] 05-inotify-task-general.png Task Scheduler triggered task, General tab: User root, Event Boot-up
  [ ] 06-inotify-task-script.png  Same task, Task Settings tab with the sysctl line
  [ ] 07-project-create.png       Container Manager → Project → Create, name/path/source filled in, compose pasted
  [ ] 08-project-running.png      Project list with legato running (green)
  [ ] 09-container-log.png        Container → legato → Log, showing the version, database and setup-code lines
  [ ] 10-setup-page.png           http://<nas>:8899/setup in a browser on the LAN, code and countdown visible
  [ ] 11-add-music.png            Legato's add-folder picker with /music listed
  [ ] 12-image-update.png         Container Manager → Image, "Update available" on legato-server (also confirms that flow)

While walking through it, also confirm on the real NAS, and fix the text if
it's wrong: the relative ./data bind mount resolves inside the project folder;
"Action → View Result" exists in Task Scheduler; the Image tab offers an
update for a :latest image; Project → Action → Stop, edit the YAML, Action →
Build recreates the container with the edited file; network_mode: host builds,
the server answers on the NAS's port 8899, and the desktop app lists it under
"on this network" with its LEGATO_SERVER_NAME. Record the NAS model and DSM version in the PR.
-->

# Installing Legato on a Synology NAS

This guide runs the Legato server on a Synology through **Container Manager**, DSM's Docker app, using a compose project. It takes about fifteen minutes, plus the first scan, which runs on its own once you've added your library. Every step happens in DSM's web interface. SSH is optional: one step offers it as the quick way to look up two numbers, and the update section has a command-line shortcut.

What you end up with: Legato's server running as a normal (non-root) DSM user, reading your music share **read-only**, reachable at `http://<your NAS>:8899` from any browser or Legato app on your network.

The general Docker reference is [docker.md](docker.md). This page covers the parts that differ on a Synology.

## 1. Check your NAS can run Container Manager

Container Manager needs **DSM 7.2 or later** and one of these processors:

- **Any Intel or AMD model.** That covers every "+" model (DS224+, DS423+, DS923+, DS1522+ …), the xs/rs business models, and the older Intel "play" models.
- **The ARM models built on the Realtek RTD1619B chip:** DS124, DS223, DS223j and DS423. Synology ships Container Manager for these as its `armv8` build, which sits next to the `x86_64` build in [Synology's package archive](https://archive.synology.com/download/Package/ContainerManager). Legato's image is published for `linux/arm64` as well as `linux/amd64`, so they run the same image.

**Every other ARM model can't run Container Manager, and most "j" models are in that group:** DS220j, DS120j, DS218, DS118, DS418j and the rest of the older value line, along with every 32-bit model. On those the package doesn't appear at all. For those models, run Legato on another machine (a Raspberry Pi 4 or 5, or any Linux box) and point it at the NAS's music over the network.

The list above can go out of date when Synology adds models, so check yours directly: **open Package Center and search for "Container Manager."** If it shows up with an Install button, your NAS can run Legato. If it doesn't appear, your NAS can't. Over SSH, `uname -m` gives a quick hint. `armv7l` or anything else starting `arm` means no. `x86_64` means yes. `aarch64` means it depends on the chip, so Package Center has the final word.

**On a DS223j, or any model with 1 GB of RAM,** Legato runs but the first scan is slow. It reads every file's tags, matches and lays out your artists, then works through fingerprints, cover art and waveforms in the background. On a library of tens of thousands of files that takes hours rather than minutes, and memory is the limit. Add `LEGATO_MEDIA_CONCURRENCY: "1"` to the compose file's `environment:` block (step 6) so only one ffmpeg or fingerprint job runs at a time. Playback stays ahead of that background work either way. You can pause a scan from Legato's library settings and resume it later, even after a restart.

## 2. Install Container Manager

**Package Center** → search **Container Manager** → **Install**.

> **[Screenshot 1: `01-package-center.png`]** Package Center with Container Manager found and its Install button.

Installing it creates a shared folder called **`docker`** on your first volume. Legato's project folder and its database go in there.

## 3. Choose the user Legato runs as, and find its ids

Legato runs as an ordinary DSM user, never as root. That user needs to be able to **read your music share**, and nothing else. You can use your own account, but a dedicated user is tidier. **Control Panel → User & Group → Create** a user called `legato`, giving it no application permissions and no access to any share except music (step 4).

The container needs that user's numeric ids, `PUID` (the user id) and `PGID` (its group id). DSM doesn't show these in its user list, so pick whichever of these two ways you prefer.

### With SSH

1. **Control Panel → Terminal & SNMP → Enable SSH service** → Apply.

   > **[Screenshot 2: `02-ssh-enable.png`]** Terminal & SNMP with "Enable SSH service" ticked.

2. From a computer on your network, sign in with an administrator account and ask for the ids:

   ```sh
   $ ssh admin@192.168.1.20
   $ id legato
   uid=1027(legato) gid=100(users) groups=100(users)
   ```

   Here `PUID` is **1027** and `PGID` is **100**. On a Synology, `PGID` is almost always 100, the built-in `users` group. User ids are 1024 or higher, one per account in the order they were made.

3. Turn SSH back off if you don't otherwise use it.

### Without SSH

Task Scheduler can run a one-off command as root and show you its output.

1. **Control Panel → Task Scheduler → Create → Scheduled Task → User-defined script.**
2. **General** tab: name it `show legato ids`, set **User** to `root`, and untick **Enabled** so it never runs on a schedule.
3. **Task Settings** tab, in **Run command**, write `id legato` (or your own username).
4. **OK**, then select the task → **Run**. Once it's finished, select it again → **Action → View Result**.

   > **[Screenshot 3: `03-task-view-result.png`]** View Result showing `uid=1027(legato) gid=100(users) …`.

5. Read the two numbers off the result as in the SSH example above, then delete the task.

## 4. Give that user read access to your music

**Control Panel → Shared Folder** → select the share that holds your music → **Edit → Permissions**. Under **Local users**, find the Legato user and tick **Read only**. Save.

> **[Screenshot 4: `04-shared-folder-perms.png`]** The music share's Permissions tab, the `legato` user set to Read only.

While you're there, note the share's **path**. A share called `music` on Volume 1 is `/volume1/music` and the compose file needs that exact path. If your library lives in a subfolder (`/volume1/music/Library`), use the subfolder's full path instead.

Read only is all Legato needs for scanning, playback, enrichment and the hygiene worklist. The one feature that writes to files, tag write-back, also needs Read/Write here *and* a change to the compose file. See [docker.md → Tag write-back](docker.md#tag-write-back-needs-a-read-write-library) before turning it on.

The `docker` share needs no change. The container starts as root just long enough to hand its own data folder to `PUID:PGID`, then drops to that user before the server starts.

## 5. Raise the file-watch limit

Legato notices new music the moment it lands by watching every folder in your library. Each folder uses one inotify "watch," and DSM's default limit is low enough that a big library runs out. When that happens Legato falls back to checking for new music every 30 minutes, and Settings → library says so. The container uses the NAS's own kernel, so the limit has to be raised on the NAS itself. DSM resets it on every reboot, so a boot-up task sets it again each time.

1. **Control Panel → Task Scheduler → Create → Triggered Task → User-defined script.**
2. **General** tab: name it `raise inotify watch limit`, **User** `root`, **Event** **Boot-up**, **Enabled** ticked.

   > **[Screenshot 5: `05-inotify-task-general.png`]** The General tab: User root, Event Boot-up.

3. **Task Settings** tab, in **Run command**:

   ```sh
   sysctl -w fs.inotify.max_user_watches=524288
   ```

   > **[Screenshot 6: `06-inotify-task-script.png`]** The Task Settings tab with that line.

4. **OK**, then select the task → **Run** so it applies now, without waiting for a reboot.

524288 covers even a very large library, and each watch costs a few hundred bytes of kernel memory only when it's in use. [watch-limit.md](../watch-limit.md) has the background. If you do this after Legato is already running, restart the container (step 7) so it picks the new limit up.

## 6. Create the project

1. **File Station** → open the `docker` share → **Create → Create folder** → `legato`.
2. **Container Manager → Project → Create.**
   - **Project name:** `legato`
   - **Path:** `docker/legato`, the folder you just made
   - **Source:** **Create docker-compose.yml**
3. Paste this into the editor, then change the three marked values:

   ```yaml
   services:
     legato:
       image: ghcr.io/danielbchurchill/legato-server:latest
       container_name: legato
       restart: unless-stopped
       environment:
         PUID: "1027"   # ← your PUID from step 3
         PGID: "100"    # ← your PGID from step 3
       ports:
         - "8899:8899"
       volumes:
         # Database, cover art and waveform cache, in docker/legato/data.
         - ./data:/data
         # Your music, read-only. ← your share's path from step 4
         - /volume1/music:/music:ro
   ```

   > **[Screenshot 7: `07-project-create.png`]** The Create Project screen, name and path filled in and the compose file pasted.

4. **Next.** If it offers **Web portal settings** (Web Station), leave it unticked, because Legato serves its own web page. **Next**, tick **Start the project once it is created**, then **Done**.

Container Manager downloads the image (a couple of hundred MB) and starts it. The project turns green in the list when it's running.

> **[Screenshot 8: `08-project-running.png`]** The Project list, `legato` running.

This file differs from the general [docker-compose.yml](docker-compose.yml) in two ways, both because of how Container Manager works:

- **Values are written in directly** rather than read from variables, since the project editor has no place to set them.
- **Data goes in `./data`** (inside `docker/legato`) rather than a named Docker volume. Named volumes live in DSM's hidden `@docker` folder, which File Station can't show and Hyper Backup can't select. In the project folder you can see the database and back it up.

If port 8899 is already taken on your NAS, change only the **left** number (`"8900:8899"`) and use that port in the steps below. The container always listens on 8899 inside.

## 7. Check it started

**Container Manager → Container → legato → Details → Log.** The server logs one JSON object per line. The ones that matter on a first start have these `msg` values (trimmed here):

```
{"level":30,…,"msg":"legato-server 0.4.0 (3d06f23)"}
{"level":30,…,"msg":"database: /data/legato.db (0 files)"}
{"level":40,…,"msg":"No owner account yet — setup code K7QM-4XRD, valid for 10 minutes. Open http://<this server>:8899/setup …"}
{"level":30,…,"msg":"legato-server listening at http://127.0.0.1:8899"}
```

> **[Screenshot 9: `09-container-log.png`]** The container log showing those lines.

0 files is right on a first start, and `127.0.0.1` in the last line is the container's own view; from your network it's the NAS's address. If the log instead stops at `PUID and PGID must be numeric ids` or `refusing to run the server as root`, fix the two numbers in the project (**Project → legato → Action → Stop**, edit the YAML, **Action → Build**). `Permission denied` on `/data` means the `docker` share's own permissions are unusually tight: give the Legato user Read/Write on the `docker` share and restart. To restart the container at any point, use **Container → legato → Action → Restart**.

## 8. Create the owner

Open **`http://<your NAS's IP>:8899/setup`** in a browser on the same network, for example `http://192.168.1.20:8899/setup`.

The page shows this server's **setup code**, with a countdown, and the form to create the owner: a name, a password, and that password again. Choose **create owner**. The password lives only on the NAS and works with no internet connection. From then on, this is how you sign in from any browser or Legato app.

> **[Screenshot 10: `10-setup-page.png`]** The setup page, code and countdown showing.

A few things about the code:

- **It replaces itself every ten minutes.** When the countdown runs out a new one appears in its place, and the log shows each new one too. You never need to restart anything to get a fresh code.
- **It's only shown on your own network.** You'll see it when you open the page by IP address, by a bare name (`http://diskstation:8899`), or by a `.local` name. If you reach the NAS through QuickConnect, DSM's reverse proxy, or a public domain name, the page asks you to type the code instead. Read it from the container log (step 7).
- **The QR code** under the form is for claiming the server to a legato.fm account, which isn't live yet. Creating the owner is all a server needs.

Until an owner exists, the server answers nothing but this page, so nobody else on your network can browse your library in the meantime.

## 9. Add your library

Signed in, open Legato's library settings and add a folder. The picker shows the folders **inside the container**, so choose **`/music`**, whatever your share is called on the NAS. The first scan starts on its own.

> **[Screenshot 11: `11-add-music.png`]** The add-folder picker with `/music` listed.

To add a second share later, add another line under `volumes:` (`- /volume2/more-music:/more-music:ro`), give the Legato user Read only on that share as in step 4, and rebuild the project (**Action → Stop**, then **Action → Build**). The new folder then shows up in the picker.

## Appearing on the connect screen

Legato's desktop app lists the servers it finds under **on this network** on its connect screen, so nobody has to type the NAS's address. The server announces itself over mDNS, but on Container Manager's default bridge network that announcement stays on Docker's internal network, where other devices can't hear it. With the project as written in step 6, you connect by address.

Container Manager accepts host networking in a project's compose file, which puts the container on the NAS's own network. **Project → legato → Action → Stop**, then in the YAML replace the `ports:` block with `network_mode: host`, and give the server a name:

```yaml
    container_name: legato
    restart: unless-stopped
    network_mode: host
    environment:
      PUID: "1027"
      PGID: "100"
      LEGATO_SERVER_NAME: "DiskStation"
```

then **Action → Build**. Host networking changes two things:

- **There's no `ports:` mapping.** The server listens on the NAS's own network, so there's nothing to publish.
- **`LEGATO_PORT` takes the place of the left-hand port number.** The server listens on 8899 on the NAS itself. If that's taken, add `LEGATO_PORT: "8900"` under `environment:` and use that port everywhere this guide says 8899.

`LEGATO_SERVER_NAME` is the name the apps show for this server, whichever network it's on. Without it, they show the container's hostname: a random id on the bridge network, or the NAS's own name with host networking.

## Updating

Your library and settings carry over. The server updates its database by itself on the first start of a new version, and saves a copy of it beforehand.

**In DSM:** **Container Manager → Image.** When a newer `legato-server` is available, the image shows an update notice. Choose **Update**, and Container Manager pulls it and recreates the container.

> **[Screenshot 12: `12-image-update.png`]** The Image list with an update notice on `legato-server`.

**Over SSH**, which works whether or not the notice has appeared:

```sh
cd /volume1/docker/legato
sudo docker compose pull && sudo docker compose up -d
```

Either way, the container log's first line shows the new version.

## Backups

Only the database matters. Everything else in `docker/legato/data` is cover art and waveforms that Legato rebuilds by itself. Stop the project (**Project → legato → Action → Stop**), copy `docker/legato/data/legato.db` and any `legato.db-wal` / `legato.db-shm` next to it, then start it again. In Hyper Backup, select those files under `docker/legato/data`. Stopping first matters: a copy taken mid-write can be unusable.

Legato also keeps its own copies in `docker/legato/data/backups/`, made automatically before each database upgrade. It keeps the three newest.
