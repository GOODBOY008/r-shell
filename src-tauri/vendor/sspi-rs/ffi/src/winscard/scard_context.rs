use std::borrow::Cow;
use std::ffi::CStr;
use std::slice::{from_raw_parts, from_raw_parts_mut};
use std::sync::{LazyLock, Mutex};

#[cfg(target_os = "windows")]
use ffi_types::winscard::functions::SCardApiFunctionTable;
use ffi_types::winscard::{
    LpScardAtrMask, LpScardContext, LpScardReaderStateA, LpScardReaderStateW, ScardContext, ScardStatus,
};
use ffi_types::{Handle, LpByte, LpCByte, LpCGuid, LpCStr, LpCVoid, LpCWStr, LpDword, LpGuid, LpStr, LpUuid, LpWStr};
use libc::c_void;
use sspi::{U16CString, U16CStringExt};
#[cfg(target_os = "windows")]
use symbol_rename_macro::rename_symbol;
use uuid::Uuid;
use winscard::winscard::{CurrentState, ReaderState, WinScardContext};
use winscard::{Error, ErrorKind, ScardContext as PivCardContext, SmartCardInfo, WinScardResult};

use super::buf_alloc::{build_buf_request_type, build_buf_request_type_wide, save_out_buf, save_out_buf_wide};
use crate::utils::into_raw_ptr;
use crate::winscard::scard_handle::{
    WinScardContextHandle, raw_scard_context_handle_to_scard_context_handle, scard_context_to_winscard_context,
};
use crate::winscard::system_scard::SystemScardContext;

const ERROR_INVALID_HANDLE: u32 = 6;

// Environment variable that indicates what smart card type use. It can have the following values:
// `true` - use a system-provided smart card.
// `false` (or unset) - use an emulated smart card.
const SMART_CARD_TYPE: &str = "WINSCARD_USE_SYSTEM_SCARD";

// We need to store all active smart card contexts in one collection.
// The `SCardIsValidContext` function can be called with already released context. So, with the help
// of `SCARD_CONTEXTS` we can track all active contexts and correctly check is the passed context is valid.
// The same applies to the `SCardReleaseContext`. We need to ensure that the passed context handle was not
// released before.
static SCARD_CONTEXTS: LazyLock<Mutex<Vec<ScardContext>>> = LazyLock::new(|| Mutex::new(Vec::new()));
// This API table instance is only needed for the `SCardAccessStartedEvent` function. This function
// doesn't accept any parameters, so we need a separate initialized API table to call the system API.
#[cfg(target_os = "windows")]
static WINSCARD_API: LazyLock<SCardApiFunctionTable> = LazyLock::new(|| {
    crate::winscard::system_scard::init_scard_api_table().expect("winscard module loading should not fail")
});

fn save_context(context: ScardContext) {
    SCARD_CONTEXTS
        .lock()
        .expect("SCARD_CONTEXTS mutex locking should not fail")
        .push(context)
}

fn is_present(context: ScardContext) -> bool {
    SCARD_CONTEXTS
        .lock()
        .expect("SCARD_CONTEXTS mutex locking should not fail")
        .contains(&context)
}

fn release_context(context: ScardContext) {
    SCARD_CONTEXTS
        .lock()
        .expect("SCARD_CONTEXTS mutex locking should not fail")
        .retain(|ctx| *ctx != context)
}

fn create_emulated_smart_card_context() -> WinScardResult<Box<dyn WinScardContext>> {
    Ok(Box::new(PivCardContext::new(SmartCardInfo::try_from_env()?)?))
}

/// The `SCardEstablishContext` function establishes the `resource manager context` (the scope) within
/// which database operations are performed.
///
/// [MSDN Reference](https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scardestablishcontext)
///
/// # Safety
///
/// The `context` must be a properly-aligned pointer valid for writes.
#[cfg_attr(windows, rename_symbol(to = "Rust_SCardEstablishContext"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn SCardEstablishContext(
    dw_scope: u32,
    _r1: *const c_void,
    _r2: *const c_void,
    context: LpScardContext,
) -> ScardStatus {
    crate::logging::setup_logger();

    check_null!(context);

    let scard_context = if let Ok(use_system_card) = std::env::var(SMART_CARD_TYPE) {
        if use_system_card == "true" {
            info!("Creating system-provided smart card context");
            Box::new(try_execute!(SystemScardContext::establish(
                try_execute!(dw_scope.try_into()),
                true
            )))
        } else {
            info!("Creating emulated smart card context");
            try_execute!(create_emulated_smart_card_context())
        }
    } else {
        info!("Creating emulated smart card context");
        try_execute!(create_emulated_smart_card_context())
    };

    let scard_context = WinScardContextHandle::with_scard_context(scard_context);

    let raw_ptr = into_raw_ptr(scard_context) as ScardContext;
    info!(new_established_context = ?raw_ptr);
    // SAFETY: The `context` is guaranteed to be non-null due to the prior check.
    unsafe {
        *context = raw_ptr;
    }
    save_context(raw_ptr);

    ErrorKind::Success.into()
}

/// The `SCardReleaseContext` function closes an established `resource manager context`, freeing any
/// resources allocated under that context.
///
/// [MSDN Reference](https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scardreleasecontext)
///
/// # Safety
///
/// The `context` must be a valid pointer to a memory region that is allocated by [`SCardEstablishContext`] function.
#[cfg_attr(windows, rename_symbol(to = "Rust_SCardReleaseContext"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn SCardReleaseContext(context: ScardContext) -> ScardStatus {
    check_handle!(context);

    if is_present(context) {
        // SAFETY:
        // - `context` is guaranteed to be non-null due to the prior check.
        // - `context` is allocated by `SCardEstablishContext` function.
        //   It guarantees that the pointer was allocated using `Box::into_raw`.
        let _ = unsafe { Box::from_raw(context as *mut WinScardContextHandle) };
        release_context(context);

        info!("Scard context has been successfully released");

        ErrorKind::Success.into()
    } else {
        warn!(context, "Scard context is invalid or has been released");

        ERROR_INVALID_HANDLE
    }
}

/// The `SCardIsValidContext` function determines whether a `smart card` context handle is valid.
///
/// [MSDN Reference](https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scardisvalidcontext)
///
/// # Safety
///
/// The `context` must be a valid raw scard context handle.
#[cfg_attr(windows, rename_symbol(to = "Rust_SCardIsValidContext"))]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn SCardIsValidContext(context: ScardContext) -> ScardStatus {
    if is_present(context) {
        check_handle!(context);

        let context = try_execute!(
            // SAFETY:
            // - `context` is guaranteed to be non-zero due to the prior check.
            // - `context` is a valid raw scard context handle.
            unsafe { scard_context_to_winscard_context(context) }
        );

        if context.is_valid() {
            ErrorKind::Success.into()
        } else {
            ERROR_INVALID_HANDLE
        }
    } else {
        debug!(context, "Provided context is not present in active contexts");

        ERROR_INVALID_HANDLE
    }
}

#[cfg_attr(windows, rename_symbol(to = "Rust_SCardListReaderGroupsA"))]
#[unsafe(no_mangle)]
pub extern "system" fn SCardListReaderGroupsA(
    _context: ScardContext,
    _gmsz_groups: LpStr,
    _pcch_groups: LpDword,
) -> ScardStatus {
    ErrorKind::UnsupportedFeature.into()
}

#[cfg_attr(windows, rename_symbol(to = "Rust_SCardListReaderGroupsW"))]
#[unsafe(no_mangle)]
pub extern "system" fn SCardListReaderGroupsW(
    _context: ScardContext,
    _gmsz_groups: LpWStr,
    _pcch_groups: LpDword,
) -> ScardStatus {
    ErrorKind::UnsupportedFeature.into()
}

