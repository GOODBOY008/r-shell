macro_rules! check_handle {
    ($x:expr) => {{
        if $x == 0 {
            return u32::from(winscard::ErrorKind::InvalidHandle);
        }
    }};
    ($x:expr, $name:expr) => {{
        use winscard::{Error, ErrorKind};

        if $x == 0 {
            return Err(Error::new(ErrorKind::InvalidHandle, $name));
        }
    }};
}

macro_rules! try_execute {
    ($x:expr) => {{
        match $x {
            Ok(value) => value,
            Err(err) => {
                error!(%err, "an error occurred");
                return u32::from(err.error_kind);
            }
        }
    }};
    ($x:expr, $err_value:expr) => {{
        match $x {
            Ok(val) => val,
            Err(err) => {
                error!(%err, "an error occurred");
                return $err_value.into();
            }
        }
    }};
}

macro_rules! check_null {
    ($x:expr) => {{
        if $x.is_null() {
            return u32::from(winscard::ErrorKind::InvalidParameter);
        }
    }};
    ($x:expr, $name:expr) => {{
        use winscard::{Error, ErrorKind};

        if $x.is_null() {
            return Err(Error::new(ErrorKind::InvalidParameter, $name));
        }
    }};
}
