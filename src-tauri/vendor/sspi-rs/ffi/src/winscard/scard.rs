use std::ffi::CStr;
use std::slice::{from_raw_parts, from_raw_parts_mut};

use ffi_types::winscard::{
    LpCScardIoRequest, LpOpenCardNameA, LpOpenCardNameExA, LpOpenCardNameExW, LpOpenCardNameW, LpScardHandle,
    LpScardIoRequest, ScardContext, ScardHandle, ScardStatus,
};
use ffi_types::{LpByte, LpCByte, LpCStr, LpCVoid, LpCWStr, LpDword, LpStr, LpVoid, LpWStr};
use num_traits::FromPrimitive;
use sspi::U16CString;
#[cfg(target_os = "windows")]
use symbol_rename_macro::rename_symbol;
use winscard::winscard::{AttributeId, Protocol, ScardConnectData, ShareMode};
use winscard::{Error, ErrorKind, WinScardResult};

use super::buf_alloc::{build_buf_request_type, build_buf_request_type_wide, save_out_buf, save_out_buf_wide};
use crate::utils::into_raw_ptr;
use crate::winscard::scard_handle::{
    WinScardHandle, copy_io_request_to_scard_io_request, raw_scard_context_handle_to_scard_context_handle,
    raw_scard_handle_to_scard_handle, scard_context_to_winscard_context, scard_handle_to_winscard,
};

/// # Safety
///
/// - `context` must be a valid raw scard context handle.
/// - `ph_card` must be a properly-aligned pointer, valid for writes.
/// - `pdw_active_protocol` must be a properly-aligned pointer, valid for writes.
unsafe fn connect(
    context: ScardContext,
    reader_name: &str,
    dw_share_mode: u32,
    dw_preferred_protocols: u32,
    ph_card: LpScardHandle,
    pdw_active_protocol: LpDword,
) -> WinScardResult<()> {
    if ph_card.is_null() {
        return Err(Error::new(ErrorKind::InvalidParameter, "ph_card cannot be null"));
    }
    if pdw_active_protocol.is_null() {
        return Err(Error::new(
            ErrorKind::InvalidParameter,
            "pdw_active_protocol cannot be null",
        ));
    }

    let share_mode = dw_share_mode.try_into()?;
    let protocol = Protocol::from_bits(dw_preferred_protocols);

    // SAFETY: `context` is a valid context handle.
    let scard_context = unsafe { scard_context_to_winscard_context(context)? };
    let ScardConnectData { handle, protocol } = scard_context.connect(reader_name, share_mode, protocol)?;

    let scard = WinScardHandle::new(handle, context);

    let raw_card_handle = into_raw_ptr(scard) as ScardHandle;

    // SAFETY: `context` is a valid context handle.
    let context = unsafe { raw_scard_context_handle_to_scard_context_handle(context) }?;
    context.add_scard(raw_card_handle)?;

    // SAFETY: `ph_card` is guaranteed to be non-null due to the prior check.
    unsafe {
        *ph_card = raw_card_handle;
    }

    // SAFETY: `pdw_active_protocol` is guaranteed to be non-null due to the prior check.
    unsafe {
        *pdw_active_protocol = protocol.bits();
    }

    Ok(())
}

