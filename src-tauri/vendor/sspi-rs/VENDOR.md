# Vendored sspi-rs

Upstream: https://github.com/Devolutions/sspi-rs

Base: commit `09088ac` — identical to the `sspi 0.21.3` release published to
crates.io (2026-07-16).

Cherry-picks applied on top (both fix CredSSP/NLA behaviour for RDP):

1. `fix(auth_identity): accept @ in down-level account names` — upstream
   PR #719, commit `4878c505`.
2. `fix(kerberos): remove unnecessary sequence number incrementation` —
   upstream PR #717, commit `6d177082`.

Why not sspi-rs master (0.21.4)? Master pins `picky = "=7.0.0-rc.26"`, while
`ironrdp-connector 0.10.0` (via `ironrdp 0.17`) pins `picky = "=7.0.0-rc.25"`
and passes picky types (`picky_asn1_x509::Certificate`, `picky::PrivateKey`)
across the ironrdp→sspi API boundary in its smart-card CredSSP path, so the
two picky prereleases cannot coexist in one graph.

This directory is wired in via `[patch.crates-io]` in `src-tauri/Cargo.toml`.
Remove the patch (and this directory) once a crates.io sspi release compatible
with ironrdp's picky pin is published — i.e. any release that keeps
`picky =7.0.0-rc.25`, or an ironrdp update that moves to the newer picky.
