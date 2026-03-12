#!/usr/bin/env python3
import os
import sys
import time
from pathlib import Path


def install_device_discovery_wait(timeout_seconds: float) -> None:
    from ohos.managers.manager_device import ManagerDevice

    if getattr(ManagerDevice, "_codex_device_wait_patch", False):
        return

    original_start = ManagerDevice._start_device_monitor

    def patched_start(self, environment: str = "", user_config_file: str = "") -> bool:
        result = original_start(self, environment, user_config_file)
        if not result or self.devices_list or not self.device_connectors:
            return result

        deadline = time.monotonic() + timeout_seconds
        self.lock_con.acquire()
        try:
            while not self.devices_list:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self.lock_con.wait(timeout=min(0.5, remaining))
        finally:
            self.lock_con.release()
        return result

    ManagerDevice._start_device_monitor = patched_start
    ManagerDevice._codex_device_wait_patch = True


def main() -> int:
    if len(sys.argv) < 3:
        print(
            "Usage: run_framework.py <testfwk_developer_test_dir> <framework-args...>",
            file=sys.stderr,
        )
        return 2

    repo_dir = Path(sys.argv[1]).expanduser().resolve()
    src_dir = repo_dir / "src"
    if not src_dir.is_dir():
        print(f"Framework src dir not found: {src_dir}", file=sys.stderr)
        return 2

    os.chdir(src_dir)
    if str(src_dir) not in sys.path:
        sys.path.insert(0, str(src_dir))

    import main._init_global_config  # noqa: F401

    timeout_seconds = float(os.environ.get("XDEVICE_DISCOVERY_TIMEOUT", "6"))
    install_device_discovery_wait(timeout_seconds)

    from main.__main__ import main_process

    sys.argv = ["__main__", *sys.argv[2:]]
    main_process()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