/// The `SCardListReadersA` function provides the list of `readers` within a set of named reader groups, eliminating duplicates.
///
/// [MSDN Reference](https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scardlistreadersa)
///
/// # Safety
///
/// - `context` must be a valid raw scard context handle.
/// - `msz_readers` must be valid for both reads and writes for `*pcch_readers` many bytes, and it must be properly aligned.
/// - `pcch_readers` must be a properly-aligned pointer valid for both reads and writes.
#[cfg_attr(windows, rename_symbol(to = "Rust_SCardListReadersA"))]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn SCardListReadersA(
    context: ScardContext,
    _msz_groups: LpCStr,
    msz_readers: LpStr,
    pcch_readers: LpDword,
) -> ScardStatus {
    check_handle!(context);
    check_null!(msz_readers);
    check_null!(pcch_readers);

    let context = try_execute!(
        // SAFETY:
        // - `context` is guaranteed to be non-zero due to the prior check.
        // - `context` is a valid raw scard context handle.
        unsafe { raw_scard_context_handle_to_scard_context_handle(context) }
    );
    let buffer_type = try_execute!(
        // SAFETY: `msz_readers` is valid for both reads and writes for `*pcch_readers` many bytes.
        unsafe { build_buf_request_type(msz_readers, pcch_readers) }
    );

    let out_buf = try_execute!(context.list_readers(buffer_type));

    try_execute!(
        // SAFETY:
        // - `msz_readers` is valid for writes.
        // - `pcch_readers` is valid for writes.
        unsafe { save_out_buf(out_buf, msz_readers, pcch_readers) }
    );

    ErrorKind::Success.into()
}

/// The `SCardListReadersW` function provides the list of `readers` within a set of named reader groups, eliminating duplicates.
///
/// [MSDN Reference](https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scardlistreadersW)
///
/// # Safety
///
/// - `context` must be a valid raw scard context handle.
/// - `msz_readers` must be valid for both reads and writes for `*pcch_readers` many bytes, and it must be properly aligned.
/// - `pcch_readers` must be a properly-aligned pointer valid for both reads and writes.
#[cfg_attr(windows, rename_symbol(to = "Rust_SCardListReadersW"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn SCardListReadersW(
    context: ScardContext,
    _msz_groups: LpCWStr,
    msz_readers: LpWStr,
    pcch_readers: LpDword,
) -> ScardStatus {
    check_handle!(context);
    check_null!(msz_readers);
    check_null!(pcch_readers);

    let context = try_execute!(
        // SAFETY:
        // - `context` is guaranteed to be non-zero due to the prior check.
        // - `context` is a valid raw scard context handle.
        unsafe { raw_scard_context_handle_to_scard_context_handle(context) }
    );
    let buffer_type = try_execute!(
        // SAFETY: `msz_readers` is valid for both reads and writes for `*pcch_readers` many bytes.
        unsafe { build_buf_request_type_wide(msz_readers, pcch_readers) }
    );

    let out_buf = try_execute!(context.list_readers_wide(buffer_type));

    try_execute!(
        // SAFETY:
        // - `msz_readers` is valid for writes.
        // - `pcch_readers` is valid for writes.
        unsafe { save_out_buf_wide(out_buf, msz_readers, pcch_readers) }
    );

    ErrorKind::Success.into()
}

/// # Safety
///
/// `guids` can be null.
/// Else, `guids` must be valid for both reads and writes for `len` many elements, and it must be properly aligned.
unsafe fn guids_to_uuids(guids: LpCGuid, len: u32) -> WinScardResult<Option<Vec<Uuid>>> {
    Ok(if guids.is_null() {
        None
    } else {
        Some(
            // SAFETY:
            // - `guids` is guaranteed to be non-null due to the prior check.
            // - `guids` is valid for reads for `len` many elements.
            unsafe { from_raw_parts(guids, len.try_into()?) }
                .iter()
                .map(|id| Uuid::from_fields(id.data1, id.data2, id.data3, &id.data4))
                .collect::<Vec<_>>(),
        )
    })
}

/// The `SCardListCardsA` function searches the `smart card database` and provides a list of named cards
/// previously introduced to the system by the user.
///
/// [MSDN Reference](https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scardlistcardsa)
///
/// # Safety
///
/// - `context` must be a valid raw scard context handle.
/// - `pb_atr` must be valid for both reads and writes for 32 bytes, and it must be properly aligned.
/// - `rgquid_interfaces` must be valid for both reads and writes for `cguid_interface_count` many elements, and it must be properly aligned.
/// - `msz_cards` must be valid for both reads and writes for `*pcch_cards` elements, and it must be properly aligned.
/// - `pcch_cards` must be a properly-aligned pointer valid for both reads and writes.
#[cfg_attr(windows, rename_symbol(to = "Rust_SCardListCardsA"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn SCardListCardsA(
    context: ScardContext,
    pb_atr: LpCByte,
    rgquid_interfaces: LpCGuid,
    cguid_interface_count: u32,
    msz_cards: *mut u8,
    pcch_cards: LpDword,
) -> ScardStatus {
    use std::slice::from_raw_parts;

    check_handle!(context);
    check_null!(msz_cards);
    check_null!(pcch_cards);

    let context = try_execute!(
        // SAFETY:
        // - `context` is guaranteed to be non-zero due to the prior check.
        // - `context` is a valid raw scard context handle.
        unsafe { raw_scard_context_handle_to_scard_context_handle(context) }
    );
    let buffer_type = try_execute!(
        // SAFETY: `msz_cards` is valid for both reads and writes for `*pcch_cards` many elements.
        unsafe { build_buf_request_type(msz_cards, pcch_cards) }
    );
    let atr = if pb_atr.is_null() {
        None
    } else {
        // SAFETY:
        // - `pb_attr` is guaranteed to be non-null due to the prior check.
        // - `pb_attr` is valid for reads for 32 bytes.
        Some(unsafe { from_raw_parts(pb_atr, 32) })
    };
    let required_interfaces = try_execute!(
        // SAFETY:
        // - `rgquid_interfaces` is guaranteed to be non-null due to the prior check.
        // - `rgquid_interfaces` is valid for both reads and writes for `cguid_interface_count` many elements.
        unsafe { guids_to_uuids(rgquid_interfaces, cguid_interface_count) }
    );

    let out_buf = try_execute!(context.list_cards(atr, required_interfaces.as_deref(), buffer_type));

    try_execute!(
        // SAFETY:
        // - `msz_cards` is valid for writes.
        // - `pcch_cards` is valid for writes.
        unsafe { save_out_buf(out_buf, msz_cards, pcch_cards) }
    );

    ErrorKind::UnsupportedFeature.into()
}

/// The `SCardListCardsW` function searches the `smart card database` and provides a list of named cards
/// previously introduced to the system by the user.
///
/// [MSDN Reference](https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scardlistcardsw)
///
/// # Safety
///
/// - `context` must be a valid raw scard context handle.
/// - `pb_atr` must be valid for both reads and writes for 32 bytes, and it must be properly aligned.
/// - `rgquid_interfaces` must be valid for both reads and writes for `cguid_interface_count` many elements, and it must be properly aligned.
/// - `msz_cards` must be valid for both reads and writes for `*pcch_cards` elements, and it must be properly aligned.
/// - `pcch_cards` must be a properly-aligned pointer valid for both reads and writes.
#[cfg_attr(windows, rename_symbol(to = "Rust_SCardListCardsW"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn SCardListCardsW(
    context: ScardContext,
    pb_atr: LpCByte,
    rgquid_interfaces: LpCGuid,
    cguid_interface_count: u32,
    msz_cards: *mut u16,
    pcch_cards: LpDword,
) -> ScardStatus {
    use std::slice::from_raw_parts;

    check_handle!(context);
    check_null!(msz_cards);
    check_null!(pcch_cards);

    let context = try_execute!(
        // SAFETY:
        // - `context` is guaranteed to be non-zero due to the prior check.
        // - `context` is a valid raw scard context handle.
        unsafe { raw_scard_context_handle_to_scard_context_handle(context) }
    );
    let buffer_type = try_execute!(
        // SAFETY: `msz_cards` is valid for both reads and writes for `*pcch_cards` many elements.
        unsafe { build_buf_request_type_wide(msz_cards, pcch_cards) }
    );
    let atr = if pb_atr.is_null() {
        None
    } else {
        // SAFETY:
        // - `pb_attr` is guaranteed to be non-null due to the prior check.
        // - `pb_attr` is valid for reads for 32 bytes.
        Some(unsafe { from_raw_parts(pb_atr, 32) })
    };
    let required_interfaces = try_execute!(
        // SAFETY:
        // - `rgquid_interfaces` is guaranteed to be non-null due to the prior check.
        // - `rgquid_interfaces` is valid for both reads and writes for `cguid_interface_count` many elements.
        unsafe { guids_to_uuids(rgquid_interfaces, cguid_interface_count) }
    );

    let out_buf = try_execute!(context.list_cards_wide(atr, required_interfaces.as_deref(), buffer_type));

    try_execute!(
        // SAFETY:
        // - `msz_cards` is valid for writes.
        // - `pcch_cards` is valid for writes.
        unsafe { save_out_buf_wide(out_buf, msz_cards, pcch_cards) }
    );

    ErrorKind::Success.into()
}

