pub mod functions;

use crate::common::{Bool, Handle, LpCGuid, LpCStr, LpCWStr, LpStr, LpVoid, LpWStr};

pub type ScardStatus = u32;

pub type ScardContext = usize;
pub type LpScardContext = *mut ScardContext;

pub type ScardHandle = usize;
pub type LpScardHandle = *mut ScardHandle;
pub type Hwnd = Handle;
pub type Hicon = Handle;
// https://docs.rs/winapi/latest/winapi/um/winscard/type.LPOCNCHKPROC.html
pub type LpOcnChkProc = Option<unsafe extern "system" fn(_: ScardContext, _: ScardHandle, _: LpVoid) -> Bool>;
// https://docs.rs/winapi/latest/winapi/um/winscard/type.LPOCNCONNPROCA.html
pub type LpOcnConnProcA =
    Option<unsafe extern "system" fn(_: ScardContext, _: LpStr, _: LpStr, _: LpVoid) -> ScardHandle>;
// https://docs.rs/winapi/latest/winapi/um/winscard/type.LPOCNCONNPROCW.html
pub type LpOcnConnProcW =
    Option<unsafe extern "system" fn(_: ScardContext, _: LpWStr, _: LpWStr, _: LpVoid) -> ScardHandle>;
// https://docs.rs/winapi/latest/winapi/um/winscard/type.LPOCNDSCPROC.html
pub type LpOcnDscProc = Option<unsafe extern "system" fn(_: ScardContext, _: ScardHandle, _: LpVoid)>;

/// [SCARD_READERSTATEA](https://learn.microsoft.com/en-us/windows/win32/api/winscard/ns-winscard-scard_readerstatea)
///
/// ```not_rut
/// typedef struct {
///   LPCSTR szReader;
///   LPVOID pvUserData;
///   DWORD  dwCurrentState;
///   DWORD  dwEventState;
///   DWORD  cbAtr;
///   BYTE   rgbAtr[36];
/// } SCARD_READERSTATEA, *PSCARD_READERSTATEA, *LPSCARD_READERSTATEA;
/// ```
#[repr(C)]
pub struct ScardReaderStateA {
    pub sz_reader: LpCStr,
    pub pv_user_data: LpVoid,
    pub dw_current_state: u32,
    pub dw_event_state: u32,
    pub cb_atr: u32,
    pub rgb_atr: [u8; 36],
}

pub type LpScardReaderStateA = *mut ScardReaderStateA;

/// [SCARD_READERSTATEW](https://learn.microsoft.com/en-us/windows/win32/api/winscard/ns-winscard-scard_readerstatew)
///
/// ```not_rut
/// typedef struct {
///   LPCWSTR szReader;
///   LPVOID pvUserData;
///   DWORD  dwCurrentState;
///   DWORD  dwEventState;
///   DWORD  cbAtr;
///   BYTE   rgbAtr[36];
/// } SCARD_READERSTATEW, *PSCARD_READERSTATEW, *LPSCARD_READERSTATEW;
/// ```
#[derive(Debug)]
#[repr(C)]
pub struct ScardReaderStateW {
    pub sz_reader: LpCWStr,
    pub pv_user_data: LpVoid,
    pub dw_current_state: u32,
    pub dw_event_state: u32,
    pub cb_atr: u32,
    pub rgb_atr: [u8; 36],
}

pub type LpScardReaderStateW = *mut ScardReaderStateW;

/// [SCARD_ATRMASK](https://learn.microsoft.com/en-us/windows/win32/api/winscard/ns-winscard-scard_atrmask)
///
/// ```not_rust
/// typedef struct _SCARD_ATRMASK {
///   DWORD cbAtr;
///   BYTE  rgbAtr[36];
///   BYTE  rgbMask[36];
/// } SCARD_ATRMASK, *PSCARD_ATRMASK, *LPSCARD_ATRMASK;
/// ```
#[repr(C)]
pub struct ScardAtrMask {
    cb_atr: u32,
    rgb_atr: [u8; 36],
    rgb_mask: [u8; 36],
}

pub type LpScardAtrMask = *mut ScardAtrMask;

