//! A run is created only by a main-window IPC command. The terminal bridge may
//! attach to a run, but cannot create a process or choose its executable.
use crate::local_pty::{LocalPty, LocalPtyEvent};
use anyhow::{anyhow, bail, Result};
use rand::Rng;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, Mutex as AsyncMutex, RwLock, Semaphore};
use tokio_util::sync::CancellationToken;

// Keep the shell through a transient transport drop. This also bounds the
// lifetime of a start whose caller disappeared before taking its first lease.
const ATTACH_GRACE: Duration = Duration::from_secs(5 * 60);

pub(crate) struct LocalEvents {
    pub(crate) receiver: mpsc::Receiver<LocalPtyEvent>,
    // Keep an output chunk here while waiting for a credit/WS queue slot.
    // Superseding an attachment must leave that chunk for its next reader.
    pub(crate) pending: Option<LocalPtyEvent>,
}

struct Run {
    pty: Arc<LocalPty>,
    events: Arc<AsyncMutex<LocalEvents>>,
    generation: u64,
    cancel: CancellationToken,
}

pub(crate) struct LocalAttachment {
    pub(crate) input_credit: Arc<Semaphore>,
    pub(crate) pty: Arc<LocalPty>,
    pub(crate) events: Arc<AsyncMutex<LocalEvents>>,
    pub(crate) generation: u64,
    pub(crate) cancel: CancellationToken,
}

#[derive(Default)]
pub(crate) struct LocalShells {
    runs: Mutex<HashMap<String, Run>>,
    // On exit, wait for in-flight spawns and closes before draining the registry.
    shutting_down: RwLock<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalShellStarted {
    pub(crate) run_id: String,
    shell_name: String,
}

impl LocalShells {
    pub(crate) async fn start(
        self: &Arc<Self>,
        cols: u16,
        rows: u16,
        shell_path: Option<String>,
    ) -> Result<LocalShellStarted> {
        let stopping = self.shutting_down.read().await;
        if *stopping {
            bail!("Application is quitting");
        }
        let (pty, receiver) = LocalPty::spawn(cols, rows, shell_path).await?;
        let shell_name = pty.shell_name().to_owned();
        let mut nonce = [0; 16];
        rand::rng().fill_bytes(&mut nonce);
        let run_id = format!("local-{:032x}", u128::from_le_bytes(nonce));
        let cancel = CancellationToken::new();
        self.runs.lock().unwrap().insert(
            run_id.clone(),
            Run {
                pty: Arc::new(pty),
                events: Arc::new(AsyncMutex::new(LocalEvents {
                    receiver,
                    pending: None,
                })),
                generation: 0,
                cancel: cancel.clone(),
            },
        );
        self.expire_when_idle(run_id.clone(), 0, cancel);
        Ok(LocalShellStarted { run_id, shell_name })
    }

    pub(crate) fn attach(&self, id: &str) -> Result<LocalAttachment> {
        let mut runs = self.runs.lock().unwrap();
        let run = runs
            .get_mut(id)
            .ok_or_else(|| anyhow!("Local shell is no longer available"))?;
        run.cancel.cancel();
        run.cancel = CancellationToken::new();
        run.generation += 1;
        Ok(LocalAttachment {
            input_credit: Arc::new(Semaphore::new(1)),
            pty: run.pty.clone(),
            events: run.events.clone(),
            generation: run.generation,
            cancel: run.cancel.clone(),
        })
    }

    pub(crate) fn release_attachment(self: &Arc<Self>, id: String, generation: u64) {
        let cancel = {
            let mut runs = self.runs.lock().unwrap();
            let Some(run) = runs.get_mut(&id) else { return };
            if run.generation != generation {
                return;
            }
            run.cancel.cancel();
            run.cancel = CancellationToken::new();
            run.cancel.clone()
        };
        self.expire_when_idle(id, generation, cancel);
    }

    fn expire_when_idle(self: &Arc<Self>, id: String, generation: u64, cancel: CancellationToken) {
        let manager = Arc::downgrade(self);
        tokio::spawn(async move {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => return,
                _ = tokio::time::sleep(ATTACH_GRACE) => {}
            }
            if let Some(manager) = manager.upgrade() {
                manager.close(&id, Some(generation)).await;
            }
        });
    }

    async fn close(&self, id: &str, generation: Option<u64>) {
        let _guard = self.shutting_down.read().await;
        let run = {
            let mut runs = self.runs.lock().unwrap();
            if let Some(expected) = generation {
                if runs.get(id).map(|r| r.generation) != Some(expected) {
                    return;
                }
            }
            runs.remove(id)
        };
        if let Some(run) = run {
            run.cancel.cancel();
            run.pty.close().await;
        }
    }

    pub(crate) fn active_count(&self) -> usize {
        self.runs
            .lock()
            .unwrap()
            .values()
            .filter(|run| run.pty.is_running())
            .count()
    }

    pub(crate) async fn shutdown(&self) {
        let mut stopping = self.shutting_down.write().await;
        *stopping = true;
        let runs = std::mem::take(&mut *self.runs.lock().unwrap());
        futures::future::join_all(runs.into_values().map(|run| async move {
            run.cancel.cancel();
            run.pty.close().await;
        }))
        .await;
    }
}

#[tauri::command]
pub(crate) async fn local_shell_start(
    state: tauri::State<'_, Arc<LocalShells>>,
    cols: u16,
    rows: u16,
    shell_path: Option<String>,
) -> Result<LocalShellStarted, String> {
    if cols == 0 || rows == 0 {
        return Err("Invalid terminal dimensions".into());
    }
    state
        .inner()
        .start(cols, rows, shell_path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn local_shell_close(
    state: tauri::State<'_, Arc<LocalShells>>,
    run_id: String,
) -> Result<(), String> {
    state.close(&run_id, None).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stale_socket_teardown_cannot_expire_a_reattached_shell() {
        let shells = Arc::new(LocalShells::default());
        #[cfg(unix)]
        let shell = Some("/bin/sh".into());
        #[cfg(windows)]
        let shell = None;
        let started = shells.start(80, 24, shell).await.unwrap();
        let first = shells.attach(&started.run_id).unwrap();
        let second = shells.attach(&started.run_id).unwrap();
        assert!(first.cancel.is_cancelled());
        shells.release_attachment(started.run_id.clone(), first.generation);
        shells.close(&started.run_id, Some(first.generation)).await;
        assert!(!second.cancel.is_cancelled());
        assert_eq!(shells.active_count(), 1);

        shells.shutdown().await;
        assert!(second.cancel.is_cancelled());
        assert!(!second.pty.is_running());
        assert_eq!(shells.active_count(), 0);
        assert!(shells.attach(&started.run_id).is_err());
        assert!(shells.start(80, 24, None).await.is_err());
        shells.close(&started.run_id, None).await;
    }
}