#[cfg_attr(windows, rename_symbol(to = "Rust_SCardListInterfacesA"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub extern "system" fn SCardListInterfacesA(
    _context: ScardContext,
    _sz_scard: LpCStr,
    _pguid_interfaces: LpGuid,
    _pcguid_interfaces: LpDword,
) -> ScardStatus {
    ErrorKind::UnsupportedFeature.into()
}

#[cfg_attr(windows, rename_symbol(to = "Rust_SCardListInterfacesW"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub extern "system" fn SCardListInterfacesW(
    _context: ScardContext,
    _sz_scard: LpCWStr,
    _pguid_interfaces: LpGuid,
    _pcguid_interfaces: LpDword,
) -> ScardStatus {
    ErrorKind::UnsupportedFeature.into()
}

#[cfg_attr(windows, rename_symbol(to = "Rust_SCardGetProviderIdA"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub extern "system" fn SCardGetProviderIdA(
    _context: ScardContext,
    _sz_card: LpCStr,
    _pguid_provider_id: LpGuid,
) -> ScardStatus {
    ErrorKind::UnsupportedFeature.into()
}

#[cfg_attr(windows, rename_symbol(to = "Rust_SCardGetProviderIdW"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub extern "system" fn SCardGetProviderIdW(
    _context: ScardContext,
    _sz_card: LpCWStr,
    _pguid_provider_id: LpGuid,
) -> ScardStatus {
    ErrorKind::UnsupportedFeature.into()
}

/// The `SCardGetCardTypeProviderNameA` function returns the name of the module (dynamic link library)
/// that contains the provider for a given card name and provider type.
///
/// [MSDN Refrence](https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scardgetcardtypeprovidernamea)
///
/// # Safety
///
/// - `context` must be a valid raw scard context handle.
/// - `sz_card_name` must be a non-null pointer to a valid, null-terminated C string representing the card name.
/// - `szProvider` must be valid for both reads and writes for `*pcch_provider` elements, and it must be properly aligned.
/// - `pcch_provider` must be a properly-aligned pointer valid for both reads and writes.
#[cfg_attr(windows, rename_symbol(to = "Rust_SCardGetCardTypeProviderNameA"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn SCardGetCardTypeProviderNameA(
    context: ScardContext,
    sz_card_name: LpCStr,
    dw_provide_id: u32,
    szProvider: *mut u8,
    pcch_provider: LpDword,
) -> ScardStatus {
    check_handle!(context);
    check_null!(sz_card_name);
    check_null!(szProvider);
    check_null!(pcch_provider);

    let card_name = try_execute!(
        // SAFETY:
        // - `sz_card_name` is guaranteed to be non-null due to the prior check.
        // - The memory region `sz_card_name` contains a valid null-terminator at the end of string.
        // - The memory region `sz_card_name` points to is valid for reads of bytes up to and including null-terminator.
        unsafe { CStr::from_ptr(sz_card_name.cast()) }.to_str(),
        ErrorKind::InvalidParameter
    );

    let context_handle = try_execute!(
        // SAFETY:
        // - `context` is guaranteed to be non-zero due to the prior check.
        // - `context` is a valid raw scard context handle.
        unsafe { raw_scard_context_handle_to_scard_context_handle(context) }
    );

    let context = context_handle.scard_context();
    let provider_name =
        try_execute!(context.get_card_type_provider_name(card_name, try_execute!(dw_provide_id.try_into())))
            .to_string();

    let buffer_type = try_execute!(
        // SAFETY: `szProvider` is valid for both reads and writes for `*pcch_provider` many elements.
        unsafe { build_buf_request_type(szProvider, pcch_provider) }
    );
    let out_buf = try_execute!(context_handle.write_to_out_buf(provider_name.as_bytes(), buffer_type));

    try_execute!(
        // SAFETY:
        // - `szProvider` is valid for writes.
        // - `pcch_provider` is valid for writes.
        unsafe { save_out_buf(out_buf, szProvider, pcch_provider) }
    );

    ErrorKind::Success.into()
}

/// The `SCardGetCardTypeProviderNameW` function returns the name of the module (dynamic link library)
/// that contains the provider for a given card name and provider type.
///
/// [MSDN Refrence](https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scardgetcardtypeprovidernamew)
///
/// # Safety
///
/// - `context` must be a valid raw scard context handle.
/// - `sz_card_name` must be a non-null pointer to a valid, null-terminated C string representing the card name.
///    Must be properly aligned for `u16`.
/// - `szProvider` must be valid for both reads and writes for `*pcch_provider` elements, and it must be properly aligned.
/// - `pcch_provider` must be a properly-aligned pointer valid for both reads and writes.
#[cfg_attr(windows, rename_symbol(to = "Rust_SCardGetCardTypeProviderNameW"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn SCardGetCardTypeProviderNameW(
    context: ScardContext,
    sz_card_name: LpCWStr,
    dw_provide_id: u32,
    szProvider: *mut u16,
    pcch_provider: LpDword,
) -> ScardStatus {
    check_handle!(context);
    check_null!(sz_card_name);
    check_null!(szProvider);
    check_null!(pcch_provider);

    let card_name = try_execute!(
        // SAFETY:
        // - `sz_card_name` is guaranteed to be non-null due to the prior check.
        // - The memory region `sz_card_name` contains a valid null-terminator at the end of string.
        // - The memory region `sz_card_name` points to is valid for reads of `u16` code units up to and including null-terminator.
        // - `sz_card_name` is properly aligned for `u16`, per the safety preconditions.
        unsafe { U16CString::from_ptr_str(sz_card_name) }
            .to_string()
            .map_err(Error::from)
    );

    let context_handle = try_execute!(
        // SAFETY:
        // - `context` is guaranteed to be non-zero due to the prior check.
        // - `context` is a valid raw scard context handle.
        unsafe { raw_scard_context_handle_to_scard_context_handle(context) }
    );

    let context = context_handle.scard_context();
    let provider_name =
        try_execute!(context.get_card_type_provider_name(&card_name, try_execute!(dw_provide_id.try_into())));
    let wide_provider_name =
        try_execute!(U16CString::from_str(&provider_name).map_err(Error::from)).to_bytes_with_nul();

    let buffer_type = try_execute!(
        // SAFETY: `szProvider` is valid for both reads and writes for `*pcch_provider` many elements.
        unsafe { build_buf_request_type_wide(szProvider, pcch_provider) }
    );
    let out_buf = try_execute!(context_handle.write_to_out_buf(&wide_provider_name, buffer_type));

    try_execute!(
        // SAFETY:
        // - `szProvider` is valid for writes.
        // - `pcch_provider` is valid for writes.
        unsafe { save_out_buf_wide(out_buf, szProvider, pcch_provider) }
    );

    ErrorKind::Success.into()
}

#[cfg_attr(windows, rename_symbol(to = "Rust_SCardIntroduceReaderGroupA"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub extern "system" fn SCardIntroduceReaderGroupA(_context: ScardContext, _sz_group_name: LpCStr) -> ScardStatus {
    ErrorKind::UnsupportedFeature.into()
}

#[cfg_attr(windows, rename_symbol(to = "Rust_SCardIntroduceReaderGroupW"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub extern "system" fn SCardIntroduceReaderGroupW(_context: ScardContext, _sz_group_name: LpCWStr) -> ScardStatus {
    ErrorKind::UnsupportedFeature.into()
}

#[cfg_attr(windows, rename_symbol(to = "Rust_SCardForgetReaderGroupA"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub extern "system" fn SCardForgetReaderGroupA(_context: ScardContext, _sz_group_name: LpCStr) -> ScardStatus {
    ErrorKind::UnsupportedFeature.into()
}

#[cfg_attr(windows, rename_symbol(to = "Rust_SCardForgetReaderGroupW"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub extern "system" fn SCardForgetReaderGroupW(_context: ScardContext, _sz_group_name: LpCWStr) -> ScardStatus {
    ErrorKind::UnsupportedFeature.into()
}

