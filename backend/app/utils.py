from __future__ import annotations

import os
import shutil


def remove_path(path: str | None) -> None:
    if not path:
        return
    try:
        if os.path.isdir(path) and not os.path.islink(path):
            shutil.rmtree(path, ignore_errors=True)
        elif os.path.exists(path):
            os.unlink(path)
    except OSError:
        pass


def path_has_files(path: str | None) -> bool:
    if not path or not os.path.isdir(path):
        return False
    try:
        return any(name.endswith(".parquet") for name in os.listdir(path))
    except OSError:
        return False
