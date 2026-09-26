# SSPI FFI

Implements multiple APIs, exported as a single dynamic library:

1. Implements [Windows SSPI]-compatible API, based on `sspi` crate.
2. Implements [Windows WinSCard]-compatible API, with support for emulated and system-provided smart cards.
3. Implements [Windows DPAPI]. While exported functions are not compatible with Windows DPAPI, output blobs are.

[Windows SSPI]: https://learn.microsoft.com/en-us/windows/win32/rpc/security-support-provider-interface-sspi-
[Windows WinSCard]: https://learn.microsoft.com/ru-ru/windows/win32/api/winscard/
[DPAPI]: https://learn.microsoft.com/en-us/windows/win32/seccng/cng-dpapi

# Feature flags

As all APIs are bundled in the same dynamic library, this crate provides feature flags to enable relevant parts:

- `tsssp` to enable the CredSSP security package in the SSPI API. Note that Kerberos/NTLM/Negotiate security packages are always available, even without this flag.
- `scard` to enable WinSCard.
- `dpapi` to enable DPAPI.

Two features can be enabled to use an alternate rustls crypto provider:

- `aws-lc-rs` to use [aws-lc-rs] crate (takes precedence over `ring`).
- `ring` to use [ring] crate.

[aws-lc-rs]: https://github.com/aws/aws-lc-rs
[ring]: https://docs.rs/ring/latest/ring/

# Logging

Two environmental variables control logging:

1. `SSPI_LOG_PATH` enables logging when set and specifies the file where logs will be written.
2. `SSPI_LOG_LEVEL` sets the log filter. See [`tracing-subscriber`’s documentation][tracing-doc] for more details.

[tracing-doc]: https://docs.rs/tracing-subscriber/latest/tracing_subscriber/

# Note

This crate is part of the [sspi-rs] project.

[sspi-rs]: https://github.com/Devolutions/sspi-rs
