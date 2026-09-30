/**
 * Pick the network interface the System Monitor's Network Usage card should display.
 *
 * This used to guess from the name (`eth0`/`ens*`/`enp*`), which are Linux
 * conventions only. On macOS nothing matched, so the lookup fell back to
 * `interfaceNames[0]` — alphabetically `anpi0`, an Apple internal interface
 * whose counters never move — and the card read 0 KB/s no matter what the real
 * NIC was doing. Ranking by measured throughput is naming-agnostic and correct
 * on every platform.
 *
 * Falls back to `'all'` when the host is genuinely idle, so there is nothing
 * better to show than the aggregate.
 */
export const pickDefaultNetworkInterface = (
  bandwidth: Array<{ interface: string; rx_bytes_per_sec: number; tx_bytes_per_sec: number }>,
): string => {
  const total = (iface: { rx_bytes_per_sec: number; tx_bytes_per_sec: number }) =>
    iface.rx_bytes_per_sec + iface.tx_bytes_per_sec;

  // Nothing is moving anywhere — the aggregate is the only honest view.
  if (!bandwidth.some(total)) return 'all';

  return bandwidth.reduce((busiest, iface) => (total(iface) > total(busiest) ? iface : busiest))
    .interface;
};

/**
 * Which interface the Network Usage card should read this tick.
 *
 * `userPicked` is the interface the user explicitly chose from the dropdown, or
 * null while auto-selection is still in charge. A pick only wins while that
 * interface is still present — when it disappears (VPN torn down, dongle
 * unplugged) we fall back to auto, because resolving to the missing name
 * yields `undefined` and pins the card at a permanent 0 KB/s. `'all'` is not an
 * interface name and is therefore always considered present.
 */
export const resolveActiveInterface = (
  userPicked: string | null,
  interfaceNames: string[],
  bandwidth: Array<{ interface: string; rx_bytes_per_sec: number; tx_bytes_per_sec: number }>,
): string => {
  if (userPicked === null) {
    return pickDefaultNetworkInterface(bandwidth);
  }
  // `'all'` is the aggregate, not an interface name — it is always selectable.
  if (userPicked === 'all' || interfaceNames.includes(userPicked)) {
    return userPicked;
  }
  return pickDefaultNetworkInterface(bandwidth);
};
