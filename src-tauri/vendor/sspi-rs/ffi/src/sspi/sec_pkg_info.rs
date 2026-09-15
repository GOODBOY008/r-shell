use std::ffi::CStr;
use std::mem::size_of;
use std::ptr::copy_nonoverlapping;

use sspi::{
    Error, KERBEROS_VERSION, PackageInfo, U16CString, Utf16String, Utf16StringExt, enumerate_security_packages,
};
#[cfg(windows)]
use symbol_rename_macro::rename_symbol;

use super::sspi_data_types::{SecChar, SecWChar, SecurityStatus};

#[derive(Debug)]
#[repr(C)]
pub struct SecPkgInfoW {
    pub f_capabilities: u32,
    pub w_version: u16,
    pub w_rpc_id: u16,
    pub cb_max_token: u32,
    pub name: *mut SecWChar,
    pub comment: *mut SecWChar,
}

pub type PSecPkgInfoW = *mut SecPkgInfoW;

pub struct RawSecPkgInfoW(pub *mut SecPkgInfoW);

#[allow(clippy::useless_conversion)]
impl From<PackageInfo> for RawSecPkgInfoW {
    fn from(pkg_info: PackageInfo) -> Self {
        let pkg_name = Utf16String::from_str(&pkg_info.name).into_vec_with_nul();
        let name_bytes_len = pkg_name.len() * 2;

        let pkg_comment = Utf16String::from_str(&pkg_info.comment).into_vec_with_nul();
        let comment_bytes_len = pkg_comment.len() * 2;

        let pkg_info_w_size = size_of::<SecPkgInfoW>();
        let size = pkg_info_w_size + name_bytes_len + comment_bytes_len;

        let raw_pkg_info;
        let pkg_info_w;
        // SAFETY: Memory allocation is safe.
        unsafe {
            raw_pkg_info = libc::malloc(size);
        }
        // SAFETY:
        // FIXME(safety): it is illegal to construct a reference to uninitialized data
        // Useful references:
        // - https://doc.rust-lang.org/nomicon/unchecked-uninit.html
        // - https://doc.rust-lang.org/core/mem/union.MaybeUninit.html#initializing-a-struct-field-by-field
        // NOTE: this is not the only place that needs to be fixed. An audit is required.
        unsafe {
            pkg_info_w = (raw_pkg_info as *mut SecPkgInfoW).as_mut().unwrap();
        }

        pkg_info_w.f_capabilities = pkg_info.capabilities.bits();
        pkg_info_w.w_version = KERBEROS_VERSION as u16;
        pkg_info_w.w_rpc_id = pkg_info.rpc_id;
        pkg_info_w.cb_max_token = pkg_info.max_token_len.try_into().unwrap();

        let name_ptr;
        // SAFETY: Our allocated buffer is big enough to contain package name and comment.
        unsafe {
            name_ptr = raw_pkg_info.add(pkg_info_w_size);
        }
        // SAFETY:
        // * pkg_name ptr is valid for read because it is Rust-allocated vector.
        // * name_ptr is valid for write because we took into account its length during memory allocation.
        unsafe {
            copy_nonoverlapping(pkg_name.as_ptr().cast(), name_ptr, name_bytes_len);
        }
        pkg_info_w.name = name_ptr.cast();

        let comment_ptr;
        // SAFETY: Our allocated buffer is big enough to contain package name and comment.
        unsafe {
            comment_ptr = name_ptr.add(name_bytes_len);
        }
        // SAFETY:
        // * pkg_comment ptr is valid for read because it is Rust-allocated vector.
        // * pkg_comment is valid for write because we took into account its length during memory allocation.
        unsafe {
            copy_nonoverlapping(pkg_comment.as_ptr().cast(), comment_ptr, comment_bytes_len);
        }
        pkg_info_w.comment = comment_ptr.cast();

        Self(raw_pkg_info as *mut SecPkgInfoW)
    }
}

#[derive(Debug)]
#[repr(C)]
pub struct SecPkgInfoA {
    pub f_capabilities: u32,
    pub w_version: u16,
    pub w_rpc_id: u16,
    pub cb_max_token: u32,
    pub name: *mut SecChar,
    pub comment: *mut SecChar,
}

