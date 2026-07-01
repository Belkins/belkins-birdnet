# Contributing to Belkins BirdNET

Thank you for wanting to make this better. Belkins BirdNET is a small, calm appliance — a Raspberry Pi and a $17 mic that name the birds outside your window and paint each one as a *kachō-e* illustration in a live collage. Contributions here are welcome and valued, whether that's a bug fix, a new forwarding recipe, a bird illustration, or a doc tweak. This guide covers how to set up, how to propose a change, and — importantly — how contributions are licensed.

## Relationship to upstream

Belkins BirdNET is a **standalone build** of [BirdNET-Pi](https://github.com/Nachtzuster/BirdNET-Pi), not a fork you PR back upstream. Everything we add lives under `avian/`, `web/`, `services/`, and `frame/`; everything else is upstream BirdNET-Pi. We track upstream by **cherry-picking** relevant fixes, not by auto-merging — so if you're fixing something in the base recorder/detector, it's usually better to send it to BirdNET-Pi first, and we'll pull it in. Changes to the Living Gallery, the realtime spine, the generator, or the frame belong here.

## Setting up a dev environment

You don't need a Pi to work on most of this.

**The collage (`web/`)** — a Vite + React + TypeScript shell. It runs with no backend at all against mock data:

```bash
cd web
npm install
npm run dev        # or: npm run dev:mock  (VITE_MOCK=1, no backend needed)
npm run build      # tsc -b && vite build — must stay green
npm run lint       # oxlint
```

`dev:mock` seeds from a canned snapshot and replays a fake SSE stream, so you can iterate on the collage on any laptop. Point it at a real Pi with `npm run dev:real`.

**The generator (`services/birdgen/`)** — the on-demand FastAPI service that paints birds not yet in the library. It deploys to Railway; see its `README.md` for running it locally. The Gemini key lives here and only here — never on the Pi, never in the collage.

**The Pi services (`avian/`)** — the realtime `birdcast` SSE spine, the forwarder, the illustration pipeline, and the PHP shims. These run on-device; `deploy-christina.sh` is the idempotent, additive deploy. Python 3.11+.

## Proposing a change

- **Something big** (a new view, a new data source, a change to how detections flow, anything touching the aesthetic) — **open an issue first** so we can agree on the shape before you build. Use the issue templates in `.github/ISSUE_TEMPLATE`.
- **Something small** (a typo, a clear bug, a tidy refactor within existing style) — just open a PR.

Please **do not report security issues in public issues.** Belkins BirdNET is a LAN-first appliance and should not be exposed to the public internet without a reverse proxy, auth, and hardening. Report vulnerabilities privately via GitHub's **"Report a vulnerability"** button on the repo's Security tab, or email **vladislav@belkins.io**.

## What a PR needs to honor

Every change is measured against the four product pillars. A PR that breaks one of these won't merge, however clean the code:

1. **Museum, not dashboard.** Calm and editorial. No clutter, no chartjunk, no notification noise.
2. **The honesty firewall.** One real data stream. Never show fabricated, estimated, interpolated, or placeholder data as if it were real. If a value is unknown, say so or omit it — don't invent it.
3. **No engagement dark patterns.** No streaks, leaderboards, badges, FOMO, or manipulative counters.
4. **Local-first and unattended.** It should run for weeks on a windowsill with nobody watching.

Concretely, for a PR:

- **Match the existing style.** Read the neighboring code first and conform to it.
- **Keep TypeScript strict.** No `any`, no `@ts-ignore` to paper over a type. `npm run build` and `npm run lint` must pass.
- **Include screenshots** (or a short clip) for any UI change — ideally in both the nocturne and day themes.
- **Keep changes surgical.** Touch what the change needs; don't refactor adjacent code in the same PR.
- Write a clear description of what changed and why it honors the pillars above.

## The role of art contributions

The illustrations *are* the product. New or improved *kachō-e* birds — every species ships in a perched **and** a flight pose — are genuinely welcome, as are region-specific styling improvements to the Gemini pipeline in `avian/scripts/`. If you're contributing art, aim for the bundled house style (see `avian/scripts/prompt.template.md`) and confirm the ground is cleanly cut so the collage masks build correctly. Open an issue first for a whole new set so we can coordinate.

## Licensing of contributions

**Please read this before you contribute.**

Belkins BirdNET is licensed under **CC-BY-NC-SA 4.0** (Creative Commons Attribution–NonCommercial–ShareAlike 4.0), inherited from Cornell's BirdNET model and Nachtzuster/BirdNET-Pi. **By submitting a contribution — code, illustrations, or docs — you agree to license it under CC-BY-NC-SA 4.0.** You keep the copyright to your work; you're granting everyone the right to use it under those terms.

In plain language:

- It's a **non-commercial** license. The software **may not be sold.**
- Contributed illustrations and artwork are **non-commercial and must not be resold** — not by us, not by anyone. If the project maintainers ever commercialize artwork, it is strictly their **own original** work, never a contributor's.
- **ShareAlike** means derivatives must carry the same license. You can't relicense it under something more permissive or more restrictive.
- Credit stays attached: contributors are attributed, and we credit our upstreams — **Nachtzuster/BirdNET-Pi**, the **Cornell Lab of Ornithology** for the BirdNET model, and **AvianVisitors (Twarner491)**, whose live-collage concept inspired this build.

If you can't contribute your work under CC-BY-NC-SA 4.0, please don't submit it — open an issue instead and we'll talk.

---

Thanks for helping the dawn chorus find its way onto the wall.