/// The `SCardConnectA` function establishes a connection (using a specific `resource manager context`)
/// between the calling application and a smart card contained by a specific reader. If no card exists
/// in the specified reader, an error is returned.
///
/// [MSDN Reference](https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scardconnecta)
///
/// # Safety
///
/// - `context` must be a valid raw scard context handle.
/// - `sz_reader` must be a non-null pointer to a valid, null-terminated C string.
/// - `ph_card` must be a properly-aligned pointer, valid for writes.
/// - `pdw_active_protocol` must be a properly-aligned pointer, valid for writes.
#[cfg_attr(windows, rename_symbol(to = "Rust_SCardConnectA"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn SCardConnectA(
    context: ScardContext,
    sz_reader: LpCStr,
    dw_share_mode: u32,
    dw_preferred_protocols: u32,
    ph_card: LpScardHandle,
    pdw_active_protocol: LpDword,
) -> ScardStatus {
    check_handle!(context);
    check_null!(sz_reader);
    check_null!(ph_card);
    check_null!(pdw_active_protocol);

    let reader_name = try_execute!(
        // SAFETY:
        // - `sz_reader` is guaranteed to be non-null due to the prior check.
        // - The memory region `sz_reader` contains a valid null-terminator at the end of string.
        // - The memory region `sz_reader` points to is valid for reads of bytes up to and including null-terminator.
        unsafe { CStr::from_ptr(sz_reader.cast()) }.to_str(),
        ErrorKind::InvalidParameter
    );

    try_execute!(
        // SAFETY:
        // - `context` is a valid raw scard context handle.
        // - `ph_card` is a pointer to a memory region that is valid for writes.
        // - `pdw_active_protocol`: is a pointer to a memory region that is valid for writes.
        unsafe {
            connect(
                context,
                reader_name,
                dw_share_mode,
                dw_preferred_protocols,
                ph_card,
                pdw_active_protocol,
            )
        }
    );

    ErrorKind::Success.into()
}

/// The `SCardConnectW` function establishes a connection (using a specific `resource manager context`)
/// between the calling application and a smart card contained by a specific reader. If no card exists
/// in the specified reader, an error is returned.
///
/// [MSDN Reference](https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scardconnectw)
///
/// # Safety
///
/// - `context` must be a valid raw scard context handle.
/// - `sz_reader` must be a properly-aligned, non-null pointer to a valid, null-terminated wide character string (UTF-16).
/// - `ph_card` must be a properly-aligned pointer, valid for writes.
/// - `pdw_active_protocol` must be a properly-aligned pointer, valid for writes.
#[cfg_attr(windows, rename_symbol(to = "Rust_SCardConnectW"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn SCardConnectW(
    context: ScardContext,
    sz_reader: LpCWStr,
    dw_share_mode: u32,
    dw_preferred_protocols: u32,
    ph_card: LpScardHandle,
    pdw_active_protocol: LpDword,
) -> ScardStatus {
    check_handle!(context);
    check_null!(sz_reader);
    check_null!(ph_card);
    check_null!(pdw_active_protocol);

    let reader_name = try_execute!(
        // SAFETY:
        // - `sz_reader` is guaranteed to be non-null due to the prior check.
        // - `sz_reader` is guaranteed to be properly aligned for `u16` access (upheld by the caller per the function's safety contract).
        // - The memory region `sz_reader` contains a valid null-terminator at the end of string.
        // - The memory region `sz_reader` is properly aligned for `u16`, per safety preconditions.
        // - The memory region `sz_reader` points to is valid for reads of u16 code units up to and including the null-terminating u16.
        unsafe { U16CString::from_ptr_str(sz_reader) }
            .to_string()
            .map_err(Error::from)
    );

    try_execute!(
        // SAFETY:
        // - `context` is a valid raw scard context handle.
        // - `ph_card` is a pointer to a memory region that is valid for writes.
        // - `pdw_active_protocol`: is a pointer to a memory region that is valid for writes.
        unsafe {
            connect(
                context,
                &reader_name,
                dw_share_mode,
                dw_preferred_protocols,
                ph_card,
                pdw_active_protocol,
            )
        }
    );

    ErrorKind::Success.into()
}

/// The `SCardReconnect` function reestablishes an existing connection between the calling application
/// and a `smart card`.
///
/// [MSDN Reference](https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scardreconnect)
///
/// # Safety
///
/// - `context` must be a valid raw scard context handle.
/// - `pdw_active_protocol` must be a properly-aligned pointer, valid for writes.
#[cfg_attr(windows, rename_symbol(to = "Rust_SCardReconnect"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn SCardReconnect(
    handle: ScardHandle,
    dw_share_mode: u32,
    dw_preferred_protocols: u32,
    dw_initialization: u32,
    pdw_active_protocol: LpDword,
) -> ScardStatus {
    check_handle!(handle);
    check_null!(pdw_active_protocol);

    let share_mode = try_execute!(ShareMode::try_from(dw_share_mode));
    let protocol = Protocol::from_bits(dw_preferred_protocols);
    let initialization = try_execute!(dw_initialization.try_into(), ErrorKind::InvalidParameter);

    let scard = try_execute!(
        // SAFETY: `context` is a valid context handle.
        unsafe { scard_handle_to_winscard(handle) }
    );
    let active_protocol = try_execute!(scard.reconnect(share_mode, protocol, initialization));

    // SAFETY: `pdw_active_protocol` is guaranteed to be non-null due to the prior check.
    unsafe {
        *pdw_active_protocol = active_protocol.bits();
    }

    ErrorKind::Success.into()
}

