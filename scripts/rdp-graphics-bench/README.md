# IronRDP graphics comparison

Run from the repository root:

```sh
cargo run --release --locked --manifest-path scripts/rdp-graphics-bench/Cargo.toml > results.csv
```

This standalone executable compares `ironrdp-graphics` 0.10.0 with 0.11.0.
The older dependencies belong only to this benchmark; the desktop app still
uses one aligned IronRDP release family. The lockfile pins both versions.

## What is measured

Each case decodes a 64 × 64 tile. Flat, sparse and dense coefficient arrays
are deterministic synthetic inputs, generated with seed `0x5273484c` and
encoded before timing. Both RLGR1 and RLGR3 run separately. The RemoteFX
cases also include sub-band reconstruction, dequantization, inverse DWT and
YCbCr-to-RGBA conversion. The RDP6 control cases use a generated RGB checkerboard,
with and without planar RLE.

The executable verifies both RLGR decoders reproduce the original coefficients,
both full RemoteFX decoders produce identical RGBA pixels, and both RDP6 decoders
reproduce the original RGB pixels. It fails before reporting timings if any
comparison fails. No captured desktops, credentials or server connections are used.

For each case, it warms both decoders for 100 iterations, then takes seven
samples of at least 100 ms per version. Each sample processes batches of 256
tiles. The execution order alternates between versions. Buffers are reused,
inputs and outputs pass through `black_box`, and the CSV reports median
nanoseconds per tile. A speedup above 1 means the new version was faster.

## Recorded result, 2026-11-03

Environment: Apple M4, macOS 27.0.1 (26A434), rustc 1.99.1, release profile
with thin LTO and one codegen unit. Application base: `181cd1a`.
Raw measurements are in [results.csv](results.csv).

| Decoder | Flat | Sparse | Dense |
| --- | ---: | ---: | ---: |
| RLGR1 only | 1.33× | 3.49× | 3.32× |
| RLGR3 only | 1.28× | 3.39× | 4.98× |
| Full RemoteFX, RLGR1 | 1.01× | 1.79× | 3.11× |
| Full RemoteFX, RLGR3 | 1.01× | 1.78× | 4.39× |

RDP6 raw and RLE controls measured 1.08× and 1.02× respectively. These small
differences should not be treated as an application performance improvement.
Results depend on hardware and input distribution; these synthetic tiles do
not estimate a typical remote desktop workload or provide confidence intervals.

## Effect on R-Shell

R-Shell currently negotiates ordinary bitmap updates (`bitmap: None`) and does
not advertise the EGFX dynamic graphics channel. The RLGR improvements therefore
do not establish a speedup for its current sessions. Network latency, frame
copying, WebSocket delivery, canvas painting and native presentation are outside
this measurement; it is not an FPS or end-to-end latency benchmark.

The result supports investigating RemoteFX for suitable servers. Enabling EGFX
requires registering its channel processor, handling its compositor output and
validating reactivation, resize, fallback and rendering against a real server.
This change does not advertise an unhandled graphics channel or make an
application-wide speed claim.

See the pinned upstream [graphics changelog](https://github.com/Devolutions/IronRDP/blob/ironrdp-graphics-v0.11.0/crates/ironrdp-graphics/CHANGELOG.md)
and [connector configuration](https://github.com/Devolutions/IronRDP/blob/ironrdp-connector-v0.12.0/crates/ironrdp-connector/src/lib.rs)
for the release changes and EGFX negotiation contract.
