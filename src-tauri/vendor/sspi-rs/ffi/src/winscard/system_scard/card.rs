use std::borrow::Cow;
use std::fmt;
use std::ptr::null_mut;

#[cfg(target_os = "windows")]
use ffi_types::winscard::functions::SCardApiFunctionTable;
#[cfg(target_os = "windows")]
use ffi_types::winscard::{ScardContext, ScardHandle};
use num_traits::ToPrimitive;
use winscard::winscard::{
    AttributeId, ControlCode, Protocol, ReaderAction, ShareMode, Status, TransmitOutData, WinScard,
};
use winscard::{Error, ErrorKind, WinScardResult};

use super::parse_multi_string_owned;
#[cfg(not(target_os = "windows"))]
use crate::winscard::pcsc_lite::functions::PcscLiteApiFunctionTable;
#[cfg(not(target_os = "windows"))]
use crate::winscard::pcsc_lite::{ScardContext, ScardHandle, initialize_pcsc_lite_api};

/// Represents a state of the current `SystemScard`.
#[derive(Copy, Clone, Debug)]
enum HandleState {
    /// The card is not connected or has been disconnected.
    Disconnected,
    /// The card is connected and ready to use.
    Connected(ScardHandle),
}

/// Represents a system-provided smart card.
///
/// _Hint:_ It's **always better** to explicitly disconnect the card using the [SystemScard::disconnect] method.
/// Otherwise, the card will be disconnected automatically on the drop. But in such a case,
/// the user is unable to pass the custom `dwDisposition` parameter in `SCardDisconnect` function.
pub struct SystemScard {
    h_card: HandleState,
    h_card_context: ScardContext,
    active_protocol: Protocol,

    #[cfg(target_os = "windows")]
    api: SCardApiFunctionTable,
    #[cfg(not(target_os = "windows"))]
    api: PcscLiteApiFunctionTable,
}

impl SystemScard {
    /// Creates a new instance of the [SystemScard].
    ///
    /// _Note._ `h_card` and `h_card_context` parameters (handles) must be initialized using
    /// the corresponding methods.
    pub fn new(h_card: ScardHandle, active_protocol: Protocol, h_card_context: ScardContext) -> WinScardResult<Self> {
        if h_card == 0 {
            return Err(Error::new(
                ErrorKind::InvalidParameter,
                "scard handle can not be a zero",
            ));
        }

        if h_card_context == 0 {
            return Err(Error::new(
                ErrorKind::InvalidParameter,
                "scard context handle can not be a zero",
            ));
        }

        Ok(Self {
            h_card: HandleState::Connected(h_card),
            h_card_context,
            active_protocol,

            #[cfg(target_os = "windows")]
            api: super::init_scard_api_table()?,
            #[cfg(not(target_os = "windows"))]
            api: initialize_pcsc_lite_api()?,
        })
    }

    fn h_card(&self) -> WinScardResult<ScardHandle> {
        if let HandleState::Connected(handle) = self.h_card {
            Ok(handle)
        } else {
            Err(Error::new(
                ErrorKind::InvalidHandle,
                "smart card is not connected or has been disconnected",
            ))
        }
    }
}

impl Drop for SystemScard {
    fn drop(&mut self) {
        if let HandleState::Connected(handle) = self.h_card
            && let Err(err) = try_execute!(
                // SAFETY: `handle` is valid.
                unsafe { (self.api.SCardDisconnect)(handle, 0) }
            )
        {
            error!(?err, "Failed to disconnect the card");
        }
    }
}

impl fmt::Debug for SystemScard {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SystemScard")
            .field("h_card", &self.h_card)
            .field("h_card_context", &self.h_card_context)
            .finish()
    }
}

impl WinScard for SystemScard {
    #[instrument(ret)]
    fn status(&self) -> WinScardResult<Status<'_>> {
        // macOS PC/SC framework doesn't support `SCARD_AUTOALLOCATE` option, so we use preallocated buffer for reader name.
        let mut reader_name = vec![0; 1024];
        let mut reader_name_len = 1024;

        let mut state = 0;
        let mut protocol = 0;
        // https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scardstatusw
        //
        // `pbAtr`: Pointer to a 32-byte buffer that receives the ATR string from the currently
        // inserted card, if available.
        //
        // PCSC-lite docs do not specify that ATR buf should be 32 bytes long, but actually,
        // the ATR string can not be longer than 32 bytes.
        let mut atr = vec![0; 32];
        let mut atr_len = 32;

