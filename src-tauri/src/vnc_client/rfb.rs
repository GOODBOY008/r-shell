use anyhow::{bail, ensure, Result};
use des::cipher::{Block, BlockCipherEncrypt, KeyInit};
use des::Des;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::desktop_protocol::FrameUpdate;

const SECURITY_NONE: u32 = 1;
const SECURITY_VNC_AUTH: u32 = 2;
const MAX_HANDSHAKE_TEXT: usize = 4096;
pub(super) const MAX_CLIPBOARD_BYTES: usize = 1024 * 1024;
pub(super) const RAW: i32 = 0;
pub(super) const DESKTOP_SIZE: i32 = -223;

pub(super) async fn handshake(
    stream: &mut (impl AsyncRead + AsyncWrite + Unpin),
    password: Option<&str>,
    format: PixelFormat,
) -> Result<(u16, u16)> {
    let mut banner = [0; 12];
    stream.read_exact(&mut banner).await?;
    let (version, response) = match &banner {
        b"RFB 003.007\n" => (7, b"RFB 003.007\n"),
        b"RFB 003.008\n" => (8, b"RFB 003.008\n"),
        // RFC 6143 §6: legacy 3.x banners use the 3.3 handshake.
        _ if banner.starts_with(b"RFB 003.")
            && banner[8..11].iter().all(u8::is_ascii_digit)
            && banner[11] == b'\n' =>
        {
            (3, b"RFB 003.003\n")
        }
        _ => bail!("Unsupported VNC protocol version"),
    };
    stream.write_all(response).await?;

    let password = password.filter(|value| !value.is_empty());
    let security = if version == 3 {
        let security = stream.read_u32().await?;
        if security == 0 {
            bail!("VNC connection rejected: {}", read_reason(stream).await?);
        }
        security
    } else {
        let count = stream.read_u8().await?;
        if count == 0 {
            bail!("VNC connection rejected: {}", read_reason(stream).await?);
        }
        let mut types = vec![0; usize::from(count)];
        stream.read_exact(&mut types).await?;
        let security = match (
            password,
            types.contains(&(SECURITY_VNC_AUTH as u8)),
            types.contains(&(SECURITY_NONE as u8)),
        ) {
            (Some(_), true, _) => SECURITY_VNC_AUTH,
            (None, _, true) => SECURITY_NONE,
            (None, true, false) => bail!("The VNC server requires a password"),
            (Some(_), false, true) => bail!("The VNC server offered no password authentication"),
            _ => bail!("The VNC server offered no supported security type"),
        };
        stream.write_u8(security as u8).await?;
        security
    };

    match security {
        SECURITY_VNC_AUTH => {
            let password =
                password.ok_or_else(|| anyhow::anyhow!("The VNC server requires a password"))?;
            let mut challenge = [0; 16];
            stream.read_exact(&mut challenge).await?;
            stream
                .write_all(&challenge_response(password, challenge))
                .await?;
        }
        SECURITY_NONE => ensure!(
            password.is_none(),
            "The VNC server offered no password authentication"
        ),
        _ => bail!("The VNC server offered no supported security type ({security})"),
    }
    // Older servers omit SecurityResult for the None security type.
    if (version == 8 || security == SECURITY_VNC_AUTH) && stream.read_u32().await? != 0 {
        if version == 8 {
            bail!("VNC authentication failed: {}", read_reason(stream).await?);
        }
        bail!("VNC authentication failed");
    }

    stream.write_u8(1).await?; // ClientInit: share the desktop.
    let width = stream.read_u16().await?;
    let height = stream.read_u16().await?;
    validate_size(width, height)?;
    let mut server_format = [0; 16];
    stream.read_exact(&mut server_format).await?;
    read_payload(stream, MAX_HANDSHAKE_TEXT).await?; // Desktop name.

    stream.write_all(&format.set_pixel_format()).await?;
    stream.write_all(&[2, 0, 0, 2]).await?; // SetEncodings.
    stream.write_i32(RAW).await?;
    stream.write_i32(DESKTOP_SIZE).await?;
    Ok((width, height))
}

fn challenge_response(password: &str, mut challenge: [u8; 16]) -> [u8; 16] {
    // VNC DES keys are padded/truncated to eight bytes, with each byte's bits reversed.
    let mut key = [0; 8];
    for (target, byte) in key.iter_mut().zip(password.bytes()) {
        *target = byte.reverse_bits();
    }
    let cipher = Des::new(&key.into());
    for bytes in challenge.chunks_exact_mut(8) {
        let mut block = Block::<Des>::default();
        block.copy_from_slice(bytes);
        cipher.encrypt_block(&mut block);
        bytes.copy_from_slice(&block);
    }
    challenge
}

