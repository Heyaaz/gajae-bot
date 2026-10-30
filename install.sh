#!/bin/sh
# Installs or updates Gajae from the latest GitHub release.
#
#   curl -fsSL https://raw.githubusercontent.com/Heyaaz/gajae-bot/main/install.sh | sh
#
# GAJAE_VERSION=0.1.0 pins a release. GAJAE_INSTALL_DIR overrides the target
# folder, which is /Applications when writable and ~/Applications otherwise.
# GAJAE_RELEASES_URL points at a mirror laid out like GitHub's releases.
set -eu

releases="${GAJAE_RELEASES_URL:-https://github.com/Heyaaz/gajae-bot/releases}"

fail() {
  printf 'gajae: %s\n' "$1" >&2
  exit 1
}

[ "$(uname -s)" = "Darwin" ] || fail "Gajae runs on macOS only."
[ "$(uname -m)" = "arm64" ] || fail "Gajae needs an Apple-silicon Mac."

version="${GAJAE_VERSION:-}"
if [ -z "$version" ]; then
  # The latest-release page redirects to /releases/tag/<tag>. Reading the
  # redirect avoids the GitHub API and its 60-an-hour anonymous limit.
  latest=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$releases/latest") ||
    fail "could not reach the release server."
  case "$latest" in
    */releases/tag/*) version="${latest##*/}" ;;
    *) fail "no published release found." ;;
  esac
fi
version="${version#v}"

if [ -n "${GAJAE_INSTALL_DIR:-}" ]; then
  target="$GAJAE_INSTALL_DIR"
elif [ -w /Applications ]; then
  target="/Applications"
else
  target="$HOME/Applications"
fi
mkdir -p "$target"

name="Gajae-$version-darwin-arm64.zip"
url="$releases/download/v$version"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

printf 'Downloading Gajae %s...\n' "$version"
curl -fL --progress-bar -o "$work/$name" "$url/$name" || fail "download failed: $url/$name"
curl -fsSL -o "$work/$name.sha256" "$url/$name.sha256" || fail "checksum download failed."
(cd "$work" && shasum -a 256 -c "$name.sha256" >/dev/null) || fail "checksum mismatch; nothing was installed."

ditto -x -k "$work/$name" "$work/app"
[ -d "$work/app/Gajae.app" ] || fail "the archive does not contain Gajae.app."

if pgrep -x Gajae >/dev/null 2>&1; then
  printf 'Quitting the running Gajae...\n'
  osascript -e 'quit app "Gajae"' >/dev/null 2>&1 || true
  i=0
  while pgrep -x Gajae >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -le 20 ] || fail "Gajae is still running. Quit it and run the installer again."
    sleep 0.5
  done
fi

# Swap in the new copy only after it verified and unpacked, so a failed
# download never leaves the old app half replaced.
rm -rf "$target/Gajae.app"
mv "$work/app/Gajae.app" "$target/Gajae.app"

printf 'Installed Gajae %s in %s.\n' "$version" "$target"
[ "${GAJAE_NO_OPEN:-}" = "1" ] || open "$target/Gajae.app"
