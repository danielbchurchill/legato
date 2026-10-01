# Issue #109: `brew install danielbchurchill/legato/legato` followed by
# `brew services start legato`. Lives in this repo until the
# danielbchurchill/homebrew-legato tap exists; see README.md beside it.
#
# The release archives (#102, scripts/package-release.mjs) also carry their
# own ffmpeg and fpcalc. This formula installs only legato-server and points
# it at Homebrew's ffmpeg and chromaprint instead, so `brew upgrade` keeps
# those patched and they never sit unsigned in a keg nobody updates.
#
# Every url and sha256 below is rewritten on each release by
# scripts/bump-homebrew-formula.mjs (release.yml's `homebrew` job). There is
# no `version` line: Homebrew reads it from the url, and `brew audit
# --strict` rejects one that repeats it. Keep each sha256 on the line right
# after its url, because the script pairs them by position.
class Legato < Formula
  desc "Music library server that maps how your artists connect"
  homepage "https://legato.fm"
  depends_on "chromaprint"
  depends_on "ffmpeg"

  on_macos do
    on_arm do
      url "https://github.com/danielbchurchill/legato/releases/download/v0.0.0/legato-server-0.0.0-darwin-arm64.tar.gz"
      sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    end
    on_intel do
      url "https://github.com/danielbchurchill/legato/releases/download/v0.0.0/legato-server-0.0.0-darwin-x64-baseline.tar.gz"
      sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    end
  end

  # Homebrew on Linux gets the same formula: the Pi (arm64) and the AIO (x64)
  # are Legato's daily hosts, and `service do` writes a systemd user unit there.
  on_linux do
    on_arm do
      url "https://github.com/danielbchurchill/legato/releases/download/v0.0.0/legato-server-0.0.0-linux-arm64.tar.gz"
      sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    end
    on_intel do
      url "https://github.com/danielbchurchill/legato/releases/download/v0.0.0/legato-server-0.0.0-linux-x64-baseline.tar.gz"
      sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    end
  end

  def install
    libexec.install "legato-server"

    # A wrapper rather than service-only environment_variables, so running
    # `legato-server` by hand opens the same database the service does. A
    # second empty database next to the real one is this project's most
    # common standalone-run mistake (CLAUDE.md). Each value is a ${VAR:-...}
    # default, so anything already set in the caller's environment still wins.
    (bin/"legato-server").write_env_script libexec/"legato-server",
      LEGATO_DATA_DIR:        "${LEGATO_DATA_DIR:-#{var}/legato}",
      LEGATO_FFMPEG_PATH:     "${LEGATO_FFMPEG_PATH:-#{formula_opt_bin("ffmpeg")}/ffmpeg}",
      LEGATO_FPCALC_PATH:     "${LEGATO_FPCALC_PATH:-#{formula_opt_bin("chromaprint")}/fpcalc}",
      # #110's update notice reads this to show `brew upgrade legato`.
      LEGATO_INSTALL_CHANNEL: "brew"
  end

  def caveats
    <<~EOS
      Legato keeps its database and caches in:
        #{var}/legato
      and listens on port 8899 (set LEGATO_PORT to change it).

      Once the service is running, open http://127.0.0.1:8899 on this machine
      to create the owner account. From another machine you will also need
      the setup code the server prints at startup:
        grep "setup code" #{var}/log/legato.log

      If your music is on an external drive or in a protected folder, macOS
      may ask you to allow legato-server access the first time it scans.
    EOS
  end

  service do
    run opt_bin/"legato-server"
    keep_alive true
    working_dir var/"legato"
    log_path var/"log/legato.log"
    error_log_path var/"log/legato.log"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/legato-server --version")

    port = free_port
    pid = spawn({ "LEGATO_PORT" => port.to_s, "LEGATO_DATA_DIR" => (testpath/"data").to_s },
                bin/"legato-server")
    begin
      body = nil
      30.times do
        sleep 1
        body = shell_output("curl -fsS http://127.0.0.1:#{port}/api/v1/health 2>/dev/null || true")
        break if body.include?('"status":"ok"')
      end
      assert_match '"status":"ok"', body
    ensure
      Process.kill("TERM", pid)
      Process.wait(pid)
    end
  end
end