/// The `SCardDisconnect` function terminates a connection previously opened between the calling
/// application and a `smart card` in the target `reader`.
///
/// [MSDN Reference](https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scarddisconnect)
///
/// # Safety
///
/// The `handle` must be a valid raw scard context handle.
#[cfg_attr(windows, rename_symbol(to = "Rust_SCardDisconnect"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn SCardDisconnect(handle: ScardHandle, dw_disposition: u32) -> ScardStatus {
    check_handle!(handle);

    let scard = try_execute!(
        // SAFETY: `handle` is a valid raw scard context handle.
        unsafe { raw_scard_handle_to_scard_handle(handle) }
    );
    try_execute!(
        scard
            .scard_mut()
            .disconnect(try_execute!(dw_disposition.try_into(), ErrorKind::InvalidParameter))
    );

    if let Ok(context) = scard.context() {
        if context.remove_scard(handle) {
            info!(?handle, "Successfully disconnected");
        } else {
            warn!("ScardHandle does not belong to the specified context")
        }
    }

    ErrorKind::Success.into()
}

/// The `SCardBeginTransaction` function starts a `transaction`.
///
/// [MSDN Reference](https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scardbegintransaction)
///
/// # Safety
///
/// The `handle` must be a valid raw scard context handle.
#[cfg_attr(windows, rename_symbol(to = "Rust_SCardBeginTransaction"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn SCardBeginTransaction(handle: ScardHandle) -> ScardStatus {
    check_handle!(handle);

    let scard = try_execute!(
        // SAFETY: `handle` is a valid raw scard context handle.
        unsafe { scard_handle_to_winscard(handle) }
    );

    try_execute!(scard.begin_transaction());

    ErrorKind::Success.into()
}

/// The `SCardEndTransaction` function completes a previously declared `transaction`, allowing other
/// applications to resume interactions with the card.
///
/// [MSDN Reference](https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scardendtransaction)
///
/// # Safety
///
/// The `handle` must be a valid raw scard context handle.
#[cfg_attr(windows, rename_symbol(to = "Rust_SCardEndTransaction"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn SCardEndTransaction(handle: ScardHandle, dw_disposition: u32) -> ScardStatus {
    check_handle!(handle);

    let scard = try_execute!(
        // SAFETY: `handle` is a valid raw scard context handle.
        unsafe { scard_handle_to_winscard(handle) }
    );

    try_execute!(scard.end_transaction(try_execute!(dw_disposition.try_into())));

    ErrorKind::Success.into()
}

#[cfg_attr(windows, rename_symbol(to = "Rust_SCardCancelTransaction"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub extern "system" fn SCardCancelTransaction(_handle: ScardHandle) -> ScardStatus {
    ErrorKind::UnsupportedFeature.into()
}

#[cfg_attr(windows, rename_symbol(to = "Rust_SCardState"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub extern "system" fn SCardState(
    _handle: ScardHandle,
    _pdw_state: LpDword,
    _pdw_protocol: LpDword,
    _pb_atr: LpByte,
    _pcb_atr_len: LpDword,
) -> ScardStatus {
    ErrorKind::UnsupportedFeature.into()
}

