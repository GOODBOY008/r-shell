#![allow(non_snake_case)]

use std::ptr::null;

use libc::c_void;
use sspi::KERBEROS_VERSION;
#[cfg(windows)]
use symbol_rename_macro::rename_symbol;

use super::common::{
    AcceptSecurityContext, AcceptSecurityContextFn, ApplyControlToken, ApplyControlTokenFn, CompleteAuthToken,
    CompleteAuthTokenFn, DecryptMessage, DecryptMessageFn, DeleteSecurityContext, DeleteSecurityContextFn,
    EncryptMessage, EncryptMessageFn, ExportSecurityContext, ExportSecurityContextFn, FreeContextBuffer,
    FreeContextBufferFn, FreeCredentialsHandle, FreeCredentialsHandleFn, ImpersonateSecurityContext,
    ImpersonateSecurityContextFn, MakeSignature, MakeSignatureFn, QuerySecurityContextToken,
    QuerySecurityContextTokenFn, RevertSecurityContext, RevertSecurityContextFn, VerifySignature, VerifySignatureFn,
};
use super::sec_handle::{
    AcquireCredentialsHandleA, AcquireCredentialsHandleFnA, AcquireCredentialsHandleFnW, AcquireCredentialsHandleW,
    AddCredentialsA, AddCredentialsFnA, AddCredentialsFnW, AddCredentialsW, ChangeAccountPasswordA,
    ChangeAccountPasswordFnA, ChangeAccountPasswordFnW, ChangeAccountPasswordW, ImportSecurityContextA,
    ImportSecurityContextFnA, ImportSecurityContextFnW, ImportSecurityContextW, InitializeSecurityContextA,
    InitializeSecurityContextFnA, InitializeSecurityContextFnW, InitializeSecurityContextW, QueryContextAttributesA,
    QueryContextAttributesExA, QueryContextAttributesExFnA, QueryContextAttributesExFnW, QueryContextAttributesExW,
    QueryContextAttributesFnA, QueryContextAttributesFnW, QueryContextAttributesW, QueryCredentialsAttributesA,
    QueryCredentialsAttributesExA, QueryCredentialsAttributesExFnA, QueryCredentialsAttributesExFnW,
    QueryCredentialsAttributesExW, QueryCredentialsAttributesFnA, QueryCredentialsAttributesFnW,
    QueryCredentialsAttributesW, SetContextAttributesA, SetContextAttributesFnA, SetContextAttributesFnW,
    SetContextAttributesW, SetCredentialsAttributesA, SetCredentialsAttributesFnA, SetCredentialsAttributesFnW,
    SetCredentialsAttributesW,
};
use super::sec_pkg_info::{
    EnumerateSecurityPackagesA, EnumerateSecurityPackagesFnA, EnumerateSecurityPackagesFnW, EnumerateSecurityPackagesW,
    QuerySecurityPackageInfoA, QuerySecurityPackageInfoFnA, QuerySecurityPackageInfoFnW, QuerySecurityPackageInfoW,
};
use crate::utils::into_raw_ptr;

#[repr(C)]
pub struct SecurityFunctionTableA {
    pub dwVersion: u32,
    pub EnumerateSecurityPackagesA: EnumerateSecurityPackagesFnA,
    pub QueryCredentialsAttributesA: QueryCredentialsAttributesFnA,
    pub AcquireCredentialsHandleA: AcquireCredentialsHandleFnA,
    pub FreeCredentialsHandle: FreeCredentialsHandleFn,
    pub Reserved2: *const c_void,
    pub InitializeSecurityContextA: InitializeSecurityContextFnA,
    pub AcceptSecurityContext: AcceptSecurityContextFn,
    pub CompleteAuthToken: CompleteAuthTokenFn,
    pub DeleteSecurityContext: DeleteSecurityContextFn,
    pub ApplyControlToken: ApplyControlTokenFn,
    pub QueryContextAttributesA: QueryContextAttributesFnA,
    pub ImpersonateSecurityContext: ImpersonateSecurityContextFn,
    pub RevertSecurityContext: RevertSecurityContextFn,
    pub MakeSignature: MakeSignatureFn,
    pub VerifySignature: VerifySignatureFn,
    pub FreeContextBuffer: FreeContextBufferFn,
    pub QuerySecurityPackageInfoA: QuerySecurityPackageInfoFnA,
    // In the Windows sspicli.dll, the `Reserved3` field is used as EncryptFunction
    pub Reserved3: EncryptMessageFn,
    // In the Windows sspicli.dll, the `Reserved4` field is used as DecryptFunction
    pub Reserved4: DecryptMessageFn,
    pub ExportSecurityContext: ExportSecurityContextFn,
    pub ImportSecurityContextA: ImportSecurityContextFnA,
    pub AddCredentialsA: AddCredentialsFnA,
    pub Reserved8: *const c_void,
    pub QuerySecurityContextToken: QuerySecurityContextTokenFn,
    pub EncryptMessage: EncryptMessageFn,
    pub DecryptMessage: DecryptMessageFn,
    pub SetContextAttributesA: SetContextAttributesFnA,
    pub SetCredentialsAttributesA: SetCredentialsAttributesFnA,
    pub ChangeAccountPasswordA: ChangeAccountPasswordFnA,
    pub Reserved9: *const c_void,
    pub QueryContextAttributesExA: QueryContextAttributesExFnA,
    pub QueryCredentialsAttributesExA: QueryCredentialsAttributesExFnA,
}

pub type PSecurityFunctionTableA = *mut SecurityFunctionTableA;