#[cfg_attr(windows, rename_symbol(to = "Rust_SCardIntroduceReaderA"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub extern "system" fn SCardIntroduceReaderA(
    _context: ScardContext,
    _sz_reader_name: LpCStr,
    _sz_device_name: LpCStr,
) -> ScardStatus {
    ErrorKind::UnsupportedFeature.into()
}

#[cfg_attr(windows, rename_symbol(to = "Rust_SCardIntroduceReaderW"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub extern "system" fn SCardIntroduceReaderW(
    _context: ScardContext,
    _sz_reader_name: LpCWStr,
    _sz_device_name: LpCWStr,
) -> ScardStatus {
    ErrorKind::UnsupportedFeature.into()
}

#[cfg_attr(windows, rename_symbol(to = "Rust_SCardForgetReaderA"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub extern "system" fn SCardForgetReaderA(_context: ScardContext, _sz_reader_name: LpCStr) -> ScardStatus {
    ErrorKind::UnsupportedFeature.into()
}

#[cfg_attr(windows, rename_symbol(to = "Rust_SCardForgetReaderW"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub extern "system" fn SCardForgetReaderW(_context: ScardContext, _sz_reader_name: LpCWStr) -> ScardStatus {
    ErrorKind::UnsupportedFeature.into()
}

#[cfg_attr(windows, rename_symbol(to = "Rust_SCardAddReaderToGroupA"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub extern "system" fn SCardAddReaderToGroupA(
    _context: ScardContext,
    _sz_reader_name: LpCStr,
    _sz_group_name: LpCStr,
) -> ScardStatus {
    ErrorKind::UnsupportedFeature.into()
}

#[cfg_attr(windows, rename_symbol(to = "Rust_SCardAddReaderToGroupW"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub extern "system" fn SCardAddReaderToGroupW(
    _context: ScardContext,
    _sz_reader_name: LpCWStr,
    _sz_group_name: LpCWStr,
) -> ScardStatus {
    ErrorKind::UnsupportedFeature.into()
}

#[cfg_attr(windows, rename_symbol(to = "Rust_SCardRemoveReaderFromGroupA"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub extern "system" fn SCardRemoveReaderFromGroupA(
    _context: ScardContext,
    _sz_reader_name: LpCStr,
    _sz_group_name: LpCStr,
) -> ScardStatus {
    ErrorKind::UnsupportedFeature.into()
}

#[cfg_attr(windows, rename_symbol(to = "Rust_SCardRemoveReaderFromGroupW"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub extern "system" fn SCardRemoveReaderFromGroupW(
    _context: ScardContext,
    _sz_reader_name: LpCWStr,
    _sz_group_name: LpCWStr,
) -> ScardStatus {
    ErrorKind::UnsupportedFeature.into()
}

#[cfg_attr(windows, rename_symbol(to = "Rust_SCardIntroduceCardTypeA"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub extern "system" fn SCardIntroduceCardTypeA(
    _context: ScardContext,
    _sz_card_name: LpCStr,
    _pguid_primary_provider: LpCGuid,
    _rgguid_interfaces: LpCGuid,
    _dw_interface_count: u32,
    _pb_atr: LpCByte,
    _pb_atr_mask: LpCByte,
    _cb_atr_len: u32,
) -> ScardStatus {
    ErrorKind::UnsupportedFeature.into()
}

#[cfg_attr(windows, rename_symbol(to = "Rust_SCardIntroduceCardTypeW"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub extern "system" fn SCardIntroduceCardTypeW(
    _context: ScardContext,
    _sz_card_name: LpCWStr,
    _pguid_primary_provider: LpCGuid,
    _rgguid_interfaces: LpCGuid,
    _dw_interface_count: u32,
    _pb_atr: LpCByte,
    _pb_atr_mask: LpCByte,
    _cb_atr_len: u32,
) -> ScardStatus {
    ErrorKind::UnsupportedFeature.into()
}

#[cfg_attr(windows, rename_symbol(to = "Rust_SCardSetCardTypeProviderNameA"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub extern "system" fn SCardSetCardTypeProviderNameA(
    _context: ScardContext,
    _sz_card_name: LpCStr,
    _dw_provider_id: u32,
    _sz_provider: LpCStr,
) -> ScardStatus {
    ErrorKind::UnsupportedFeature.into()
}

#[cfg_attr(windows, rename_symbol(to = "Rust_SCardSetCardTypeProviderNameW"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub extern "system" fn SCardSetCardTypeProviderNameW(
    _context: ScardContext,
    _sz_card_name: LpCWStr,
    _dw_provider_id: u32,
    _sz_provider: LpCWStr,
) -> ScardStatus {
    ErrorKind::UnsupportedFeature.into()
}

#[cfg_attr(windows, rename_symbol(to = "Rust_SCardForgetCardTypeA"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub extern "system" fn SCardForgetCardTypeA(_context: ScardContext, _sz_card_name: LpCStr) -> ScardStatus {
    ErrorKind::UnsupportedFeature.into()
}

#[cfg_attr(windows, rename_symbol(to = "Rust_SCardForgetCardTypeW"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub extern "system" fn SCardForgetCardTypeW(_context: ScardContext, _sz_card_name: LpCWStr) -> ScardStatus {
    ErrorKind::UnsupportedFeature.into()
}

/// The `SCardFreeMemory` function releases memory that has been returned from the `resource manager`
/// using the `SCARD_AUTOALLOCATE` length designator.
///
/// [MSDN Reference](https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scardfreememory)
///
/// # Safety
///
/// The `context` must be a valid raw scard context handle.
#[cfg_attr(windows, rename_symbol(to = "Rust_SCardFreeMemory"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn SCardFreeMemory(context: ScardContext, pv_mem: LpCVoid) -> ScardStatus {
    check_handle!(context);

    // SAFETY:
    // - `context` is guaranteed to be non-zero due to the prior check.
    // - `context` is a valid raw scard context handle.
    if let Ok(context) = unsafe { raw_scard_context_handle_to_scard_context_handle(context) } {
        if context.free_buffer(pv_mem) {
            info!("Allocated buffer successfully freed");
        } else {
            warn!(?pv_mem, "Attempt to free unknown buffer");
        }

        ErrorKind::Success.into()
    } else {
        ErrorKind::InvalidHandle.into()
    }
}

// This handle exists up to the end of the program and never freed.
// We use created event to return its handle from the `SCardAccessStartedEvent` function.
// Note. If the `SCardAccessStartedEvent` frunction is not be called, the event will not be created.
#[cfg(target_os = "windows")]
static START_EVENT_HANDLE: LazyLock<Handle> = LazyLock::new(|| {
    use windows::Win32::System::Threading::CreateEventA;

    // SAFETY: FFI call with no outstanding preconditions.
    let handle = unsafe { CreateEventA(None, true, true, None) };

    let handle = handle
        .inspect_err(|error| {
            error!(?error, "Unable to create event",);
        })
        .unwrap_or_default();

    handle.0.expose_provenance() as isize
});

/// The `SCardAccessStartedEvent` function returns an event handle when an event signals that the smart
/// card resource manager is started.
///
/// [MSDN Reference](https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scardaccessstartedevent)
#[cfg_attr(windows, rename_symbol(to = "Rust_SCardAccessStartedEvent"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub extern "system" fn SCardAccessStartedEvent() -> Handle {
    #[cfg(target_os = "windows")]
    {
        // https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scardaccessstartedevent
        // The `SCardAccessStartedEvent` function returns an event handle when an event signals that
        // the smart card resource manager is started. The event-object handle can be specified in a call
        // to one of the wait functions.

        if std::env::var(SMART_CARD_TYPE)
            .and_then(|use_system_card| Ok(use_system_card == "true"))
            .unwrap_or_default()
        {
            // Use system-provided smart card.
            //
            // SAFETY: The `WINSCARD_API` is lazily initialized, so it's safe to call this function.
            unsafe { (WINSCARD_API.SCardAccessStartedEvent)() }
        } else {
            // Use emulated smart card.
            //
            // We create the event once for the entire process and keep it like a singleton in the "signaled" state.
            // We assume we're always ready for our virtual smart cards. Moreover, we don't use reference counters
            // because we are always in a ready (signaled) state and have only one handle for the entire process.
            *START_EVENT_HANDLE
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        // We support the `SCardAccessStartedEvent` function only on Windows OS. Reason:
        // On non-Windows OS we use pcsc-lite API that doesn't have the `SCardAccessStartedEvent` function.
        // Thus, we don't need it there.
        //
        // The function returns an event HANDLE if it succeeds or NULL if it fails.
        0
    }
}