        #[cfg(not(target_os = "windows"))]
        {
            // https://pcsclite.apdu.fr/api/group__API.html#gae49c3c894ad7ac12a5b896bde70d0382
            try_execute!(
                // SAFETY:
                // - `h_card` is set by a previous call to `SCardConnectA`.
                // - `reader_name.as_mut_ptr()` is a valid pointer to a locally allocated `Vec` with size `reader_name_len`.
                // - `&mut reader_name_len` is a valid length for the `reader_name` buffer.
                // - `&mut state` is a properly-aligned, writable pointer to a local variable.
                // - `&mut protocol` is a properly-aligned, writable pointer to a local variable.
                // - `atr.as_mut_ptr()` is a valid pointer to a locally allocated `Vec` with size of 32 bytes.
                // - `&mut atr_len` is a properly-aligned, both readable and writable pointer to a local variable.
                unsafe {
                    (self.api.SCardStatus)(
                        self.h_card()?,
                        reader_name.as_mut_ptr(),
                        &mut reader_name_len,
                        &mut state,
                        &mut protocol,
                        atr.as_mut_ptr(),
                        &mut atr_len,
                    )
                },
                "SCardStatus failed"
            )?;
        }
        #[cfg(target_os = "windows")]
        {
            // https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scardstatusa
            try_execute!(
                // SAFETY:
                // - `h_card` is set by a previous call to `SCardConnectA`.
                // - `reader_name.as_mut_ptr()` is a valid pointer to a locally allocated `Vec` with size `reader_name_len`.
                // - `&mut reader_name_len` is a valid length for the `reader_name` buffer.
                // - `&mut state` is a properly-aligned, writable pointer to a local variable.
                // - `&mut protocol` is a properly-aligned, writable pointer to a local variable.
                // - `atr.as_mut_ptr()` is a valid pointer to a locally allocated `Vec` with size of 32 bytes.
                // - `&mut atr_len` is a properly-aligned, both readable and writable pointer to a local variable.
                unsafe {
                    (self.api.SCardStatusA)(
                        self.h_card()?,
                        reader_name.as_mut_ptr(),
                        &mut reader_name_len,
                        &mut state,
                        &mut protocol,
                        atr.as_mut_ptr(),
                        &mut atr_len,
                    )
                },
                "SCardStatusA failed"
            )?;
        }

        let multi_string_buffer = &reader_name[0..reader_name_len.try_into()?];

        let readers = if let Ok(readers) = parse_multi_string_owned(multi_string_buffer) {
            readers
        } else {
            return Err(Error::new(
                ErrorKind::InternalError,
                "returned reader is not valid UTF-8",
            ));
        };

        atr.truncate(atr_len.try_into()?);

        let status = Status {
            readers,
            #[cfg(not(target_os = "windows"))]
            state: crate::winscard::pcsc_lite::State::from_bits(state)
                .unwrap_or(crate::winscard::pcsc_lite::State::Specific)
                .into(),
            #[cfg(target_os = "windows")]
            state: state.try_into()?,
            protocol: Protocol::from_bits(
                #[allow(clippy::useless_conversion)]
                protocol.try_into()?,
            )
            .ok_or_else(|| Error::new(ErrorKind::InternalError, format!("Invalid protocol value: {protocol}")))?,
            atr: atr.into(),
        };

