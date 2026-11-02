//! Reproducible decode-only comparison; generated inputs contain no remote data.
use std::hint::black_box;
use std::time::{Duration, Instant};

fn measure(mut decode: impl FnMut()) -> f64 {
    let start = Instant::now();
    let mut count = 0u64;
    loop {
        for _ in 0..256 {
            decode();
        }
        count += 256;
        if start.elapsed() >= Duration::from_millis(100) {
            return start.elapsed().as_nanos() as f64 / count as f64;
        }
    }
}

fn compare(name: &str, bytes: usize, mut old: impl FnMut(), mut new: impl FnMut()) {
    for _ in 0..100 {
        old();
        new();
    }
    let mut before = Vec::new();
    let mut after = Vec::new();
    for round in 0..7 {
        // Alternate order to reduce warm-up, thermal and frequency bias.
        if round % 2 == 0 {
            before.push(measure(&mut old));
            after.push(measure(&mut new));
        } else {
            after.push(measure(&mut new));
            before.push(measure(&mut old));
        }
    }
    before.sort_by(f64::total_cmp);
    after.sort_by(f64::total_cmp);
    println!(
        "{name},{bytes},{:.1},{:.1},{:.3}",
        before[3],
        after[3],
        before[3] / after[3]
    );
}

fn coefficients(kind: &str) -> Vec<i16> {
    let mut seed = 0x5273484cu32;
    (0..4096)
        .map(|i| {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            match kind {
                "flat" => 0,
                "sparse" if i % 37 != 0 => 0,
                _ => ((seed >> 24) % 31) as i16 - 15,
            }
        })
        .collect()
}

fn main() {
    println!("case,encoded_bytes,old_ns_per_tile,new_ns_per_tile,speedup");
    for kind in ["flat", "sparse", "dense"] {
        let input = coefficients(kind);
        for rlgr3 in [false, true] {
            let old_mode = if rlgr3 {
                pdu_old::codecs::rfx::EntropyAlgorithm::Rlgr3
            } else {
                pdu_old::codecs::rfx::EntropyAlgorithm::Rlgr1
            };
            let new_mode = if rlgr3 {
                pdu_new::codecs::rfx::EntropyAlgorithm::Rlgr3
            } else {
                pdu_new::codecs::rfx::EntropyAlgorithm::Rlgr1
            };
            let mut encoded = vec![0; 65536];
            let len = graphics_new::rlgr::encode(new_mode, &input, &mut encoded).unwrap();
            encoded.truncate(len);
            let mut old_output = vec![0i16; 4096];
            let mut new_output = vec![0i16; 4096];
            graphics_old::rlgr::decode(old_mode, &encoded, &mut old_output).unwrap();
            graphics_new::rlgr::decode(new_mode, &encoded, &mut new_output).unwrap();
            assert_eq!(old_output, input, "old RLGR round-trip: {kind}");
            assert_eq!(new_output, input, "new RLGR round-trip: {kind}");
            let mode_name = if rlgr3 { "rlgr3" } else { "rlgr1" };
            compare(
                &format!("{mode_name}-{kind}"),
                len,
                || {
                    graphics_old::rlgr::decode(
                        old_mode,
                        black_box(&encoded),
                        black_box(&mut old_output),
                    )
                    .unwrap();
                },
                || {
                    graphics_new::rlgr::decode(
                        new_mode,
                        black_box(&encoded),
                        black_box(&mut new_output),
                    )
                    .unwrap();
                },
            );

            let old_tile = pdu_old::codecs::rfx::Tile {
                y_quant_index: 0,
                cb_quant_index: 0,
                cr_quant_index: 0,
                x: 0,
                y: 0,
                y_data: &encoded,
                cb_data: &encoded,
                cr_data: &encoded,
            };
            let new_tile = pdu_new::codecs::rfx::Tile {
                y_quant_index: 0,
                cb_quant_index: 0,
                cr_quant_index: 0,
                x: 0,
                y: 0,
                y_data: &encoded,
                cb_data: &encoded,
                cr_data: &encoded,
            };
            let old_quants = [pdu_old::codecs::rfx::Quant::default()];
            let new_quants = [pdu_new::codecs::rfx::Quant::default()];
            let mut old_decoder = graphics_old::rfx::TileDecoder::new();
            let mut new_decoder = graphics_new::rfx::TileDecoder::new();
            assert_eq!(
                old_decoder
                    .decode(&old_tile, &old_quants, old_mode)
                    .unwrap(),
                new_decoder
                    .decode(&new_tile, &new_quants, new_mode)
                    .unwrap(),
                "RFX pixel mismatch: {kind}"
            );
            compare(
                &format!("rfx-{mode_name}-{kind}"),
                len * 3,
                || {
                    black_box(
                        old_decoder
                            .decode(black_box(&old_tile), &old_quants, old_mode)
                            .unwrap(),
                    );
                },
                || {
                    black_box(
                        new_decoder
                            .decode(black_box(&new_tile), &new_quants, new_mode)
                            .unwrap(),
                    );
                },
            );
        }
    }

    // The current R-Shell configuration uses bitmap updates, not RemoteFX/EGFX.
    // Include its RDP6 planar decoder as a control, with and without RLE.
    let rgb: Vec<u8> = (0..4096)
        .flat_map(|i| {
            let value = if (i / 64 / 8 + i % 64 / 8) % 2 == 0 {
                32
            } else {
                220
            };
            [value, 64, 255 - value]
        })
        .collect();
    for rle in [false, true] {
        let mut encoded = vec![0; 65536];
        let len = graphics_new::rdp6::BitmapStreamEncoder::new(64, 64)
            .encode_bitmap::<graphics_new::rdp6::RgbChannels>(&rgb, &mut encoded, rle)
            .unwrap();
        encoded.truncate(len);
        let mut old_decoder = graphics_old::rdp6::BitmapStreamDecoder::default();
        let mut new_decoder = graphics_new::rdp6::BitmapStreamDecoder::default();
        let mut old_output = Vec::new();
        let mut new_output = Vec::new();
        old_decoder
            .decode_bitmap_stream_to_rgb24(&encoded, &mut old_output, 64, 64)
            .unwrap();
        new_decoder
            .decode_bitmap_stream_to_rgb24(&encoded, &mut new_output, 64, 64)
            .unwrap();
        assert_eq!(old_output, rgb);
        assert_eq!(new_output, rgb);
        compare(
            if rle { "rdp6-rle" } else { "rdp6-raw" },
            len,
            || {
                old_decoder
                    .decode_bitmap_stream_to_rgb24(
                        black_box(&encoded),
                        black_box(&mut old_output),
                        64,
                        64,
                    )
                    .unwrap();
            },
            || {
                new_decoder
                    .decode_bitmap_stream_to_rgb24(
                        black_box(&encoded),
                        black_box(&mut new_output),
                        64,
                        64,
                    )
                    .unwrap();
            },
        );
    }
}
