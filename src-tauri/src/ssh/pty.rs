use russh::{ChannelMsg, Sig};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::sync::{mpsc, Mutex};
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "reason", rename_all = "snake_case")]
pub enum PtyEnd {
    /// An orderly channel close can omit the optional SSH exit-status.
    Exited {
        exit_code: Option<u32>,
    },
    Signalled {
        signal: String,
    },
    TransportLost,
}

/// EOF ends the output direction. The process status may arrive on either
/// side of EOF, and final output can still follow an early exit-status.
#[derive(Default)]
pub(super) struct PtyExitTracker {
    eof: bool,
    status: Option<PtyEnd>,
}

impl PtyExitTracker {
    pub(super) fn observe(&mut self, message: Option<ChannelMsg>) -> Option<PtyEnd> {
        match message {
            Some(ChannelMsg::ExitStatus { exit_status }) => {
                self.status = Some(PtyEnd::Exited {
                    exit_code: Some(exit_status),
                });
            }
            Some(ChannelMsg::ExitSignal { signal_name, .. }) => {
                let signal = match signal_name {
                    Sig::Custom(name) => name,
                    known => format!("{known:?}"),
                };
                self.status = Some(PtyEnd::Signalled { signal });
            }
            Some(ChannelMsg::Eof) => self.eof = true,
            Some(ChannelMsg::Close) => {
                return Some(
                    self.status
                        .take()
                        .unwrap_or(PtyEnd::Exited { exit_code: None }),
                );
            }
            None => return Some(self.status.take().unwrap_or(PtyEnd::TransportLost)),
            _ => return None,
        }
        if self.eof {
            self.status.take()
        } else {
            None
        }
    }
}

#[derive(Debug)]
pub struct PtySession {
    pub input_tx: mpsc::Sender<Vec<u8>>,
    pub output_rx: Arc<Mutex<mpsc::Receiver<Vec<u8>>>>,
    pub resize_tx: mpsc::Sender<(u32, u32)>,
    pub cancel: CancellationToken,
    /// Published before the SSH worker drops its output sender. Retaining the
    /// outcome lets a reattached reader deliver an exit that raced a WS drop.
    pub end: Arc<OnceLock<PtyEnd>>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum PtyRead {
    Data(Vec<u8>),
    Flush,
    Ended(PtyEnd),
}

impl PtySession {
    pub async fn read_output(&self, max_wait: Option<Duration>) -> PtyRead {
        let mut output = self.output_rx.lock().await;
        let chunk = match max_wait {
            None => output.recv().await,
            Some(delay) => match tokio::time::timeout(delay, output.recv()).await {
                Ok(chunk) => chunk,
                Err(_) => return PtyRead::Flush,
            },
        };
        match chunk {
            Some(data) => PtyRead::Data(data),
            None => PtyRead::Ended(self.end.get_or_init(|| PtyEnd::TransportLost).clone()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eof_and_exit_status_can_arrive_in_either_order() {
        for code in [0, 23] {
            for eof_first in [true, false] {
                let status = ChannelMsg::ExitStatus { exit_status: code };
                let (first, last) = if eof_first {
                    (ChannelMsg::Eof, status)
                } else {
                    (status, ChannelMsg::Eof)
                };
                let mut tracker = PtyExitTracker::default();
                assert_eq!(tracker.observe(Some(first)), None);
                assert_eq!(
                    tracker.observe(Some(last)),
                    Some(PtyEnd::Exited {
                        exit_code: Some(code)
                    })
                );
            }
        }
    }

    #[test]
    fn orderly_closes_and_signals_are_distinct_from_transport_loss() {
        let mut tracker = PtyExitTracker::default();
        assert_eq!(
            tracker.observe(Some(ChannelMsg::Close)),
            Some(PtyEnd::Exited { exit_code: None })
        );
        assert_eq!(tracker.observe(None), Some(PtyEnd::TransportLost));
        assert_eq!(tracker.observe(Some(ChannelMsg::Eof)), None);
        assert_eq!(tracker.observe(None), Some(PtyEnd::TransportLost));

        let mut tracker = PtyExitTracker::default();
        assert_eq!(
            tracker.observe(Some(ChannelMsg::ExitSignal {
                signal_name: Sig::TERM,
                core_dumped: false,
                error_message: String::new(),
                lang_tag: String::new(),
            })),
            None
        );
        assert_eq!(
            tracker.observe(Some(ChannelMsg::Close)),
            Some(PtyEnd::Signalled {
                signal: "TERM".into()
            })
        );
    }
}
