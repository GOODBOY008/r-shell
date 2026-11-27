---
title: "Monitor hosts and build a dashboard"
description: "Inspect a connected host, compare a fleet, and understand when dashboard commands run."
---

Use the **Monitor** panel for the active connection. Use **Dashboards** in the left sidebar when you want readings from several saved SSH connections in one view.

## Check the active host

Select a connected terminal and open the monitor panel. Start with CPU, memory, load and disk usage. For a network or service problem, inspect interfaces or logs for that same host. Log sources can include files, journalctl and Docker, depending on the host and the permissions of your SSH account.

## Compare two hosts

1. Save an SSH connection for each host.
2. Open **Dashboards → Browse templates** and choose **Linux host**. Give the dashboard a recognizable name.
3. Select the saved connections for each collection group and choose **Create and start**. The dashboard opens as a tab. Compare the host labels on each card to identify which machine a reading belongs to.
4. Switch to a terminal tab while investigating. An open dashboard continues collecting in the background. Use **Pause** when you want sampling to stop.

![A dashboard compares request rates, latency and service readiness across two SSH hosts.](/media/multi-host-dashboard.webp)

Templates run commands using the selected SSH account. For example, the Docker template needs access to the Docker CLI and daemon, and the NVIDIA GPU template needs `nvidia-smi`. If a card reports an error, check that host's access and the card's last successful sample before interpreting the value.

## Add a custom reading

Add a command card, select the connection and enter a non-interactive command. Use the test run to inspect standard output, errors and exit status before saving. Choose a **number** or **chart** for numeric output, a **table** for structured rows, or **text** for a command such as `uptime`. Several cards can share one data source and use the same sample. A Markdown card can hold a deployment checklist alongside the measurements.