/// [SCARD_IO_REQUEST](https://learn.microsoft.com/en-us/windows/win32/secauthn/scard-io-request)
///
/// ```not_rust
/// typedef struct {
///   DWORD dwProtocol;
///   DWORD cbPciLength;
/// } SCARD_IO_REQUEST;
/// ```
#[derive(Debug)]
#[repr(C)]
pub struct ScardIoRequest {
    pub dw_protocol: u32,
    pub cb_pci_length: u32,
}

pub type LpScardIoRequest = *mut ScardIoRequest;
pub type LpCScardIoRequest = *const ScardIoRequest;

/// [OPENCARD_SEARCH_CRITERIAA](https://learn.microsoft.com/en-us/windows/win32/api/winscard/ns-winscard-opencard_search_criteriaa)
///
/// ```not_rust
/// typedef struct {
///   DWORD          dwStructSize;
///   LPSTR          lpstrGroupNames;
///   DWORD          nMaxGroupNames;
///   LPCGUID        rgguidInterfaces;
///   DWORD          cguidInterfaces;
///   LPSTR          lpstrCardNames;
///   DWORD          nMaxCardNames;
///   LPOCNCHKPROC   lpfnCheck;
///   LPOCNCONNPROCA lpfnConnect;
///   LPOCNDSCPROC   lpfnDisconnect;
///   LPVOID         pvUserData;
///   DWORD          dwShareMode;
///   DWORD          dwPreferredProtocols;
/// } OPENCARD_SEARCH_CRITERIAA, *POPENCARD_SEARCH_CRITERIAA, *LPOPENCARD_SEARCH_CRITERIAA;
/// ```
#[repr(C)]
pub struct OpenCardSearchCriteriaA {
    dw_struct_size: u32,
    lpstr_group_names: LpStr,
    n_max_group_names: u32,
    rgguid_interfaces: LpCGuid,
    cguid_interfaces: u32,
    lpstr_card_names: LpStr,
    n_max_card_names: u32,
    lpfn_check: LpOcnChkProc,
    lpfn_connect: LpOcnConnProcA,
    lpfn_disconnect: LpOcnChkProc,
    pv_user_data: LpVoid,
    dw_share_mode: u32,
    dw_preferred_protocols: u32,
}

pub type LpOpenCardSearchCriteriaA = *mut OpenCardSearchCriteriaA;

/// [OPENCARD_SEARCH_CRITERIAW](https://learn.microsoft.com/en-us/windows/win32/api/winscard/ns-winscard-opencard_search_criteriaw)
///
/// ```not_rust
/// typedef struct {
///   DWORD          dwStructSize;
///   LPWSTR         lpstrGroupNames;
///   DWORD          nMaxGroupNames;
///   LPCGUID        rgguidInterfaces;
///   DWORD          cguidInterfaces;
///   LPWSTR         lpstrCardNames;
///   DWORD          nMaxCardNames;
///   LPOCNCHKPROC   lpfnCheck;
///   LPOCNCONNPROCW lpfnConnect;
///   LPOCNDSCPROC   lpfnDisconnect;
///   LPVOID         pvUserData;
///   DWORD          dwShareMode;
///   DWORD          dwPreferredProtocols;
/// } OPENCARD_SEARCH_CRITERIAW, *POPENCARD_SEARCH_CRITERIAW, *LPOPENCARD_SEARCH_CRITERIAW;
/// ```
#[repr(C)]
pub struct OpenCardSearchCriteriaW {
    dw_struct_size: u32,
    lpstr_group_names: LpWStr,
    n_max_group_names: u32,
    rgguid_interfaces: LpCGuid,
    cguid_interfaces: u32,
    lpstr_card_names: LpWStr,
    n_max_card_names: u32,
    lpfn_check: LpOcnChkProc,
    lpfn_connect: LpOcnConnProcW,
    lpfn_disconnect: LpOcnChkProc,
    pv_user_data: LpVoid,
    dw_share_mode: u32,
    dw_preferred_protocols: u32,
}

pub type LpOpenCardSearchCriteriaW = *mut OpenCardSearchCriteriaW;