/// The `SCardStatusA` function provides the current status of a `smart card` in a `reader`.
///
/// [MSDN Reference](https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scardstatusa)
///
/// # Safety
///
/// - `handle` must be a valid raw scard context handle.
/// - `msz_reader_names` must be properly-aligned pointer, valid for both reads and writes for `*pcch_reader_len` many bytes.
/// - `pcch_reader_len` must be a properly-aligned pointer valid for both reads and writes.
/// - `pdw_state` must be valid for writes.
/// - `pdw_protocol` must be valid for writes.
/// - `pb_atr` can be null. If non-null, it must be properly-aligned pointer, valid for both reads and writes
///   for `*pcb_atr_len` many bytes.
/// - `pcb_atr_len` must be valid for writes.
#[cfg_attr(windows, rename_symbol(to = "Rust_SCardStatusA"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn SCardStatusA(
    handle: ScardHandle,
    msz_reader_names: LpStr,
    pcch_reader_len: LpDword,
    pdw_state: LpDword,
    pdw_protocol: LpDword,
    pb_atr: LpByte,
    pcb_atr_len: LpDword,
) -> ScardStatus {
    check_handle!(handle);
    check_null!(msz_reader_names);
    check_null!(pcch_reader_len);
    check_null!(pdw_state);
    check_null!(pdw_protocol);
    // pb_atr can be null.
    // it's not specified in a docs, but `msclmd.dll` can invoke this function with pb_atr = 0.
    check_null!(pcb_atr_len);

    let scard = try_execute!(
        // SAFETY: `handle` is a valid raw scard context handle.
        unsafe { raw_scard_handle_to_scard_handle(handle) }
    );
    let readers_buf_type = try_execute!(
        // SAFETY: `msz_reader_names` is valid for both reads and writes for `*pcch_reader_len` many bytes.
        unsafe { build_buf_request_type(msz_reader_names, pcch_reader_len) }
    );
    let atr_buf_type = try_execute!(
        // SAFETY: `pb_atr` is valid for both reads and writes for `*pcb_atr_len` many bytes.
        unsafe { build_buf_request_type(pb_atr, pcb_atr_len) }
    );

    let status = try_execute!(scard.status(readers_buf_type, atr_buf_type));

    // SAFETY: `pdw_state` is guaranteed to be non-null due to the prior check.
    unsafe {
        *pdw_state = status.state.into();
    }

    // SAFETY: `pdw_protocol` is guaranteed to be non-null due to the prior check.
    unsafe {
        *pdw_protocol = status.protocol.bits();
    }

    try_execute!(
        // SAFETY:
        // - `msz_reader_names` is valid for writes.
        // - `pcch_reader_len` is valid for writes.
        unsafe { save_out_buf(status.readers, msz_reader_names, pcch_reader_len) }
    );

    try_execute!(
        // SAFETY:
        // - `pb_attr` can to be null. If non-null, it is valid for writes.
        // - `pcch_reader_len` is valid for writes.
        unsafe { save_out_buf(status.atr, pb_atr, pcb_atr_len) }
    );

    ErrorKind::Success.into()
}