async fn read_reason(stream: &mut (impl AsyncRead + Unpin)) -> Result<String> {
    let reason = read_payload(stream, MAX_HANDSHAKE_TEXT).await?;
    Ok(String::from_utf8_lossy(&reason).into_owned())
}

pub(super) async fn read_payload(
    stream: &mut (impl AsyncRead + Unpin),
    max_len: usize,
) -> Result<Vec<u8>> {
    let len = stream.read_u32().await? as usize;
    ensure!(len <= max_len, "VNC text exceeds the supported size");
    let mut data = vec![0; len];
    stream.read_exact(&mut data).await?;
    Ok(data)
}

pub(super) fn validate_size(width: u16, height: u16) -> Result<()> {
    ensure!(
        (1..=8192).contains(&width)
            && (1..=8192).contains(&height)
            && u32::from(width) * u32::from(height) <= 8192 * 4320,
        "Unsupported VNC framebuffer dimensions ({width}x{height})"
    );
    Ok(())
}

#[derive(Clone, Copy)]
pub(super) enum PixelFormat {
    Rgb332,
    Rgb565,
    Bgrx8888,
}

impl PixelFormat {
    pub(super) fn from_depth(depth: u8) -> Result<Self> {
        match depth {
            8 => Ok(Self::Rgb332),
            16 => Ok(Self::Rgb565),
            24 => Ok(Self::Bgrx8888),
            _ => bail!("Unsupported VNC color depth ({depth})"),
        }
    }

    fn set_pixel_format(self) -> [u8; 20] {
        let (bits, depth, r_max, g_max, b_max, r_shift, g_shift, b_shift) = match self {
            Self::Rgb332 => (8, 8, 7, 7, 3, 5, 2, 0),
            Self::Rgb565 => (16, 16, 31, 63, 31, 11, 5, 0),
            Self::Bgrx8888 => (32, 24, 255, 255, 255, 16, 8, 0),
        };
        [
            0, 0, 0, 0, bits, depth, 0, 1, // SetPixelFormat, little-endian true color.
            0, r_max, 0, g_max, 0, b_max, r_shift, g_shift, b_shift, 0, 0, 0,
        ]
    }

    pub(super) async fn read_raw(
        self,
        stream: &mut (impl AsyncRead + Unpin),
        (x, y, width, height): (u16, u16, u16, u16),
        (desktop_width, desktop_height): (u16, u16),
    ) -> Result<FrameUpdate> {
        ensure!(
            u32::from(x) + u32::from(width) <= u32::from(desktop_width)
                && u32::from(y) + u32::from(height) <= u32::from(desktop_height),
            "VNC framebuffer rectangle is out of bounds"
        );
        let mut rgba_data = vec![0; usize::from(width) * usize::from(height) * 4];
        match self {
            Self::Bgrx8888 => {
                stream.read_exact(&mut rgba_data).await?;
                for pixel in rgba_data.chunks_exact_mut(4) {
                    pixel.swap(0, 2);
                    pixel[3] = 255;
                }
            }
            Self::Rgb332 | Self::Rgb565 if width != 0 => {
                let bytes_per_pixel = if matches!(self, Self::Rgb332) { 1 } else { 2 };
                let mut row = vec![0; usize::from(width) * bytes_per_pixel];
                for target in rgba_data.chunks_exact_mut(usize::from(width) * 4) {
                    stream.read_exact(&mut row).await?;
                    for (pixel, color) in target
                        .chunks_exact_mut(4)
                        .zip(row.chunks_exact(bytes_per_pixel))
                    {
                        let rgb = match self {
                            Self::Rgb332 => {
                                let value = u16::from(color[0]);
                                [scale(value >> 5, 7), scale(value >> 2, 7), scale(value, 3)]
                            }
                            _ => {
                                let value = u16::from_le_bytes([color[0], color[1]]);
                                [
                                    scale(value >> 11, 31),
                                    scale(value >> 5, 63),
                                    scale(value, 31),
                                ]
                            }
                        };
                        pixel[..3].copy_from_slice(&rgb);
                        pixel[3] = 255;
                    }
                }
            }
            _ => {}
        }
        Ok(FrameUpdate {
            x,
            y,
            width,
            height,
            rgba_data,
        })
    }
}

fn scale(value: u16, max: u16) -> u8 {
    (((value & max) * 255 + max / 2) / max) as u8
}
