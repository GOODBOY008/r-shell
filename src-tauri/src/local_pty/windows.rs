use super::{next_input, send_event, Input, LocalPtyEvent, OUTPUT_CHUNK};
use anyhow::Result;
use portable_pty::MasterPty;
use std::io::{self, Read, Write};
use tokio::{
    runtime::Handle,
    sync::mpsc,
    task::{self, JoinHandle},
};
use tokio_util::sync::CancellationToken;

pub(super) struct PtyIo {
    reader: Box<dyn Read + Send>,
    writer: Box<dyn Write + Send>,
}

impl PtyIo {
    pub(super) fn open(master: &dyn MasterPty) -> Result<Self> {
        Ok(Self {
            reader: master.try_clone_reader()?,
            writer: master.take_writer()?,
        })
    }

    pub(super) fn run(
        mut self,
        mut inputs: mpsc::Receiver<Input>,
        events: mpsc::Sender<LocalPtyEvent>,
        closing: CancellationToken,
        exited: CancellationToken,
    ) -> (JoinHandle<Result<()>>, JoinHandle<()>) {
        let stop_writing = closing.clone();
        let writer = task::spawn_blocking(move || {
            let runtime = Handle::current();
            while let Some((bytes, ack)) =
                runtime.block_on(next_input(&mut inputs, &stop_writing, &exited))
            {
                let result = self.writer.write_all(&bytes);
                let failed = result.is_err();
                let _ = ack.send(result.map_err(Into::into));
                if failed {
                    break;
                }
            }
        });
        let reader = task::spawn_blocking(move || {
            let runtime = Handle::current();
            let mut buffer = vec![0; OUTPUT_CHUNK];
            loop {
                match self.reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(length) => {
                        // ClosePseudoConsole may block until its last frame is read.
                        // Keep draining even after the caller drops the transport.
                        if !closing.is_cancelled() {
                            runtime.block_on(send_event(
                                &events,
                                LocalPtyEvent::Output(buffer[..length].to_vec()),
                                &closing,
                            ));
                        }
                    }
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(error) if error.kind() == io::ErrorKind::BrokenPipe => break,
                    Err(error) => return Err(error.into()),
                }
            }
            Ok(())
        });
        (reader, writer)
    }
}