/// The `SCardStatusW` function provides the current status of a `smart card` in a `reader`.
///
/// [MSDN Reference](https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scardstatusw)
///
/// # Safety
///
/// - `handle` must be a valid raw scard context handle.
/// - `msz_reader_names` must be properly-aligned pointer, valid for both reads and writes for `*pcch_reader_len` many bytes.
/// - `pcch_reader_len` must be a properly-aligned pointer valid for both reads and writes.
/// - `pdw_state` must be valid for writes.
/// - `pdw_protocol` must be valid for writes.
/// - `pb_atr` can be null. If non-null, it must be properly-aligned pointer, valid for both reads and writes
///   for `*pcb_atr_len` many bytes.
/// - `pcb_atr_len` must be valid for writes.
#[cfg_attr(windows, rename_symbol(to = "Rust_SCardStatusW"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn SCardStatusW(
    handle: ScardHandle,
    msz_reader_names: LpWStr,
    pcch_reader_len: LpDword,
    pdw_state: LpDword,
    pdw_protocol: LpDword,
    pb_atr: LpByte,
    pcb_atr_len: LpDword,
) -> ScardStatus {
    check_handle!(handle);
    check_null!(msz_reader_names);
    check_null!(pcch_reader_len);
    check_null!(pdw_state);
    check_null!(pdw_protocol);
    // pb_atr can be null.
    // it's not specified in a docs, but `msclmd.dll` can invoke this function with pb_atr = 0.
    check_null!(pcb_atr_len);

    let scard = try_execute!(
        // SAFETY: `handle` is a valid raw scard context handle.
        unsafe { raw_scard_handle_to_scard_handle(handle) }
    );
    let readers_buf_type = try_execute!(
        // SAFETY: `msz_reader_names` is valid for both reads and writes for `*pcch_reader_len` many bytes.
        unsafe { build_buf_request_type_wide(msz_reader_names, pcch_reader_len) }
    );
    let atr_buf_type = try_execute!(
        // SAFETY: `pb_atr` is valid for both reads and writes for `*pcb_atr_len` many bytes.
        unsafe { build_buf_request_type(pb_atr, pcb_atr_len) }
    );

    let status = try_execute!(scard.status_wide(readers_buf_type, atr_buf_type));

    // SAFETY: `pdw_state` is guaranteed to be non-null due to the prior check.
    unsafe {
        *pdw_state = status.state.into();
    }

    // SAFETY: `pdw_protocol` is guaranteed to be non-null due to the prior check.
    unsafe {
        *pdw_protocol = status.protocol.bits();
    }

    try_execute!(
        // SAFETY:
        // - `msz_reader_names` is valid for writes.
        // - `pcch_reader_len` is valid for writes.
        unsafe { save_out_buf_wide(status.readers, msz_reader_names, pcch_reader_len) }
    );

    try_execute!(
        // SAFETY:
        // - `pb_attr` can to be null. If non-null, it is valid for writes.
        // - `pcch_reader_len` is valid for writes.
        unsafe { save_out_buf(status.atr, pb_atr, pcb_atr_len) }
    );

    ErrorKind::Success.into()
}

/// The `SCardTransmit` function sends a service request to the `smart card` and expects to receive
/// data back from the card.
///
/// [MSDN Reference](https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scardtransmit)
///
/// # Safety
///
/// - `handle` must be a valid raw scard context handle.
/// - `pio_send_pci` must be a pointer to a valid `ScardIoRequest` structure.
/// - `pb_send_buffer` must be valid for reads for `cb_send_length` many bytes, and it must be properly-aligned.
/// - `pio_recv_pci` must be a pointer to a valid `ScardIoRequest` structure.
/// - `pb_recv_buffer` must be valid for reads for `*pcb_recv_length` many bytes, and it must be properly-aligned.
/// - `pcb_recv_length` must be valid for both reads and writes.
#[cfg_attr(windows, rename_symbol(to = "Rust_SCardTransmit"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn SCardTransmit(
    handle: ScardHandle,
    pio_send_pci: LpCScardIoRequest,
    pb_send_buffer: LpCByte,
    cb_send_length: u32,
    pio_recv_pci: LpScardIoRequest,
    pb_recv_buffer: LpByte,
    pcb_recv_length: LpDword,
) -> ScardStatus {
    check_handle!(handle);
    check_null!(pio_send_pci);
    check_null!(pb_send_buffer);
    check_null!(pcb_recv_length);

    let scard = try_execute!(
        // SAFETY: `handle` is a valid raw scard context handle.
        unsafe { scard_handle_to_winscard(handle) }
    );

    // SAFETY: The `pb_send_buffer` parameter cannot be null (checked above).
    let input_apdu = unsafe {
        from_raw_parts(
            pb_send_buffer,
            try_execute!(cb_send_length.try_into(), ErrorKind::InsufficientBuffer),
        )
    };

    let out_data = try_execute!(scard.transmit(input_apdu));

    let out_apdu_len = out_data.output_apdu.len();
    if out_apdu_len
        > try_execute!(
            // SAFETY: `pcb_recv_length` is guaranteed to be non-null due to the prior check.
            usize::try_from(unsafe { *pcb_recv_length }),
            ErrorKind::InsufficientBuffer
        )
        || pb_recv_buffer.is_null()
    {
        return ErrorKind::InsufficientBuffer.into();
    }

    // SAFETY:
    // - `pb_recv_buffer` is guaranteed to be non-null due to the prior check.
    // - `pb_recv_buffer` is valid for reads for `*pcb_recv_length` bytes.
    // - `out_apdu_len` is guaranteed to be less or equal than `*pcb_recv_length`.
    let recv_buffer = unsafe { from_raw_parts_mut(pb_recv_buffer, out_apdu_len) };
    recv_buffer.copy_from_slice(&out_data.output_apdu);

    if !pio_recv_pci.is_null()
        && let Some(receive_pci) = out_data.receive_pci.as_ref()
    {
        try_execute!(
            // SAFETY: `pio_recv_pci` is a pointer to a valid `ScardIoRequest` structure.
            unsafe { copy_io_request_to_scard_io_request(receive_pci, pio_recv_pci,) }
        );
    }

    // SAFETY: `pcb_recv_length` is guaranteed to be non-null due to the prior check.
    unsafe {
        *pcb_recv_length = try_execute!(out_apdu_len.try_into(), ErrorKind::InsufficientBuffer);
    }

    ErrorKind::Success.into()
}

