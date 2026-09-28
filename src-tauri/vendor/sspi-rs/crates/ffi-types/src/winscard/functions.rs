use std::ffi::c_void;

use super::{
    LpCScardIoRequest, LpOpenCardNameA, LpOpenCardNameExA, LpOpenCardNameExW, LpOpenCardNameW, LpScardAtrMask,
    LpScardContext, LpScardHandle, LpScardIoRequest, LpScardReaderStateA, LpScardReaderStateW, ScardContext,
    ScardHandle, ScardStatus,
};
use crate::winscard::ScardIoRequest;
use crate::{
    Handle, LpByte, LpCByte, LpCGuid, LpCStr, LpCVoid, LpCWStr, LpDword, LpGuid, LpStr, LpUuid, LpVoid, LpWStr,
};

pub type SCardEstablishContextFn =
    unsafe extern "system" fn(u32, *const c_void, *const c_void, LpScardContext) -> ScardStatus;
pub type SCardReleaseContextFn = unsafe extern "system" fn(ScardContext) -> ScardStatus;
pub type SCardIsValidContextFn = unsafe extern "system" fn(ScardContext) -> ScardStatus;
pub type SCardListReaderGroupsAFn = unsafe extern "system" fn(ScardContext, LpStr, LpDword) -> ScardStatus;
pub type SCardListReaderGroupsWFn = unsafe extern "system" fn(ScardContext, LpWStr, LpDword) -> ScardStatus;
pub type SCardListReadersAFn = unsafe extern "system" fn(ScardContext, LpCStr, LpStr, LpDword) -> ScardStatus;
pub type SCardListReadersWFn = unsafe extern "system" fn(ScardContext, LpCWStr, LpWStr, LpDword) -> ScardStatus;
pub type SCardListCardsAFn =
    unsafe extern "system" fn(ScardContext, LpCByte, LpCGuid, u32, *mut u8, LpDword) -> ScardStatus;
pub type SCardListCardsWFn =
    unsafe extern "system" fn(ScardContext, LpCByte, LpCGuid, u32, *mut u16, LpDword) -> ScardStatus;
pub type SCardListInterfacesAFn = unsafe extern "system" fn(ScardContext, LpCStr, LpGuid, LpDword) -> ScardStatus;
pub type SCardListInterfacesWFn = unsafe extern "system" fn(ScardContext, LpCWStr, LpGuid, LpDword) -> ScardStatus;
pub type SCardGetProviderIdAFn = unsafe extern "system" fn(ScardContext, LpCStr, LpGuid) -> ScardStatus;
pub type SCardGetProviderIdWFn = unsafe extern "system" fn(ScardContext, LpCWStr, LpGuid) -> ScardStatus;
pub type SCardGetCardTypeProviderNameAFn =
    unsafe extern "system" fn(ScardContext, LpCStr, u32, *mut u8, LpDword) -> ScardStatus;
pub type SCardGetCardTypeProviderNameWFn =
    unsafe extern "system" fn(ScardContext, LpCWStr, u32, *mut u16, LpDword) -> ScardStatus;
pub type SCardIntroduceReaderGroupAFn = unsafe extern "system" fn(ScardContext, LpCStr) -> ScardStatus;
pub type SCardIntroduceReaderGroupWFn = unsafe extern "system" fn(ScardContext, LpCWStr) -> ScardStatus;
pub type SCardForgetReaderGroupAFn = unsafe extern "system" fn(ScardContext, LpCStr) -> ScardStatus;
pub type SCardForgetReaderGroupWFn = unsafe extern "system" fn(ScardContext, LpCWStr) -> ScardStatus;
pub type SCardIntroduceReaderAFn = unsafe extern "system" fn(ScardContext, LpCStr, LpCStr) -> ScardStatus;
pub type SCardIntroduceReaderWFn = unsafe extern "system" fn(ScardContext, LpCWStr, LpCWStr) -> ScardStatus;
pub type SCardForgetReaderAFn = unsafe extern "system" fn(ScardContext, LpCStr) -> ScardStatus;
pub type SCardForgetReaderWFn = unsafe extern "system" fn(ScardContext, LpCWStr) -> ScardStatus;
pub type SCardAddReaderToGroupAFn = unsafe extern "system" fn(ScardContext, LpCStr, LpCStr) -> ScardStatus;
pub type SCardAddReaderToGroupWFn = unsafe extern "system" fn(ScardContext, LpCWStr, LpCWStr) -> ScardStatus;
pub type SCardRemoveReaderFromGroupAFn = unsafe extern "system" fn(ScardContext, LpCStr, LpCStr) -> ScardStatus;
pub type SCardRemoveReaderFromGroupWFn = unsafe extern "system" fn(ScardContext, LpCWStr, LpCWStr) -> ScardStatus;
pub type SCardIntroduceCardTypeAFn =
    unsafe extern "system" fn(ScardContext, LpCStr, LpCGuid, LpCGuid, u32, LpCByte, LpCByte, u32) -> ScardStatus;
