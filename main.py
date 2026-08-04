#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path

# 保证以脚本方式运行时可导入 src
ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.gui.app import run_app


def main() -> None:
    run_app()


if __name__ == "__main__":
    main()