#[cfg_attr(windows, rename_symbol(to = "Rust_SCardGetTransmitCount"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub extern "system" fn SCardGetTransmitCount(_handle: ScardHandle, pc_transmit_count: LpDword) -> ScardStatus {
    ErrorKind::UnsupportedFeature.into()
}

/// The `SCardControl` function gives you direct control of the `reader`.
///
/// [MSDN Reference](https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scardcontrol)
///
/// # Safety
///
/// - `handle` must be a valid raw scard context handle.
/// - `lp_in_buffer` must be valid for reads for `cb_in_buffer_size` many bytes, and it must be properly-aligned.
/// - `lp_out_buffer` must be valid for reads for `cb_out_buffer_size` many bytes, and it must be properly-aligned.
/// - `lp_bytes_returned` must be valid for writes.
#[cfg_attr(windows, rename_symbol(to = "Rust_SCardControl"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn SCardControl(
    handle: ScardHandle,
    dw_control_code: u32,
    lp_in_buffer: LpCVoid,
    cb_in_buffer_size: u32,
    lp_out_buffer: LpVoid,
    cb_out_buffer_size: u32,
    lp_bytes_returned: LpDword,
) -> ScardStatus {
    check_handle!(handle);

    let scard = try_execute!(
        // SAFETY: `handle` is a valid raw scard context handle.
        unsafe { scard_handle_to_winscard(handle) }
    );

    let in_buffer = if !lp_in_buffer.is_null() {
        // SAFETY:
        // - `lp_in_buffer` is guaranteed to be non-null due to the prior check.
        // - `lp_in_buffer` is valid for reads for `cb_in_buffer_size` many bytes.
        unsafe {
            from_raw_parts(
                lp_in_buffer as *const u8,
                try_execute!(cb_in_buffer_size.try_into(), ErrorKind::InsufficientBuffer),
            )
        }
    } else {
        &[]
    };

    if !lp_out_buffer.is_null() {
        // SAFETY:
        // - `lp_out_buffer` is guaranteed to be non-null due to the prior check.
        // - `lp_out_buffer` is valid for reads for `cb_out_buffer_size` many bytes.
        let lp_out_buffer = unsafe {
            from_raw_parts_mut(
                lp_out_buffer as *mut u8,
                try_execute!(cb_out_buffer_size.try_into(), ErrorKind::InvalidParameter),
            )
        };

        let out_bytes_count = try_execute!(scard.control_with_output(dw_control_code, in_buffer, lp_out_buffer));
        if !lp_bytes_returned.is_null() {
            // SAFETY: `lp_bytes_returned` is guaranteed to be non-null due to the prior check.
            unsafe {
                *lp_bytes_returned = try_execute!(out_bytes_count.try_into(), ErrorKind::InternalError);
            }
        }
    } else {
        try_execute!(scard.control(dw_control_code, in_buffer));
    }

    ErrorKind::Success.into()
}