/// The `SCardReleaseStartedEvent` function decrements the reference count for a handle acquired by a
/// previous call to the `SCardAccessStartedEvent` function.
///
/// [MSDN Reference](https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scardreleasestartedevent)
#[cfg_attr(windows, rename_symbol(to = "Rust_SCardReleaseStartedEvent"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub extern "system" fn SCardReleaseStartedEvent() {
    #[cfg(target_os = "windows")]
    {
        if std::env::var(SMART_CARD_TYPE)
            .and_then(|use_system_card| Ok(use_system_card == "true"))
            .unwrap_or_default()
        {
            // Use system-provided smart card.
            //
            // SAFETY: The `WINSCARD_API` is lazily initialized.
            unsafe { (WINSCARD_API.SCardReleaseStartedEvent)() }
        } else {
            use windows::Win32::Foundation::{CloseHandle, GetLastError, HANDLE};

            // Use emulated smart card.
            //
            // We create the event once for the entire process and keep it like a singleton in the "signaled" state.
            // We assume we're always ready for our virtual smart cards. Moreover, we don't use reference counters
            // because we are always in a ready (signaled) state and have only one handle for the entire process.
            //
            // SAFETY: The `START_EVENT_HANDLE` is lazily initialized.
            let result = unsafe {
                CloseHandle(HANDLE(std::ptr::with_exposed_provenance_mut(
                    *START_EVENT_HANDLE as usize,
                )))
            };

            if let Err(error) = result {
                error!(?error, "Cannot close the event handle");
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        // We support the `SCardReleaseStartedEvent` function only on Windows OS. Reason:
        // On non-Windows OS we use pcsc-lite API that doesn't have the `SCardReleaseStartedEvent` function.
        // Thus, we don't need it there.
    }
}

#[cfg_attr(windows, rename_symbol(to = "Rust_SCardLocateCardsA"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub extern "system" fn SCardLocateCardsA(
    _context: ScardContext,
    _msz_cards: LpCStr,
    _rg_reader_states: LpScardReaderStateA,
    _c_readers: u32,
) -> ScardStatus {
    ErrorKind::UnsupportedFeature.into()
}

#[cfg_attr(windows, rename_symbol(to = "Rust_SCardLocateCardsW"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub extern "system" fn SCardLocateCardsW(
    _context: ScardContext,
    _msz_cards: LpCWStr,
    _rg_reader_states: LpScardReaderStateW,
    _c_readers: u32,
) -> ScardStatus {
    ErrorKind::UnsupportedFeature.into()
}

#[cfg_attr(windows, rename_symbol(to = "Rust_SCardLocateCardsByATRA"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub extern "system" fn SCardLocateCardsByATRA(
    _context: ScardContext,
    _rg_atr_masks: LpScardAtrMask,
    _c_atrs: u32,
    _rg_reader_states: LpScardReaderStateA,
    _c_readers: u32,
) -> ScardStatus {
    ErrorKind::UnsupportedFeature.into()
}

#[cfg_attr(windows, rename_symbol(to = "Rust_SCardLocateCardsByATRW"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub extern "system" fn SCardLocateCardsByATRW(
    _context: ScardContext,
    _rg_atr_masks: LpScardAtrMask,
    _c_atrs: u32,
    _rg_reader_states: LpScardReaderStateW,
    _c_readers: u32,
) -> ScardStatus {
    ErrorKind::UnsupportedFeature.into()
}

/// The `SCardGetStatusChangeA` function blocks execution until the current availability of the cards
/// in a specific set of readers changes.
///
/// [MSDN Reference](https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scardgetstatuschangea)
///
/// # Safety
///
/// - `context` must be a valid raw scard context handle.
/// - `rg_reader_state` must point to an array of valid [`ScardReaderStateA`](ffi_types::winscard::ScardReaderStateA) structures.
///   Also, it must be valid for both reads and writes for `c_readers` many bytes, and it must be properly aligned.
///   Each [`ScardReaderStateA`](ffi_types::winscard::ScardReaderStateA)'s `sz_reader` field must be a non-null pointer
///   to a valid, null-terminated C string.
#[cfg_attr(windows, rename_symbol(to = "Rust_SCardGetStatusChangeA"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn SCardGetStatusChangeA(
    context: ScardContext,
    dw_timeout: u32,
    rg_reader_states: LpScardReaderStateA,
    c_readers: u32,
) -> ScardStatus {
    check_handle!(context);
    check_null!(rg_reader_states);

    let context = try_execute!(
        // SAFETY:
        // - `context` is guaranteed to be non-zero due to the prior check.
        // - `context` is a valid raw scard context handle.
        unsafe { scard_context_to_winscard_context(context) }
    );

    // SAFETY:
    // - `rg_reader_state` is guaranteed to be non-null due to the prior check.
    // - `rh_reader_state` is valid for both reads and writes for `c_readers` many bytes.
    let c_reader_states = unsafe {
        from_raw_parts_mut(
            rg_reader_states,
            try_execute!(c_readers.try_into(), ErrorKind::InsufficientBuffer),
        )
    };
    let mut reader_states = try_execute!(
        c_reader_states
            .iter()
            .map(|c_reader| {
                check_null!(c_reader.sz_reader, "reader name in reader state");

                Ok(ReaderState {
                    // SAFETY:
                    // - `c_reader.sz_reader` is guaranteed to be non-null due to the prior check.
                    // - The memory region `c_reader.sz_reader` contains a valid null-terminator at the end of string.
                    // - The memory region `c_reader.sz_reader` points to is valid for reads of bytes up to and including null-terminator.
                    reader_name: unsafe { CStr::from_ptr(c_reader.sz_reader.cast()) }.to_string_lossy(),
                    user_data: c_reader.pv_user_data as usize,
                    current_state: CurrentState::from_bits(c_reader.dw_current_state).unwrap_or_default(),
                    event_state: CurrentState::from_bits(c_reader.dw_event_state).unwrap_or_default(),
                    atr_len: c_reader.cb_atr.try_into()?,
                    atr: c_reader.rgb_atr,
                })
            })
            .collect::<Result<Vec<_>, Error>>()
    );
    try_execute!(context.get_status_change(dw_timeout, &mut reader_states));

    for (reader_state, c_reader_state) in reader_states.iter().zip(c_reader_states.iter_mut()) {
        c_reader_state.dw_event_state = reader_state.event_state.bits();
        c_reader_state.cb_atr = try_execute!(reader_state.atr_len.try_into(), ErrorKind::InternalError);
        c_reader_state.rgb_atr.copy_from_slice(&reader_state.atr);
    }

    ErrorKind::Success.into()
}

