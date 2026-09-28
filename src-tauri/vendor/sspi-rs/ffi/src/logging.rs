use std::fs::OpenOptions;
use std::path::PathBuf;
use std::sync::Once;

use tracing_subscriber::EnvFilter;
use tracing_subscriber::prelude::*;

static SETUP: Once = Once::new();

const SSPI_LOG_PATH_ENV: &str = "SSPI_LOG_PATH";

pub fn setup_logger() {
    SETUP.call_once(|| {
        let path = if let Ok(path) = std::env::var(SSPI_LOG_PATH_ENV) {
            println!("[SSPI-DEBUG] SSPI_LOG_PATH = {path}");
            PathBuf::from(path)
        } else {
            return;
        };

        let file = match OpenOptions::new().create(true).append(true).open(path) {
            Ok(f) => f,
            Err(e) => {
                println!("[SSPI-DEBUG] Couldn't open log file: {e}");
                return;
            }
        };

        let fmt_layer = tracing_subscriber::fmt::layer()
            .pretty()
            .with_thread_names(true)
            .with_writer(file);

        tracing_subscriber::registry()
            .with(fmt_layer)
            .with(EnvFilter::from_env("SSPI_LOG_LEVEL"))
            .init();

        std::panic::set_hook(Box::new(move |panic| {
            if let Some(location) = panic.location() {
                error!(
                    message = %panic,
                    panic.file = location.file(),
                    panic.line = location.line(),
                    panic.column = location.column(),
                );
            } else {
                error!(message = %panic);
            }
        }));
    })
}

/// FFI function to call in order to manually setup the debug logger.
///
/// Under normal circumstances, it is not required to call this function.
/// Indeed `InitSecurityInterface*` family functions will trigger the same
/// behavior. However, you can call this directly if you need to manually set up the logger
/// (maybe in order to debug `InitSecurityInterface*`).
///
/// This function can be called multiple times safely.
#[unsafe(no_mangle)]
pub extern "system" fn RustSspiSetupLogger() {
    setup_logger();
}
