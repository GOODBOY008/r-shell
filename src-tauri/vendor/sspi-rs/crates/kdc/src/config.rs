/// Domain user credentials.
#[derive(PartialEq, Eq, Debug, Clone)]
pub struct DomainUser {
    /// Username in FQDN format (e.g. "pw13@example.com").
    pub username: String,
    /// User password.
    pub password: String,
    /// Salt for generating the user's key.
    ///
    /// Usually, it is equal to `{REALM}{username}` (e.g. "EXAMPLEpw13").
    pub salt: String,
}

/// Kerberos server config
///
/// This config is used to configure the Kerberos server during RDP proxying.
#[derive(PartialEq, Eq, Debug, Clone)]
pub struct KerberosServer {
    /// KDC and Kerberos Application Server realm.
    ///
    /// For example, `cd9bee03-b0aa-49dd-bad7-568b595c8024.jet`.
    pub realm: String,
    /// Users credentials inside fake KDC.
    pub users: Vec<DomainUser>,
    /// The maximum allowed time difference between client and proxy clocks.
    ///
    /// The value must be in seconds.
    pub max_time_skew: u64,
    /// krbtgt service key.
    ///
    /// This key is used to encrypt/decrypt TGT tickets.
    pub krbtgt_key: Vec<u8>,
    /// Ticket decryption key.
    ///
    /// This key is used to decrypt the TGS ticket sent by the client. If you do not plan
    /// to use Kerberos U2U authentication, then the `ticket_decryption_key` is required.
    pub ticket_decryption_key: Option<Vec<u8>>,
    /// The domain user credentials for the Kerberos U2U authentication.
    ///
    /// This field is needed only for Kerberos User-to-User authentication. If you do not plan
    /// to use Kerberos U2U, do not specify it.
    pub service_user: Option<DomainUser>,
}