/// The `SCardGetStatusChangeW` function blocks execution until the current availability of the cards
/// in a specific set of readers changes.
///
/// [MSDN Reference](https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scardgetstatuschangew)
///
/// # Safety
///
/// - `context` must be a valid raw scard context handle.
/// - `rg_reader_state` must point to an array of valid [`ScardReaderStateW`](ffi_types::winscard::ScardReaderStateW) structures.
///   Also, it must be valid for both reads and writes for `c_readers` many bytes, and it must be properly aligned.
///   Each [`ScardReaderStateW`](ffi_types::winscard::ScardReaderStateW)'s `sz_reader` field must be a non-null pointer
///   to a valid, null-terminated C string, and be properly aligned for `u16`.
#[cfg_attr(windows, rename_symbol(to = "Rust_SCardGetStatusChangeW"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn SCardGetStatusChangeW(
    context: ScardContext,
    dw_timeout: u32,
    rg_reader_states: LpScardReaderStateW,
    c_readers: u32,
) -> ScardStatus {
    check_handle!(context);
    check_null!(rg_reader_states);

    let context = try_execute!(
        // SAFETY:
        // - `context` is guaranteed to be non-zero due to the prior check.
        // - `context` is a valid raw scard context handle.
        unsafe { scard_context_to_winscard_context(context) }
    );

    // SAFETY:
    // - `rg_reader_state` is guaranteed to be non-null due to the prior check.
    // - `rh_reader_state` is valid for both reads and writes for `c_readers` many bytes.
    let c_reader_states = unsafe {
        from_raw_parts_mut(
            rg_reader_states,
            try_execute!(c_readers.try_into(), ErrorKind::InsufficientBuffer),
        )
    };
    let mut reader_states = try_execute!(
        c_reader_states
            .iter()
            .map(|c_reader| {
                check_null!(c_reader.sz_reader, "reader name in reader state");

                Ok(ReaderState {
                    reader_name: Cow::Owned(
                        // SAFETY:
                        // - `c_reader.sz_reader` is guaranteed to be non-null due to the prior check.
                        // - The memory region `c_reader.sz_reader` contains a valid null-terminator at the end of string.
                        // - The memory region `c_reader.sz_reader` points to is valid for reads of `u16` code units up to and including null-terminator.
                        // - `c_reader.sz_reader` is properly aligned for `u16`, per the safety preconditions.
                        unsafe { U16CString::from_ptr_str(c_reader.sz_reader) }
                            .to_string()
                            .map_err(Error::from)?,
                    ),
                    user_data: c_reader.pv_user_data as usize,
                    current_state: CurrentState::from_bits(c_reader.dw_current_state).unwrap_or_default(),
                    event_state: CurrentState::from_bits(c_reader.dw_event_state).unwrap_or_default(),
                    atr_len: c_reader.cb_atr.try_into()?,
                    atr: c_reader.rgb_atr,
                })
            })
            .collect::<Result<Vec<_>, Error>>()
    );
    try_execute!(context.get_status_change(dw_timeout, &mut reader_states));

    for (reader_state, c_reader_state) in reader_states.iter().zip(c_reader_states.iter_mut()) {
        c_reader_state.dw_event_state = reader_state.event_state.bits();
        c_reader_state.cb_atr = try_execute!(reader_state.atr_len.try_into(), ErrorKind::InternalError);
        c_reader_state.rgb_atr.copy_from_slice(&reader_state.atr);
    }

    ErrorKind::Success.into()
}

/// The `SCardCancel` function terminates all outstanding actions within a specific `resource manager context`.
///
/// [MSDN Reference](https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scardcancel)
///
/// # Safety
///
/// The `context` must be a valid raw scard context handle.
#[cfg_attr(windows, rename_symbol(to = "Rust_SCardCancel"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn SCardCancel(context: ScardContext) -> ScardStatus {
    check_handle!(context);

    let context = try_execute!(
        // SAFETY:
        // - `context` is guaranteed to be non-zero due to the prior check.
        // - `context` is a valid raw scard context handle.
        unsafe { scard_context_to_winscard_context(context) }
    );
    try_execute!(context.cancel());

    ErrorKind::Success.into()
}

/// # Safety
///
/// - `context` must be a valid raw scard context handle.
/// - `card_identifier` must be a pointer to a valid [`Uuid`](ffi_types::Uuid) structure, and it must be properly-aligned.
/// - `data` must be valid for both reads and writes for `*data_len` elements, and it must be properly aligned.
/// - `data_len` must be valid for both reads and writes, and it must be properly aligned.
unsafe fn read_cache(
    context: ScardContext,
    card_identifier: LpUuid,
    freshness_counter: u32,
    lookup_name: &str,
    data: LpByte,
    data_len: LpDword,
) -> WinScardResult<()> {
    check_handle!(context, "scard context handle");
    check_null!(card_identifier, "scard card identifier");
    check_null!(data_len, "data buffer length");

    // SAFETY:
    // - `context` is guaranteed to be non-zero due to the prior check.
    // - `context` is a valid raw scard context handle.
    let context = unsafe { raw_scard_context_handle_to_scard_context_handle(context) }?;

    // SAFETY:
    // - `card_identifier` is guaranteed to be non-null due to the prior check.
    // - `card_identifier` points to a valid `Uuid` structure.
    let card_identifier = unsafe { *card_identifier };

    let card_id = Uuid::from_fields(
        card_identifier.data1,
        card_identifier.data2,
        card_identifier.data3,
        &card_identifier.data4,
    );

    // SAFETY: `data` is valid for both reads and writes for `*data_len` many elements.
    let buffer_type = unsafe { build_buf_request_type(data, data_len) }?;

    let out_buf = context.read_cache(card_id, freshness_counter, lookup_name, buffer_type)?;

    // SAFETY:
    // - `data` is valid for writes.
    // - `data_len` is valid for writes.
    unsafe { save_out_buf(out_buf, data, data_len) }
}

/// The `SCardReadCacheA` function retrieves the value portion of a name-value pair from the global cache
/// maintained by the `Smart Card Resource Manager`.
///
/// [MSDN Reference](https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scardreadcachea)
///
/// # Safety
///
/// - `context` must be a valid raw scard context handle.
/// - `card_identifier` must be a pointer to a valid [`Uuid`](ffi_types::Uuid) structure, and it must be properly-aligned.
/// - `lookup_name` must be a non-null pointer to a valid, null-terminated C string.
/// - `data` must be valid for both reads and writes for `*data_len` elements, and it must be properly aligned.
/// - `data_len` must be valid for both reads and writes, and it must be properly aligned.
#[cfg_attr(windows, rename_symbol(to = "Rust_SCardReadCacheA"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn SCardReadCacheA(
    context: ScardContext,
    card_identifier: LpUuid,
    freshness_counter: u32,
    lookup_name: LpStr,
    data: LpByte,
    data_len: LpDword,
) -> ScardStatus {
    check_null!(lookup_name);

    let lookup_name = try_execute!(
        // SAFETY:
        // - `lookup_name` is guaranteed to be non-null due to the prior check.
        // - The memory region `lookup_name` contains a valid null-terminator at the end of string.
        // - The memory region `lookup_name` points to is valid for reads of bytes up to and including null-terminator.
        unsafe { CStr::from_ptr(lookup_name.cast()) }.to_str(),
        ErrorKind::InvalidParameter
    );
    try_execute!(
        // SAFETY:
        // - `context` is a valid raw scard context handle.
        // - `card_identifier` is a pointer to a valid `Uuid` structure, and it is properly-aligned.
        // - `data` is a valid for both reads and writes for `*data_len` elements, and it is properly-aligned.
        // - `data_len` is valid for both reads and writes, and it is properly-aligned.
        unsafe { read_cache(context, card_identifier, freshness_counter, lookup_name, data, data_len,) }
    );

    ErrorKind::Success.into()
}

/// The `SCardReadCacheW` function retrieves the value portion of a name-value pair from the global cache
/// maintained by the `Smart Card Resource Manager`.
///
/// [MSDN Reference](https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scardreadcachew)
///
/// # Safety
///
/// - `context` must be a valid raw scard context handle.
/// - `card_identifier` must be a pointer to a valid [`Uuid`](ffi_types::Uuid) structure, and it must be properly-aligned.
/// - `lookup_name` must be a non-null pointer to a valid, null-terminated C string, and be properly aligned for `u16`.
/// - `data` must be valid for both reads and writes for `*data_len` elements, and it must be properly aligned.
/// - `data_len` must be valid for both reads and writes, and it must be properly aligned.
#[cfg_attr(windows, rename_symbol(to = "Rust_SCardReadCacheW"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn SCardReadCacheW(
    context: ScardContext,
    card_identifier: LpUuid,
    freshness_counter: u32,
    lookup_name: LpWStr,
    data: LpByte,
    data_len: LpDword,
) -> ScardStatus {
    check_null!(lookup_name);

    let lookup_name = try_execute!(
        // SAFETY:
        // - `lookup_name` is guaranteed to be non-null due to the prior check.
        // - The memory region `lookup_name` contains a valid null-terminator at the end of string.
        // - The memory region `lookup_name` points to is valid for reads of `u16` code units up to and including null-terminator.
        // - `lookup_name` is properly aligned for `u16`, per the safety preconditions.
        unsafe { U16CString::from_ptr_str(lookup_name) }
            .to_string()
            .map_err(Error::from)
    );

    try_execute!(
        // SAFETY:
        // - `context` is a valid raw scard context handle.
        // - `card_identifier` is a pointer to a valid `Uuid` structure, and it is properly-aligned.
        // - `data` us a valid for both reads and writes for `*data_len` elements, and it is properly-aligned.
        // - `data_len` is valid for both reads and writes, and it is properly-aligned.
        unsafe {
            read_cache(
                context,
                card_identifier,
                freshness_counter,
                &lookup_name,
                data,
                data_len,
            )
        }
    );

    ErrorKind::Success.into()
}

