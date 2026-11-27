---
title: "Use RDP and VNC"
description: "Connect to a graphical desktop, choose the resolution, and control how it appears in your workspace."
---

Open **New Connection** and select the protocol enabled on the remote computer. The host address and port must be reachable from your network or VPN.

## RDP

1. Select **RDP**. Enter the hostname or IP address, port (usually `3389`), username and password. Fill in the domain if your administrator gave you one.
2. Start with **Balanced Auto (up to 1080p)**. The remote desktop follows the window size using logical pixels, up to 1920×1080.
3. Connect and click inside the remote desktop to send keyboard and pointer input. Use the toolbar to enter full screen, send **Ctrl+Alt+Del**, or **Open in Separate Window**.
4. If you want the remote dimensions to stay constant, choose a fixed resolution in the connection settings. **Fit to Window** scales that image on your computer. **Retina** requests physical pixels for more detail and uses more bandwidth.

## VNC

Select **VNC**, enter the host and the port configured on the server (commonly `5900`), then enter its VNC password if required. The viewer supports pointer and keyboard input, local display scaling and Latin-1 clipboard text. R-Shell's VNC transport uses unencrypted RFB. Use an SSH tunnel when crossing an untrusted network.

## macOS local-network access

On macOS 15 and later, connecting to a LAN host or local virtual machine can trigger a **Local Network** permission prompt. Choose **Allow** for the installed application. If a connection still reports “No route to host,” check **System Settings → Privacy & Security → Local Network** for R-Shell, then check the host, VPN and route before reconnecting.
