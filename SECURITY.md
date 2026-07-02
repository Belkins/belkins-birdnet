# Security Policy

Belkins BirdNET is a LAN-first appliance: a Raspberry Pi and a USB microphone that
listens for birds, names them with Cornell's BirdNET, and paints each one into a
live *kachō-e* collage. It is meant to run quietly on your home network, not to face
the public internet. This document explains what we support, how to report a
vulnerability, and how the box is hardened.

## Supported versions

Belkins BirdNET is an appliance, not a versioned software product. There are no
tagged releases or long-lived release branches to backport fixes to. The supported
line is simply the **`main` branch** — the code the installer pulls when you run it,
and the code a re-run of the installer converges you back onto.

| Line | Supported |
|------|-----------|
| `main` (latest) | ✅ Yes |
| Older checkouts / forks | ⚠️ Re-run the installer to update; no separate patches |

If you are on an older checkout, the fix for almost anything is to pull `main` and
re-run the installer. It is additive, idempotent, and self-heals the security-relevant
configuration described below.

## Reporting a vulnerability

**Please report privately. Do not open a public GitHub issue for a security problem.**

Two private channels, either is fine:

- **GitHub → the repo's *Security* tab → "Report a vulnerability"** (private
  vulnerability reporting). This is the preferred route — it keeps the report,
  the discussion, and the fix in one place.
- **Email [vladislav@belkins.io](mailto:vladislav@belkins.io)** if you'd rather not
  use GitHub.

A useful report includes what you found, where (file, endpoint, or install step),
how to reproduce it, and what an attacker could do with it. Proof-of-concept steps
are welcome.

We are a small team, so please set expectations accordingly: we aim to acknowledge a
report within **a few days**, confirm the issue, and work a fix on `main`. We'll keep
you in the loop and are glad to credit you once a fix has shipped, if you'd like.
Please give us a reasonable window to fix things before disclosing publicly.

## Security model & hardening

Belkins BirdNET is designed to be a **local-first, unattended appliance on a trusted
LAN**. Two properties are worth understanding before you deploy it:

**The public PHP surface runs unprivileged.** The Caddy web server and the PHP-FPM
pool that serve the collage and the admin overlay run as the low-privilege `caddy`
user — not as root. That user is granted a **least-privilege `sudoers` allowlist**:
only the exact `systemctl restart …` and `journalctl -u …` commands on the BirdNET
service units that the admin overlay actually calls. It is **not** blanket root. A
prior blanket `NOPASSWD: ALL` rule was removed, and the installer deletes it on every
run — so an already-installed box self-heals the moment the installer re-runs. The
intent is that even a bug in a PHP endpoint cannot escalate to a full-root RCE.

**It is not meant for the public internet.** The appliance assumes a trusted home
network and has no built-in authentication on the collage itself. **Do not expose the
Pi directly to the internet.** If you need remote access, put it behind a reverse
proxy that terminates TLS and enforces authentication, and harden the box first. The
bundled Cloudflare Tunnel recipe is a convenience, not a hardening layer — the same
"add auth in front of it" advice applies.

A few practical notes:

- Keep the Pi on your LAN; reach it at `http://birdnet.local/`.
- The optional off-LAN forwarding recipes (Cloudflare / Home Assistant / MQTT) and
  the auto-gen forwarder send data outward — review each before enabling it, and note
  that the Gemini API key for auto-generation lives only on the Railway service, never
  on the Pi.
- Re-run the installer after updating so the sudoers allowlist and other config stay
  in their intended, least-privilege state.

## Scope

**In scope** — the code this project adds and operates:

- The PHP API surface under `avian/api/` (e.g. the cutout resolver and status/admin
  endpoints) and the collage frontend it serves.
- The installer and its service/`sudoers`/Caddy configuration
  (`scripts/install_services.sh` and friends).
- The realtime spine and forwarder (`avian/realtime/`) and the on-demand generator
  service (`services/birdgen/`).

**Out of scope** — upstream projects we build on. Please report these to their
maintainers:

- **[BirdNET-Pi](https://github.com/Nachtzuster/BirdNET-Pi)** (Nachtzuster · Patrick
  McGuire) — the recording and detection foundation. Issues in stock BirdNET-Pi code
  belong upstream.
- **The BirdNET model** — © the K. Lisa Yang Center for Conservation Bioacoustics,
  [Cornell Lab of Ornithology](https://www.birds.cornell.edu/ccb/). Model behaviour
  and accuracy questions go to Cornell, not here.
- The live-collage concept was inspired by
  [AvianVisitors](https://github.com/Twarner491/AvianVisitors/tree/avian-visitors)
  (Twarner491).

If you're unsure whether something is ours or upstream, report it to us anyway — we'd
rather triage it than have it fall through the cracks.

---

*Belkins BirdNET is distributed under CC-BY-NC-SA 4.0, inherited from BirdNET-Pi and
Cornell's BirdNET. Reporting a vulnerability, like everything else here, is a
non-commercial, good-faith contribution — thank you for helping keep the gallery
safe.*
