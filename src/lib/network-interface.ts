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
 * yields `undefined` and pins the card at a permanent 0 KB/s.
 *
 * `previousAuto` is what auto-selection chose on the previous tick, used only
 * to hold the selection steady while the host reads idle.
 */
export const resolveActiveInterface = (
  userPicked: string | null,
  previousAuto: string | null,
  interfaceNames: string[],
  bandwidth: Array<{ interface: string; rx_bytes_per_sec: number; tx_bytes_per_sec: number }>,
): string => {
  // A user's choice outranks auto-selection, and `'all'` is the aggregate
  // rather than an interface name, so it is always considered present.
  if (userPicked !== null && (userPicked === 'all' || interfaceNames.includes(userPicked))) {
    return userPicked;
  }

  const busiest = pickDefaultNetworkInterface(bandwidth);
  if (busiest !== 'all') return busiest;

  // Every counter reads zero this tick. Holding the previous auto pick instead
  // of dropping to `'all'` keeps the selection — and therefore the chart — from
  // flapping on an idle-then-bursty host, where each burst would otherwise clear
  // the history and leave a one-point segment. The aggregate is only the honest
  // view when there is no earlier pick to hold on to.
  if (previousAuto !== null && interfaceNames.includes(previousAuto)) {
    return previousAuto;
  }
  return 'all';
};
