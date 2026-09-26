#[macro_use]
extern crate tracing;

use std::io::{Error, ErrorKind};
use std::net::SocketAddr;

use dpapi_transport::{ConnectOptions, DEFAULT_RPC_PORT, Stream, Transport};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite;
use tokio_tungstenite::tungstenite::Bytes;
use url::Url;
use uuid::Uuid;

pub trait AsyncReadWrite: AsyncRead + AsyncWrite + Unpin {}

impl<T> AsyncReadWrite for T where T: AsyncRead + AsyncWrite + Unpin + 'static {}

pub type ErasedReadWrite = Box<dyn AsyncReadWrite>;

pub struct TokioStream<S> {
    stream: S,
}

impl<S> TokioStream<S> {
    pub fn new(stream: S) -> Self {
        Self { stream }
    }
}

impl<S> Stream for TokioStream<S>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    async fn read_vec(&mut self, length: usize) -> Result<Vec<u8>, Error> {
        let mut buf = vec![0; length];
        self.read_exact(&mut buf).await?;

        Ok(buf)
    }

    async fn read_exact(&mut self, mut buf: &mut [u8]) -> Result<(), Error> {
        use tokio::io::AsyncReadExt as _;

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
        use tokio::io::AsyncWriteExt as _;

        Box::pin(async {
            self.stream.write_all(buf).await?;
            self.stream.flush().await?;

            Ok(())
        })
        .await
    }
}

pub struct NativeTransport;

impl NativeTransport {
    /// Connects to the RPC server via the Devolutions Gateway tunneled connection.
    #[instrument(err)]
    async fn ws_connect(
        mut proxy: Url,
        session_id: Uuid,
        session_token: &str,
    ) -> Result<TokioStream<ErasedReadWrite>, Error> {
        proxy.path_segments_mut().unwrap().extend([session_id.to_string()]);
        proxy.query_pairs_mut().append_pair("token", session_token);

        let (ws, _) = tokio_tungstenite::connect_async(proxy.as_str()).await.map_err(|err| {
            error!(?err, "Failed to establish WS connection.");
            Error::other(err)
        })?;

        {
            use futures_util::{SinkExt as _, StreamExt as _, future};

            let ws_compat = ws
                .filter_map(|item| {
                    future::ready(
                        item.map(|msg| match msg {
                            tungstenite::Message::Text(data) => {
                                Some(transport::WsReadMsg::Payload(data.as_bytes().to_vec()))
                            }
                            tungstenite::Message::Binary(data) => Some(transport::WsReadMsg::Payload(data.to_vec())),
                            tungstenite::Message::Ping(_) | tungstenite::Message::Pong(_) => None,
                            tungstenite::Message::Close(_) => Some(transport::WsReadMsg::Close),
                            tungstenite::Message::Frame(_) => {
                                unreachable!("raw frames are never returned when reading")
                            }
                        })
                        .transpose(),
                    )
                })
                .with(|item: Vec<u8>| {
                    future::ready(Ok::<_, tungstenite::Error>(tungstenite::Message::Binary(Bytes::from(
                        item,
                    ))))
                });

            Ok(TokioStream::new(
                Box::new(transport::WsStream::new(ws_compat)) as ErasedReadWrite
            ))
        }
    }
}

fn url_to_socket_addr(url: &Url) -> Result<SocketAddr, Error> {
    url.socket_addrs(|| Some(DEFAULT_RPC_PORT))?
        .first()
        .ok_or_else(|| {
            Error::new(
                ErrorKind::InvalidInput,
                "cannot convert destination URL to socket address",
            )
        })
        .copied()
}

impl Transport for NativeTransport {
    type Stream = TokioStream<ErasedReadWrite>;

    #[instrument(skip(connection_options), err)]
    async fn connect(connection_options: &ConnectOptions) -> Result<Self::Stream, Error> {
        match connection_options {
            ConnectOptions::Tcp(addr) => {
                let stream =
                    TokioStream::new(Box::new(TcpStream::connect(url_to_socket_addr(addr)?).await?) as ErasedReadWrite);
                Ok(stream)
            }
            ConnectOptions::WsTunnel {
                proxy,
                destination,
                get_session_token,
            } => {
                let session_id = Uuid::new_v4();
                let session_token = get_session_token(session_id, destination.clone()).await?;

                Self::ws_connect(proxy.clone(), session_id, session_token.as_ref()).await
            }
        }
    }
}
