#!/usr/bin/env bash
# install-cloud-backup.sh — arm the encrypted off-site backup, or refuse and say why.
#
# This follows install-backup.sh's discipline: it REFUSES rather than pretends.
# A backup timer that goes green while uploading nothing, or while uploading
# something nobody can decrypt, is worse than no timer — it manufactures
# confidence. Every refusal below names the exact problem and installs nothing.
#
# It will not arm the timer until it has PROVEN, against the real remote:
#   * the remote is a crypt remote (never plain object storage)
#   * a real object can be written, read back, and byte-compared
#   * the operator has confirmed the passphrase exists somewhere other than
#     this SD card
#
# EXIT CODES
#   0  installed and armed
#   2  rclone / sqlite3 / the repo layout is not ready
#   3  ~/.christina/cloud-backup.env missing, empty, or still the placeholder
#   4  the configured remote is NOT a crypt remote (would upload plaintext audio)
#   5  the remote is unreachable, or the write/read/compare probe failed
#   6  the crypt passphrase has not been confirmed saved off this box

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
USER_NAME="$(id -un)"
ENV_DIR="$HOME/.christina"
ENV_FILE="$ENV_DIR/cloud-backup.env"
UNIT_DIR="/etc/systemd/system"
DRY="${DRY:-0}"

ok()     { printf '  \033[32mok\033[0m   %s\n' "$*"; }
warn()   { printf '  \033[33mwarn\033[0m %s\n' "$*"; }
refuse() { printf '\n\033[31mREFUSED (%s)\033[0m %s\n\nNothing was installed. The timer is NOT armed.\n' "$1" "$2" >&2; exit "$1"; }

echo "install-cloud-backup — arming the encrypted off-site backup"
echo

# --- 1. prerequisites --------------------------------------------------------
command -v rclone  >/dev/null || refuse 2 "rclone is not installed. sudo apt install rclone"
command -v sqlite3 >/dev/null || refuse 2 "sqlite3 is not installed."
[ -f "$HERE/cloud-backup.sh" ] || refuse 2 "cloud-backup.sh is missing from $HERE"
ok "rclone $(rclone version | head -1 | awk '{print $2}'), sqlite3, scripts present"

# --- 2. config ---------------------------------------------------------------
[ -f "$ENV_FILE" ] || refuse 3 "$ENV_FILE does not exist.
     Create it (mode 0600) with at least:
       CHRISTINA_CLOUD_REMOTE=r2crypt:christina
       CHRISTINA_CLOUD_BWLIMIT=2M      # optional, keeps the uplink free for the museum"
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a
: "${CHRISTINA_CLOUD_REMOTE:=}"
[ -n "$CHRISTINA_CLOUD_REMOTE" ] || refuse 3 "CHRISTINA_CLOUD_REMOTE is unset in $ENV_FILE"
case "$CHRISTINA_CLOUD_REMOTE" in
  *REPLACE_ME*) refuse 3 "CHRISTINA_CLOUD_REMOTE is still the placeholder in $ENV_FILE" ;;
esac
PERM=$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%A' "$ENV_FILE")
[ "$PERM" = "600" ] || warn "$ENV_FILE is mode $PERM, not 600 — it holds credentials"
ok "config: $CHRISTINA_CLOUD_REMOTE"

# --- 3. the remote must be ENCRYPTED -----------------------------------------
# These are 15-second clips from a microphone in a residential garden. Shipping
# them to a third party in the clear is a decision nobody made deliberately, so
# it is refused rather than warned about.
REMOTE_NAME="${CHRISTINA_CLOUD_REMOTE%%:*}"
rclone config show "$REMOTE_NAME" 2>/dev/null | grep -q '^type = crypt' \
  || refuse 4 "$REMOTE_NAME is not a crypt remote (rclone config show '$REMOTE_NAME').
     Uploading through it would put readable filenames and playable garden audio
     in the provider's bucket. Point CHRISTINA_CLOUD_REMOTE at the crypt layer."
ok "$REMOTE_NAME is a crypt remote — filenames and contents encrypt on this box"

