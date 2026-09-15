use std::iter::once;
use std::mem::size_of;
use std::slice::from_raw_parts_mut;
use std::{fmt, ptr};

use ffi_types::LpCVoid;
use ffi_types::winscard::{LpScardIoRequest, ScardContext, ScardHandle, ScardIoRequest};
use uuid::Uuid;
use winscard::winscard::{AttributeId, IoRequest, Protocol, State, WinScard, WinScardContext};
use winscard::{Error, ErrorKind, WinScardResult};

/// Scard context handle representation.
///
/// Additionally, it holds allocated buffers and created smart card handles.
/// We need them because during the smart card context deletion, we need to free all allcated resources.
pub(super) struct WinScardContextHandle {
    /// Context of the emulated smart card.
    scard_context: Box<dyn WinScardContext>,
    /// Created smart card handles during the API usage.
    scards: Vec<ScardHandle>,
    /// Allocated buffers in our smart card context.
    /// All buffers are `[u8]`, so we need only pointer and don't need to remember its type.
    allocations: Vec<usize>,
}

impl fmt::Debug for WinScardContextHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WinScardContextHandle")
            .field("scards", &self.scards)
            .field("allocations", &self.allocations)
            .field("scard_context", &"<scard context obj>")
            .finish()
    }
}

impl WinScardContextHandle {
    /// Creates a new [WinScardContextHandle] based on the provided inner scard context.
    pub(super) fn with_scard_context(scard_context: Box<dyn WinScardContext>) -> Self {
        Self {
            scard_context,
            scards: Vec::new(),
            allocations: Vec::new(),
        }
    }

    /// Returns the shared reference to the inner [WinScardContext].
    pub(super) fn scard_context(&self) -> &dyn WinScardContext {
        self.scard_context.as_ref()
    }

    /// Adds a new [ScardHandle] to the context handles.
    pub(super) fn add_scard(&mut self, scard: ScardHandle) -> WinScardResult<()> {
        if scard == 0 {
            return Err(Error::new(ErrorKind::InvalidHandle, "ScardHandle can not be NULL"));
        }

        self.scards.push(scard);

        Ok(())
    }

    /// Removes the [ScardHandle] from the scard context.
    #[instrument(level = "debug", ret)]
    pub(super) fn remove_scard(&mut self, scard: ScardHandle) -> bool {
        if let Some(index) = self.scards.iter().position(|x| *x == scard) {
            self.scards.remove(index);

            true
        } else {
            false
        }
    }

    /// Allocated a new buffer inside the scard context.
    #[instrument(level = "debug", ret)]
    pub(super) fn allocate_buffer(&mut self, size: usize) -> WinScardResult<*mut u8> {
        // SAFETY: Memory allocation is safe. Moreover, we check for the null value below.
        let buff = unsafe { libc::malloc(size) as *mut u8 };
        if buff.is_null() {
            return Err(Error::new(ErrorKind::NoMemory, format!("cannot allocate {size} bytes")));
        }
        self.allocations.push(buff as usize);

        Ok(buff)
    }

    /// Deletes the buffer inside the scard context.
    #[instrument(level = "debug", ret)]
    pub(super) fn free_buffer(&mut self, buff: LpCVoid) -> bool {
        let buff = buff.expose_provenance();

        if let Some(index) = self.allocations.iter().position(|x| *x == buff) {
            self.allocations.remove(index);

            // SAFETY: The `allocations` collection contains only allocated memory pointers, so it's
            // safe to deallocate them using the `libc::free` function.
            unsafe { libc::free(ptr::with_exposed_provenance_mut(buff)) }

            true
        } else {
            false
        }
    }

    /// Returns the icon of the specified reader.
    pub(super) fn get_reader_icon(
        &mut self,
        reader: &str,
        buffer_type: RequestedBufferType<'_>,
    ) -> WinScardResult<OutBuffer<'_>> {
        let reader_icon = self.scard_context.reader_icon(reader)?.as_ref().to_vec();

