#!/usr/bin/env python3
"""Latency-injecting TCP relay for the docker_sftp_transfer_roundtrip_relay e2e
test (src-tauri/src/ssh/tests.rs).

Usage: latency-relay.py <listen_port> <target_port> <one_way_ms>

Every connection accepted on listen_port is proxied to 127.0.0.1:target_port;
each forwarded chunk is held for one_way_ms before delivery, in both
directions. Because a chunk is held after it is received and before it is
sent, the delay is per-chunk, not per-byte: with the default 256 KiB chunk
this both adds latency and caps throughput at roughly CHUNK/one_way —
~51 MB/s at the default 5 ms. The test asserts byte-exactness and prints
observed throughput, so that cap is fine for a latency/behaviour fixture.

Sockets are half-closed (SHUT_WR) when a direction sees EOF and are left to
the process lifetime — this is a one-test helper, not a long-lived daemon.
"""

import socket
import sys
import threading
import time

CHUNK = 256 * 1024


def pump(src: socket.socket, dst: socket.socket, one_way: float) -> None:
    try:
        while True:
            data = src.recv(CHUNK)
            if not data:
                break
            if one_way > 0:
                time.sleep(one_way)
            dst.sendall(data)
    except OSError:
        pass
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def main() -> None:
    if len(sys.argv) != 4:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    listen_port = int(sys.argv[1])
    target_port = int(sys.argv[2])
    one_way = float(sys.argv[3]) / 1000.0

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", listen_port))
    server.listen(16)
    print(f"relay 127.0.0.1:{listen_port} -> 127.0.0.1:{target_port} "
          f"({sys.argv[3]}ms one-way)", flush=True)

    while True:
        conn, _ = server.accept()
        upstream = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            upstream.connect(("127.0.0.1", target_port))
        except OSError:
            conn.close()
            continue
        threading.Thread(target=pump, args=(conn, upstream, one_way),
                         daemon=True).start()
        threading.Thread(target=pump, args=(upstream, conn, one_way),
                         daemon=True).start()


if __name__ == "__main__":
    main()
