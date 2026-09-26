use std::ffi::c_void;

pub type LpStr = *mut u8;
pub type LpCStr = *const u8;
pub type Dword = u32;
pub type LpDword = *mut u32;
pub type WChar = u16;
pub type LpWStr = *mut u16;
pub type LpCWStr = *const u16;
pub type LpCByte = *const u8;
pub type LpByte = *mut u8;
pub type LpCVoid = *const c_void;
pub type LpVoid = *mut c_void;
pub type Handle = isize;
pub type Bool = i32;

/// [Guid](https://learn.microsoft.com/en-us/windows/win32/api/guiddef/ns-guiddef-guid)
///
/// ```not_rust
/// typedef struct _GUID {
///   unsigned long  Data1;
///   unsigned short Data2;
///   unsigned short Data3;
///   unsigned char  Data4[8];
/// } GUID;
/// ```
#[derive(Clone, Copy, Debug)]
#[repr(C)]
pub struct Guid {
    pub data1: u32,
    pub data2: u16,
    pub data3: u16,
    pub data4: [u8; 8],
}
pub type LpCGuid = *const Guid;
pub type LpGuid = *mut Guid;
pub type Uuid = Guid;
pub type LpUuid = *mut Uuid;
pub type LpCUuid = *const Uuid;