/// The `SCardGetAttrib` function retrieves the current reader attributes for the given handle.
///
/// [MSDN Reference](https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scardgetattrib)
///
/// # Safety
///
/// - `handle` must be a valid raw scard context handle.
/// - `pb_attr` can be null. If it's non-null, then it must be valid for both reads and writes for `*pcb_attr_len` many bytes,
///   and it must be properly-aligned.
/// - `pcb_attr_len` must be valid for writes.
#[cfg_attr(windows, rename_symbol(to = "Rust_SCardGetAttrib"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn SCardGetAttrib(
    handle: ScardHandle,
    dw_attr_id: u32,
    pb_attr: LpByte,
    pcb_attr_len: LpDword,
) -> ScardStatus {
    check_handle!(handle);
    check_null!(pcb_attr_len);

    let attr_id = try_execute!(AttributeId::from_u32(dw_attr_id).ok_or_else(|| Error::new(
        ErrorKind::InvalidParameter,
        format!("invalid attribute id: {dw_attr_id}")
    )));

    let scard = try_execute!(
        // SAFETY: `handle` is a valid raw scard context handle.
        unsafe { raw_scard_handle_to_scard_handle(handle) }
    );
    let buffer_type = try_execute!(
        // SAFETY:
        // - `pb_attr` can be null.
        // - If `pb_attr` is non-null, it is valid for both reads and writes for `*pcb_atr_len` many bytes.
        unsafe { build_buf_request_type(pb_attr, pcb_attr_len) }
    );

    let out_buf = try_execute!(scard.get_attribute(attr_id, buffer_type));

    try_execute!(
        // SAFETY:
        // - `pb_attr` can be null.
        // - If `pb_attr` is non-null, it is valid for writes.
        // - `pcb_attr_len` is valid for writes.
        unsafe { save_out_buf(out_buf, pb_attr, pcb_attr_len) }
    );

    ErrorKind::Success.into()
}

/// The `SCardSetAttrib` function sets the given reader attribute for the given handle.
///
/// [MSDN Reference](https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scardsetattrib)
///
/// # Safety
///
/// - `handle` must be a valid raw scard context handle.
/// - `pb_atter` must be valid for reads for `cb_attr_len` many bytes, and it must be properly-aligned.
#[cfg_attr(windows, rename_symbol(to = "Rust_SCardSetAttrib"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn SCardSetAttrib(
    handle: ScardHandle,
    dw_attr_id: u32,
    pb_attr: LpCByte,
    cb_attr_len: u32,
) -> ScardStatus {
    check_handle!(handle);
    check_null!(pb_attr);

    // SAFETY:
    // - `pb_attr` is guaranteed to be non-null due to the prior check.
    // - `pb_attr` is valid for reads for `cb_attr_len` many bytes.
    let attr_data = unsafe { from_raw_parts(pb_attr, cb_attr_len.try_into().unwrap()) };
    let attr_id = try_execute!(AttributeId::from_u32(dw_attr_id).ok_or_else(|| Error::new(
        ErrorKind::InvalidParameter,
        format!("Invalid attribute id: {dw_attr_id}")
    )));
    let scard = try_execute!(
        // SAFETY: `handle` is a valid raw scard context handle.
        unsafe { scard_handle_to_winscard(handle) }
    );

    try_execute!(scard.set_attribute(attr_id, attr_data));

    ErrorKind::Success.into()
}

#[cfg_attr(windows, rename_symbol(to = "Rust_SCardUIDlgSelectCardA"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub extern "system" fn SCardUIDlgSelectCardA(_p: LpOpenCardNameExA) -> ScardStatus {
    ErrorKind::UnsupportedFeature.into()
}

#[cfg_attr(windows, rename_symbol(to = "Rust_SCardUIDlgSelectCardW"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub extern "system" fn SCardUIDlgSelectCardW(_p: LpOpenCardNameExW) -> ScardStatus {
    ErrorKind::UnsupportedFeature.into()
}

#[cfg_attr(windows, rename_symbol(to = "Rust_GetOpenCardNameA"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub extern "system" fn GetOpenCardNameA(_p: LpOpenCardNameA) -> ScardStatus {
    ErrorKind::UnsupportedFeature.into()
}

#[cfg_attr(windows, rename_symbol(to = "Rust_GetOpenCardNameW"))]
#[instrument(ret)]
#[unsafe(no_mangle)]
pub extern "system" fn GetOpenCardNameW(_p: LpOpenCardNameW) -> ScardStatus {
    ErrorKind::UnsupportedFeature.into()
}
