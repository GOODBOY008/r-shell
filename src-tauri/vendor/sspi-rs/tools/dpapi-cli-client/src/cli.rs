use std::path::PathBuf;

xflags::xflags! {
    /// DPAPI cli client. This app is used to encrypt/decrypt secrets using the DPAPI.
    cmd dpapi {
        /// Target server hostname.
        /// For example, win-956cqossjtf.tbt.com.
        required --server server: String

        /// Websocket proxy address.
        /// For example, ws://devolutions-gateway.tbt.com:7171/jet/fwd/tcp
        optional --proxy-address proxy_address: String

        /// The username to decrypt/encrypt the DPAPI blob.
        /// The username can be specified in FQDN (DOMAIN\username) or UPN (username@domain) format.
        required --username username: String

        /// User's password.
        required --password password: String

        /// Client's computer name. This parameter is optional.
        /// If not provided, the current computer name will be used.
        optional --computer-name computer_name: String

        /// Encrypt secret.
        /// This command simulates the `NCryptProtectSecret` function. The encrypted secret (DPAPI blob) will be printed to stdout.
        cmd encrypt {
            /// User's SID.
            required --sid sid: String

            /// Secret to encrypt.
            /// This parameter is optional. If not provided, the app will try to read the secret from stdin.
            optional --secret secret: String
        }

        cmd decrypt {
            /// Path to file that contains DPAPI blob.
            /// This parameter is optional. If not provided, the app will try to read the DPAPI blob from stdin.
            optional --file file: PathBuf
        }
    }
}
