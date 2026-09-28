#![no_main]
#[macro_use]
extern crate libfuzzer_sys;
extern crate sspi;

use sspi::credssp::TsRequest;

fuzz_target!(|data: &[u8]| {
    if let Ok(req) = TsRequest::from_buffer(data) {
        let _req_len = req.buffer_len();
        let _result = req.check_error();
    }

    let _creds = sspi::credssp::read_ts_credentials(data);
});
