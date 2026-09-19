use std::io::{Error, ErrorKind};
use std::time::Duration;

use dpapi_transport::{ConnectOptions, Stream, Transport};
use futures_util::{AsyncRead, AsyncWrite};
use gloo_net::websocket;
use gloo_net::websocket::futures::WebSocket;
use url::Url;
use uuid::Uuid;

pub(crate) trait AsyncReadWrite: AsyncRead + AsyncWrite + Unpin {}

impl<T> AsyncReadWrite for T where T: AsyncRead + AsyncWrite + Unpin + 'static {}

type ErasedReadWrite = Box<dyn AsyncReadWrite>;

pub(crate) struct FuturesStream<S> {
    stream: S,
}

impl<S> FuturesStream<S> {
    fn new(stream: S) -> Self {
        Self { stream }
    }
}

impl<S> Stream for FuturesStream<S>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    async fn read_vec(&mut self, length: usize) -> Result<Vec<u8>, Error> {
        let mut buf = vec![0; length];
        self.read_exact(&mut buf).await?;
        Ok(buf)
    }

    async fn read_exact(&mut self, mut buf: &mut [u8]) -> Result<(), Error> {
        use futures_util::AsyncReadExt as _;

        while !buf.is_empty() {
            let bytes_read = Box::pin(async { self.stream.read(buf).await }).await?;
            buf = &mut buf[bytes_read..];

            if bytes_read == 0 {
                return Err(ErrorKind::UnexpectedEof.into());
            }
        }

        Ok(())
    }

    async fn write_all(&mut self, buf: &[u8]) -> Result<(), Error> {
        use futures_util::AsyncWriteExt as _;

        Box::pin(async {
            self.stream.write_all(buf).await?;
            self.stream.flush().await?;

            Ok(())
        })
        .await
    }
}

/// WASM transport.
///
/// It uses the WEB API under the hood to open the WS connection.
pub(crate) struct WasmTransport;

impl WasmTransport {
    /// Connects to the RPC server via the Devolutions Gateway tunneled connection.
    async fn ws_connect(
        mut proxy: Url,
        session_id: Uuid,
        session_token: &str,
    ) -> Result<FuturesStream<ErasedReadWrite>, Error> {
        proxy.path_segments_mut().unwrap().extend([session_id.to_string()]);
        proxy.query_pairs_mut().append_pair("token", session_token);

        let ws = WebSocket::open(proxy.as_str()).map_err(Error::other)?;

        // NOTE: ideally, when the WebSocket can’t be opened, the above call should fail with details on why is that
        // (e.g., the proxy hostname could not be resolved, proxy service is not running), but errors are never
        // bubbled up in practice, so instead we poll the WebSocket state until we know its connected (i.e., the
        // WebSocket handshake is a success and user data can be exchanged).
        loop {
            match ws.state() {
                websocket::State::Closing | websocket::State::Closed => {
                    return Err(Error::new(
                        ErrorKind::BrokenPipe,
                        format!("failed to open a WS connection: {:?}", ws.state()),
                    ));
                }
                websocket::State::Connecting => {
                    trace!("WebSocket is connecting to proxy at {proxy}...");
                    gloo_timers::future::sleep(Duration::from_millis(50)).await;
                }
                websocket::State::Open => {
                    debug!("WebSocket connected to {proxy} with success");
                    break;
                }
            }
        }

        Ok(FuturesStream::new(Box::new(ws) as ErasedReadWrite))
    }
}

impl Transport for WasmTransport {
    type Stream = FuturesStream<ErasedReadWrite>;

    #[instrument(err, skip_all)]
    async fn connect(connection_options: &ConnectOptions) -> Result<Self::Stream, Error> {
        match connection_options {
            ConnectOptions::Tcp(_) => Err(Error::new(
                ErrorKind::Unsupported,
                "tcp transport is not supported for wasm32 target",
            )),
            ConnectOptions::WsTunnel {
                proxy,
                destination,
                get_session_token,
            } => {
                let session_id = Uuid::new_v4();
                debug!("session token");
                let session_token = get_session_token(session_id, destination.clone()).await?;

                Self::ws_connect(proxy.clone(), session_id, session_token.as_ref()).await
            }
        }
    }
}
