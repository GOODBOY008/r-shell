#![cfg(feature = "scard")]

#[macro_use]
mod macros;

pub mod card;
pub mod context;

use std::borrow::Cow;

pub use card::SystemScard;
pub use context::SystemScardContext;
#[cfg(target_os = "windows")]
use ffi_types::winscard::LpCScardIoRequest;
#[cfg(target_os = "windows")]
use ffi_types::winscard::functions::SCardApiFunctionTable;
use winscard::WinScardResult;

fn parse_multi_string(buf: &[u8]) -> WinScardResult<Vec<&str>> {
    let res: Result<Vec<&str>, _> = buf
        .split(|&c| c == 0)
        .filter(|v| !v.is_empty())
        .map(std::str::from_utf8)
        .collect();

    Ok(res?)
}

fn parse_multi_string_owned(buf: &[u8]) -> WinScardResult<Vec<Cow<'static, str>>> {
    Ok(parse_multi_string(buf)?
        .into_iter()
        .map(|r| Cow::Owned(r.to_owned()))
        .collect())
}

#[cfg(target_os = "windows")]
fn uuid_to_c_guid(id: uuid::Uuid) -> ffi_types::Uuid {
    let (data1, data2, data3, data4) = id.as_fields();

    ffi_types::Uuid {
        data1,
        data2,
        data3,
        data4: *data4,
    }
}