pub type SCardIntroduceCardTypeWFn =
    unsafe extern "system" fn(ScardContext, LpCWStr, LpCGuid, LpCGuid, u32, LpCByte, LpCByte, u32) -> ScardStatus;
pub type SCardSetCardTypeProviderNameAFn = unsafe extern "system" fn(ScardContext, LpCStr, u32, LpCStr) -> ScardStatus;
pub type SCardSetCardTypeProviderNameWFn =
    unsafe extern "system" fn(ScardContext, LpCWStr, u32, LpCWStr) -> ScardStatus;
pub type SCardForgetCardTypeAFn = unsafe extern "system" fn(ScardContext, LpCStr) -> ScardStatus;
pub type SCardForgetCardTypeWFn = unsafe extern "system" fn(ScardContext, LpCWStr) -> ScardStatus;
pub type SCardFreeMemoryFn = unsafe extern "system" fn(ScardContext, LpCVoid) -> ScardStatus;
pub type SCardAccessStartedEventFn = unsafe extern "system" fn() -> Handle;
pub type SCardReleaseStartedEventFn = unsafe extern "system" fn();
pub type SCardLocateCardsAFn = unsafe extern "system" fn(ScardContext, LpCStr, LpScardReaderStateA, u32) -> ScardStatus;
pub type SCardLocateCardsWFn =
    unsafe extern "system" fn(ScardContext, LpCWStr, LpScardReaderStateW, u32) -> ScardStatus;
pub type SCardLocateCardsByATRAFn =
    unsafe extern "system" fn(ScardContext, LpScardAtrMask, u32, LpScardReaderStateA, u32) -> ScardStatus;
pub type SCardLocateCardsByATRWFn =
    unsafe extern "system" fn(ScardContext, LpScardAtrMask, u32, LpScardReaderStateW, u32) -> ScardStatus;
pub type SCardGetStatusChangeAFn =
    unsafe extern "system" fn(ScardContext, u32, LpScardReaderStateA, u32) -> ScardStatus;
pub type SCardGetStatusChangeWFn =
    unsafe extern "system" fn(ScardContext, u32, LpScardReaderStateW, u32) -> ScardStatus;
pub type SCardCancelFn = unsafe extern "system" fn(ScardContext) -> ScardStatus;
pub type SCardReadCacheAFn =
    unsafe extern "system" fn(ScardContext, LpUuid, u32, LpStr, LpByte, LpDword) -> ScardStatus;
pub type SCardReadCacheWFn =
    unsafe extern "system" fn(ScardContext, LpUuid, u32, LpWStr, LpByte, LpDword) -> ScardStatus;
pub type SCardWriteCacheAFn = unsafe extern "system" fn(ScardContext, LpUuid, u32, LpStr, LpCByte, u32) -> ScardStatus;
pub type SCardWriteCacheWFn = unsafe extern "system" fn(ScardContext, LpUuid, u32, LpWStr, LpCByte, u32) -> ScardStatus;
pub type SCardGetReaderIconAFn = unsafe extern "system" fn(ScardContext, LpCStr, LpByte, LpDword) -> ScardStatus;
pub type SCardGetReaderIconWFn = unsafe extern "system" fn(ScardContext, LpCWStr, LpByte, LpDword) -> ScardStatus;
pub type SCardGetDeviceTypeIdAFn = unsafe extern "system" fn(ScardContext, LpCStr, LpDword) -> ScardStatus;
pub type SCardGetDeviceTypeIdWFn = unsafe extern "system" fn(ScardContext, LpCWStr, LpDword) -> ScardStatus;
pub type SCardGetReaderDeviceInstanceIdAFn =
    unsafe extern "system" fn(ScardContext, LpCStr, LpStr, LpDword) -> ScardStatus;
pub type SCardGetReaderDeviceInstanceIdWFn =
    unsafe extern "system" fn(ScardContext, LpCWStr, LpWStr, LpDword) -> ScardStatus;
pub type SCardListReadersWithDeviceInstanceIdAFn =
    unsafe extern "system" fn(ScardContext, LpCStr, LpStr, LpDword) -> ScardStatus;
pub type SCardListReadersWithDeviceInstanceIdWFn =
    unsafe extern "system" fn(ScardContext, LpCWStr, LpWStr, LpDword) -> ScardStatus;