/// [OPENCARDNAME_EXA](https://learn.microsoft.com/en-us/windows/win32/api/winscard/ns-winscard-opencardname_exa)
///
/// ```not_rust
/// typedef struct {
///   DWORD                      dwStructSize;
///   SCARDCONTEXT               hSCardContext;
///   HWND                       hwndOwner;
///   DWORD                      dwFlags;
///   LPCSTR                     lpstrTitle;
///   LPCSTR                     lpstrSearchDesc;
///   HICON                      hIcon;
///   POPENCARD_SEARCH_CRITERIAA pOpenCardSearchCriteria;
///   LPOCNCONNPROCA             lpfnConnect;
///   LPVOID                     pvUserData;
///   DWORD                      dwShareMode;
///   DWORD                      dwPreferredProtocols;
///   LPSTR                      lpstrRdr;
///   DWORD                      nMaxRdr;
///   LPSTR                      lpstrCard;
///   DWORD                      nMaxCard;
///   DWORD                      dwActiveProtocol;
///   SCARDHANDLE                hCardHandle;
/// } OPENCARDNAME_EXA, *POPENCARDNAME_EXA, *LPOPENCARDNAME_EXA;
/// ```
#[repr(C)]
pub struct OpenCardNameExA {
    dw_struct_size: u32,
    h_scard_context: ScardContext,
    hwnd_owner: Hwnd,
    dw_flags: u32,
    lpstr_title: LpCStr,
    lpstr_search_sesc: LpCStr,
    h_icon: Hicon,
    p_open_card_search_criteria: LpOpenCardSearchCriteriaA,
    lpfn_connect: LpOcnConnProcA,
    pv_user_data: LpVoid,
    dw_share_mode: u32,
    dw_preferred_protocols: u32,
    lpstr_rdr: LpStr,
    n_max_rdr: u32,
    lpstr_card: LpStr,
    n_max_card: u32,
    dw_active_protocol: u32,
    h_card_handle: ScardHandle,
}

pub type LpOpenCardNameExA = *mut OpenCardNameExA;

/// [OPENCARDNAME_EXW](https://learn.microsoft.com/en-us/windows/win32/api/winscard/ns-winscard-opencardname_exw)
///
/// ```not_rust
/// typedef struct {
///   DWORD                      dwStructSize;
///   SCARDCONTEXT               hSCardContext;
///   HWND                       hwndOwner;
///   DWORD                      dwFlags;
///   LPCWSTR                    lpstrTitle;
///   LPCWSTR                    lpstrSearchDesc;
///   HICON                      hIcon;
///   POPENCARD_SEARCH_CRITERIAW pOpenCardSearchCriteria;
///   LPOCNCONNPROCW             lpfnConnect;
///   LPVOID                     pvUserData;
///   DWORD                      dwShareMode;
///   DWORD                      dwPreferredProtocols;
///   LPWSTR                     lpstrRdr;
///   DWORD                      nMaxRdr;
///   LPWSTR                     lpstrCard;
///   DWORD                      nMaxCard;
///   DWORD                      dwActiveProtocol;
///   SCARDHANDLE                hCardHandle;
/// } OPENCARDNAME_EXW, *POPENCARDNAME_EXW, *LPOPENCARDNAME_EXW;
/// ```
#[repr(C)]
pub struct OpenCardNameExW {
    dw_struct_size: u32,
    h_scard_context: ScardContext,
    hwnd_owner: Hwnd,
    dw_flags: u32,
    lpstr_title: LpCWStr,
    lpstr_search_sesc: LpCWStr,
    h_icon: Hicon,
    p_open_card_search_criteria: LpOpenCardSearchCriteriaW,
    lpfn_connect: LpOcnConnProcW,
    pv_user_data: LpVoid,
    dw_share_mode: u32,
    dw_preferred_protocols: u32,
    lpstr_rdr: LpStr,
    n_max_rdr: u32,
    lpstr_card: LpStr,
    n_max_card: u32,
    dw_active_protocol: u32,
    h_card_handle: ScardHandle,
}

pub type LpOpenCardNameExW = *mut OpenCardNameExW;

