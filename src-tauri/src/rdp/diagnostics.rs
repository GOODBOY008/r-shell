//! Public session diagnostics contain only status codes, never logon identities
//! or auto-reconnect cookies from Save Session Info.
use ironrdp_session::ActiveStageOutput;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionInfo {
    pub logon_complete: bool,
    pub session_id: Option<u32>,
    pub notification: Option<LogonNotification>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogonNotification {
    pub code: u32,
    pub data: u32,
}

impl SessionInfo {
    /// Observe only the explicit logon outputs. A TCP connection, activation,
    /// framebuffer, or an extended-info notification does not prove a logon.
    pub(super) fn observe(&mut self, output: &ActiveStageOutput) -> bool {
        match output {
            ActiveStageOutput::SessionId(id) => {
                if self.session_id == Some(*id) {
                    return false;
                }
                self.session_id = Some(*id);
            }
            ActiveStageOutput::SaveSessionInfo {
                logon_complete: true,
            } => {
                if self.logon_complete && self.notification.is_none() {
                    return false;
                }
                self.logon_complete = true;
                self.notification = None;
            }
            ActiveStageOutput::LogonErrors(error) => {
                let notification = LogonNotification {
                    code: error.error_type.as_u32(),
                    data: error.error_data.to_u32(),
                };
                if self.notification.as_ref() == Some(&notification) {
                    return false;
                }
                // LOGON_MSG_* may describe another session offered by the
                // logon UI. Its data must not replace our confirmed session ID.
                self.notification = Some(notification);
            }
            _ => return false,
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ironrdp_pdu::rdp::session_info::{
        LogonErrorNotificationData, LogonErrorNotificationType, LogonErrorsInfo,
    };

    #[test]
    fn only_a_completed_logon_clears_an_error() {
        let mut info = SessionInfo::default();
        let error = ActiveStageOutput::LogonErrors(LogonErrorsInfo {
            error_type: LogonErrorNotificationType::NtStatus(0xc000_006d),
            error_data: LogonErrorNotificationData::SessionId(42),
        });
        assert!(info.observe(&error));
        assert!(
            !info.observe(&error),
            "duplicate notifications should coalesce"
        );
        assert!(!info.observe(&ActiveStageOutput::SaveSessionInfo {
            logon_complete: false
        }));
        assert!(!info.logon_complete);
        assert!(info.notification.is_some());
        assert!(info.observe(&ActiveStageOutput::SessionId(7)));
        assert!(info.observe(&ActiveStageOutput::SaveSessionInfo {
            logon_complete: true
        }));
        assert!(info.logon_complete);
        assert_eq!(info.session_id, Some(7));
        assert!(info.notification.is_none());
    }

    #[test]
    fn logon_dialog_session_ids_do_not_become_our_session_id() {
        let mut info = SessionInfo {
            session_id: Some(12),
            ..Default::default()
        };
        info.observe(&ActiveStageOutput::LogonErrors(LogonErrorsInfo {
            error_type: LogonErrorNotificationType::SessionBusyOptions,
            error_data: LogonErrorNotificationData::SessionId(1),
        }));
        assert_eq!(info.session_id, Some(12));
        assert_eq!(
            info.notification,
            Some(LogonNotification {
                code: 0xffff_fff8,
                data: 1
            })
        );
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json.as_object().unwrap().len(), 3);
        assert!(!info.logon_complete);
    }
}