#[cfg(target_os = "windows")]
pub fn init_scard_api_table() -> WinScardResult<SCardApiFunctionTable> {
    use std::env;
    use std::ffi::CString;
    use std::mem::transmute;

    use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryA};
    use windows::core::PCSTR;
    use winscard::{Error, ErrorKind};

    /// Path to the `winscard` module.
    ///
    /// The user can use this environment variable to customize the `winscard` library loading.
    const WINSCARD_LIB_PATH_ENV: &str = "WINSCARD_LIB_PATH";

    let file_name = CString::new(if let Ok(lib_path) = env::var(WINSCARD_LIB_PATH_ENV) {
        lib_path.into_bytes()
    } else {
        "WinSCard.dll".as_bytes().to_vec()
    })?;

    let file_name = PCSTR::from_raw(file_name.as_ptr().cast());

    // SAFETY: `file_name` is guaranteed to be the null-terminated C string as it's a pointer to `CString`
    let winscard_module = unsafe { LoadLibraryA(file_name) };

    let winscard_module = winscard_module.map_err(|_| {
        Error::new(
            ErrorKind::InternalError,
            "can not load the winscard module: LoadLibrary function has returned NULL",
        )
    })?;

    info!("The winscard module has been loaded");

    macro_rules! load_fn {
        ($func_name:literal) => {{
            let func_name = CString::new($func_name).expect("func_name is valid to pass to CString::new");
            let func_name = PCSTR::from_raw(func_name.as_ptr().cast());

            // SAFETY:
            // - We've checked the `winscard_module` handle above.
            // - `$func_name` is correct and hardcoded in the code.
            let fn_handle = unsafe { GetProcAddress(winscard_module, func_name) };
            // SAFETY:
            // - FARPROC is a C-function pointer. It has the same layout as other C function pointers.
            //   Thus, we can safely transmute it to another C function pointer.
            // - FARPROC will never be `None` in this context, because all function names are hardcoded in the code and are valid.
            unsafe {
                // Not great to silent, but mostly fine in this context.
                #[expect(clippy::missing_transmute_annotations)]
                transmute::<windows::Win32::Foundation::FARPROC, _>(fn_handle)
            }
        }};
    }

    macro_rules! load_io_request {
        ($req_name:literal) => {{
            let req_name = CString::new($req_name).expect("req_name is valid to pass to CString::new");
            let req_name = PCSTR::from_raw(req_name.as_ptr().cast());

            // SAFETY:
            // - We've checked the `winscard_module` handle above.
            // - `$req_name` is correct and hardcoded in the code.
            let req_handle = unsafe { GetProcAddress(winscard_module, req_name) };
            // SAFETY:
            // - FARPROC is a C-function pointer. But it can also mean variable pointer. [GetProcAddress](https://learn.microsoft.com/en-us/windows/win32/api/libloaderapi/nf-libloaderapi-getprocaddress):
            //   > If the function succeeds, the return value is the address of the exported function or variable.
            //   Thus, we can safely transmute it to another C structure pointer.
            // - FARPROC will never be `None` in this context, because all names are hardcoded in the code and are valid.
            let send_pci = unsafe {
                transmute::<windows::Win32::Foundation::FARPROC, LpCScardIoRequest>(req_handle)
            };
            // SAFETY:
            // - `send_pci` is not NULL and valid, because its initial handle is valid, because library variable names are valid and hardcoded in the code.
            // - We never call the `FreeLibrary` function, so the pointer will remain valid for the `'static` lifetime.
            unsafe { &*send_pci }
        }};
    }

    Ok(SCardApiFunctionTable {
        dw_version: 0,
        dw_flags: 0,
        SCardEstablishContext: load_fn!("SCardEstablishContext"),
        SCardReleaseContext: load_fn!("SCardReleaseContext"),
        SCardIsValidContext: load_fn!("SCardIsValidContext"),
        SCardListReaderGroupsA: load_fn!("SCardListReaderGroupsA"),
        SCardListReaderGroupsW: load_fn!("SCardListReaderGroupsW"),
        SCardListReadersA: load_fn!("SCardListReadersA"),
        SCardListReadersW: load_fn!("SCardListReadersW"),
        SCardListCardsA: load_fn!("SCardListCardsA"),
        SCardListCardsW: load_fn!("SCardListCardsW"),
        SCardListInterfacesA: load_fn!("SCardListInterfacesA"),
        SCardListInterfacesW: load_fn!("SCardListInterfacesW"),
        SCardGetProviderIdA: load_fn!("SCardGetProviderIdA"),
        SCardGetProviderIdW: load_fn!("SCardGetProviderIdW"),
        SCardGetCardTypeProviderNameA: load_fn!("SCardGetCardTypeProviderNameA"),
        SCardGetCardTypeProviderNameW: load_fn!("SCardGetCardTypeProviderNameW"),
        SCardIntroduceReaderGroupA: load_fn!("SCardIntroduceReaderGroupA"),
        SCardIntroduceReaderGroupW: load_fn!("SCardIntroduceReaderGroupW"),
        SCardForgetReaderGroupA: load_fn!("SCardForgetReaderGroupA"),
        SCardForgetReaderGroupW: load_fn!("SCardForgetReaderGroupW"),
        SCardIntroduceReaderA: load_fn!("SCardIntroduceReaderA"),
        SCardIntroduceReaderW: load_fn!("SCardIntroduceReaderW"),
        SCardForgetReaderA: load_fn!("SCardForgetReaderA"),
        SCardForgetReaderW: load_fn!("SCardForgetReaderW"),
        SCardAddReaderToGroupA: load_fn!("SCardAddReaderToGroupA"),
        SCardAddReaderToGroupW: load_fn!("SCardAddReaderToGroupW"),
        SCardRemoveReaderFromGroupA: load_fn!("SCardRemoveReaderFromGroupA"),
        SCardRemoveReaderFromGroupW: load_fn!("SCardRemoveReaderFromGroupW"),
        SCardIntroduceCardTypeA: load_fn!("SCardIntroduceCardTypeA"),
        SCardIntroduceCardTypeW: load_fn!("SCardIntroduceCardTypeW"),
        SCardSetCardTypeProviderNameA: load_fn!("SCardSetCardTypeProviderNameA"),
        SCardSetCardTypeProviderNameW: load_fn!("SCardSetCardTypeProviderNameW"),
        SCardFreeMemory: load_fn!("SCardFreeMemory"),
        SCardAccessStartedEvent: load_fn!("SCardAccessStartedEvent"),
        SCardReleaseStartedEvent: load_fn!("SCardReleaseStartedEvent"),
        SCardLocateCardsA: load_fn!("SCardLocateCardsA"),
        SCardLocateCardsW: load_fn!("SCardLocateCardsW"),
        SCardLocateCardsByATRA: load_fn!("SCardLocateCardsByATRA"),
        SCardLocateCardsByATRW: load_fn!("SCardLocateCardsByATRW"),
        SCardGetStatusChangeA: load_fn!("SCardGetStatusChangeA"),
        SCardGetStatusChangeW: load_fn!("SCardGetStatusChangeW"),
        SCardCancel: load_fn!("SCardCancel"),
        SCardConnectA: load_fn!("SCardConnectA"),
        SCardConnectW: load_fn!("SCardConnectW"),
        SCardReconnect: load_fn!("SCardReconnect"),
        SCardDisconnect: load_fn!("SCardDisconnect"),
        SCardBeginTransaction: load_fn!("SCardBeginTransaction"),
        SCardEndTransaction: load_fn!("SCardEndTransaction"),
        SCardCancelTransaction: load_fn!("SCardCancelTransaction"),
        SCardState: load_fn!("SCardState"),
        SCardStatusA: load_fn!("SCardStatusA"),
        SCardStatusW: load_fn!("SCardStatusW"),
        SCardTransmit: load_fn!("SCardTransmit"),
        SCardGetTransmitCount: load_fn!("SCardGetTransmitCount"),
        SCardControl: load_fn!("SCardControl"),
        SCardGetAttrib: load_fn!("SCardGetAttrib"),
        SCardSetAttrib: load_fn!("SCardSetAttrib"),
        SCardUIDlgSelectCardA: load_fn!("SCardUIDlgSelectCardA"),
        SCardUIDlgSelectCardW: load_fn!("SCardUIDlgSelectCardW"),
        GetOpenCardNameA: load_fn!("GetOpenCardNameA"),
        GetOpenCardNameW: load_fn!("GetOpenCardNameW"),
        SCardReadCacheA: load_fn!("SCardReadCacheA"),
        SCardReadCacheW: load_fn!("SCardReadCacheW"),
        SCardWriteCacheA: load_fn!("SCardWriteCacheA"),
        SCardWriteCacheW: load_fn!("SCardWriteCacheW"),
        SCardGetReaderIconA: load_fn!("SCardGetReaderIconA"),
        SCardGetReaderIconW: load_fn!("SCardGetReaderIconW"),
        SCardGetDeviceTypeIdA: load_fn!("SCardGetDeviceTypeIdA"),
        SCardGetDeviceTypeIdW: load_fn!("SCardGetDeviceTypeIdW"),
        SCardGetReaderDeviceInstanceIdA: load_fn!("SCardGetReaderDeviceInstanceIdA"),
        SCardGetReaderDeviceInstanceIdW: load_fn!("SCardGetReaderDeviceInstanceIdW"),
        SCardListReadersWithDeviceInstanceIdA: load_fn!("SCardListReadersWithDeviceInstanceIdA"),
        SCardListReadersWithDeviceInstanceIdW: load_fn!("SCardListReadersWithDeviceInstanceIdW"),
        SCardAudit: load_fn!("SCardAudit"),

        g_rgSCardT0Pci: load_io_request!("g_rgSCardT0Pci"),
        g_rgSCardT1Pci: load_io_request!("g_rgSCardT1Pci"),
        g_rgSCardRawPci: load_io_request!("g_rgSCardRawPci"),
    })
}