pub type PSecPkgInfoA = *mut SecPkgInfoA;

pub struct RawSecPkgInfoA(pub *mut SecPkgInfoA);

#[allow(clippy::useless_conversion)]
impl From<PackageInfo> for RawSecPkgInfoA {
    fn from(pkg_info: PackageInfo) -> Self {
        let mut pkg_name = pkg_info.name.to_string().as_bytes().to_vec();
        // We need to add the null-terminator during the conversion from Rust to C string.
        pkg_name.push(0);
        let name_bytes_len = pkg_name.len();

        let mut pkg_comment = pkg_info.comment.as_bytes().to_vec();
        // We need to add the null-terminator during the conversion from Rust to C string.
        pkg_comment.push(0);
        let comment_bytes_len = pkg_comment.len();

        let pkg_info_a_size = size_of::<SecPkgInfoA>();

        let size = pkg_info_a_size + name_bytes_len + comment_bytes_len;

        let raw_pkg_info;
        let pkg_info_a;

        // SAFETY: Memory allocation is safe.
        unsafe {
            raw_pkg_info = libc::malloc(size);
        }
        // SAFETY:
        // FIXME(safety): it is illegal to construct a reference to uninitialized data
        // Useful references:
        // - https://doc.rust-lang.org/nomicon/unchecked-uninit.html
        // - https://doc.rust-lang.org/core/mem/union.MaybeUninit.html#initializing-a-struct-field-by-field
        // NOTE: this is not the only place that needs to be fixed. An audit is required.
        unsafe {
            pkg_info_a = (raw_pkg_info as *mut SecPkgInfoA).as_mut().unwrap();
        }

        pkg_info_a.f_capabilities = pkg_info.capabilities.bits();
        pkg_info_a.w_version = KERBEROS_VERSION as u16;
        pkg_info_a.w_rpc_id = pkg_info.rpc_id;
        pkg_info_a.cb_max_token = pkg_info.max_token_len;

        let name_ptr;
        // SAFETY: Our allocated buffer is big enough to contain package name and comment.
        unsafe {
            name_ptr = raw_pkg_info.add(pkg_info_a_size);
        }
        // SAFETY:
        // * pkg_name ptr is valid for read because it is Rust-allocated vector.
        // * name_ptr is valid for write because we took into account its length during memory allocation.
        unsafe {
            copy_nonoverlapping(pkg_name.as_ptr().cast(), name_ptr, name_bytes_len);
        }
        pkg_info_a.name = name_ptr.cast();

        let comment_ptr;
        // SAFETY: Our allocated buffer is big enough to contain package name and comment.
        unsafe {
            comment_ptr = name_ptr.add(name_bytes_len);
        }
        // SAFETY:
        // * pkg_comment ptr is valid for read because it is Rust-allocated vector.
        // * pkg_comment is valid for write because we took into account its length during memory allocation.
        unsafe {
            copy_nonoverlapping(pkg_comment.as_ptr().cast(), comment_ptr, comment_bytes_len);
        }
        pkg_info_a.comment = comment_ptr.cast();

        Self(raw_pkg_info as *mut SecPkgInfoA)
    }
}

#[derive(Debug)]
#[repr(C)]
pub struct SecNegoInfoW {
    pub package_info: *mut SecPkgInfoW,
    pub nego_state: u32,
}

#[derive(Debug)]
#[repr(C)]
pub struct SecNegoInfoA {
    pub package_info: *mut SecPkgInfoA,
    pub nego_state: u32,
}

