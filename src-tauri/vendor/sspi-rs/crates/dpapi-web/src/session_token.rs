use std::io::Error;

use dpapi_transport::GetSessionTokenFn;
use url::Url;
use uuid::Uuid;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

/// This function wraps a JS-function into a Rust closure which we can pass into the Rust API.
pub(crate) fn session_token_fn(get_session_token: js_sys::Function) -> Box<GetSessionTokenFn> {
    Box::new(move |session_id: Uuid, destination: Url| {
        let get_session_token = get_session_token.clone();
        Box::pin(async move {
            let session_id = JsValue::from_str(&session_id.to_string());
            let destination = JsValue::from_str(destination.as_str());

            let promise = get_session_token
                .call2(&JsValue::NULL, &session_id, &destination)
                .map_err(|err| Error::other(format!("failed to obtain the session token: {:?}", err)))?
                .dyn_into::<js_sys::Promise>()
                .map_err(|err| Error::other(format!("failed to obtain the session token: {:?}", err)))?;

            let session_token = JsFuture::from(promise)
                .await
                .map_err(|err| Error::other(format!("failed to obtain the session token: {:?}", err)))?;

            session_token
                .as_string()
                .ok_or_else(|| Error::other("obtained session token is not a String"))
        })
    })
}