        self.write_to_out_buf(&reader_icon, buffer_type)
    }

    /// Lists readers.
    #[instrument(level = "debug", ret)]
    pub(super) fn list_readers(&mut self, buffer_type: RequestedBufferType<'_>) -> WinScardResult<OutBuffer<'_>> {
        let readers: Vec<_> = self
            .scard_context()
            .list_readers()?
            .into_iter()
            .map(|i| i.to_string())
            .collect();

        self.write_multi_string(&readers, buffer_type)
    }

    /// Lists readers but the resulting buffers contain wide strings.
    #[instrument(level = "debug", ret)]
    pub(super) fn list_readers_wide(&mut self, buffer_type: RequestedBufferType<'_>) -> WinScardResult<OutBuffer<'_>> {
        let readers: Vec<_> = self
            .scard_context()
            .list_readers()?
            .into_iter()
            .map(|i| i.to_string())
            .collect();

        self.write_multi_string_wide(&readers, buffer_type)
    }

    /// Lists cards.
    #[instrument(level = "debug", ret)]
    pub(super) fn list_cards(
        &mut self,
        atr: Option<&[u8]>,
        required_interfaces: Option<&[Uuid]>,
        buffer_type: RequestedBufferType<'_>,
    ) -> WinScardResult<OutBuffer<'_>> {
        let cards: Vec<_> = self
            .scard_context()
            .list_cards(atr, required_interfaces)?
            .into_iter()
            .map(|i| i.to_string())
            .collect();

        self.write_multi_string(&cards, buffer_type)
    }

    /// Lists readers but the resulting buffers contain wide strings.
    #[instrument(level = "debug", ret)]
    pub(super) fn list_cards_wide(
        &mut self,
        atr: Option<&[u8]>,
        required_interfaces: Option<&[Uuid]>,
        buffer_type: RequestedBufferType<'_>,
    ) -> WinScardResult<OutBuffer<'_>> {
        let cards: Vec<_> = self
            .scard_context()
            .list_cards(atr, required_interfaces)?
            .into_iter()
            .map(|i| i.to_string())
            .collect();

        self.write_multi_string_wide(&cards, buffer_type)
    }

    /// Reads smart card cache.
    #[instrument(level = "debug", ret)]
    pub(super) fn read_cache(
        &mut self,
        card_id: Uuid,
        freshness_counter: u32,
        key: &str,
        buffer_type: RequestedBufferType<'_>,
    ) -> WinScardResult<OutBuffer<'_>> {
        let cached_value = self
            .scard_context()
            .read_cache(card_id, freshness_counter, key)?
            .to_vec();

        self.write_to_out_buf(cached_value.as_ref(), buffer_type)
    }

    /// Converts provided strings to the C-multi-string and saves it.
    #[instrument(level = "debug", ret)]
    pub(super) fn write_multi_string(
        &mut self,
        values: &[String],
        buffer_type: RequestedBufferType<'_>,
    ) -> WinScardResult<OutBuffer<'static>> {
        let data: Vec<_> = values
            .iter()
            .flat_map(|reader| reader.as_bytes().iter().cloned().chain(once(0)))
            .chain(once(0))
            .collect();

        self.write_to_out_buf(&data, buffer_type)
    }

    /// Converts provided strings to the C-multi-string and saves it but the resulting buffers contain
    /// wide strings.
    #[instrument(level = "debug", ret)]
    pub(super) fn write_multi_string_wide(
        &mut self,
        values: &[String],
        buffer_type: RequestedBufferType<'_>,
    ) -> WinScardResult<OutBuffer<'static>> {
        let data: Vec<_> = values
            .iter()
            .flat_map(|reader| reader.encode_utf16().chain(once(0)).flat_map(|i| i.to_le_bytes()))
            .chain([0, 0])
            .collect();

        self.write_to_out_buf(&data, buffer_type)
    }

    /// Saves the provided data in the [OutBuffer] based on the [RequestedBufferType].
    pub(super) fn write_to_out_buf(
        &mut self,
        data: &[u8],
        buffer_type: RequestedBufferType<'_>,
    ) -> WinScardResult<OutBuffer<'static>> {
        Ok(match buffer_type {
            RequestedBufferType::Buf(buf) => {
                if buf.len() < data.len() {
                    return Err(Error::new(
                        ErrorKind::InsufficientBuffer,
                        format!(
                            "provided buffer is too small to fill the requested attribute into: buffer len: {}, attribute data len: {}.",
                            buf.len(),
                            data.len()
                        ),
                    ));
                }

                buf[0..data.len()].copy_from_slice(data);

                OutBuffer::Written(data.len())
            }
            RequestedBufferType::Length => OutBuffer::DataLen(data.len()),
            RequestedBufferType::Allocate => {
                let allocated = self.allocate_buffer(data.len())?;
                // SAFETY: The `allocated` pointer has been returned from the [WinScardContextHandle]
                // internal method, so it's safe to create a slice.
                let buf = unsafe { from_raw_parts_mut(allocated, data.len()) };

                buf.copy_from_slice(data);

                OutBuffer::Allocated(buf)
            }
        })
    }
}

