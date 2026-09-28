macro_rules! kout {
    ($name:ident, $size:ident) => {
        pub(crate) struct $name;

        impl digest::common::KeySizeUser for $name {
            type KeySize = digest::consts::$size;
        }
    };
}

kout!(Kout32, U32);
kout!(Kout64, U64);
