#![cfg(not(target_os = "windows"))]

pub mod functions;

#[cfg(not(target_os = "macos"))]
use core::ffi::{c_long, c_ulong};
use std::borrow::Cow;
use std::env;
use std::ffi::CString;

use ffi_types::{LpCStr, LpVoid};
use libc::{RTLD_LAZY, RTLD_LOCAL, dlopen, dlsym};
use winscard::{Error, ErrorKind, WinScardResult};

use crate::winscard::pcsc_lite::functions::PcscLiteApiFunctionTable;

/// [SCARD_IO_REQUEST Struct Reference](https://pcsclite.apdu.fr/api/structSCARD__IO__REQUEST.html)
///
/// Protocol Control Information (PCI).
#[cfg_attr(not(target_os = "macos"), repr(C))]
#[cfg_attr(target_os = "macos", repr(C, packed))]
pub struct ScardIoRequest {
    /// Protocol identifier.
    pub dw_protocol: u32,
    /// Protocol Control Inf Length.
    pub cb_pci_length: u32,
}

/// [SCARD_READERSTATE Struct Reference](https://pcsclite.apdu.fr/api/structSCARD__READERSTATE.html)
#[cfg_attr(not(target_os = "macos"), repr(C))]
#[cfg_attr(target_os = "macos", repr(C, packed))]
pub struct ScardReaderState {
    pub sz_reader: LpCStr,
    pub pv_user_data: LpVoid,
    pub dw_current_state: u32,
    pub dw_event_state: u32,
    pub cb_atr: u32,
    pub rgb_atr: [u8; 36],
}

#[cfg(not(target_os = "macos"))]
pub type ScardStatus = c_long;
#[cfg(target_os = "macos")]
pub type ScardStatus = u32;

#[cfg(target_os = "macos")]
pub type Dword = u32;
#[cfg(not(target_os = "macos"))]
pub type Dword = c_ulong;

pub type LpDword = *mut Dword;

pub const SCARD_AUTOALLOCATE: Dword = Dword::MAX;

/// `hContext` returned by `SCardEstablishContext()`.
///
/// https://pcsclite.apdu.fr/api/pcsclite_8h.html#a22530ffaff18b5d3e32260a5f1ce4abd
#[cfg(target_os = "macos")]
pub type ScardContext = i32;
#[cfg(not(target_os = "macos"))]
pub type ScardContext = c_long;

/// Pointer to the [ScardContext].
pub type LpScardContext = *mut ScardContext;

/// `hCard` returned by `SCardConnect()`.
///
/// https://pcsclite.apdu.fr/api/pcsclite_8h.html#af328aca3e11de737ecd771bcf1f75fb5
#[cfg(target_os = "macos")]
pub type ScardHandle = i32;
#[cfg(not(target_os = "macos"))]
pub type ScardHandle = c_long;

/// Pointer to the [ScardHandle].
pub type LpScardHandle = *mut ScardHandle;

// We have already defined `State` flags in the `winscard` crate but we need a separate one for the pcsc-lite because of
// differences between Windows WinSCard API and pcsc-lite.
//
// https://pcsclite.apdu.fr/api/group__API.html#differences
// > SCardStatus() returns a bit field on pcsc-lite but a enumeration on Windows.
bitflags::bitflags! {
    /// [SCardStatus](https://pcsclite.apdu.fr/api/group__API.html#gae49c3c894ad7ac12a5b896bde70d0382)
    ///
    /// Current state of this reader: is a DWORD possibly OR'd with the following values:
    #[derive(Debug, Copy, Clone, PartialEq, Eq, Default)]
    pub struct State: Dword {
        /// There is no card in the reader.
        const Absent = 0x0002;
        /// There is a card in the reader, but it has not been moved into position for use.
        const Present = 0x0004;
        /// There is a card in the reader in position for use. The card is not powered.
        const Swallowed = 0x0008;
        /// Power is being provided to the card, but the reader driver is unaware of the mode of the card.
        const Powered = 0x0010;
        /// The card has been reset and is awaiting PTS negotiation.
        const Negotiable = 0x0020;
        /// The card has been reset and specific communication protocols have been established.
        const Specific = 0x0040;
    }
}

impl From<State> for winscard::winscard::State {
    fn from(value: State) -> Self {
        #[allow(clippy::useless_conversion)]
        let bits: u32 = value.bits().try_into().expect("Card state value should fit in u32");
        if let Ok(state) = Self::try_from(bits) {
            // If the pcsc-lite card state has only one bit set, then we can safely convert it to the Windows WinSCard state.
            state
        } else {
            // If the pcsc-lite card state has more then one bit set, then we just return the `State::Specific` state. The Windows
            // WinSCard usually returns this state for the working inserted smart card. We do the same for the emulated smart cards
            // and for the system scards in the case of state uncertainty.
            Self::Specific
        }
    }
}

