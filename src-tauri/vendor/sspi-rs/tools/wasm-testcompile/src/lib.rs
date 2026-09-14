use sspi::ntlm::NtlmConfig;
use sspi::{credssp, AuthIdentity, Credentials, Username};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn credssp_client() {
    let identity = AuthIdentity {
        username: Username::parse("NETBIOSDMN\\AccountName").unwrap(),
        password: String::from("secret").into(),
    };

    let mut cred_ssp_client = credssp::CredSspClient::new(
        Vec::new(),
        Credentials::AuthIdentity(identity),
        credssp::CredSspMode::WithCredentials,
        credssp::ClientMode::Negotiate(sspi::NegotiateConfig {
            protocol_config: Box::<NtlmConfig>::default(),
            package_list: None,
            client_computer_name: "win2017".into(),
        }),
        String::new(),
    )
    .unwrap();

    let next_ts_request = credssp::TsRequest::default();

    let result = cred_ssp_client.process(next_ts_request).unwrap();

    std::hint::black_box(result);
}
