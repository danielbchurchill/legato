# Unraid template

[`legato.xml`](legato.xml) is the Community Applications (CA) template for the Legato server. It wraps the same image as [`docs/install/docker-compose.yml`](../../docs/install/docker-compose.yml) with the same container paths, so [`docs/install/docker.md`](../../docs/install/docker.md) applies to an Unraid install too. [`ca_profile.xml`](ca_profile.xml) is the profile CA shows for the repository the template is published from.

| Template field | Container side | Default | Why |
|---|---|---|---|
| WebUI port | `8899/tcp` | `8899` | The server's `LEGATO_PORT`, fixed in the image. Only the host side changes. |
| Music | `/music`, **read-only** | none, required | No default, so Unraid won't create an empty folder that Legato scans as an empty library. |
| Appdata | `/data` | `/mnt/user/appdata/legato` | Matches the image's `LEGATO_DATA_DIR`. |
| PUID / PGID | env | `99` / `100` | `nobody:users`, the owner of Unraid share files by default. The entrypoint refuses `0`. |
| Install channel | `LEGATO_INSTALL_CHANNEL` | `docker` | Tells update notices (#110) which upgrade steps to show. Hidden under advanced view, without edit buttons. |

## Trying it on an Unraid box before it's listed

1. Copy `legato.xml` to the flash drive as `/boot/config/plugins/dockerMan/templates-user/my-Legato.xml` (the `my-` prefix is how Unraid names user templates).
2. **Docker → Add Container → Template:** pick **Legato** under User templates.
3. Set **Music** to your share (`/mnt/user/music`), then **Apply**.
4. In the container's menu, choose **WebUI**. Create the owner with the setup code the page shows, then add `/music` as a library folder.

## Submitting to Community Applications

CA lists templates from a **public** GitHub repository with an OSI-approved license, a `ca_profile.xml` at its root and one XML per app under `templates/`. This repository is private and unlicensed, so the template is published from a small separate repository. Only the template files are public, not Legato's code.

1. **Publish the image.** Tag a release so `.github/workflows/release.yml` pushes `ghcr.io/danielbchurchill/legato-server:latest`. Then **GitHub → your profile → Packages → legato-server → Package settings → Change visibility → Public**. Check from a machine that isn't signed in to GHCR: `docker logout ghcr.io && docker pull ghcr.io/danielbchurchill/legato-server:latest`.
2. **Create the template repository**, public: `danielbchurchill/unraid-templates`. `legato.xml`'s `<TemplateURL>` already points at `main/templates/legato.xml` there. If you pick another name, change that URL to match. Add:
   - `LICENSE`, MIT. It covers the template files only.
   - `ca_profile.xml`, copied from this folder.
   - `templates/legato.xml`, copied from this folder.
3. **Check the raw URLs answer** without signing in: `https://raw.githubusercontent.com/danielbchurchill/unraid-templates/main/templates/legato.xml`, and the icon, `https://legato.fm/favicon-128.png`.
4. **Submit:** open <https://ca.unraid.net/submit/new>, sign in with an Unraid account, enter the repository URL, and run **Validate → Scan → Submit**. Fix whatever the validator reports, then resubmit.
5. **Optional, for support:** start a support thread on the Unraid forums. Put its URL in the template as `<Support>` and in `ca_profile.xml` as `<Forum>`. CA requires either `<Support>` or `<Project>`, and `<Project>` (legato.fm) is already set.

After it's listed, CA re-reads the template repository periodically. This folder stays the source: change the template here, then copy it across.