/// Path to the `pcsc-lite` library.
///
/// The user can use this environment variable to customize the `pcsc-lite` library loading.
const PCSC_LITE_LIB_PATH_ENV: &str = "PCSC_LITE_LIB_PATH";

pub fn initialize_pcsc_lite_api() -> WinScardResult<PcscLiteApiFunctionTable> {
    let pcsc_lite_path = if let Ok(lib_path) = env::var(PCSC_LITE_LIB_PATH_ENV) {
        Cow::Owned(lib_path)
    } else {
        #[cfg(target_os = "macos")]
        {
            Cow::Borrowed("/System/Library/Frameworks/PCSC.framework/PCSC")
        }
        #[cfg(not(target_os = "macos"))]
        {
            Cow::Borrowed("libpcsclite.so")
        }
    };
    debug!(?pcsc_lite_path);

    let pcsc_lite_path = CString::new(pcsc_lite_path.as_ref())?;

    // SAFETY: FFI call with no outstanding preconditions.
    let handle = unsafe { dlopen(pcsc_lite_path.as_ptr(), RTLD_LOCAL | RTLD_LAZY) };
    if handle.is_null() {
        return Err(Error::new(
            ErrorKind::InternalError,
            format!("Can not load pcsc-lite library: {}", pcsc_lite_path.to_str().unwrap()),
        ));
    }

    macro_rules! load_fn {
        ($func_name:literal) => {{
            let fn_name = CString::new($func_name).expect("CString creation should not fail");

            // SAFETY:
            // - We've checked the `handle` above.
            // - `fn_name` is correct and hardcoded in the code.
            let fn_ptr = unsafe { dlsym(handle, fn_name.as_ptr()) };
            debug!(?fn_ptr, $func_name);

            // SAFETY:
            // - `*mut c_void` and target transmute type are both C pointers. They have the same layout.
            //   Thus, we can safely transmute the C pointer to the C function pointer.
            // - The target transmute type is our defined PCSC-lite C function which is correct.
            //   We are responsible for the function signature correctness.
            unsafe {
                // Not great to silent, but mostly fine in this context.
                #[expect(clippy::missing_transmute_annotations)]
                std::mem::transmute::<*mut libc::c_void, _>(fn_ptr)
            }
        }};
    }

    macro_rules! load_io_request {
        ($req_name:literal) => {{
            let req_name = CString::new($req_name).expect("CString creation should not fail");

            // SAFETY:
            // - We've checked the `handle` above.
            // - `req_name` is correct and hardcoded in the code.
            let io_request_ptr = unsafe { dlsym(handle, req_name.as_ptr()) };
            debug!(?io_request_ptr, $req_name);

            // SAFETY:
            // - `*mut c_void` and `*const ScardIoRequest` are both C pointers. They have the same layout.
            //   Thus, we can safely transmute one C pointer to another C pointer.
            // - The `*const ScardIoRequest` type is our defined PCSC-lite C structure and it is correct.
            //   We are responsible for the structure correctness.
            unsafe { std::mem::transmute::<*mut libc::c_void, *const ScardIoRequest>(io_request_ptr) }
        }};
    }

    Ok(PcscLiteApiFunctionTable {
        SCardEstablishContext: load_fn!("SCardEstablishContext"),
        SCardReleaseContext: load_fn!("SCardReleaseContext"),
        SCardConnect: load_fn!("SCardConnect"),
        SCardReconnect: load_fn!("SCardReconnect"),
        SCardDisconnect: load_fn!("SCardDisconnect"),
        SCardBeginTransaction: load_fn!("SCardBeginTransaction"),
        SCardEndTransaction: load_fn!("SCardEndTransaction"),
        SCardStatus: load_fn!("SCardStatus"),
        SCardGetStatusChange: load_fn!("SCardGetStatusChange"),
        SCardControl: load_fn!("SCardControl"),
        SCardGetAttrib: load_fn!("SCardGetAttrib"),
        SCardSetAttrib: load_fn!("SCardSetAttrib"),
        SCardTransmit: load_fn!("SCardTransmit"),
        SCardListReaders: load_fn!("SCardListReaders"),
        SCardFreeMemory: load_fn!("SCardFreeMemory"),
        SCardListReaderGroups: load_fn!("SCardListReaderGroups"),
        SCardCancel: load_fn!("SCardCancel"),
        SCardIsValidContext: load_fn!("SCardIsValidContext"),

        g_rgSCardT0Pci: load_io_request!("g_rgSCardT0Pci"),
        g_rgSCardT1Pci: load_io_request!("g_rgSCardT1Pci"),
        g_rgSCardRawPci: load_io_request!("g_rgSCardRawPci"),
    })
}
