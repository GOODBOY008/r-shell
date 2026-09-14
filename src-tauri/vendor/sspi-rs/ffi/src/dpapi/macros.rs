macro_rules! check_null {
    ($x:expr) => {{
        if $x.is_null() {
            // https://learn.microsoft.com/en-us/windows/win32/api/ncryptprotect/nf-ncryptprotect-ncryptprotectsecret#return-value
            return crate::dpapi::NTE_INVALID_PARAMETER;
        }
    }};
}

macro_rules! try_execute {
    ($x:expr, $err_value:expr) => {{
        match $x {
            Ok(val) => val,
            Err(err) => {
                error!(%err, "an error occurred");
                return $err_value;
            }
        }
    }};
}

macro_rules! catch_panic {
    ($($tokens:tt)*) => {{
        match std::panic::catch_unwind(move || { $($tokens)* }) {
            Ok(val) => val,
            Err(_) => {
                return crate::dpapi::NTE_INTERNAL_ERROR;
            }
        }
    }};
}
