#!/usr/bin/env python3
"""Local SSH server for PTY output memory stress tests.

The server accepts test/test and starts writing high-volume PTY output after it
receives a command containing "yes". It is intended for local development only.
"""

from __future__ import annotations

import argparse
import socket
import sys
import threading
import time
from pathlib import Path

import paramiko


HOST_KEY = paramiko.RSAKey.generate(2048)


class StressServer(paramiko.ServerInterface):
    def __init__(self) -> None:
        self.shell_ready = threading.Event()

    def check_auth_password(self, username: str, password: str) -> int:
        if username == "test" and password == "test":
            return paramiko.AUTH_SUCCESSFUL
        return paramiko.AUTH_FAILED

    def get_allowed_auths(self, username: str) -> str:
        return "password"

    def check_channel_request(self, kind: str, chanid: int) -> int:
        if kind == "session":
            return paramiko.OPEN_SUCCEEDED
        return paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

    def check_channel_pty_request(
        self,
        channel: paramiko.Channel,
        term: bytes,
        width: int,
        height: int,
        pixelwidth: int,
        pixelheight: int,
        modes: bytes,
    ) -> bool:
        return True

    def check_channel_shell_request(self, channel: paramiko.Channel) -> bool:
        self.shell_ready.set()
        return True


def output_loop(channel: paramiko.Channel, stop: threading.Event) -> None:
    payload = (b"0123456789abcdefghijklmnopqrstuvwxyz\r\n" * 1024)
    while not stop.is_set():
        try:
            channel.sendall(payload)
        except Exception:
            stop.set()
            return


def handle_client(client: socket.socket) -> None:
    transport = paramiko.Transport(client)
    transport.add_server_key(HOST_KEY)
    server = StressServer()
    stop = threading.Event()

    try:
        transport.start_server(server=server)
        channel = transport.accept(20)
        if channel is None:
            return
        if not server.shell_ready.wait(10):
            return

        channel.settimeout(0.2)
        received = bytearray()
        writer: threading.Thread | None = None

        while transport.is_active() and not stop.is_set():
            try:
                data = channel.recv(1024)
            except socket.timeout:
                continue
            except Exception:
                break
            if not data:
                break

            received.extend(data)
            if writer is None and b"yes" in received:
                writer = threading.Thread(
                    target=output_loop,
                    args=(channel, stop),
                    daemon=True,
                )
                writer.start()
    finally:
        stop.set()
        try:
            transport.close()
        finally:
            client.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--port-file")
    args = parser.parse_args()

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((args.host, args.port))
    sock.listen(100)
    host, port = sock.getsockname()

    if args.port_file:
        Path(args.port_file).write_text(str(port), encoding="utf-8")

    print(f"stress ssh server listening on {host}:{port}", flush=True)

    try:
        while True:
            client, _ = sock.accept()
            threading.Thread(target=handle_client, args=(client,), daemon=True).start()
    except KeyboardInterrupt:
        return 0
    finally:
        sock.close()


if __name__ == "__main__":
    sys.exit(main())