# --- 4. the passphrase must exist somewhere that is NOT this SD card ----------
# This is the whole ballgame. rclone stores the passphrase in rclone.conf only
# lightly obscured, and that file lives on the same card this backup exists to
# survive. If the card dies and the passphrase died with it, the cloud holds
# gigabytes of undecryptable noise: a backup that fails in exactly the scenario
# it was built for. There is no technical check for "is it in your password
# manager", so this is a deliberate, explicit human gate.
if [ "${CHRISTINA_CRYPT_PASSPHRASE_SAVED:-0}" != "1" ]; then
  refuse 6 "The crypt passphrase has not been confirmed saved OFF this box.

     rclone.conf holds it only lightly obscured, on the same SD card this backup
     exists to survive. If that card dies and the passphrase dies with it, every
     byte in the cloud is permanently unreadable.

     Put it in your password manager, then re-run with:
       CHRISTINA_CRYPT_PASSPHRASE_SAVED=1 $0"
fi
ok "passphrase confirmed saved off-box"

# --- 5. prove the remote works, with a real round trip -----------------------
# Not `rclone lsd` — reachability is not the same as writable, and writable is
# not the same as readable-back. Write a real object, read it back, compare.
PROBE="$(mktemp -t cloudprobe-XXXXXX)"; PROBE_BACK="$(mktemp -t cloudprobe-back-XXXXXX)"
trap 'rm -f "$PROBE" "$PROBE_BACK"' EXIT
head -c 4096 /dev/urandom > "$PROBE"
if ! rclone copyto "$PROBE" "${CHRISTINA_CLOUD_REMOTE%/}/.install-probe" --no-traverse 2>/dev/null; then
  refuse 5 "could not write a probe object to $CHRISTINA_CLOUD_REMOTE.
     Check the R2 credentials, the endpoint, and no_check_bucket=true if the API
     token is scoped to object-level permissions."
fi
rclone cat "${CHRISTINA_CLOUD_REMOTE%/}/.install-probe" > "$PROBE_BACK" 2>/dev/null \
  || refuse 5 "wrote the probe but could NOT read it back — the upload path reports success while the object is unreadable."
cmp -s "$PROBE" "$PROBE_BACK" \
  || refuse 5 "the probe read back DIFFERENT bytes than were written. Do not trust this remote."
ok "round trip proven: wrote 4096 random bytes, read them back, byte-identical"

# Prove the encryption is real, not just configured: the object must NOT be
# listable under its plaintext name on the underlying remote.
WRAPPED=$(rclone config show "$REMOTE_NAME" 2>/dev/null | sed -n 's/^remote = //p')
if [ -n "$WRAPPED" ] && rclone lsf "$WRAPPED" 2>/dev/null | grep -q '^\.install-probe$'; then
  refuse 4 "the probe is visible as '.install-probe' on the UNDERLYING remote ($WRAPPED).
     That means it was written in the clear — the crypt layer is being bypassed."
fi
ok "encryption verified: the object is not visible under its plaintext name"

# --- 6. install --------------------------------------------------------------
if [ "$DRY" = "1" ]; then
  echo; echo "DRY RUN — everything above passed; no units were installed."; exit 0
fi

render() { sed -e "s|/home/belkins|$HOME|g" -e "s|^User=belkins$|User=$USER_NAME|" "$1"; }
# continuity-r2 rides this installer because it writes through the SAME crypt
# remote every check above just validated — a separate installer would re-prove
# the same five facts or, worse, skip them.
for u in cloud-backup.service cloud-backup.timer continuity-r2.service continuity-r2.timer; do
  render "$HERE/$u" | sudo tee "$UNIT_DIR/$u" >/dev/null || refuse 2 "could not write $UNIT_DIR/$u"
  ok "installed $u"
done
sudo systemctl daemon-reload
sudo systemctl enable --now cloud-backup.timer >/dev/null 2>&1 || refuse 2 "could not enable cloud-backup.timer"
ok "cloud-backup.timer enabled"
sudo systemctl enable --now continuity-r2.timer >/dev/null 2>&1 || refuse 2 "could not enable continuity-r2.timer"
ok "continuity-r2.timer enabled (weekly: station identity + volume plates)"

echo
echo "Next, in this order:"
echo "  1. Seed by hand (the first ~1.6 GB, roughly an hour):"
echo "       bash $HERE/cloud-backup.sh"
echo "  2. Confirm the timer will fire:"
echo "       systemctl list-timers cloud-backup.timer"
echo "  3. NEGATIVE-TEST THE ALARM — a backup whose failure is silent is the"
echo "     failure this directory exists to prevent:"
echo "       sudo systemctl start christina-alert@cloud-backup.service"
echo "     Your phone should buzz. If it does not, fix that before trusting any of this."