pub type SCardAuditFn = unsafe extern "system" fn(ScardContext, u32) -> ScardStatus;
pub type SCardConnectAFn =
    unsafe extern "system" fn(ScardContext, LpCStr, u32, u32, LpScardHandle, LpDword) -> ScardStatus;
pub type SCardConnectWFn =
    unsafe extern "system" fn(ScardContext, LpCWStr, u32, u32, LpScardHandle, LpDword) -> ScardStatus;
pub type SCardReconnectFn = unsafe extern "system" fn(ScardHandle, u32, u32, u32, LpDword) -> ScardStatus;
pub type SCardDisconnectFn = unsafe extern "system" fn(ScardHandle, u32) -> ScardStatus;
pub type SCardBeginTransactionFn = unsafe extern "system" fn(ScardHandle) -> ScardStatus;
pub type SCardEndTransactionFn = unsafe extern "system" fn(ScardHandle, u32) -> ScardStatus;
pub type SCardCancelTransactionFn = unsafe extern "system" fn(ScardHandle) -> ScardStatus;
pub type SCardStateFn = unsafe extern "system" fn(ScardHandle, LpDword, LpDword, LpByte, LpDword) -> ScardStatus;
pub type SCardStatusAFn =
    unsafe extern "system" fn(ScardHandle, LpStr, LpDword, LpDword, LpDword, LpByte, LpDword) -> ScardStatus;
pub type SCardStatusWFn =
    unsafe extern "system" fn(ScardHandle, LpWStr, LpDword, LpDword, LpDword, LpByte, LpDword) -> ScardStatus;
pub type SCardTransmitFn = unsafe extern "system" fn(
    ScardHandle,
    LpCScardIoRequest,
    LpCByte,
    u32,
    LpScardIoRequest,
    LpByte,
    LpDword,
) -> ScardStatus;
pub type SCardGetTransmitCountFn = unsafe extern "system" fn(ScardHandle, LpDword) -> ScardStatus;
pub type SCardControlFn =
    unsafe extern "system" fn(ScardHandle, u32, LpCVoid, u32, LpVoid, u32, LpDword) -> ScardStatus;
pub type SCardGetAttribFn = unsafe extern "system" fn(ScardHandle, u32, LpByte, LpDword) -> ScardStatus;
pub type SCardSetAttribFn = unsafe extern "system" fn(ScardHandle, u32, LpCByte, u32) -> ScardStatus;
pub type SCardUIDlgSelectCardAFn = unsafe extern "system" fn(LpOpenCardNameExA) -> ScardStatus;
pub type SCardUIDlgSelectCardWFn = unsafe extern "system" fn(LpOpenCardNameExW) -> ScardStatus;
pub type GetOpenCardNameAFn = unsafe extern "system" fn(LpOpenCardNameA) -> ScardStatus;
pub type GetOpenCardNameWFn = unsafe extern "system" fn(LpOpenCardNameW) -> ScardStatus;
// Not a part of the standard winscard.h API
pub type GetSCardApiFunctionTableFn = unsafe extern "system" fn() -> PSCardApiFunctionTable;

// https://github.com/FreeRDP/FreeRDP/blob/88f79c5748f4031cb50dfae3ebadcc6619b69f1c/winpr/include/winpr/smartcard.h#L1114
#[derive(Debug)]
#[repr(C)]
#[allow(non_snake_case)]
pub struct SCardApiFunctionTable {
    pub dw_version: u32,
    pub dw_flags: u32,