/// # Safety
///
/// - `context` must be a valid raw scard context handle.
/// - `card_identifier` must be a pointer to a valid [`Uuid`](ffi_types::Uuid) structure, and it must be properly-aligned.
/// - `data` must be valid for reads for `data_len` elements, and it must be properly aligned.
unsafe fn write_cache(
    context: ScardContext,
    card_identifier: LpUuid,
    freshness_counter: u32,
    lookup_name: &str,
    data: LpCByte,
    data_len: u32,
) -> WinScardResult<()> {
    check_handle!(context, "scard context handle");
    check_null!(card_identifier, "card identified");

    // SAFETY:
    // - `card_identifier` is guaranteed to be non-null due to the prior check.
    // - `card_identifier` points to a valid `Uuid` structure.
    let card_identifier = unsafe { *card_identifier };

    let card_id = Uuid::from_fields(
        card_identifier.data1,
        card_identifier.data2,
        card_identifier.data3,
        &card_identifier.data4,
    );

    // SAFETY: `context` is a valid raw scard context handle.
    let context = unsafe { scard_context_to_winscard_context(context) }?;
    // The YubiKey Smart Card Minidriver can call `SCardWriteCacheW` with the `Data` pointer set to NULL and
    // `DataLen` equal to 0.
    let data = if data.is_null() || data_len == 0 {
        Vec::new()
    } else {
        // SAFETY: The `data` parameter is not null (checked above).
        unsafe { from_raw_parts(data, data_len.try_into()?) }.to_vec()
    };

    context.write_cache(card_id, freshness_counter, lookup_name.to_owned(), data)
}

/// The `SCardWriteCacheA` function writes a name-value pair from a smart card to the global cache
/// maintained by the `Smart Card Resource Manager`.
///
/// [MSDN Reference](https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scardwritecachea)
///
/// # Safety
///
/// - `context` must be a valid raw scard context handle.
/// - `card_identifier` must be a pointer to a valid [`Uuid`](ffi_types::Uuid) structure, and it must be properly-aligned.
/// - `lookup_name` must be a non-null pointer to a valid, null-terminated C string.
/// - `data` must be valid for reads for `data_len` elements, and it must be properly aligned.
#[cfg_attr(windows, rename_symbol(to = "Rust_SCardWriteCacheA"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn SCardWriteCacheA(
    context: ScardContext,
    card_identifier: LpUuid,
    freshness_counter: u32,
    lookup_name: LpStr,
    data: LpCByte,
    data_len: u32,
) -> ScardStatus {
    check_null!(lookup_name);

    let lookup_name = try_execute!(
        // SAFETY:
        // - `lookup_name` is guaranteed to be non-null due to the prior check.
        // - The memory region `lookup_name` contains a valid null-terminator at the end of string.
        // - The memory region `lookup_name` points to is valid for reads of bytes up to and including null-terminator.
        unsafe { CStr::from_ptr(lookup_name.cast()) }.to_str(),
        ErrorKind::InvalidParameter
    );
    try_execute!(
        // SAFETY:
        // - `context` is a valid raw scard context handle.
        // - `card_identifier` is a pointer to a valid `Uuid` structure, and it is properly-aligned.
        // - `data` us a valid for reads for `data_len` elements, and it is properly-aligned.
        unsafe { write_cache(context, card_identifier, freshness_counter, lookup_name, data, data_len,) }
    );

    ErrorKind::Success.into()
}

/// The `SCardWriteCacheW` function writes a name-value pair from a smart card to the global cache
/// maintained by the `Smart Card Resource Manager`.
///
/// [MSDN Reference](https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scardwritecachew)
///
/// # Safety
///
/// - `context` must be a valid raw scard context handle.
/// - `card_identifier` must be a pointer to a valid [`Uuid`](ffi_types::Uuid) structure, and it must be properly-aligned.
/// - `lookup_name` must be a non-null pointer to a valid, null-terminated C string, and be properly aligned for `u16`.
/// - `data` must be valid for reads for `data_len` elements, and it must be properly aligned.
#[cfg_attr(windows, rename_symbol(to = "Rust_SCardWriteCacheW"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn SCardWriteCacheW(
    context: ScardContext,
    card_identifier: LpUuid,
    freshness_counter: u32,
    lookup_name: LpWStr,
    data: LpCByte,
    data_len: u32,
) -> ScardStatus {
    check_null!(lookup_name);

    let lookup_name = try_execute!(
        // SAFETY:
        // - `lookup_name` is guaranteed to be non-null due to the prior check.
        // - The memory region `lookup_name` contains a valid null-terminator at the end of string.
        // - The memory region `lookup_name` points to is valid for reads of `u16` code units up to and including null-terminator.
        // - `lookup_name` is properly aligned for `u16`, per the safety preconditions.
        unsafe { U16CString::from_ptr_str(lookup_name) }
            .to_string()
            .map_err(Error::from)
    );
    try_execute!(
        // SAFETY:
        // - `context` is a valid raw scard context handle.
        // - `card_identifier` is a pointer to a valid `Uuid` structure, and it is properly-aligned.
        // - `data` us a valid for reads for `data_len` elements, and it is properly-aligned.
        unsafe {
            write_cache(
                context,
                card_identifier,
                freshness_counter,
                &lookup_name,
                data,
                data_len,
            )
        }
    );

    ErrorKind::Success.into()
}

/// # Safety
///
/// - `context` must be a valid raw scard context handle.
/// - `pb_icon` can be null. Else, it must be valid for reads for `*pb_icon` elements, and it must be properly aligned.
/// - `data_len` must be valid for both reads and writes, and it must be properly aligned.
unsafe fn get_reader_icon(
    context: ScardContext,
    reader_name: &str,
    pb_icon: LpByte,
    pcb_icon: LpDword,
) -> WinScardResult<()> {
    check_handle!(context, "scard context handle");
    // `pb_icon` can be null.
    check_null!(pcb_icon, "pcb_icon");

    // SAFETY: `context` is a valid raw scard context handle.
    let context = unsafe { raw_scard_context_handle_to_scard_context_handle(context) }?;

    // SAFETY:
    // - `pb_icon` is allowed to be null.
    // - If `pb_icon` is non-null, it is valid for both reads and writes for `*pcb_icon` many elements.
    let buffer_type = unsafe { build_buf_request_type(pb_icon, pcb_icon) }?;

    let out_buf = context.get_reader_icon(reader_name, buffer_type)?;

    // SAFETY:
    // - `pb_icon` is allowed to be null.
    // ` If `pb_icon` is non-null, it is valid for writes.
    // - `pcb_icon` is valid for writes.
    unsafe { save_out_buf(out_buf, pb_icon, pcb_icon) }?;

    Ok(())
}

/// The `SCardGetReaderIconA` function gets an icon of the smart card reader for a given reader's name.
///
/// [MSDN Reference](https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scardgetreadericona)
///
/// # Safety
///
/// - `context` must be a valid raw scard context handle.
/// - `sz_reader_name` must be a non-null pointer to a valid, null-terminated C string.
/// - `pb_icon` can be null. Else, it must be valid for reads for `*pb_icon` elements, and it must be properly aligned.
/// - `data_len` must be valid for both reads and writes, and it must be properly aligned.
#[cfg_attr(windows, rename_symbol(to = "Rust_SCardGetReaderIconA"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn SCardGetReaderIconA(
    context: ScardContext,
    sz_reader_name: LpCStr,
    pb_icon: LpByte,
    pcb_icon: LpDword,
) -> ScardStatus {
    check_null!(sz_reader_name);

    let reader_name = try_execute!(
        // SAFETY:
        // - `sz_reader_name` is guaranteed to be non-null due to the prior check.
        // - The memory region `sz_reader_name` contains a valid null-terminator at the end of string.
        // - The memory region `sz_reader_name` points to is valid for reads of bytes up to and including null-terminator.
        unsafe { CStr::from_ptr(sz_reader_name.cast()) }.to_str(),
        ErrorKind::InvalidParameter
    );

    try_execute!(
        // SAFETY:
        // - `context` is a valid raw scard context handle.
        // - `pb_icon` us a valid for both reads and writes for `*pcb_icon` elements, and it is properly-aligned.
        // - `pcb_icon` is valid for both reads and writes, and it is properly-aligned.
        unsafe { get_reader_icon(context, reader_name, pb_icon, pcb_icon) }
    );

    ErrorKind::Success.into()
}

