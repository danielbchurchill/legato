# Third-party notices

Legato itself is licensed under the [AGPL-3.0](LICENSE). It includes, bundles or downloads the third-party components below, and each keeps its own licence. Every other dependency (npm packages under `package-lock.json`, `server/package-lock.json` and `relay/package-lock.json`, and Rust crates under `src-tauri/Cargo.lock`) is distributed under its own licence, as recorded in that package. Almost all of them use MIT, Apache-2.0, BSD or ISC.

## Bundled programs

These are separate programs that Legato runs as child processes. They aren't linked into Legato.

### FFmpeg

Used for decoding, transcoding, waveforms and cover art.

- **The release archives (used by the install script) and the desktop app bundle** ship prebuilt static FFmpeg binaries. They come from johnvansickle.com (Linux), evermeet.cx and osxexperts.net (macOS) and gyan.dev (Windows). See `scripts/fetch-media-binaries.mjs` and `scripts/fetch-release-media-binaries.mjs`.
- These builds include GPL-licensed components, so as distributed they're licensed under the **GNU General Public License v3.0 or later**.
- Source: <https://ffmpeg.org/download.html>. Each provider also publishes the build configuration it used.
- **The Docker image** installs Debian's own `ffmpeg` package, under Debian's licensing. **The Homebrew formula** depends on Homebrew's `ffmpeg`.

### Chromaprint (`fpcalc`)

Used for AcoustID audio fingerprinting.

- Chromaprint is licensed under the **GNU Lesser General Public License v2.1 or later**.
- The official `fpcalc` binaries are statically linked against FFmpeg, which brings in FFmpeg's licence as described above.
- Source: <https://github.com/acoustid/chromaprint>.

## Libraries

### node-taglib-sharp

Used for tag write-back. Licensed under the **GNU Lesser General Public License v2.1 or later**. Source: <https://github.com/benrr101/node-taglib-sharp>.

## Fonts

Self-hosted through `@fontsource`. All three are under the **SIL Open Font License 1.1**: <https://openfontlicense.org>.

- **Rubik**: Copyright 2015 The Rubik Project Authors.
- **Sometype Mono**: Copyright 2018 The Sometype Mono Project Authors.
- **Luxurious Script**: Copyright The Luxurious Script Project Authors. Used only in the Legato wordmark artwork, which is covered by [TRADEMARKS.md](TRADEMARKS.md).

## Icons

### proicons

Vendored as SVG in `src/assets/icons/`. Source: <https://github.com/ProCode-Software/proicons>.

```
MIT License

Copyright (c) ProCode Software

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Data sources

Legato looks things up in these services at runtime. Their data is used under each service's own terms: MusicBrainz (CC0 core data), Cover Art Archive, LRCLIB, Deezer, Wikipedia and Wikidata (CC BY-SA and CC0), and AcoustID when a key is configured.
