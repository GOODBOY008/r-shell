use wasm_bindgen::prelude::wasm_bindgen;

#[wasm_bindgen]
pub struct DpapiError {
    error: anyhow::Error,
}

#[wasm_bindgen]
impl DpapiError {
    pub fn backtrace(&self) -> String {
        format!("{:?}", self.error)
    }
}

impl From<anyhow::Error> for DpapiError {
    fn from(e: anyhow::Error) -> Self {
        Self { error: e }
    }
}

impl From<dpapi::Error> for DpapiError {
    fn from(err: dpapi::Error) -> Self {
        Self {
            error: anyhow::Error::new(err),
        }
    }
}

impl From<url::ParseError> for DpapiError {
    fn from(err: url::ParseError) -> Self {
        Self {
            error: anyhow::Error::new(err),
        }
    }
}
