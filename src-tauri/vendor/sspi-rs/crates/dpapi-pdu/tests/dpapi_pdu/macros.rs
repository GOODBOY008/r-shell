macro_rules! test_encoding_decoding {
    ($name:ident, $type:ty, $expected:expr, $data:expr) => {
        paste::paste! {
            #[test]
            fn [<$name:lower _encoding_decoding>]() {
                use dpapi_core::{EncodeVec, DecodeOwned, ReadCursor};

                let data = $data;

                let parsed = $type::decode_owned(&mut ReadCursor::new(data.as_slice())).unwrap();
                let encoded = parsed.encode_vec().unwrap();

                assert_eq!($expected, parsed);
                assert_eq!(data[..], encoded[..]);
            }
        }
    };
}
