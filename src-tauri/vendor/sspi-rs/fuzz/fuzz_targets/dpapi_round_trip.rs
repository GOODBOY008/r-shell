#![no_main]

extern crate dpapi_fuzzing;
extern crate libfuzzer_sys;

use dpapi_fuzzing::generator::AnyStruct;
use dpapi_fuzzing::oracles::round_trip;

libfuzzer_sys::fuzz_target!(|any: AnyStruct| {
    round_trip(any);
});
