# Raising the file-watch limit

Legato watches your library's folders for changes using inotify (on Linux)
so new music shows up automatically. Every watched folder uses one inotify
"watch," and the kernel caps how many a single user can hold open at once —
`fs.inotify.max_user_watches`. On a library with a lot of artist/album
folders, that cap can run out. When it does, Legato falls back to checking
for new music every 30 minutes instead of noticing it immediately, and says
so in Settings → library.

Raising the limit fixes it. The number itself is cheap — each watch is a
few hundred bytes of kernel memory — so there's no real downside to setting
it much higher than you need.

## Synology (DSM)

DSM resets `/proc/sys/fs/inotify/max_user_watches` back to its low stock
default on every reboot, and `/etc/sysctl.conf` doesn't reliably survive a
DSM update either. The durable fix is a **Task Scheduler boot-up task**
that reapplies it every time the NAS starts:

1. **Control Panel → Task Scheduler → Create → Triggered Task → User-defined script.**
2. General tab: give it a name (e.g. "raise inotify watch limit"), set **User** to `root`, and **Event** to **Boot-up**.
3. Task Settings tab, in the script box:
   ```sh
   echo 524288 > /proc/sys/fs/inotify/max_user_watches
   ```
4. Save, then either reboot the NAS once to apply it immediately, or run
   the task by hand from Task Scheduler's list ("Run" from the right-click
   menu) — either way it's back in place on every future boot from then on.

524288 comfortably covers even a very large library; lower it if you'd
rather be more conservative.

## Linux (non-Synology)

Most distributions keep sysctl changes across reboots without any of the
above — add a line to `/etc/sysctl.d/99-legato-watches.conf`:

```
fs.inotify.max_user_watches=524288
```

then apply it immediately with `sudo sysctl --system` (or reboot).

## After raising it

Restart Legato's server (the embedded server if you're running the desktop
app, or the standalone one otherwise). It resumes normal watching
automatically the next time it starts a library root — no re-scan or
reconfiguration needed.
