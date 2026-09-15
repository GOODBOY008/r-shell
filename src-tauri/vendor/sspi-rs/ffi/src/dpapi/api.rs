#[cfg(not(any(test, miri)))]
mod inner {
    pub(crate) use dpapi::{n_crypt_protect_secret, n_crypt_unprotect_secret};
}

#[cfg(any(test, miri))]
mod inner {
    //! We have FFI wrappers for DPAPI functions from the [dpapi] crate and we want to test them.
    //! The DPAPI implementation is complex and makes calls to the RPC and KDC servers.
    //! Implementing a mock for KDF and RPC servers is too hard and unreasonable. So, we wrote a simple
    //! high-level mock of [n_crypt_protect_secret] and [n_crypt_unprotect_secret] functions.
    //!
    //! **Note**: The goal is to test FFI functions, not the DPAPI implementation correctness.
    //! The FFI tests should not care about returned data correctness but rather check
    //! for memory corruptions and memory leaks.

    use std::ffi::CStr;
    use std::slice::from_raw_parts_mut;

    use dpapi::{CryptProtectSecretArgs, CryptUnprotectSecretArgs, Result};
    use dpapi_transport::{ProxyOptions, Transport};
    use ffi_types::{Dword, LpByte, LpCStr, LpCUuid, LpDword};
    use sspi::Secret;
    use url::Url;
    use uuid::Uuid;

    #[allow(clippy::extra_unused_type_parameters)]
    pub(crate) async fn n_crypt_unprotect_secret<T: Transport>(
        args: CryptUnprotectSecretArgs<'_, '_, '_, '_>,
    ) -> Result<Secret<Vec<u8>>> {
        if let Some(ProxyOptions {
            proxy,
            get_session_token,
        }) = args.proxy
        {
            println!("proxy: {proxy}");
            println!(
                "token: {}",
                get_session_token(Uuid::new_v4(), Url::parse("tcp://win-956cqossjtf.tbt.com:125").unwrap())
                    .await
                    .unwrap()
            );
        }

        Ok(b"secret-to-encrypt".to_vec().into())
    }

    #[allow(clippy::extra_unused_type_parameters)]
    pub(crate) async fn n_crypt_protect_secret<T: Transport>(
        args: CryptProtectSecretArgs<'_, '_, '_>,
    ) -> Result<Vec<u8>> {
        if let Some(ProxyOptions {
            proxy,
            get_session_token,
        }) = args.proxy
        {
            println!("proxy: {proxy}");
            println!(
                "token: {}",
                get_session_token(Uuid::new_v4(), Url::parse("tcp://win-956cqossjtf.tbt.com:125").unwrap())
                    .await
                    .unwrap()
            );
        }

        Ok(b"DPAPI_blob".to_vec())
    }

    pub(crate) unsafe extern "system" fn get_session_token(
        session_id: LpCUuid,
        destination: LpCStr,
        token_buf: LpByte,
        token_len: LpDword,
    ) -> u32 {
        check_null!(session_id);
        check_null!(destination);
        check_null!(token_buf);
        check_null!(token_len);

        // SAFETY:
        // - `session_id` is guaranteed to be non-null due to the prior check.
        // - The memory region `session_id` points to contains valid data.
        let session_id = unsafe { *session_id };
        let session_id = Uuid::from_fields(session_id.data1, session_id.data2, session_id.data3, &session_id.data4);

        // SAFETY:
        // - `destination` is guaranteed to be non-null due to the prior check.
        // - The memory region `destination` contains a valid null-terminator at the end of string.
        // - The memory region `destination` points to is valid for reads of bytes up to and including null-terminator.
        let destination = unsafe { CStr::from_ptr(destination.cast()) }.to_str().unwrap();

        println!("session id: {session_id:?}. destination: {destination:?}.");

        let session_token = b"eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImN0eSI6IkFTU09DSUFUSU9OIn0.eyJkc3RfaHN0IjoidGNwOi8vMTkyLjE2OC4xLjEwMzoxMzUiLCJleHAiOjE3NDQ1MzQ5NTMsImpldF9haWQiOiIwY2I3M2Y3Yy0wZTA5LTRiNzAtYTVjMy1jMjBjY2IzMDJhYjAiLCJqZXRfYXAiOiJ1bmtub3duIiwiamV0X2NtIjoiZndkIiwiamV0X3JlYyI6Im5vbmUiLCJqdGkiOiJlYmNkNzhmMi0zMTlhLTRlM2UtOGZiOS02MjcyMTIzZTA1YWMiLCJuYmYiOjE3NDQ1MzEzNTN9.BEEaY2Mcm4ubdFBrugen7TEPW2PqxHj9Mi-DdP71C6vJ5YftpxGZns9KS4i_9ayPvpBRTyWW0YhLO1sUdGww6ePID0qP-IEYTY5rJ-pBRwX5eTtU4ci1hgxa2bcGOeWRJtX_Yg_rS49hgxYF1qMJL1CdoZbAx70656ygohQzEyeqOeto_ZpMxz2S_EMJyeXfJI-IgFrBnMvK-6iBLxc9xgc3TmGKdPefoAmlpV24OsyS9AT9U-gqlGpJ-DDAc7ZUvYyeaRG_JnEuBdvydtJyUDAvIvS73kPLAOHJfsOxXzu-izEOdaJQ8nIiSKcN_aKL_mSqSBN02zCiBuWbvAJP8EOlvqzuwRxB_zKpJNwS2fOQFhRd8L4dK034sajh3m485Zg-B5OwcmyPMAbmMpb2vyC9x5Gg9PcWN0ikHkILkNtPngsrt5r4rUTKo7h-KG4gMApfD38fmmIms01h_qh3btSDtf-ok-W8T6Sq0dJS6rhSmjhw5vJQVf_js3eRML1T5NbyGPmk6O9qKvaiGMNNgoVDawTDpCD2Sy9LTZTJajeX2vYkCI11neUkVeOxSCokOekhnVdqQVnWPfME10dtaTgDwBz-nmZg1tWAXcwouZFu2MZPLVH4xM7BqwoY8-Pmvuupr2ctOi8C9DfsKIPXmrbswdBSxKEd28HuZxDB2w8";
        // SAFETY:
        // - `token_buf` is guaranteed to be non-null due to the prior check.
        // - The memory region `token_buf` points to is valid for reads of `token_len` elements.
        unsafe { from_raw_parts_mut(token_buf, session_token.len()) }.copy_from_slice(session_token);

        // SAFETY: `token_len` is guaranteed to be non-null due to the prior check.
        unsafe {
            *token_len = Dword::try_from(session_token.len()).unwrap();
        }

        0
    }
}

pub(super) use inner::*;