    pub SCardEstablishContext: SCardEstablishContextFn,
    pub SCardReleaseContext: SCardReleaseContextFn,
    pub SCardIsValidContext: SCardIsValidContextFn,
    pub SCardListReaderGroupsA: SCardListReaderGroupsAFn,
    pub SCardListReaderGroupsW: SCardListReaderGroupsWFn,
    pub SCardListReadersA: SCardListReadersAFn,
    pub SCardListReadersW: SCardListReadersWFn,
    pub SCardListCardsA: SCardListCardsAFn,
    pub SCardListCardsW: SCardListCardsWFn,
    pub SCardListInterfacesA: SCardListInterfacesAFn,
    pub SCardListInterfacesW: SCardListInterfacesWFn,
    pub SCardGetProviderIdA: SCardGetProviderIdAFn,
    pub SCardGetProviderIdW: SCardGetProviderIdWFn,
    pub SCardGetCardTypeProviderNameA: SCardGetCardTypeProviderNameAFn,
    pub SCardGetCardTypeProviderNameW: SCardGetCardTypeProviderNameWFn,
    pub SCardIntroduceReaderGroupA: SCardIntroduceReaderGroupAFn,
    pub SCardIntroduceReaderGroupW: SCardIntroduceReaderGroupWFn,
    pub SCardForgetReaderGroupA: SCardForgetReaderGroupAFn,
    pub SCardForgetReaderGroupW: SCardForgetReaderGroupWFn,
    pub SCardIntroduceReaderA: SCardIntroduceReaderAFn,
    pub SCardIntroduceReaderW: SCardIntroduceReaderWFn,
    pub SCardForgetReaderA: SCardForgetReaderAFn,
    pub SCardForgetReaderW: SCardForgetReaderWFn,
    pub SCardAddReaderToGroupA: SCardAddReaderToGroupAFn,
    pub SCardAddReaderToGroupW: SCardAddReaderToGroupWFn,
    pub SCardRemoveReaderFromGroupA: SCardRemoveReaderFromGroupAFn,
    pub SCardRemoveReaderFromGroupW: SCardRemoveReaderFromGroupWFn,
    pub SCardIntroduceCardTypeA: SCardIntroduceCardTypeAFn,
    pub SCardIntroduceCardTypeW: SCardIntroduceCardTypeWFn,
    pub SCardSetCardTypeProviderNameA: SCardSetCardTypeProviderNameAFn,
    pub SCardSetCardTypeProviderNameW: SCardSetCardTypeProviderNameWFn,
    pub SCardFreeMemory: SCardFreeMemoryFn,
    pub SCardAccessStartedEvent: SCardAccessStartedEventFn,
    pub SCardReleaseStartedEvent: SCardReleaseStartedEventFn,
    pub SCardLocateCardsA: SCardLocateCardsAFn,
    pub SCardLocateCardsW: SCardLocateCardsWFn,
    pub SCardLocateCardsByATRA: SCardLocateCardsByATRAFn,
    pub SCardLocateCardsByATRW: SCardLocateCardsByATRWFn,
    pub SCardGetStatusChangeA: SCardGetStatusChangeAFn,
    pub SCardGetStatusChangeW: SCardGetStatusChangeWFn,
    pub SCardCancel: SCardCancelFn,
    pub SCardConnectA: SCardConnectAFn,
    pub SCardConnectW: SCardConnectWFn,
    pub SCardReconnect: SCardReconnectFn,
    pub SCardDisconnect: SCardDisconnectFn,
    pub SCardBeginTransaction: SCardBeginTransactionFn,
    pub SCardEndTransaction: SCardEndTransactionFn,
    pub SCardCancelTransaction: SCardCancelTransactionFn,
    pub SCardState: SCardStateFn,
    pub SCardStatusA: SCardStatusAFn,
    pub SCardStatusW: SCardStatusWFn,
    pub SCardTransmit: SCardTransmitFn,
    pub SCardGetTransmitCount: SCardGetTransmitCountFn,
    pub SCardControl: SCardControlFn,
    pub SCardGetAttrib: SCardGetAttribFn,
    pub SCardSetAttrib: SCardSetAttribFn,
    pub SCardUIDlgSelectCardA: SCardUIDlgSelectCardAFn,
    pub SCardUIDlgSelectCardW: SCardUIDlgSelectCardWFn,
    pub GetOpenCardNameA: GetOpenCardNameAFn,
    pub GetOpenCardNameW: GetOpenCardNameWFn,
    pub SCardReadCacheA: SCardReadCacheAFn,
    pub SCardReadCacheW: SCardReadCacheWFn,
    pub SCardWriteCacheA: SCardWriteCacheAFn,
    pub SCardWriteCacheW: SCardWriteCacheWFn,
    pub SCardGetReaderIconA: SCardGetReaderIconAFn,
    pub SCardGetReaderIconW: SCardGetReaderIconWFn,
    pub SCardGetDeviceTypeIdA: SCardGetDeviceTypeIdAFn,
    pub SCardGetDeviceTypeIdW: SCardGetDeviceTypeIdWFn,
    pub SCardGetReaderDeviceInstanceIdA: SCardGetReaderDeviceInstanceIdAFn,
    pub SCardGetReaderDeviceInstanceIdW: SCardGetReaderDeviceInstanceIdWFn,
    pub SCardListReadersWithDeviceInstanceIdA: SCardListReadersWithDeviceInstanceIdAFn,
    pub SCardListReadersWithDeviceInstanceIdW: SCardListReadersWithDeviceInstanceIdWFn,
    pub SCardAudit: SCardAuditFn,

    pub g_rgSCardT0Pci: &'static ScardIoRequest,
    pub g_rgSCardT1Pci: &'static ScardIoRequest,
    pub g_rgSCardRawPci: &'static ScardIoRequest,
}

pub type PSCardApiFunctionTable = *mut SCardApiFunctionTable;