impl Drop for WinScardContextHandle {
    fn drop(&mut self) {
        // [SCardReleaseContext](https://learn.microsoft.com/en-us/windows/win32/api/winscard/nf-winscard-scardreleasecontext)
        // ...freeing any resources allocated under that context, including SCARDHANDLE objects
        for scard in &self.scards {
            // SAFETY: The `WinScardContextHandle` contains only valid scard handles,
            // so it's safe to cast them to `WinScardHandle` pointer.
            let _ = unsafe { Box::from_raw(*scard as *mut WinScardHandle) };
        }
        // ...and memory allocated using the SCARD_AUTOALLOCATE length designator.
        for buff in &self.allocations {
            // SAFETY: `WinScardContextHandle` contains only allocated memory pointers.
            unsafe {
                libc::free(ptr::with_exposed_provenance_mut(*buff));
            }
        }
    }
}

/// Represents how and what data the user want to extract.
#[derive(Debug)]
pub(super) enum RequestedBufferType<'data> {
    /// This means the user wants the data filled in the provided buffer.
    Buf(&'data mut [u8]),
    /// The user want to query only the data length.
    Length,
    /// The user wants the data to be allocated by the library and returned from the function.
    Allocate,
}

/// Represent the requested data buffer from the smart card.
///
/// The user can request some data from the smart card. For example, `SCardReadCache` or `SCardGetAttrib` functions.
/// However, buffer handling can be tricky in such situations. The user may want to allocate the memory
/// or ask us to do it. This enum aimed to solve this complexity.
#[derive(Debug)]
pub(super) enum OutBuffer<'data> {
    /// The data has been written into provided buffer by [RequestedBufferType::Buf].
    Written(usize),
    /// The user wants to know the requested data length to allocate the corresponding buffer in the future.
    DataLen(usize),
    /// Allocated buffer.
    ///
    /// The inner buffer is leaked and the user should free it using the `SCardFreeMemory` function.
    Allocated(&'data mut [u8]),
}

/// Represents the smart card status.
///
/// This structure is aimed to represent smart card status data on the FFI layer.
#[derive(Debug)]
pub(super) struct FfiScardStatus<'data> {
    /// List of display names (multi-string) by which the currently connected reader is known.
    pub readers: OutBuffer<'data>,
    /// Buffer that receives the ATR string from the currently inserted card, if available.
    ///
    /// [ATR string](https://learn.microsoft.com/en-us/windows/win32/secgloss/a-gly).
    pub atr: OutBuffer<'data>,
    /// Current state of the smart card in the reader.
    pub state: State,
    /// Current protocol, if any. The returned value is meaningful only if the returned value of pdwState is SCARD_SPECIFICMODE.
    pub protocol: Protocol,
}

/// Scard handle representation.
///
/// It also holds a pointer to the smart card context to which it belongs.
pub(super) struct WinScardHandle {
    /// The emulated smart card.
    scard: Box<dyn WinScard>,
    /// Pointer to the smart card context to which it belongs.
    context: ScardContext,
}

impl fmt::Debug for WinScardHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WinScardContextHandle")
            .field("context", &self.context)
            .field("scard", &"<scard obj>")
            .finish()
    }
}

impl WinScardHandle {
    /// Creates a new [WinSCardHandle] based on the provided data.
    pub(super) fn new(scard: Box<dyn WinScard>, context: ScardContext) -> Self {
        Self { scard, context }
    }

