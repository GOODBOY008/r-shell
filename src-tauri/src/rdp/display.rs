//! Keep the native window's display policy aligned with src/lib/rdp-display.ts.

/// Physical window size -> requested desktop pixels and Windows text scale.
/// Fixed resolutions never renegotiate; only the local surface follows the window.
#[cfg(any(target_os = "macos", test))]
fn native_display_target(
    resolution: &str,
    width: u32,
    height: u32,
    dpr: f64,
) -> Option<(u16, u16, u32)> {
    if !matches!(resolution, "fit" | "retina") || width == 0 || height == 0 {
        return None;
    }
    let dpr = if dpr.is_finite() && dpr > 0.0 {
        dpr
    } else {
        1.0
    };
    let scale = if resolution == "retina" {
        (dpr.clamp(1.0, 5.0) * 100.0).round() as u32
    } else {
        100
    };
    let density = f64::from(scale) / 100.0;
    let width = f64::from(width) / dpr * density;
    let height = f64::from(height) / dpr * density;
    let (cap_width, cap_height) = if resolution == "retina" {
        (8192.0, 8192.0)
    } else {
        (1920.0, 1080.0)
    };
    let fit = 1.0_f64.min(cap_width / width).min(cap_height / height);
    Some((
        (width * fit / 2.0).floor().max(100.0) as u16 * 2,
        (height * fit).floor().max(200.0) as u16,
        scale,
    ))
}

/// Each native window owns its debounce generation and resolution preference.
/// DPI changes are explicit events even when the logical size stays unchanged.
#[cfg(target_os = "macos")]
pub(crate) fn follow_native_display(
    window: &tauri::Window,
    manager: std::sync::Arc<crate::connection_manager::ConnectionManager>,
    connection_id: String,
    resolution: String,
) {
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    };
    let generation = Arc::new(AtomicU64::new(0));
    let pending = generation.clone();
    let schedule = move |size: tauri::PhysicalSize<u32>, dpr: f64| {
        let current = pending.fetch_add(1, Ordering::SeqCst) + 1;
        if size.width == 0 || size.height == 0 {
            return;
        }
        let target = native_display_target(&resolution, size.width, size.height, dpr);
        let pending = pending.clone();
        let manager = manager.clone();
        let connection_id = connection_id.clone();
        tauri::async_runtime::spawn(async move {
            if current != pending.load(Ordering::SeqCst) {
                return;
            }
            let _ = manager
                .resize_desktop_native_surface(&connection_id, size.width, size.height)
                .await;
            let Some((width, height, scale)) = target else {
                return;
            };
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            if current != pending.load(Ordering::SeqCst) {
                return;
            }
            if let Some(client) = manager.get_desktop_connection(&connection_id).await {
                let mut client = client.write().await;
                if current == pending.load(Ordering::SeqCst) && client.is_native_rendering() {
                    let _ = client.resize_with_scale(width, height, Some(scale)).await;
                }
            }
        });
    };
    if let Ok(size) = window.inner_size() {
        schedule(size, window.scale_factor().unwrap_or(1.0));
    }
    let source = window.clone();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::Resized(size) => schedule(*size, source.scale_factor().unwrap_or(1.0)),
        tauri::WindowEvent::ScaleFactorChanged {
            scale_factor,
            new_inner_size,
            ..
        } => {
            schedule(*new_inner_size, *scale_factor);
        }
        tauri::WindowEvent::Destroyed => {
            generation.fetch_add(1, Ordering::SeqCst);
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::native_display_target;

    #[test]
    fn native_and_tab_display_policies_agree_across_monitors() {
        assert_eq!(
            native_display_target("fit", 1600, 900, 2.0),
            Some((800, 450, 100))
        );
        assert_eq!(
            native_display_target("fit", 800, 450, 1.0),
            Some((800, 450, 100))
        );
        assert_eq!(
            native_display_target("retina", 1600, 900, 2.0),
            Some((1600, 900, 200))
        );
        assert_eq!(
            native_display_target("retina", 1200, 675, 1.5),
            Some((1200, 675, 150))
        );
        assert_eq!(
            native_display_target("retina", 1440, 2560, 2.0),
            Some((1440, 2560, 200))
        );
        assert_eq!(
            native_display_target("fit", 1440, 2560, 2.0),
            Some((606, 1080, 100))
        );
        assert_eq!(
            native_display_target("retina", 18000, 12000, 2.0),
            Some((8192, 5461, 200))
        );
    }

    #[test]
    fn fixed_desktops_and_minimized_windows_do_not_resize_the_server() {
        for resolution in ["1024x768", "1280x720", "1920x1080", "2560x1440"] {
            assert_eq!(native_display_target(resolution, 1600, 900, 2.0), None);
        }
        assert_eq!(native_display_target("retina", 0, 0, 2.0), None);
        assert_eq!(
            native_display_target("fit", 800, 450, f64::NAN),
            Some((800, 450, 100))
        );
    }
}