/// The `SCardGetReaderIconW` function gets an icon of the smart card reader for a given reader's name.
///
/// [MSDN Reference](https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scardgetreadericonw)
///
/// # Safety
///
/// - `context` must be a valid raw scard context handle.
/// - `sz_reader_name` must be a non-null pointer to a valid, null-terminated C string, and be properly aligned for `u16`.
/// - `pb_icon` can be null. Else, it must be valid for reads for `*pb_icon` elements, and it must be properly aligned.
/// - `data_len` must be valid for both reads and writes, and it must be properly aligned.
#[cfg_attr(windows, rename_symbol(to = "Rust_SCardGetReaderIconW"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn SCardGetReaderIconW(
    context: ScardContext,
    sz_reader_name: LpCWStr,
    pb_icon: LpByte,
    pcb_icon: LpDword,
) -> ScardStatus {
    check_null!(sz_reader_name);

    let reader_name = try_execute!(
        // SAFETY:
        // - `sz_reader_name` is guaranteed to be non-null due to the prior check.
        // - The memory region `sz_reader_name` contains a valid null-terminator at the end of string.
        // - The memory region `sz_reader_name` points to is valid for reads of `u16` code units up to and including null-terminator.
        // - `sz_reader_name` is properly aligned for `u16`, per the safety preconditions.
        unsafe { U16CString::from_ptr_str(sz_reader_name) }
            .to_string()
            .map_err(Error::from)
    );

    try_execute!(
        // SAFETY:
        // - `context` is a valid raw scard context handle.
        // - `pb_icon` us a valid for both reads and writes for `*pcb_icon` elements, and it is properly-aligned.
        // - `pcb_icon` is valid for both reads and writes, and it is properly-aligned.
        unsafe { get_reader_icon(context, &reader_name, pb_icon, pcb_icon) }
    );

    ErrorKind::Success.into()
}

/// # Safety
///
/// - `context` must be a valid raw scard context handle.
/// - `pdw_device_type_id` must be a properly-aligned pointer, that points to a memory region valid for both reads and writes.
unsafe fn get_device_type_id(
    context: ScardContext,
    reader_name: &str,
    pdw_device_type_id: LpDword,
) -> WinScardResult<()> {
    check_handle!(context, "scard context handle");
    check_null!(pdw_device_type_id, "pdw_device_type_id");

    // SAFETY:
    // - `context` is guaranteed to be non-zero due to the prior check.
    // - `context` is a valid raw scard context handle.
    let context = unsafe { scard_context_to_winscard_context(context) }?;

    // SAFETY: `pdw_device_type_id` is guaranteed to be non-null due to the prior check.
    unsafe {
        *pdw_device_type_id = context.device_type_id(reader_name)?.into();
    }

    Ok(())
}

/// The `SCardGetDeviceTypeIdA` function gets the device type identifier of the card reader for the given reader name.
///
/// [MSDN Reference](https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scardgetdevicetypeida)
///
/// # Safety
///
/// - `context` must be a valid raw scard context handle.
/// - `sz_reader_name` must be a non-null pointer to a valid, null-terminated C string.
/// - `pdw_device_type_id` must be a properly-aligned pointer, that points to a memory region valid for both reads and writes.
#[cfg_attr(windows, rename_symbol(to = "Rust_SCardGetDeviceTypeIdA"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn SCardGetDeviceTypeIdA(
    context: ScardContext,
    sz_reader_name: LpCStr,
    pdw_device_type_id: LpDword,
) -> ScardStatus {
    check_null!(sz_reader_name);

    let reader_name = try_execute!(
        // SAFETY:
        // - `sz_reader_name` is guaranteed to be non-null due to the prior check.
        // - The memory region `sz_reader_name` contains a valid null-terminator at the end of string.
        // - The memory region `sz_reader_name` points to is valid for reads of bytes up to and including null-terminator.
        unsafe { CStr::from_ptr(sz_reader_name.cast()) }.to_str(),
        ErrorKind::InvalidParameter
    );

    try_execute!(
        // SAFETY:
        // - `context` is a valid raw scard context handle.
        // - `pdw_device_type_id` is a properly-aligned pointer that points to a memory region valid for both reads and writes.
        unsafe { get_device_type_id(context, reader_name, pdw_device_type_id) }
    );

    ErrorKind::Success.into()
}

/// The `SCardGetDeviceTypeIdW` function gets the device type identifier of the card reader for the given reader name.
///
/// [MSDN Reference](https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scardgetdevicetypeidw)
///
/// # Safety
///
/// - `context` must be a valid raw scard context handle.
/// - `sz_reader_name` must be a non-null pointer to a valid, null-terminated C string, and be properly aligned for `u16`.
/// - `pdw_device_type_id` must be a properly-aligned pointer, that points to a memory region valid for both reads and writes.
#[cfg_attr(windows, rename_symbol(to = "Rust_SCardGetDeviceTypeIdW"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn SCardGetDeviceTypeIdW(
    context: ScardContext,
    sz_reader_name: LpCWStr,
    pdw_device_type_id: LpDword,
) -> ScardStatus {
    check_null!(sz_reader_name);

    let reader_name = try_execute!(
        // SAFETY:
        // - `sz_reader_name` is guaranteed to be non-null due to the prior check.
        // - The memory region `sz_reader_name` contains a valid null-terminator at the end of string.
        // - The memory region `sz_reader_name` points to is valid for reads of `u16` code units up to and including null-terminator.
        // - `sz_reader_name` is properly aligned for `u16`, per the safety preconditions.
        unsafe { U16CString::from_ptr_str(sz_reader_name) }
            .to_string()
            .map_err(Error::from)
    );

    try_execute!(
        // SAFETY:
        // - `context` is a valid raw scard context handle.
        // - `pdw_device_type_id` is a properly-aligned pointer that points to a memory region valid for both reads and writes.
        unsafe { get_device_type_id(context, &reader_name, pdw_device_type_id) }
    );

    ErrorKind::Success.into()
}

#[cfg_attr(windows, rename_symbol(to = "Rust_SCardGetReaderDeviceInstanceIdA"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub extern "system" fn SCardGetReaderDeviceInstanceIdA(
    _context: ScardContext,
    _sz_reader_name: LpCStr,
    _sz_device_instance_id: LpStr,
    _pcch_device_instance_id: LpDword,
) -> ScardStatus {
    ErrorKind::UnsupportedFeature.into()
}

#[cfg_attr(windows, rename_symbol(to = "Rust_SCardGetReaderDeviceInstanceIdW"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub extern "system" fn SCardGetReaderDeviceInstanceIdW(
    _context: ScardContext,
    _sz_reader_name: LpCWStr,
    _sz_device_instance_id: LpWStr,
    _pcch_device_instance_id: LpDword,
) -> ScardStatus {
    ErrorKind::UnsupportedFeature.into()
}

#[cfg_attr(windows, rename_symbol(to = "Rust_SCardListReadersWithDeviceInstanceIdA"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub extern "system" fn SCardListReadersWithDeviceInstanceIdA(
    _context: ScardContext,
    _sz_device_instance_id: LpCStr,
    _msz_readers: LpStr,
    _pcch_readers: LpDword,
) -> ScardStatus {
    ErrorKind::UnsupportedFeature.into()
}

#[cfg_attr(windows, rename_symbol(to = "Rust_SCardListReadersWithDeviceInstanceIdW"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub extern "system" fn SCardListReadersWithDeviceInstanceIdW(
    _context: ScardContext,
    _sz_device_instance_id: LpCWStr,
    _msz_readers: LpWStr,
    _pcch_readers: LpDword,
) -> ScardStatus {
    ErrorKind::UnsupportedFeature.into()
}

#[cfg_attr(windows, rename_symbol(to = "Rust_SCardAudit"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub extern "system" fn SCardAudit(_context: ScardContext, _dw_event: u32) -> ScardStatus {
    ErrorKind::UnsupportedFeature.into()
}
