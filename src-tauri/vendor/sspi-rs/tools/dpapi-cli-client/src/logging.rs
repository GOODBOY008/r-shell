use std::fs::OpenOptions;

use tracing_subscriber::EnvFilter;
use tracing_subscriber::prelude::*;

const DPAPI_LOG_PATH_ENV: &str = "DPAPI_LOG_PATH";

pub fn init_logging() {
    let path = if let Ok(path) = std::env::var(DPAPI_LOG_PATH_ENV) {
        path
    } else {
        eprintln!(
            "[DPAPI] {} environment variable is not set. Logging is disabled.",
            DPAPI_LOG_PATH_ENV
        );
        return;
    };

    let file = match OpenOptions::new().create(true).append(true).open(&path) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("[DPAPI] Couldn't open log file: {e}. File path: {}", path);
            return;
        }
    };

    let fmt_layer = tracing_subscriber::fmt::layer()
        .pretty()
        .with_thread_names(true)
        .with_writer(file);

    tracing_subscriber::registry()
        .with(fmt_layer)
        .with(EnvFilter::from_env("DPAPI_LOG_LEVEL"))
        .init();
}