/// The `EnumerateSecurityPackagesA` function returns an array of `SecPkgInfo` structures that provide
/// information about the `security packages` available to the client.
///
/// [MSDN Reference](https://learn.microsoft.com/en-us/windows/win32/api/sspi/nf-sspi-enumeratesecuritypackagesa)
///
/// # Safety
///
/// - `pc_packages` must be a pointer that is valid for reads.
/// - `pp_package_info` must be a pointer that is valid both for reads and writes.
#[instrument(skip_all)]
#[cfg_attr(windows, rename_symbol(to = "Rust_EnumerateSecurityPackagesA"))]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn EnumerateSecurityPackagesA(
    pc_packages: *mut u32,
    pp_package_info: *mut PSecPkgInfoA,
) -> SecurityStatus {
    catch_panic! {
        check_null!(pc_packages);
        check_null!(pp_package_info);

        let packages = try_execute!(enumerate_security_packages());

        // SAFETY: `pc_packages` is guaranteed to be non-null due to the prior check.
        unsafe { *pc_packages = packages.len() as u32; }

        let mut size = size_of::<SecPkgInfoA>() * packages.len();

        for package in &packages {
            size += package.name.as_ref().len() + 1 /* null byte */ + package.comment.len() + 1 /* null byte */;
        }

        // SAFETY: Memory allocation is safe.
        let raw_packages = unsafe { libc::malloc(size) };

        if raw_packages.is_null() {
            return ErrorKind::InsufficientMemory.to_u32().unwrap();
        }

        let mut package_ptr = raw_packages as *mut SecPkgInfoA;

        // SAFETY: It is safe to cast a pointer because we allocated enough memory to place package name and comment alongside SecPkgInfoA.
        let mut data_ptr = unsafe { raw_packages.add(size_of::<SecPkgInfoA>() * packages.len()) as *mut SecChar };
        for pkg_info in packages {
            // FIXME(safety): it is illegal to construct a reference to uninitialized data
            // Useful references:
            // - https://doc.rust-lang.org/nomicon/unchecked-uninit.html
            // - https://doc.rust-lang.org/core/mem/union.MaybeUninit.html#initializing-a-struct-field-by-field
            // NOTE: this is not the only place that needs to be fixed. An audit is required.
            // SAFETY: `package_ptr` is a local pointer and it's convertible to a reference.
            let pkg_info_a = unsafe { package_ptr.as_mut().unwrap() };

            pkg_info_a.f_capabilities = pkg_info.capabilities.bits();
            pkg_info_a.w_version = KERBEROS_VERSION as u16;
            pkg_info_a.w_rpc_id = pkg_info.rpc_id;
            pkg_info_a.cb_max_token = pkg_info.max_token_len;

            let mut name = pkg_info.name.as_ref().as_bytes().to_vec();
            // We need to add the null-terminator during the conversion from Rust to C string.
            name.push(0);
            // SAFETY:
            // - `name` is valid C string.
            // - `data_ptr` is a local pointer to allocated memory.
            // - We precalculated and allocated enough memory to accommodate all security packages + their names and comments.
            unsafe { copy_nonoverlapping(name.as_ptr(), data_ptr.cast(), name.len()); }
            pkg_info_a.name = data_ptr.cast();
            // SAFETY:
            // - Our allocated buffer is big enough to contain package name and comment.
            // - We precalculated and allocated enough memory to accommodate all security packages + their names and comments.
            data_ptr = unsafe { data_ptr.add(name.len()) };

            let mut comment = pkg_info.comment.as_bytes().to_vec();
            // We need to add the null-terminator during the conversion from Rust to C string.
            comment.push(0);

            // SAFETY:
            // - `name` is valid C string.
            // - `data_ptr` is a local pointer to allocated memory.
            // - We precalculated and allocated enough memory to accommodate all security packages + their names and comments.
            unsafe { copy_nonoverlapping(comment.as_ptr(), data_ptr.cast(), comment.len()); }
            pkg_info_a.comment = data_ptr.cast();
            // SAFETY:
            // - Our allocated buffer is big enough to contain package name and comment.
            // - We precalculated and allocated enough memory to accommodate all security packages + their names and comments.
            data_ptr = unsafe { data_ptr.add(comment.len()) };

            // SAFETY:
            // - Next structure (if any) is placed right after this structure.
            // - We precalculated and allocated enough memory to accommodate all security packages + their names and comments.
            package_ptr = unsafe { package_ptr.add(1) };
        }

        // SAFETY: `pp_package_into` is guaranteed to be non-null due to the prior check.
        unsafe { *pp_package_info = raw_packages.cast(); }

        0
    }
}