    /// Returns the [WinScard] handle.
    pub(super) fn scard(&self) -> &dyn WinScard {
        self.scard.as_ref()
    }

    /// Returns the mutable [WinScard] handle.
    pub(super) fn scard_mut(&mut self) -> &mut dyn WinScard {
        self.scard.as_mut()
    }

    /// Returns mutable reference to the parent [WinScardContextHandle].
    pub(super) fn context<'context>(&self) -> WinScardResult<&'context mut WinScardContextHandle> {
        // SAFETY: The `WinScardHandle` contains a valid context handle.
        unsafe { raw_scard_context_handle_to_scard_context_handle(self.context) }
    }

    /// Returns the requested smart card attribute.
    #[instrument(level = "debug", ret)]
    pub(super) fn get_attribute(
        &self,
        attribute_id: AttributeId,
        buffer_type: RequestedBufferType<'_>,
    ) -> WinScardResult<OutBuffer<'_>> {
        let data = self.scard().get_attribute(attribute_id)?;

        self.context()?.write_to_out_buf(data.as_ref(), buffer_type)
    }

    /// Returns smart card status.
    #[instrument(level = "debug", ret)]
    pub(super) fn status(
        &mut self,
        readers_buf_type: RequestedBufferType<'_>,
        atr_but_type: RequestedBufferType<'_>,
    ) -> WinScardResult<FfiScardStatus<'_>> {
        let status = self.scard().status()?;
        let readers: Vec<_> = status.readers.into_iter().map(|r| r.to_string()).collect();
        let context = self.context()?;

        let readers = context.write_multi_string(&readers, readers_buf_type)?;
        let atr = context.write_to_out_buf(status.atr.as_ref(), atr_but_type)?;

        Ok(FfiScardStatus {
            readers,
            atr,
            state: status.state,
            protocol: status.protocol,
        })
    }

    /// Returns smart card status but all strings are wide.
    #[instrument(level = "debug", ret)]
    pub(super) fn status_wide(
        &mut self,
        readers_buf_type: RequestedBufferType<'_>,
        atr_but_type: RequestedBufferType<'_>,
    ) -> WinScardResult<FfiScardStatus<'_>> {
        let status = self.scard().status()?;
        let readers: Vec<_> = status.readers.into_iter().map(|r| r.to_string()).collect();
        let context = self.context()?;

        let readers = context.write_multi_string_wide(&readers, readers_buf_type)?;
        let atr = context.write_to_out_buf(status.atr.as_ref(), atr_but_type)?;

        Ok(FfiScardStatus {
            readers,
            atr,
            state: status.state,
            protocol: status.protocol,
        })
    }
}

/// Tries to convert the raw scard handle to the `&mut dyn WinScard`.
///
/// # Safety
///
/// The `handle` must be a valid raw scard handle.
pub(super) unsafe fn scard_handle_to_winscard<'a>(handle: ScardHandle) -> WinScardResult<&'a mut dyn WinScard> {
    if handle == 0 {
        return Err(Error::new(ErrorKind::InvalidHandle, "scard handle cannot be zero"));
    }

    // SAFETY:
    // - `handle` is guaranteed to be non-null due to the prior check.
    // - `handle` is a valid raw scard handle.
    if let Some(scard) = unsafe { (handle as *mut WinScardHandle).as_mut() } {
        Ok(scard.scard.as_mut())
    } else {
        Err(Error::new(
            ErrorKind::InvalidHandle,
            "invalid smart card context handle",
        ))
    }
}

/// Tries to convert the raw scard handle to the [&mut WinScardHandle].
///
/// # Safety
///
/// The `h_card` must be a valid raw scard handle.
pub(super) unsafe fn raw_scard_handle_to_scard_handle<'a>(
    h_card: ScardHandle,
) -> WinScardResult<&'a mut WinScardHandle> {
    if h_card == 0 {
        return Err(Error::new(
            ErrorKind::InvalidHandle,
            "scard context handle cannot be zero",
        ));
    }

    // SAFETY:
    // - `h_card` is guaranteed to be non-null due to the prior check.
    // - `h_card` is a valid raw scard handle.
    unsafe { (h_card as *mut WinScardHandle).as_mut() }
        .ok_or_else(|| Error::new(ErrorKind::InvalidHandle, "raw scard context handle is invalid"))
}