#[repr(C)]
pub struct SecurityFunctionTableW {
    pub dwVersion: u32,
    pub EnumerateSecurityPackagesW: EnumerateSecurityPackagesFnW,
    pub QueryCredentialsAttributesW: QueryCredentialsAttributesFnW,
    pub AcquireCredentialsHandleW: AcquireCredentialsHandleFnW,
    pub FreeCredentialsHandle: FreeCredentialsHandleFn,
    pub Reserved2: *const c_void,
    pub InitializeSecurityContextW: InitializeSecurityContextFnW,
    pub AcceptSecurityContext: AcceptSecurityContextFn,
    pub CompleteAuthToken: CompleteAuthTokenFn,
    pub DeleteSecurityContext: DeleteSecurityContextFn,
    pub ApplyControlToken: ApplyControlTokenFn,
    pub QueryContextAttributesW: QueryContextAttributesFnW,
    pub ImpersonateSecurityContext: ImpersonateSecurityContextFn,
    pub RevertSecurityContext: RevertSecurityContextFn,
    pub MakeSignature: MakeSignatureFn,
    pub VerifySignature: VerifySignatureFn,
    pub FreeContextBuffer: FreeContextBufferFn,
    pub QuerySecurityPackageInfoW: QuerySecurityPackageInfoFnW,
    // In the Windows sspicli.dll, the `Reserved3` field is used as EncryptFunction
    pub Reserved3: EncryptMessageFn,
    // In the Windows sspicli.dll, the `Reserved4` field is used as DecryptFunction
    pub Reserved4: DecryptMessageFn,
    pub ExportSecurityContext: ExportSecurityContextFn,
    pub ImportSecurityContextW: ImportSecurityContextFnW,
    pub AddCredentialsW: AddCredentialsFnW,
    pub Reserved8: *const c_void,
    pub QuerySecurityContextToken: QuerySecurityContextTokenFn,
    pub EncryptMessage: EncryptMessageFn,
    pub DecryptMessage: DecryptMessageFn,
    pub SetContextAttributesW: SetContextAttributesFnW,
    pub SetCredentialsAttributesW: SetCredentialsAttributesFnW,
    pub ChangeAccountPasswordW: ChangeAccountPasswordFnW,
    pub Reserved9: *const c_void,
    pub QueryContextAttributesExW: QueryContextAttributesExFnW,
    pub QueryCredentialsAttributesExW: QueryCredentialsAttributesExFnW,
}

pub type PSecurityFunctionTableW = *mut SecurityFunctionTableW;

#[instrument(skip_all)]
#[cfg_attr(windows, rename_symbol(to = "Rust_InitSecurityInterfaceA"))]
#[unsafe(no_mangle)]
pub extern "system" fn InitSecurityInterfaceA() -> PSecurityFunctionTableA {
    crate::logging::setup_logger();

    into_raw_ptr(SecurityFunctionTableA {
        dwVersion: KERBEROS_VERSION as u32,
        EnumerateSecurityPackagesA,
        QueryCredentialsAttributesA,
        AcquireCredentialsHandleA,
        FreeCredentialsHandle,
        Reserved2: null(),
        InitializeSecurityContextA,
        AcceptSecurityContext,
        CompleteAuthToken,
        DeleteSecurityContext,
        ApplyControlToken,
        QueryContextAttributesA,
        ImpersonateSecurityContext,
        RevertSecurityContext,
        MakeSignature,
        VerifySignature,
        FreeContextBuffer,
        QuerySecurityPackageInfoA,
        Reserved3: EncryptMessage,
        Reserved4: DecryptMessage,
        ExportSecurityContext,
        ImportSecurityContextA,
        AddCredentialsA,
        Reserved8: null(),
        QuerySecurityContextToken,
        EncryptMessage,
        DecryptMessage,
        SetContextAttributesA,
        SetCredentialsAttributesA,
        ChangeAccountPasswordA,
        Reserved9: null(),
        QueryContextAttributesExA,
        QueryCredentialsAttributesExA,
    })
}

#[instrument(skip_all)]
#[cfg_attr(windows, rename_symbol(to = "Rust_InitSecurityInterfaceW"))]
#[unsafe(no_mangle)]
pub extern "system" fn InitSecurityInterfaceW() -> PSecurityFunctionTableW {
    crate::logging::setup_logger();

    into_raw_ptr(SecurityFunctionTableW {
        dwVersion: KERBEROS_VERSION as u32,
        EnumerateSecurityPackagesW,
        QueryCredentialsAttributesW,
        AcquireCredentialsHandleW,
        FreeCredentialsHandle,
        Reserved2: null(),
        InitializeSecurityContextW,
        AcceptSecurityContext,
        CompleteAuthToken,
        DeleteSecurityContext,
        ApplyControlToken,
        QueryContextAttributesW,
        ImpersonateSecurityContext,
        RevertSecurityContext,
        MakeSignature,
        VerifySignature,
        FreeContextBuffer,
        QuerySecurityPackageInfoW,
        Reserved3: EncryptMessage,
        Reserved4: DecryptMessage,
        ExportSecurityContext,
        ImportSecurityContextW,
        AddCredentialsW,
        Reserved8: null(),
        QuerySecurityContextToken,
        EncryptMessage,
        DecryptMessage,
        SetContextAttributesW,
        SetCredentialsAttributesW,
        ChangeAccountPasswordW,
        Reserved9: null(),
        QueryContextAttributesExW,
        QueryCredentialsAttributesExW,
    })
}