pub type EnumerateSecurityPackagesFnA = unsafe extern "system" fn(*mut u32, *mut PSecPkgInfoA) -> SecurityStatus;

/// The `EnumerateSecurityPackagesW` function returns an array of `SecPkgInfo` structures that provide
/// information about the `security packages` available to the client.
///
/// [MSDN Reference](https://learn.microsoft.com/en-us/windows/win32/api/sspi/nf-sspi-enumeratesecuritypackagesw)
///
/// # Safety
///
/// - `pc_packages` must be a pointer that is valid for reads.
/// - `pp_package_info` must be a pointer that is valid both for reads and writes.
#[instrument(skip_all)]
#[cfg_attr(windows, rename_symbol(to = "Rust_EnumerateSecurityPackagesW"))]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn EnumerateSecurityPackagesW(
    pc_packages: *mut u32,
    pp_package_info: *mut *mut SecPkgInfoW,
) -> SecurityStatus {
    catch_panic! {
        check_null!(pc_packages);
        check_null!(pp_package_info);

        let packages = try_execute!(enumerate_security_packages());

        // SAFETY: `pc_packages` is guaranteed to be non-null due to the prior check.
        unsafe { *pc_packages = packages.len() as u32; }

        let mut size = size_of::<SecPkgInfoW>() * packages.len();
        let mut names = Vec::with_capacity(packages.len());
        let mut comments = Vec::with_capacity(packages.len());

        for package in &packages {
            let name = Utf16String::from_str(&package.name).into_vec_with_nul();
            let comment = Utf16String::from_str(&package.comment).into_vec_with_nul();

            size += (name.len() + comment.len()) * 2;

            names.push(name);
            comments.push(comment);
        }

        // SAFETY: Memory allocation is safe.
        let raw_packages = unsafe { libc::malloc(size) };

        if raw_packages.is_null() {
            return ErrorKind::InsufficientMemory.to_u32().unwrap();
        }

        let mut package_ptr = raw_packages as *mut SecPkgInfoW;
        // SAFETY: It is safe to cast a pointer because we allocated enough memory to place package name and comment alongside SecPkgInfoA.
        let mut data_ptr = unsafe { raw_packages.add(size_of::<SecPkgInfoW>() * packages.len()) as *mut SecWChar };
        for (i, pkg_info) in packages.iter().enumerate() {
            // FIXME(safety): it is illegal to construct a reference to uninitialized data
            // Useful references:
            // - https://doc.rust-lang.org/nomicon/unchecked-uninit.html
            // - https://doc.rust-lang.org/core/mem/union.MaybeUninit.html#initializing-a-struct-field-by-field
            // NOTE: this is not the only place that needs to be fixed. An audit is required.
            // SAFETY: `package_ptr` is a local pointer and we've checked that it is not null above.
            let pkg_info_w = unsafe { package_ptr.as_mut().unwrap() };

            pkg_info_w.f_capabilities = pkg_info.capabilities.bits();
            pkg_info_w.w_version = KERBEROS_VERSION as u16;
            pkg_info_w.w_rpc_id = pkg_info.rpc_id;
            pkg_info_w.cb_max_token = pkg_info.max_token_len;

            // SAFETY:
            // - `names[i]` is valid C string.
            // - `data_ptr` is a local pointer to allocated memory.
            // - We precalculated and allocated enough memory to accommodate all security packages + their names and comments.
            unsafe { copy_nonoverlapping(names[i].as_ptr(), data_ptr.cast(), names[i].len()); }
            pkg_info_w.name = data_ptr.cast();
            // SAFETY:
            // - Our allocated buffer is big enough to contain package name and comment.
            // - We precalculated and allocated enough memory to accommodate all security packages + their names and comments.
            data_ptr = unsafe { data_ptr.add(names[i].len()) };

            // SAFETY:
            // - `name` is valid C string.
            // - `data_ptr` is a local pointer to allocated memory.
            // - We precalculated and allocated enough memory to accommodate all security packages + their names and comments.
            unsafe { copy_nonoverlapping(comments[i].as_ptr(), data_ptr.cast(), comments[i].len()); }
            pkg_info_w.comment = data_ptr.cast();
            // SAFETY:
            // - Our allocated buffer is big enough to contain package name and comment.
            // - We precalculated and allocated enough memory to accommodate all security packages + their names and comments.
            data_ptr = unsafe { data_ptr.add(comments[i].len()) };

            // SAFETY:
            // - Next structure (if any) is placed right after this structure.
            // - We precalculated and allocated enough memory to accommodate all security packages + their names and comments.
            package_ptr = unsafe { package_ptr.add(1) };
        }

        // SAFETY: `pp_package_into` is guaranteed to be non-null due to the prior check.
        unsafe { *pp_package_info = raw_packages.cast(); }

        0
    }
}