/// Tries to convert the raw scard context handle to the [&mut WinScardContextHandle].
///
/// # Safety
///
/// The `h_context` must be a valid raw scard context handle.
pub(super) unsafe fn raw_scard_context_handle_to_scard_context_handle<'a>(
    h_context: ScardContext,
) -> WinScardResult<&'a mut WinScardContextHandle> {
    if h_context == 0 {
        return Err(Error::new(
            ErrorKind::InvalidHandle,
            "scard context handle cannot be zero",
        ));
    }

    // SAFETY:
    // - `h_context` is guaranteed to be non-null due to the prior check.
    // - `h_context` is a valid raw scard context handle.
    unsafe { (h_context as *mut WinScardContextHandle).as_mut() }
        .ok_or_else(|| Error::new(ErrorKind::InvalidHandle, "raw scard context handle is invalid"))
}

/// Tries to convert the raw scard context handle to the `&mut dyn WinScardContext`.
///
/// # Safety
///
/// The `handle` must be a valid raw scard context handle.
pub(super) unsafe fn scard_context_to_winscard_context<'a>(
    handle: ScardContext,
) -> WinScardResult<&'a mut dyn WinScardContext> {
    if handle == 0 {
        return Err(Error::new(
            ErrorKind::InvalidHandle,
            "scard context handle cannot be zero",
        ));
    }

    // SAFETY:
    // - `handle` is guaranteed to be non-null due to the prior check.
    // - `handle` is a valid raw scard context handle.
    if let Some(context) = unsafe { (handle as *mut WinScardContextHandle).as_mut() } {
        Ok(context.scard_context.as_mut())
    } else {
        Err(Error::new(
            ErrorKind::InvalidHandle,
            "invalid smart card context handle",
        ))
    }
}

/// Copies data from the Rust [IoRequest] to the C `SCARD_IO_REQUEST` ([LpScardIoRequest]).
///
/// # Safety
///
/// `scard_io_request` must be a pointer to a valid `ScardIoRequest` structure.
pub(super) unsafe fn copy_io_request_to_scard_io_request(
    io_request: &IoRequest,
    scard_io_request: LpScardIoRequest,
) -> WinScardResult<()> {
    if scard_io_request.is_null() {
        return Err(Error::new(
            ErrorKind::InvalidParameter,
            "scard_io_request cannot be null",
        ));
    }

    let pci_info_len = io_request.pci_info.len();
    // SAFETY: `scard_io_request` is guaranteed to be non-null due to the prior check.
    let cb_pci_length = unsafe { (*scard_io_request).cb_pci_length };
    let scard_pci_info_len = usize::try_from(cb_pci_length)?;

    if pci_info_len > scard_pci_info_len {
        return Err(Error::new(
            ErrorKind::InsufficientBuffer,
            format!(
                "ScardIoRequest::cb_pci_length is too small. Expected at least {pci_info_len} but got {scard_pci_info_len}"
            ),
        ));
    }

    // SAFETY: `scard_io_request` is guaranteed to be non-null due to the prior check.
    unsafe {
        (*scard_io_request).dw_protocol = io_request.protocol.bits();
    }

    // SAFETY: `scard_io_request` is guaranteed to be non-null due to the prior check.
    unsafe {
        (*scard_io_request).cb_pci_length = pci_info_len.try_into()?;
    }

    // SAFETY: According to the documentation, the `pci_buffer` data is placed right after the `ScardIoRequest` structure.
    let pci_buffer_ptr = unsafe { (scard_io_request as *mut u8).add(size_of::<ScardIoRequest>()) };
    // SAFETY: According to the documentation, it's safe to create a slice of the pci data.
    let pci_buffer = unsafe { from_raw_parts_mut(pci_buffer_ptr, pci_info_len) };
    pci_buffer.copy_from_slice(&io_request.pci_info);

    Ok(())
}
