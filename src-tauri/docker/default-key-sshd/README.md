# E2E test fixture — publickey auth for the default-keypath integration test.

This directory contains a THROWAWAY test keypair used by
`docker_ssh_default_keypath_fallback` in src-tauri/src/ssh/tests.rs.

- `id_rsa` — private key, copied by the test into a temp `$HOME/.ssh/` to act
  as the users default SSH key (the fallback target of `resolve_private_key_path`).
- `id_rsa.pub` — baked into the image as testusers authorized_keys.
- `Dockerfile` — the server fixture (Alpine OpenSSH, publickey-only auth).

To regenerate the keypair, delete both files and re-run `ssh-keygen -t ed25519
-N "" -C "r-shell-e2e-test-key" -f id_rsa` in this directory, then rebuild.
Never use these keys anywhere outside tests.
