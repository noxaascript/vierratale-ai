import json
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

from . import config

MAX_MESSAGES = 20


def _root() -> Path:
    return config.get_config_dir() / "sessions"


def _active_file() -> Path:
    return _root() / ".active"


def _migrated_flag() -> Path:
    return _root() / ".migrated"


def _sanitize(name: str) -> str:
    safe = "".join(c if c.isalnum() or c in "._-" else "-" for c in str(name or "")).strip("-")
    return (safe or "default")[:60]


def _path_for(name: str) -> Path:
    return _root() / f"{_sanitize(name)}.json"


def _backup_path_for(name: str) -> Path:
    return _root() / f"{_sanitize(name)}.bak.json"


def _auto_name() -> str:
    return "session-" + datetime.now().strftime("%Y%m%d-%H%M%S-%f")


def _ensure_dir() -> None:
    _root().mkdir(parents=True, exist_ok=True)


def _migrate_legacy() -> None:
    try:
        legacy = config.get_config_dir() / "history.json"
        if legacy.exists() and not _migrated_flag().exists():
            if not _path_for("default").exists():
                data = json.loads(legacy.read_text() or "[]")
                if isinstance(data, list) and data:
                    _path_for("default").parent.mkdir(parents=True, exist_ok=True)
                    _path_for("default").write_text(json.dumps(data[-MAX_MESSAGES:], indent=2))
            _migrated_flag().write_text(datetime.now().isoformat())
    except Exception:
        pass


def active_name() -> str:
    _ensure_dir()
    _migrate_legacy()
    try:
        if _active_file().exists():
            name = _active_file().read_text().strip()
            if name and _path_for(name).exists():
                return name
    except Exception:
        pass
    if not _path_for("default").exists():
        _path_for("default").write_text("[]")
    _active_file().write_text("default")
    return "default"


def list_sessions() -> List[Dict]:
    _ensure_dir()
    _migrate_legacy()
    active = active_name()
    out = []
    for f in _root().glob("*.json"):
        name = f.name[:-5]
        try:
            msgs = json.loads(f.read_text() or "[]")
            first = next((m for m in msgs if m.get("role") == "user"), None)
            out.append({
                "name": name,
                "count": len(msgs) if isinstance(msgs, list) else 0,
                "preview": (str(first.get("content", ""))[:60] if first else "(empty)"),
                "updated": f.stat().st_mtime,
                "active": name == active,
            })
        except Exception:
            continue
    out.sort(key=lambda s: s["updated"], reverse=True)
    return out


def _resolve(name: str) -> Optional[str]:
    sessions = list_sessions()
    if name and name.startswith("#"):
        idx = int(name[1:]) - 1
        if 0 <= idx < len(sessions):
            return sessions[idx]["name"]
        return None
    safe = _sanitize(name or "")
    return safe if _path_for(safe).exists() else None


def create(name: Optional[str] = None) -> str:
    _ensure_dir()
    safe = _sanitize(name or _auto_name())
    _path_for(safe).write_text("[]")
    _active_file().write_text(safe)
    return safe


def open_session(name: str) -> Optional[str]:
    target = _resolve(name)
    if target is None:
        return None
    _active_file().write_text(target)
    return target


def remove(name: str) -> Optional[str]:
    sessions = list_sessions()
    target = _resolve(name)
    if target is None:
        return None
    if target == active_name():
        others = [s["name"] for s in sessions if s["name"] != target]
        if others:
            _active_file().write_text(others[0])
        else:
            _active_file().write_text(create(None))
    try:
        _path_for(target).unlink()
    except Exception:
        pass
    return target


def load() -> List[Dict[str, str]]:
    return load_active()


def load_active() -> List[Dict[str, str]]:
    try:
        path = _path_for(active_name())
        if path.exists():
            data = json.loads(path.read_text() or "[]")
            if isinstance(data, list):
                return data[-MAX_MESSAGES:]
    except Exception:
        pass
    return []


def save(messages: List[Dict[str, str]]) -> None:
    try:
        _ensure_dir()
        _path_for(active_name()).write_text(json.dumps(messages[-MAX_MESSAGES:], indent=2))
    except Exception:
        pass


def auto_backup() -> Optional[str]:
    """Snapshot the active session to a timestamped .bak.json before it is
    replaced or cleared, so a fresh-start or /new never loses the old talk."""
    try:
        _ensure_dir()
        name = active_name()
        src = _path_for(name)
        if not src.exists():
            return None
        msgs = json.loads(src.read_text() or "[]")
        if not isinstance(msgs, list) or not msgs:
            return None
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        dest = _backup_path_for(f"{name}.{stamp}")
        dest.write_text(json.dumps(msgs, indent=2))
        return f"{name}.{stamp}.bak.json"
    except Exception:
        return None


def backup() -> Optional[str]:
    return auto_backup()


def list_backups() -> List[Dict]:
    _ensure_dir()
    out = []
    for f in _root().glob("*.bak.json"):
        name = f.name[: -len(".bak.json")]
        try:
            out.append({"name": name, "file": f.name, "updated": f.stat().st_mtime})
        except Exception:
            continue
    out.sort(key=lambda b: b["updated"], reverse=True)
    return out


def restore_backup(name: str) -> Optional[str]:
    try:
        _ensure_dir()
        fname = str(name or "").strip()
        if not fname.endswith(".bak.json"):
            fname = fname + (".bak.json" if fname else "")
        safe = _sanitize(fname[: -len(".bak.json")])
        src = _backup_path_for(safe)
        if not src.exists():
            return None
        msgs = json.loads(src.read_text() or "[]")
        if not isinstance(msgs, list):
            return None
        base = _sanitize(safe.rsplit(".", 1)[0])
        target = base
        if _path_for(target).exists():
            target = f"{base}-restored"
        _path_for(target).write_text(json.dumps(msgs[-MAX_MESSAGES:], indent=2))
        _active_file().write_text(target)
        return target
    except Exception:
        return None


def clear() -> None:
    try:
        _ensure_dir()
        _path_for(active_name()).write_text("[]")
    except Exception:
        pass