/// [OPENCARDNAMEA](https://learn.microsoft.com/en-us/windows/win32/api/winscard/ns-winscard-opencardnamea)
///
/// ```not_rust
/// typedef struct {
///   DWORD          dwStructSize;
///   HWND           hwndOwner;
///   SCARDCONTEXT   hSCardContext;
///   LPSTR          lpstrGroupNames;
///   DWORD          nMaxGroupNames;
///   LPSTR          lpstrCardNames;
///   DWORD          nMaxCardNames;
///   LPCGUID        rgguidInterfaces;
///   DWORD          cguidInterfaces;
///   LPSTR          lpstrRdr;
///   DWORD          nMaxRdr;
///   LPSTR          lpstrCard;
///   DWORD          nMaxCard;
///   LPCSTR         lpstrTitle;
///   DWORD          dwFlags;
///   LPVOID         pvUserData;
///   DWORD          dwShareMode;
///   DWORD          dwPreferredProtocols;
///   DWORD          dwActiveProtocol;
///   LPOCNCONNPROCA lpfnConnect;
///   LPOCNCHKPROC   lpfnCheck;
///   LPOCNDSCPROC   lpfnDisconnect;
///   SCARDHANDLE    hCardHandle;
/// } OPENCARDNAMEA, *POPENCARDNAMEA, *LPOPENCARDNAMEA;
/// ```
#[repr(C)]
pub struct OpenCardNameA {
    dw_struct_size: u32,
    hwnd_owner: Hwnd,
    h_scard_context: ScardContext,
    lpstr_group_names: LpStr,
    n_max_group_names: u32,
    lpstr_card_names: LpStr,
    n_max_card_names: u32,
    rgguid_interfaces: LpCGuid,
    cguid_interfaces: u32,
    lpstr_rdr: LpStr,
    n_max_rdr: u32,
    lpstr_card: LpStr,
    n_max_card: u32,
    lpstr_title: u32,
    dw_flags: u32,
    pv_user_data: LpVoid,
    dw_share_mode: u32,
    dw_preferred_protocols: u32,
    dw_active_protocol: u32,
    lpfn_connect: LpOcnConnProcA,
    lpfn_check: LpOcnChkProc,
    lpfn_disconnect: LpOcnDscProc,
    h_card_handle: ScardHandle,
}

pub type LpOpenCardNameA = *mut OpenCardNameA;

/// [OPENCARDNAMEW](https://learn.microsoft.com/en-us/windows/win32/api/winscard/ns-winscard-opencardnamew)
///
/// ```not_rust
/// typedef struct {
///   DWORD          dwStructSize;
///   HWND           hwndOwner;
///   SCARDCONTEXT   hSCardContext;
///   LPWSTR         lpstrGroupNames;
///   DWORD          nMaxGroupNames;
///   LPWSTR         lpstrCardNames;
///   DWORD          nMaxCardNames;
///   LPCGUID        rgguidInterfaces;
///   DWORD          cguidInterfaces;
///   LPWSTR         lpstrRdr;
///   DWORD          nMaxRdr;
///   LPWSTR         lpstrCard;
///   DWORD          nMaxCard;
///   LPCWSTR        lpstrTitle;
///   DWORD          dwFlags;
///   LPVOID         pvUserData;
///   DWORD          dwShareMode;
///   DWORD          dwPreferredProtocols;
///   DWORD          dwActiveProtocol;
///   LPOCNCONNPROCW lpfnConnect;
///   LPOCNCHKPROC   lpfnCheck;
///   LPOCNDSCPROC   lpfnDisconnect;
///   SCARDHANDLE    hCardHandle;
/// } OPENCARDNAMEW, *POPENCARDNAMEW, *LPOPENCARDNAMEW;
/// ```
#[repr(C)]
pub struct OpenCardNameW {
    dw_struct_size: u32,
    hwnd_owner: Hwnd,
    h_scard_context: ScardContext,
    lpstr_group_names: LpWStr,
    n_max_group_names: u32,
    lpstr_card_names: LpWStr,
    n_max_card_names: u32,
    rgguid_interfaces: LpCGuid,
    cguid_interfaces: u32,
    lpstr_rdr: LpStr,
    n_max_rdr: u32,
    lpstr_card: LpStr,
    n_max_card: u32,
    lpstr_title: u32,
    dw_flags: u32,
    pv_user_data: LpVoid,
    dw_share_mode: u32,
    dw_preferred_protocols: u32,
    dw_active_protocol: u32,
    lpfn_connect: LpOcnConnProcW,
    lpfn_check: LpOcnChkProc,
    lpfn_disconnect: LpOcnDscProc,
    h_card_handle: ScardHandle,
}

pub type LpOpenCardNameW = *mut OpenCardNameW;
