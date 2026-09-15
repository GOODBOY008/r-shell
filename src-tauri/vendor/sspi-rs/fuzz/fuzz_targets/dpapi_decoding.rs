#![no_main]

extern crate dpapi_fuzzing;
extern crate libfuzzer_sys;

use dpapi_fuzzing::oracles::structure_decoding;

libfuzzer_sys::fuzz_target!(|data: &[u8]| {
    structure_decoding(data);
});