pub type EnumerateSecurityPackagesFnW = unsafe extern "system" fn(*mut u32, *mut PSecPkgInfoW) -> SecurityStatus;

/// Retrieves information about a specified `security package`. This information includes the bounds on
/// sizes of authentication information, credentials, and contexts.
///
/// [MSDN Reference](https://learn.microsoft.com/en-us/windows/win32/api/sspi/nf-sspi-querysecuritypackageinfoa)
///
/// # Safety
///
/// `p_package_name` must be a non-null pointer to a valid, null-terminated C string representing package name.
/// `pp_package_name` must be a pointer that is valid both for reads and writes.
#[instrument(skip_all)]
#[cfg_attr(windows, rename_symbol(to = "Rust_QuerySecurityPackageInfoA"))]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn QuerySecurityPackageInfoA(
    p_package_name: *const SecChar,
    pp_package_info: *mut PSecPkgInfoA,
) -> SecurityStatus {
    catch_panic! {
        check_null!(p_package_name);
        check_null!(pp_package_info);

        let pkg_name = try_execute!(
            // SAFETY:
            // - `p_package_name` is guaranteed to be non-null due to the prior check.
            // - The memory region `p_package_name` contains a valid null-terminator at the end of string.
            // - The memory region `p_package_name` points to is valid for reads of bytes up to and including null-terminator.
            unsafe { CStr::from_ptr(p_package_name) }.to_str(),
            ErrorKind::InvalidParameter
        );

        let pkg_info: RawSecPkgInfoA = try_execute!(enumerate_security_packages())
            .into_iter()
            .find(|pkg| pkg.name.as_ref() == pkg_name)
            .unwrap()
            .into();
        // SAFETY: `pp_package_info` is guaranteed to be non-null due to the prior check.
        unsafe { *pp_package_info = pkg_info.0; }

        0
    }
}

pub type QuerySecurityPackageInfoFnA = unsafe extern "system" fn(*const SecChar, *mut PSecPkgInfoA) -> SecurityStatus;

/// Retrieves information about a specified `security package`. This information includes the bounds on
/// sizes of authentication information, credentials, and contexts.
///
/// [MSDN Reference](https://learn.microsoft.com/en-us/windows/win32/api/sspi/nf-sspi-querysecuritypackageinfow)
///
/// # Safety
///
/// `p_package_name` must be a non-null pointer to a valid, null-terminated C string representing package name
/// and must be properly aligned for `u16`.
/// `pp_package_name` must be a pointer that is valid both for reads and writes.
#[instrument(skip_all)]
#[cfg_attr(windows, rename_symbol(to = "Rust_QuerySecurityPackageInfoW"))]
#[unsafe(no_mangle)]
pub unsafe extern "system" fn QuerySecurityPackageInfoW(
    p_package_name: *const SecWChar,
    pp_package_info: *mut PSecPkgInfoW,
) -> SecurityStatus {
    catch_panic! {
        check_null!(p_package_name);
        check_null!(pp_package_info);

        let pkg_name = try_execute!(
            // SAFETY:
            // - `p_package_name` is guaranteed to be non-null due to the prior check.
            // - The memory region `p_package_name` points to is properly aligned for `u16` reads
            //   (guaranteed by the Windows SSPI calling convention for `LPCWSTR`).
            // - The memory region `p_package_name` contains a sequence of valid `u16` values
            //   terminated by a null (`0u16`) value.
            // - The memory region `p_package_name` points to is valid for reads of `u16` values
            //   up to and including the null terminator.
            unsafe { U16CString::from_ptr_str(p_package_name) }.to_string().map_err(Error::from)
        );

        let pkg_info: RawSecPkgInfoW = try_execute!(enumerate_security_packages())
            .into_iter()
            .find(|pkg| pkg.name.to_string() == pkg_name)
            .unwrap()
            .into();
        // SAFETY: `pp_package_info` is guaranteed to be non-null due to the prior check.
        unsafe { *pp_package_info = pkg_info.0; }

        0
    }
}

