macro_rules! try_execute {
    ($x:expr) => {{
        match $x {
            Ok(value) => value,
            Err(err) => {
                error!(%err, "an error occurred");
                return err.error_type.to_u32().unwrap();
            }
        }
    }};
    ($x:expr, $err_value:expr) => {{
        use num_traits::ToPrimitive;

        match $x {
            Ok(val) => val,
            Err(err) => {
                error!(%err, "an error occurred");
                return $err_value.to_u32().unwrap();
            }
        }
    }};
}

macro_rules! check_null {
    ($x:expr) => {{
        use num_traits::ToPrimitive;
        use sspi::ErrorKind;

        if $x.is_null() {
            return ErrorKind::InvalidParameter.to_u32().unwrap();
        }
    }};
}

macro_rules! catch_panic {
    ($($tokens:tt)*) => {{
        use sspi::ErrorKind;
        use num_traits::ToPrimitive;

        match std::panic::catch_unwind(move || { $($tokens)* }) {
            Ok(val) => val,
            Err(_) => {
                return ErrorKind::InternalError.to_u32().unwrap();
            }
        }
    }};
}
