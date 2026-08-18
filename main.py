#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

WEB = ROOT / "web"
DIST = WEB / "dist" / "index.html"
DEV_URL = "http://127.0.0.1:5173"


def _npm() -> str:
    return "npm.cmd" if sys.platform == "win32" else "npm"


def _port_open(port: int = 5173) -> bool:
    with socket.socket() as sock:
        sock.settimeout(0.35)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def _run_npm(*args: str) -> None:
    subprocess.check_call([_npm(), *args], cwd=WEB)


def _ensure_node_modules() -> None:
    if not (WEB / "node_modules").exists():
        _run_npm("install")


def _wait_vite(seconds: float = 25) -> None:
    deadline = time.time() + seconds
    while time.time() < deadline:
        if _port_open():
            return
        time.sleep(0.25)
    raise RuntimeError("Vite 开发服务未在 5173 就绪，请先在 web/ 执行 npm run dev")


def resolve_frontend(dev: bool) -> tuple[str, bool]:
    """返回 (url, 是否远程 http)。正式包走 web/dist，开发走 localhost:5173。"""
    if not WEB.exists():
        raise RuntimeError(f"未找到前端目录: {WEB}")
    if dev:
        _ensure_node_modules()
        if not _port_open():
            creation = getattr(subprocess, "CREATE_NEW_CONSOLE", 0) if sys.platform == "win32" else 0
            subprocess.Popen(
                [_npm(), "run", "dev"],
                cwd=WEB,
                creationflags=creation,
            )
            _wait_vite()
        return DEV_URL, True
    _ensure_node_modules()
    if not DIST.exists():
        _run_npm("run", "build")
    if not DIST.exists():
        raise RuntimeError(f"前端构建失败，未生成 {DIST}")
    return str(DIST), False


def main() -> None:
    parser = argparse.ArgumentParser(description="PoE1 自动工艺")
    parser.add_argument(
        "--dev",
        action="store_true",
        help="加载 http://127.0.0.1:5173（可用环境变量 POE_DEV=1）",
    )
    args = parser.parse_args()
    dev = args.dev or os.environ.get("POE_DEV") == "1"
    url, remote = resolve_frontend(dev)
    from src.gui.host import run_app

    run_app(url, debug=dev, serve_local=not remote)


if __name__ == "__main__":
    main()