pub type QuerySecurityPackageInfoFnW = unsafe extern "system" fn(*const SecWChar, *mut PSecPkgInfoW) -> SecurityStatus;

#[cfg(test)]
#[expect(
    clippy::undocumented_unsafe_blocks,
    reason = "undocumented unsafe is acceptable in tests"
)]
mod tests {
    use std::ffi::CStr;
    use std::ptr::null_mut;

    use sspi::U16CString;

    use super::{EnumerateSecurityPackagesA, EnumerateSecurityPackagesW, SecPkgInfoA, SecPkgInfoW};
    use crate::sspi::common::FreeContextBuffer;

    #[test]
    fn enumerate_security_packages_a() {
        cfg_if::cfg_if!(
            if #[cfg(feature = "tsssp")] {
                let expected_packages_amount = 5;
            } else {
                let expected_packages_amount = 4;
            }
        );

        let mut packages_amount = 0;
        let mut packages = null_mut::<SecPkgInfoA>();

        let status = unsafe { EnumerateSecurityPackagesA(&mut packages_amount, &mut packages) };

        assert_eq!(status, 0);
        assert_eq!(packages_amount, expected_packages_amount);
        assert!(!packages.is_null());

        for i in 0..(packages_amount as usize) {
            let pkg_info = unsafe { packages.add(i) };
            let pkg_info = unsafe { pkg_info.as_mut() }.expect("pkg_info is not null");

            assert!(!pkg_info.name.is_null());
            let name = unsafe { CStr::from_ptr(pkg_info.name) }
                .to_str()
                .expect("package name must be valid UTF-8");
            assert!(!name.is_empty());

            assert!(!pkg_info.comment.is_null());
            let comment = unsafe { CStr::from_ptr(pkg_info.comment) }
                .to_str()
                .expect("package comment must be valid UTF-8");
            assert!(!comment.is_empty());
        }

        let pv_context_buffer = packages.cast();
        let status = unsafe { FreeContextBuffer(pv_context_buffer) };
        assert_eq!(status, 0);
    }

    #[test]
    fn enumerate_security_packages_w() {
        cfg_if::cfg_if!(
            if #[cfg(feature = "tsssp")] {
                let expected_packages_amount = 5;
            } else {
                let expected_packages_amount = 4;
            }
        );

        let mut packages_amount = 0;
        let mut packages = null_mut::<SecPkgInfoW>();

        let status = unsafe { EnumerateSecurityPackagesW(&mut packages_amount, &mut packages) };

        assert_eq!(status, 0);
        assert_eq!(packages_amount, expected_packages_amount);
        assert!(!packages.is_null());

        for i in 0..(packages_amount as usize) {
            let pkg_info = unsafe { packages.add(i) };
            let pkg_info = unsafe { pkg_info.as_mut() }.expect("pkg_info is not null");

            assert!(!pkg_info.name.is_null());
            let name = unsafe { U16CString::from_ptr_str(pkg_info.name) }
                .to_string()
                .expect("package name must be valid UTF-16");
            assert!(!name.is_empty());

            assert!(!pkg_info.comment.is_null());
            let comment = unsafe { U16CString::from_ptr_str(pkg_info.comment) }
                .to_string()
                .expect("package comment must be valid UTF-16");
            assert!(!comment.is_empty());
        }

        let pv_context_buffer = packages.cast();
        let status = unsafe { FreeContextBuffer(pv_context_buffer) };
        assert_eq!(status, 0);
    }
}