        Ok(status)
    }

    // TODO: Question: Shouldn't this method be unsafe?
    // What if the `code` will be corresponding to operation with output and
    // user will use this method instead of `control_with_output`? Then safety conditions will be violated.
    fn control(&mut self, code: ControlCode, input: &[u8]) -> WinScardResult<()> {
        try_execute!(
            // SAFETY:
            // - `h_card` is set by a previous call to `SCardConnectA`.
            // - `input.as_ptr()` is a valid, readable pointer to a
            // - `lpOutBuffer` can be null.
            // - `cbOutBufferSize` is 0 because `lpOutBuffer` is null.
            // - `lpBytesReturned` can be null if `lpOutBuffer` is null.
            unsafe {
                (self.api.SCardControl)(
                    self.h_card()?,
                    code.into(),
                    input.as_ptr().cast(),
                    input.len().try_into()?,
                    null_mut(),
                    0,
                    null_mut(),
                )
            },
            "SCardControl failed"
        )?;

        Ok(())
    }

    fn control_with_output(&mut self, code: ControlCode, input: &[u8], output: &mut [u8]) -> WinScardResult<usize> {
        let mut receive_len = 0;
        let output_buf_len = output.len().try_into()?;

        try_execute!(
            // SAFETY:
            // - `h_card` is set by a previous call to `SCardConnectA`.
            // - `input.as_ptr()` is a valid, readable pointer to a slice.
            // - `output` is a properly-aligned, writable pointer to a valid slice with size of `output_buf_len`.
            // - `output_buf_len` is valid length for `output` buffer.
            // - `&mut receive_len` is a properly-aligned, writable pointer to a local variable.
            unsafe {
                (self.api.SCardControl)(
                    self.h_card()?,
                    code.into(),
                    input.as_ptr().cast(),
                    input.len().try_into()?,
                    output.as_mut_ptr().cast(),
                    output_buf_len,
                    &mut receive_len,
                )
            },
            "SCardControl failed"
        )?;

        Ok(receive_len.try_into()?)
    }

    fn transmit(&mut self, input_apdu: &[u8]) -> WinScardResult<TransmitOutData> {
        // The SCardTransmit function doesn't support SCARD_AUTOALLOCATE attribute. So, we need to allocate
        // the buffer for the output APDU by ourselves.
        // The `msclmd.dll` has `I_ClmdCmdExtendedTransmit` and `I_ClmdCmdShortTransmit` functions.
        // The first one uses 65538-bytes long buffer for output APDU, and the second one uses 258-bytes long buffer.
        // We decided to always use the larger one.
        const OUT_APDU_BUF_LEN: usize = 65538;

        let mut output_apdu_len = OUT_APDU_BUF_LEN.try_into()?;
        let mut output_apdu = [0; OUT_APDU_BUF_LEN];

        let send_pci = match self.active_protocol {
            Protocol::T0 => self.api.g_rgSCardT0Pci,
            Protocol::T1 => self.api.g_rgSCardT1Pci,
            Protocol::Raw => self.api.g_rgSCardRawPci,
            _ => {
                return Err(Error::new(
                    ErrorKind::InvalidValue,
                    format!(
                        "failed to extract container name: smart card selected invalid ({:?}) connection protocol",
                        self.active_protocol
                    ),
                ));
            }
        };

        try_execute!(
            // SAFETY:
            // - `h_card` is set by a previous call to `SCardConnectA`.
            // - `poi_send_pci` is a properly-aligned, readable pointer to the `ScardIoRequest` structure.
            // - `input_apdu.as_ptr()` is a properly-aligned, readable pointer to a slice.
            // - `input_apdu.len()` is a valid size for `input_apdu` buffer.
            // - `pioRecvPci` can be null.
            // - `output_apdu.as_mut_ptr()` is a properly-aligned, writable pointer to a slice with a size of `output_apdu_len`.
            // - `&mut output_apdu_len` is a properly-aligned, writable pointer to a local variable.
            unsafe {
                (self.api.SCardTransmit)(
                    self.h_card()?,
                    send_pci,
                    input_apdu.as_ptr(),
                    input_apdu.len().try_into()?,
                    // https://pcsclite.apdu.fr/api/group__API.html#ga9a2d77242a271310269065e64633ab99
                    // https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scardtransmit
                    //
                    // pioRecvPci: This parameter can be NULL if no PCI is returned.
                    null_mut(),
                    output_apdu.as_mut_ptr(),
                    &mut output_apdu_len,
                )
            },
            "SCardTransmit failed"
        )?;

        Ok(TransmitOutData {
            output_apdu: output_apdu[0..output_apdu_len.try_into()?].to_vec(),
            receive_pci: None,
        })
    }

    fn begin_transaction(&mut self) -> WinScardResult<()> {
        try_execute!(
            // SAFETY: `h_card` is set by a previous call to `SCardConnectA`.
            unsafe { (self.api.SCardBeginTransaction)(self.h_card()?) },
            "SCardBeginTransaction failed"
        )
    }

    fn end_transaction(&mut self, disposition: ReaderAction) -> WinScardResult<()> {
        try_execute!(
            // SAFETY: `h_card` is set by a previous call to `SCardConnectA`.
            unsafe { (self.api.SCardEndTransaction)(self.h_card()?, disposition.into()) },
            "SCardEndTransaction failed"
        )
    }

    fn reconnect(
        &mut self,
        share_mode: ShareMode,
        preferred_protocol: Option<Protocol>,
        initialization: ReaderAction,
    ) -> WinScardResult<Protocol> {
        let dw_preferred_protocols = preferred_protocol.unwrap_or_default().bits();
        let mut active_protocol = 0;

        try_execute!(
            // SAFETY:
            // - `h_card` is set by a previous call to `SCardConnectA`.
            // - `&mut active_protocol` is a properly-aligned, writable pointer to a local variable.
            unsafe {
                (self.api.SCardReconnect)(
                    self.h_card()?,
                    share_mode.into(),
                    dw_preferred_protocols.into(),
                    initialization.into(),
                    &mut active_protocol,
                )
            },
            "SCardReconnect failed"
        )?;

        Ok(Protocol::from_bits(
            #[allow(clippy::useless_conversion)]
            active_protocol.try_into()?,
        )
        .unwrap_or_default())
    }

    fn get_attribute(&self, attribute_id: AttributeId) -> WinScardResult<Cow<'_, [u8]>> {
        let attr_id = attribute_id
            .to_u32()
            .ok_or_else(|| Error::new(ErrorKind::InternalError, "cannot convert AttributeId -> u32"))?;
        let mut data_len = 0;

        // https://pcsclite.apdu.fr/api/group__API.html#gaacfec51917255b7a25b94c5104961602
        // If this value is NULL, SCardGetAttrib() ignores the buffer length supplied in pcbAttrLen, writes the length of the buffer
        // that would have been returned if this parameter had not been NULL to pcbAttrLen, and returns a success code.
        //
        // https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scardgetattrib
        // If this value is NULL, SCardGetAttrib ignores the buffer length supplied in pcbAttrLen,
        // writes the length of the buffer that would have been returned if this parameter
        // had not been NULL to pcbAttrLen, and returns a success code.
        try_execute!(
            // SAFETY:
            // - `h_card` is set by a previous call to `SCardConnectA`.
            // - `pbAttr` can be null.
            // - `&mut data_len` is a properly-aligned, writable pointer to a local variable.
            unsafe { (self.api.SCardGetAttrib)(self.h_card()?, attr_id.into(), null_mut(), &mut data_len) },
            "SCardGetAttrib failed"
        )?;

        let mut data = vec![0; data_len.try_into()?];

        try_execute!(
            // SAFETY:
            // - `h_card` is set by a previous call to `SCardConnectA`.
            // - `data.as_mut_ptr()` is a valid pointer to a locally allocated `Vec` with size `data_len`.
            // - `&mut data_len` is a properly-aligned, both readable and writable pointer to a local variable.
            //   The length is correct because it was set by a previous call to `SCardGetAttrib`.
            unsafe { (self.api.SCardGetAttrib)(self.h_card()?, attr_id.into(), data.as_mut_ptr(), &mut data_len) },
            "SCardGetAttrib failed"
        )?;

        Ok(Cow::Owned(data))
    }

    fn set_attribute(&mut self, attribute_id: AttributeId, attribute_data: &[u8]) -> WinScardResult<()> {
        let attr_id = attribute_id
            .to_u32()
            .ok_or_else(|| Error::new(ErrorKind::InternalError, "cannot convert AttributeId -> u32"))?;

        let len = attribute_data.len().try_into()?;

        try_execute!(
            // SAFETY:
            // - `h_card` is set by a previous call to `SCardConnectA`.
            // - `attribute_data.as_ptr()` is a valid pointer to a valid slice with size of `len`.
            unsafe { (self.api.SCardSetAttrib)(self.h_card()?, attr_id.into(), attribute_data.as_ptr(), len) },
            "SCardSetAttrib failed"
        )
    }

    fn disconnect(&mut self, disposition: ReaderAction) -> WinScardResult<()> {
        try_execute!(
            // SAFETY: `h_card` is set by a previous call to `SCardConnectA`.
            unsafe { (self.api.SCardDisconnect)(self.h_card()?, disposition.into()) },
            "SCardDisconnect failed"
        )?;

        // Mark the current card handle as disconnected.
        self.h_card = HandleState::Disconnected;

        Ok(())
    }
}
