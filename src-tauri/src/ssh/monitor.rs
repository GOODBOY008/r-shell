//! Bounded, cancellable probes with separate stdout/stderr. Never borrow the
//! connection's read lock for the duration of a remote command.
use super::SshClient;
use russh::ChannelMsg;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{RwLock, Semaphore};
use tokio_util::sync::CancellationToken;

const OUTPUT_LIMIT: usize = 256 * 1024;
type JobKey = (String, String);
#[derive(Default)]
struct Registry {
    active: HashMap<JobKey, CancellationToken>,
    limits: HashMap<String, Arc<Semaphore>>,
    early_cancels: HashMap<JobKey, Instant>,
}
#[derive(Default)]
pub(crate) struct MonitorJobs(Mutex<Registry>);
pub(crate) struct MonitorJob {
    owner: Arc<MonitorJobs>,
    key: JobKey,
    pub cancel: CancellationToken,
    limit: Arc<Semaphore>,
}
impl Drop for MonitorJob {
    fn drop(&mut self) {
        self.owner.0.lock().unwrap().active.remove(&self.key);
    }
}
impl MonitorJobs {
    /// Aliases share channel admission while cancellation remains owner-scoped.
    pub fn share_connection(&self, alias: &str, existing: &str) {
        let mut state = self.0.lock().unwrap();
        let limit = state
            .limits
            .entry(existing.to_owned())
            .or_insert_with(|| Arc::new(Semaphore::new(2)))
            .clone();
        state.limits.insert(alias.to_owned(), limit);
    }
    pub fn begin(self: &Arc<Self>, connection: &str, run: &str) -> Result<MonitorJob, String> {
        let mut state = self.0.lock().unwrap();
        state
            .early_cancels
            .retain(|_, at| at.elapsed() < Duration::from_secs(60));
        let key = (connection.to_owned(), run.to_owned());
        if state.active.contains_key(&key) {
            return Err("Monitor run already exists".into());
        }
        let cancel = CancellationToken::new();
        if state.early_cancels.remove(&key).is_some() {
            cancel.cancel();
        }
        let limit = state
            .limits
            .entry(connection.to_owned())
            .or_insert_with(|| Arc::new(Semaphore::new(2)))
            .clone();
        state.active.insert(key.clone(), cancel.clone());
        Ok(MonitorJob {
            owner: self.clone(),
            key,
            cancel,
            limit,
        })
    }
    pub fn cancel(&self, connection: &str, run: &str) {
        let mut state = self.0.lock().unwrap();
        let key = (connection.to_owned(), run.to_owned());
        if let Some(cancel) = state.active.get(&key) {
            cancel.cancel();
        } else {
            // Cancellation can reach IPC before the corresponding run starts.
            state
                .early_cancels
                .retain(|_, at| at.elapsed() < Duration::from_secs(60));
            if state.early_cancels.len() >= 1024 {
                if let Some(oldest) = state
                    .early_cancels
                    .iter()
                    .min_by_key(|(_, at)| **at)
                    .map(|(key, _)| key.clone())
                {
                    state.early_cancels.remove(&oldest);
                }
            }
            state.early_cancels.insert(key, Instant::now());
        }
    }
    pub fn cancel_connection(&self, connection: &str) {
        let mut state = self.0.lock().unwrap();
        for ((id, _), token) in &state.active {
            if id == connection {
                token.cancel();
            }
        }
        state.limits.remove(connection);
    }
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MonitorStatus {
    Success,
    ExitError,
    Timeout,
    Cancelled,
    OutputLimit,
    TransportError,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<u32>,
    pub duration_ms: u64,
    pub status: MonitorStatus,
    pub error: Option<String>,
}

pub(crate) async fn execute(
    client: Arc<RwLock<SshClient>>,
    job: MonitorJob,
    command: &str,
    timeout_ms: u64,
) -> MonitorResult {
    let started = Instant::now();
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut exit_code = None;
    let mut channel = None;
    // Keep the permit through channel cleanup, including timeout/cancellation.
    let mut permit = None;
    let exchange = async {
        permit = Some(job.limit.acquire().await.map_err(|e| e.to_string())?);
        let session = client.read().await.session.clone().ok_or("Not connected")?;
        channel = Some(
            session
                .channel_open_session()
                .await
                .map_err(|e| e.to_string())?,
        );
        let channel = channel.as_mut().unwrap();
        channel
            .exec(true, command)
            .await
            .map_err(|e| e.to_string())?;
        channel.eof().await.map_err(|e| e.to_string())?;
        let mut eof = false;
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => {
                    if stdout.len() + stderr.len() + data.len() > OUTPUT_LIMIT {
                        return Ok(MonitorStatus::OutputLimit);
                    }
                    stdout.extend_from_slice(&data);
                }
                ChannelMsg::ExtendedData { data, .. } => {
                    if stdout.len() + stderr.len() + data.len() > OUTPUT_LIMIT {
                        return Ok(MonitorStatus::OutputLimit);
                    }
                    stderr.extend_from_slice(&data);
                }
                ChannelMsg::ExitStatus { exit_status } => {
                    exit_code = Some(exit_status);
                    if eof {
                        break;
                    }
                }
                ChannelMsg::Eof => {
                    eof = true;
                    if exit_code.is_some() {
                        break;
                    }
                }
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        match exit_code {
            Some(0) => Ok(MonitorStatus::Success),
            Some(_) => Ok(MonitorStatus::ExitError),
            None => Err("SSH channel closed without an exit status".to_owned()),
        }
    };
    let outcome: Result<MonitorStatus, String> = tokio::select! {
        biased;
        _ = job.cancel.cancelled() => Ok(MonitorStatus::Cancelled),
        result = tokio::time::timeout(Duration::from_millis(timeout_ms), exchange) => {
            match result { Ok(result) => result, Err(_) => Ok(MonitorStatus::Timeout) }
        }
    };
    if let Some(channel) = channel {
        // A stalled transport must not stall teardown or disconnect either.
        let _ = tokio::time::timeout(Duration::from_millis(250), channel.close()).await;
    }
    let (status, error) = match outcome {
        Ok(status) => (status, None),
        Err(error) => (MonitorStatus::TransportError, Some(error)),
    };
    MonitorResult {
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        exit_code,
        duration_ms: started.elapsed().as_millis() as u64,
        status,
        error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection_manager::ConnectionManager;
    use crate::ssh::{AuthMethod, HostKeyPolicy, SshConfig};
    #[tokio::test]
    async fn monitor_jobs_bound_concurrency_and_cancel_queued_work() {
        let jobs = Arc::new(MonitorJobs::default());
        let first = jobs.begin("host", "1").unwrap();
        let second = jobs.begin("host", "2").unwrap();
        let third = jobs.begin("host", "3").unwrap();
        let _one = first.limit.acquire().await.unwrap();
        let _two = second.limit.acquire().await.unwrap();
        assert!(third.limit.try_acquire().is_err());
        assert!(jobs.begin("host", "1").is_err());
        jobs.cancel_connection("host");
        assert!(
            first.cancel.is_cancelled()
                && second.cancel.is_cancelled()
                && third.cancel.is_cancelled()
        );
        let result = execute(
            Arc::new(RwLock::new(SshClient::new())),
            third,
            "echo unused",
            1000,
        )
        .await;
        assert_eq!(result.status, MonitorStatus::Cancelled);
    }
    #[tokio::test]
    async fn reused_transports_share_limits_but_not_cancellation() {
        let jobs = Arc::new(MonitorJobs::default());
        jobs.share_connection("dashboard", "terminal");
        let first = jobs.begin("terminal", "1").unwrap();
        let second = jobs.begin("dashboard", "2").unwrap();
        let third = jobs.begin("dashboard", "3").unwrap();
        let one = first.limit.acquire().await.unwrap();
        let _two = second.limit.acquire().await.unwrap();
        assert!(third.limit.try_acquire().is_err());
        jobs.cancel_connection("terminal");
        assert!(first.cancel.is_cancelled());
        assert!(!second.cancel.is_cancelled());
        drop(one);
        let _three = third.limit.try_acquire().unwrap();
        jobs.share_connection("trial", "dashboard");
        let trial = jobs.begin("trial", "4").unwrap();
        assert!(trial.limit.try_acquire().is_err());
        jobs.cancel_connection("dashboard");
        jobs.cancel_connection("trial");
        assert!(jobs.0.lock().unwrap().limits.is_empty());
    }
    #[tokio::test]
    async fn monitor_cancel_before_registration_never_executes() {
        let jobs = Arc::new(MonitorJobs::default());
        jobs.cancel("host", "early");
        let job = jobs.begin("host", "early").unwrap();
        let result = execute(
            Arc::new(RwLock::new(SshClient::new())),
            job,
            "echo unused",
            1000,
        )
        .await;
        assert_eq!(result.status, MonitorStatus::Cancelled);
        assert!(jobs.0.lock().unwrap().active.is_empty());
    }

    #[tokio::test]
    #[ignore = "requires the local password-sshd Docker fixture"]
    async fn docker_monitor_output_limits_cancellation_and_disconnect() {
        let manager = Arc::new(ConnectionManager::new());
        let config = SshConfig {
            host: std::env::var("RSHELL_TEST_SSH_HOST").unwrap_or_else(|_| "127.0.0.1".into()),
            port: std::env::var("RSHELL_TEST_SSH_PORT")
                .unwrap_or_else(|_| "2225".into())
                .parse()
                .unwrap(),
            username: "testuser".into(),
            auth_method: AuthMethod::Password {
                password: "testpass".into(),
            },
            compression: false,
            keepalive_interval: None,
            keepalive_max: None,
            proxy: None,
            // An ephemeral local fixture must not write the user's known_hosts.
            host_key_policy: HostKeyPolicy::Off,
            connect_timeout: 5,
            tunnel: None,
            x11: None,
        };
        manager
            .create_connection("monitor-test".into(), config)
            .await
            .unwrap();
        for (index, output) in [
            "中文🙂",
            "42",
            "{\"cpu\":12.5,\"memory\":0}",
            "[{\"service\":\"nginx\",\"count\":3}]",
        ]
        .iter()
        .enumerate()
        {
            let (client, job) = manager
                .start_monitor_job("monitor-test", &format!("format-{index}"))
                .await
                .unwrap();
            let result = execute(client, job, &format!("printf '%s' '{output}'"), 1000).await;
            assert_eq!(result.status, MonitorStatus::Success, "{result:?}");
            assert_eq!(result.stdout, *output);
            assert_eq!(result.exit_code, Some(0));
        }
        for (run, command, expected) in [
            (
                "failure",
                "printf warning >&2; printf partial; exit 7",
                MonitorStatus::ExitError,
            ),
            (
                "limit",
                "head -c 262145 /dev/zero",
                MonitorStatus::OutputLimit,
            ),
            ("timeout", "sleep 5", MonitorStatus::Timeout),
        ] {
            let (client, job) = manager
                .start_monitor_job("monitor-test", run)
                .await
                .unwrap();
            let result = execute(client, job, command, 1000).await;
            assert_eq!(result.status, expected, "{result:?}");
            assert!(result.stdout.len() + result.stderr.len() <= OUTPUT_LIMIT);
            if run == "failure" {
                assert_eq!(result.stderr, "warning");
                assert_eq!(result.stdout, "partial");
                assert_eq!(result.exit_code, Some(7));
            }
            if run == "timeout" {
                assert!(result.duration_ms < 2000);
            }
        }
        let (client, job) = manager
            .start_monitor_job("monitor-test", "cancel")
            .await
            .unwrap();
        let running = tokio::spawn(execute(client, job, "sleep 10", 60000));
        tokio::time::sleep(Duration::from_millis(100)).await;
        manager.monitor_jobs.cancel("monitor-test", "cancel");
        assert_eq!(running.await.unwrap().status, MonitorStatus::Cancelled);
        // Failed/cancelled probes leave the original SSH session usable.
        let (client, job) = manager
            .start_monitor_job("monitor-test", "recovery")
            .await
            .unwrap();
        assert_eq!(
            execute(client, job, "printf recovered", 1000).await.stdout,
            "recovered"
        );
        let (client, job) = manager
            .start_monitor_job("monitor-test", "disconnect")
            .await
            .unwrap();
        let running = tokio::spawn(execute(client, job, "sleep 10", 60000));
        tokio::time::sleep(Duration::from_millis(100)).await;
        tokio::time::timeout(
            Duration::from_secs(2),
            manager.close_connection("monitor-test"),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(running.await.unwrap().status, MonitorStatus::Cancelled);
        assert!(manager.monitor_jobs.0.lock().unwrap().active.is_empty());
    }
}
