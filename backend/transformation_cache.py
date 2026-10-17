"""Bounded SQLite storage for completed /format and /translate results.

This module is the only place in TextKit that executes SQL or interprets raw
SQLite exceptions.  Callers receive one of three typed outcomes and never see a
connection, cursor, filesystem handle, SQL statement, or exception message::

    await cache.initialize(policy)              -> CacheMaintenanceResult
    await cache.read(key, policy)               -> CacheReadResult
    await cache.write(key, record, policy)      -> CacheWriteResult

Every operation is one short-lived connection on a worker thread, one
``BEGIN IMMEDIATE`` transaction (schema setup, expiry pruning, capacity
enforcement, then lookup or upsert), bounded by a 500 ms absolute monotonic
deadline that starts before the work is queued.  A disabled policy never
reaches storage.

Rows hold only the identity digest, the operation, the output text, the
provider-reported model, the original generation token count, and the UTC
generation timestamp.  Prompts, input text, credentials, URLs, tab IDs, and
operation IDs are never persisted.
"""

from __future__ import annotations

import asyncio
import logging
import math
import os
import re
import sqlite3
import stat
import threading
import time
from concurrent.futures import Executor, Future, ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterator, Optional, Protocol, runtime_checkable

# ── public constants and allowlists ─────────────────────────────

#: Fixed event message; the only text a cache failure may log.
FAILURE_MESSAGE = "transformation cache unavailable"

#: Allowlisted reasons attached to an ``unavailable`` outcome.
FAILURE_REASONS = frozenset({"busy", "timeout", "permission", "schema", "corrupt"})

#: Operations this cache stores.  Anything else is rejected as malformed.
OPERATIONS = frozenset({"format", "translate"})

#: Absolute caller budget in seconds, including worker queue delay.
BUDGET_SECONDS = 0.5

#: SQLite lock wait, in milliseconds, and never more than 100 ms.
BUSY_TIMEOUT_MS = 100

#: SQLite VM instructions between two deadline checks inside a statement.
PROGRESS_HANDLER_STEPS = 1000

#: One day of UTC epoch seconds, used for the exact TTL boundary.
SECONDS_PER_DAY = 86_400

#: SQLite ``user_version`` owned by this schema.
SCHEMA_VERSION = 1

TABLE_NAME = "transformation_cache"
INDEX_NAME = "idx_transformation_cache_generation"

_TTL_DAYS_RANGE = (1, 3650)
_MAX_ENTRIES_RANGE = (1, 100_000)

_KEY_RE = re.compile(r"[0-9a-f]{64}\Z")
_PRIVATE_MODE = 0o600
_SIDECAR_SUFFIXES = ("-wal", "-shm")

_CREATE_TABLE_SQL = (
    f"CREATE TABLE {TABLE_NAME} ("
    " cache_key TEXT NOT NULL PRIMARY KEY,"
    " operation TEXT NOT NULL CHECK (operation IN ('format', 'translate')),"
    " output_text TEXT NOT NULL,"
    " model TEXT NOT NULL,"
    " generation_tokens INTEGER NOT NULL CHECK (generation_tokens >= 0),"
    " generated_at REAL NOT NULL CHECK (generated_at >= 0)"
    ")"
)

_CREATE_INDEX_SQL = (
    f"CREATE INDEX {INDEX_NAME}"
    f" ON {TABLE_NAME} (generated_at ASC, cache_key ASC)"
)

_EXPECTED_COLUMNS = [
    (0, "cache_key", "TEXT", 1, None, 1),
    (1, "operation", "TEXT", 1, None, 0),
    (2, "output_text", "TEXT", 1, None, 0),
    (3, "model", "TEXT", 1, None, 0),
    (4, "generation_tokens", "INTEGER", 1, None, 0),
    (5, "generated_at", "REAL", 1, None, 0),
]

_EXPECTED_INDEX_COLUMNS = [("generated_at", 0), ("cache_key", 0)]

_DELETE_EXPIRED_SQL = f"DELETE FROM {TABLE_NAME} WHERE generated_at <= ?"
_COUNT_ROWS_SQL = f"SELECT COUNT(*) FROM {TABLE_NAME}"
_DELETE_OLDEST_SQL = (
    f"DELETE FROM {TABLE_NAME} WHERE cache_key IN ("
    f"SELECT cache_key FROM {TABLE_NAME} "
    "ORDER BY generated_at ASC, cache_key ASC LIMIT ?)"
)
_SELECT_ROW_SQL = (
    "SELECT cache_key, operation, output_text, model, generation_tokens, generated_at "
    f"FROM {TABLE_NAME} WHERE cache_key = ?"
)
_UPSERT_ROW_SQL = (
    f"INSERT INTO {TABLE_NAME} "
    "(cache_key, operation, output_text, model, generation_tokens, generated_at) "
    "VALUES (?, ?, ?, ?, ?, ?) "
    "ON CONFLICT(cache_key) DO UPDATE SET "
    "operation = excluded.operation, "
    "output_text = excluded.output_text, "
    "model = excluded.model, "
    "generation_tokens = excluded.generation_tokens, "
    "generated_at = excluded.generated_at"
)

logger = logging.getLogger("textkit.transformation_cache")

# Test seams.  Production uses the real monotonic clock and the private default
# executor; tests replace this module attribute to control the deadline clock.
_monotonic: Callable[[], float] = time.monotonic

_default_executor_lock = threading.Lock()
_default_executor_instance: Optional[Executor] = None


def _default_executor() -> Executor:
    """Return the process-wide worker pool used when no executor is injected."""

    global _default_executor_instance
    with _default_executor_lock:
        if _default_executor_instance is None:
            _default_executor_instance = ThreadPoolExecutor(
                max_workers=4, thread_name_prefix="textkit-cache"
            )
        return _default_executor_instance


# ── immutable value types ───────────────────────────────────────


@dataclass(frozen=True)
class CacheRecord:
    """One completed transformation result, exactly as it may be stored."""

    key: str
    operation: str
    text: str
    model: str
    generation_tokens: int
    generated_at: float


@runtime_checkable
class CachePolicyView(Protocol):
    """Structural view of the endpoint's immutable policy snapshot.

    ``backend.main`` owns the validating model; this module only needs the three
    immutable attributes of an already-validated snapshot.
    """

    enabled: bool
    ttl_days: int
    max_entries: int


@dataclass(frozen=True)
class CacheReadResult:
    """Outcome of one completed-result lookup."""

    status: str
    record: Optional[CacheRecord] = None
    reason: Optional[str] = None

    def __post_init__(self) -> None:
        if self.status == "hit":
            if self.record is None:
                raise ValueError("a cache hit requires a record")
            if self.reason is not None:
                raise ValueError("a cache hit does not carry a reason")
            return
        if self.status == "miss":
            if self.record is not None or self.reason is not None:
                raise ValueError("a cache miss carries neither record nor reason")
            return
        if self.status == "unavailable":
            if self.record is not None:
                raise ValueError("an unavailable read does not carry a record")
            if self.reason not in FAILURE_REASONS:
                raise ValueError("an unavailable read requires an allowlisted reason")
            return
        raise ValueError(f"unsupported cache read status: {self.status!r}")


@dataclass(frozen=True)
class CacheWriteResult:
    """Outcome of one completed-result store."""

    status: str
    reason: Optional[str] = None

    def __post_init__(self) -> None:
        if self.status == "stored":
            if self.reason is not None:
                raise ValueError("a stored write does not carry a reason")
            return
        if self.status == "unavailable":
            if self.reason not in FAILURE_REASONS:
                raise ValueError("an unavailable write requires an allowlisted reason")
            return
        raise ValueError(f"unsupported cache write status: {self.status!r}")


@dataclass(frozen=True)
class CacheMaintenanceResult:
    """Outcome of one schema-validation plus maintenance pass."""

    status: str
    reason: Optional[str] = None

    def __post_init__(self) -> None:
        if self.status == "ready":
            if self.reason is not None:
                raise ValueError("a ready maintenance result does not carry a reason")
            return
        if self.status == "unavailable":
            if self.reason not in FAILURE_REASONS:
                raise ValueError("an unavailable maintenance reason is not allowlisted")
            return
        raise ValueError(f"unsupported cache maintenance status: {self.status!r}")


class DisabledCachePolicyError(ValueError):
    """Raised when a request with caching disabled reaches the cache module.

    The endpoint handles a disabled policy itself and never initializes,
    reads, prunes, or writes, so this is a caller contract violation rather than
    a storage outcome.  The cache module deliberately cannot express a
    "disabled" result: its outcome types describe storage work that happened.
    """


class _CacheFailure(Exception):
    """Internal signal carrying one allowlisted reason; never exposed."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


# ── public cache object ─────────────────────────────────────────


class TransformationCache:
    """Deep module owning the SQLite transformation cache.

    The public surface is exactly ``initialize``, ``read``, and ``write``.
    """

    def __init__(
        self,
        path: Path,
        *,
        clock: Callable[[], float] = time.time,
        executor: Optional[Executor] = None,
    ) -> None:
        self._path = Path(path)
        self._clock = clock
        self._executor = executor

    async def initialize(
        self,
        policy: CachePolicyView,
        now: Optional[float] = None,
    ) -> CacheMaintenanceResult:
        """Validate the schema and prune expired/over-capacity rows."""

        _require_enabled(policy)
        return await self._dispatch(
            _worker_initialize, CacheMaintenanceResult, policy, now
        )

    async def read(
        self,
        key: str,
        policy: CachePolicyView,
        now: Optional[float] = None,
    ) -> CacheReadResult:
        """Validate, maintain, and look up one completed result."""

        _require_enabled(policy)
        return await self._dispatch(_worker_read, CacheReadResult, policy, now, key)

    async def write(
        self,
        key: str,
        record: CacheRecord,
        policy: CachePolicyView,
        now: Optional[float] = None,
    ) -> CacheWriteResult:
        """Maintain, then upsert one completed eligible result."""

        _require_enabled(policy)
        return await self._dispatch(
            _worker_write, CacheWriteResult, policy, now, key, record
        )

    # ── caller-side budget and off-loop dispatch ────────────────

    async def _dispatch(
        self,
        worker: Callable[..., Any],
        result_type: Callable[..., Any],
        policy: CachePolicyView,
        now: Optional[float],
        *payload: Any,
    ) -> Any:
        try:
            resolved_now = _finite_timestamp(self._clock() if now is None else now)
        except (_CacheFailure, TypeError, ValueError):
            _log_failure("corrupt")
            return _unavailable(result_type, "corrupt")
        # The budget starts before queue submission so worker queue delay counts.
        deadline = _monotonic() + BUDGET_SECONDS
        executor = self._executor if self._executor is not None else _default_executor()
        try:
            future = executor.submit(
                worker, self._path, deadline, resolved_now, policy, *payload
            )
        except Exception:
            _log_failure("corrupt")
            return _unavailable(result_type, "corrupt")

        remaining = deadline - _monotonic()
        if remaining <= 0:
            _discard(future)
            _log_failure("timeout")
            return _unavailable(result_type, "timeout")

        try:
            result = await asyncio.wait_for(asyncio.wrap_future(future), remaining)
        except asyncio.TimeoutError:
            # Cancelling the caller-side future cannot stop an operating-system
            # call already running in the worker; it still closes its connection.
            _discard(future)
            _log_failure("timeout")
            return _unavailable(result_type, "timeout")

        # Workers report every failure except their own deadline expiry; the
        # caller owns timeout logging so one attempt logs exactly one event.
        if getattr(result, "reason", None) == "timeout":
            _log_failure("timeout")
        return result


def _unavailable(result_type: Callable[..., Any], reason: str) -> Any:
    return result_type(status="unavailable", reason=reason)


# ── sanitized failure reporting ─────────────────────────────────


def _log_failure(reason: str) -> None:
    """Log one fixed event with only an allowlisted reason."""

    logger.warning(FAILURE_MESSAGE, extra={"event": "cache.unavailable", "reason": reason})


def _classify_sqlite_error(exc: sqlite3.Error, deadline: float) -> str:
    message = str(exc).lower()
    if _monotonic() >= deadline or "interrupted" in message:
        return "timeout"
    if "locked" in message or "busy" in message:
        return "busy"
    if "readonly" in message or "read-only" in message or "unable to open" in message:
        return "permission"
    if "no such table" in message or "no such index" in message or "no such column" in message:
        return "schema"
    return "corrupt"


def _classify_os_error(exc: OSError) -> str:
    permission_errnos = {
        getattr(os, "EACCES", 13),
        getattr(os, "EPERM", 1),
        getattr(os, "ELOOP", 40),
        getattr(os, "ENOTDIR", 20),
    }
    return "permission" if exc.errno in permission_errnos else "corrupt"


def _sanitize(exc: BaseException, deadline: float) -> str:
    if isinstance(exc, _CacheFailure):
        return exc.reason
    if isinstance(exc, sqlite3.Error):
        return _classify_sqlite_error(exc, deadline)
    if isinstance(exc, OSError):
        return _classify_os_error(exc)
    return "corrupt"


def _discard(future: Future) -> None:
    """Consume a result nobody will await so the thread future stays quiet."""

    def consume(done: Future) -> None:
        try:
            done.exception()
        except BaseException:  # pragma: no cover - defensive
            pass

    try:
        future.add_done_callback(consume)
    except BaseException:  # pragma: no cover - defensive
        pass


# ── synchronous workers (always on the executor thread) ─────────


def _worker_initialize(
    path: Path,
    deadline: float,
    now: float,
    policy: CachePolicyView,
) -> CacheMaintenanceResult:
    return _guarded(
        deadline, CacheMaintenanceResult, _initialize_sync, path, deadline, now, policy
    )


def _worker_read(
    path: Path,
    deadline: float,
    now: float,
    policy: CachePolicyView,
    key: Any,
) -> CacheReadResult:
    return _guarded(
        deadline, CacheReadResult, _read_sync, path, deadline, now, policy, key
    )


def _worker_write(
    path: Path,
    deadline: float,
    now: float,
    policy: CachePolicyView,
    key: Any,
    record: Any,
) -> CacheWriteResult:
    return _guarded(
        deadline, CacheWriteResult, _write_sync, path, deadline, now, policy, key, record
    )


def _guarded(
    deadline: float,
    result_type: Callable[..., Any],
    operation: Callable[..., Any],
    *args: Any,
) -> Any:
    """Run one operation, mapping every local failure to a sanitized outcome."""

    try:
        return operation(*args)
    except Exception as exc:
        reason = _sanitize(exc, deadline)
        if reason != "timeout":
            _log_failure(reason)
        return _unavailable(result_type, reason)


# ── the synchronous operations ──────────────────────────────────


def _initialize_sync(
    path: Path,
    deadline: float,
    now: float,
    policy: CachePolicyView,
) -> CacheMaintenanceResult:
    ttl_days, max_entries = _policy_limits(policy)
    _check_deadline(deadline)
    connection, needs_creation = _connect(path, deadline)
    try:
        with _immediate_transaction(connection, deadline):
            _maintain(connection, deadline, needs_creation, now, ttl_days, max_entries)
        return CacheMaintenanceResult(status="ready")
    finally:
        _safe_close(connection)


def _read_sync(
    path: Path,
    deadline: float,
    now: float,
    policy: CachePolicyView,
    key: Any,
) -> CacheReadResult:
    _require_key(key)
    ttl_days, max_entries = _policy_limits(policy)
    _check_deadline(deadline)
    connection, needs_creation = _connect(path, deadline)
    try:
        with _immediate_transaction(connection, deadline):
            _maintain(connection, deadline, needs_creation, now, ttl_days, max_entries)
            _check_deadline(deadline)
            row = connection.execute(_SELECT_ROW_SQL, (key,)).fetchone()
            record = None if row is None else _row_to_record(row, key)
        if record is None:
            return CacheReadResult(status="miss")
        return CacheReadResult(status="hit", record=record)
    finally:
        _safe_close(connection)


def _write_sync(
    path: Path,
    deadline: float,
    now: float,
    policy: CachePolicyView,
    key: Any,
    record: Any,
) -> CacheWriteResult:
    stored = _validate_record(key, record)
    ttl_days, max_entries = _policy_limits(policy)
    _check_deadline(deadline)
    connection, needs_creation = _connect(path, deadline)
    try:
        with _immediate_transaction(connection, deadline):
            _maintain(connection, deadline, needs_creation, now, ttl_days, max_entries)
            _check_deadline(deadline)
            connection.execute(
                _UPSERT_ROW_SQL,
                (
                    stored.key,
                    stored.operation,
                    stored.text,
                    stored.model,
                    stored.generation_tokens,
                    stored.generated_at,
                ),
            )
            _enforce_capacity(connection, deadline, max_entries)
        return CacheWriteResult(status="stored")
    finally:
        _safe_close(connection)


# ── connection setup: permissions, pragmas, schema ─────────────


def _connect(path: Path, deadline: float) -> tuple:
    """Prepare private storage, open one connection, and inspect the schema.

    Schema inspection happens before WAL is enabled so an incompatible file is
    never rewritten: the module never migrates, deletes, or recreates it.
    Returns the connection and whether the first transaction must create the
    schema.
    """

    _prepare_storage(path)
    _check_deadline(deadline)
    connection = _open_connection(path)
    try:
        _configure(connection, deadline)
        needs_creation = _inspect_schema(connection)
        _check_deadline(deadline)
        connection.execute("PRAGMA journal_mode=WAL")
    except BaseException:
        _safe_close(connection)
        raise
    return connection, needs_creation


def _open_connection(path: Path) -> sqlite3.Connection:
    """Open the private database file.  A test seam; never public."""

    return sqlite3.connect(
        str(path),
        isolation_level=None,
        timeout=BUSY_TIMEOUT_MS / 1000.0,
    )


def _configure(connection: sqlite3.Connection, deadline: float) -> None:
    connection.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}")
    connection.execute("PRAGMA foreign_keys=ON")
    connection.set_progress_handler(_progress_handler(deadline), PROGRESS_HANDLER_STEPS)


def _progress_handler(deadline: float) -> Callable[[], int]:
    def handler() -> int:
        return 1 if _monotonic() >= deadline else 0

    return handler


def _prepare_storage(path: Path) -> None:
    """Require and establish private storage without touching umask or parents."""

    if os.name != "posix" or not hasattr(os, "geteuid"):
        return
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        _create_private_file(path)
    except OSError as exc:
        raise _CacheFailure("permission") from exc
    else:
        _ensure_private(path, info)
    for suffix in _SIDECAR_SUFFIXES:
        sidecar = path.with_name(path.name + suffix)
        try:
            sidecar_info = os.lstat(sidecar)
        except FileNotFoundError:
            continue
        except OSError as exc:
            raise _CacheFailure("permission") from exc
        _ensure_private(sidecar, sidecar_info)


def _create_private_file(path: Path) -> None:
    try:
        descriptor = os.open(
            path,
            os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_RDWR,
            _PRIVATE_MODE,
        )
    except FileExistsError:
        _ensure_private(path, os.lstat(path))
        return
    except OSError as exc:
        raise _CacheFailure("permission") from exc
    try:
        os.fchmod(descriptor, _PRIVATE_MODE)
    except OSError as exc:
        raise _CacheFailure("permission") from exc
    finally:
        os.close(descriptor)


def _ensure_private(path: Path, info: os.stat_result) -> None:
    if stat.S_ISLNK(info.st_mode):
        raise _CacheFailure("permission")
    if not stat.S_ISREG(info.st_mode):
        raise _CacheFailure("permission")
    try:
        euid = os.geteuid()
    except AttributeError:  # pragma: no cover - non-POSIX
        return
    if info.st_uid != euid:
        raise _CacheFailure("permission")
    if stat.S_IMODE(info.st_mode) != _PRIVATE_MODE:
        raise _CacheFailure("permission")


# ── schema inspection, creation, and validation ────────────────


def _inspect_schema(connection: sqlite3.Connection) -> bool:
    """Validate the schema; return True when an empty version-0 file needs setup."""

    version = _scalar(connection.execute("PRAGMA user_version"))
    if version == SCHEMA_VERSION:
        _validate_schema(connection)
        return False
    if version == 0:
        if _application_objects(connection):
            raise _CacheFailure("schema")
        return True
    raise _CacheFailure("schema")


def _application_objects(connection: sqlite3.Connection) -> list:
    rows = connection.execute("SELECT type, name FROM sqlite_master").fetchall()
    return [
        (str(row[0]), str(row[1]))
        for row in rows
        if not str(row[1]).startswith("sqlite_")
    ]


def _validate_schema(connection: sqlite3.Connection) -> None:
    if sorted(_application_objects(connection)) != sorted(
        [("index", INDEX_NAME), ("table", TABLE_NAME)]
    ):
        raise _CacheFailure("schema")

    columns = [
        tuple(
            int(value) if position in (0, 3, 5) and value is not None else value
            for position, value in enumerate(row)
        )
        for row in connection.execute(f"PRAGMA table_info({TABLE_NAME})").fetchall()
    ]
    if columns != _EXPECTED_COLUMNS:
        raise _CacheFailure("schema")

    index_rows = connection.execute(f"PRAGMA index_list({TABLE_NAME})").fetchall()
    owned = [row for row in index_rows if str(row[1]) == INDEX_NAME]
    if len(owned) != 1:
        raise _CacheFailure("schema")
    if int(owned[0][2]) != 0 or str(owned[0][3]) != "c" or int(owned[0][4]) != 0:
        raise _CacheFailure("schema")
    index_columns = [
        (str(row[2]), int(row[3]))
        for row in connection.execute(f"PRAGMA index_xinfo({INDEX_NAME})").fetchall()
        if int(row[5]) == 1
    ]
    if index_columns != _EXPECTED_INDEX_COLUMNS:
        raise _CacheFailure("schema")

    table_sql = connection.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", (TABLE_NAME,)
    ).fetchone()
    if table_sql is None or table_sql[0] is None:
        raise _CacheFailure("schema")
    if _squash(str(table_sql[0])) != _squash(_CREATE_TABLE_SQL):
        raise _CacheFailure("schema")

    index_sql = connection.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?", (INDEX_NAME,)
    ).fetchone()
    if index_sql is None or index_sql[0] is None:
        raise _CacheFailure("schema")
    if _squash(str(index_sql[0])) != _squash(_CREATE_INDEX_SQL):
        raise _CacheFailure("schema")


def _squash(text: str) -> str:
    """Drop every whitespace character, keeping case and literals intact."""

    return "".join(text.split())


def _create_schema(connection: sqlite3.Connection) -> None:
    connection.execute(_CREATE_TABLE_SQL)
    connection.execute(_CREATE_INDEX_SQL)
    connection.execute(f"PRAGMA user_version={SCHEMA_VERSION}")


# ── transactions, maintenance, row validation ─────────────────


@contextmanager
def _immediate_transaction(
    connection: sqlite3.Connection, deadline: float
) -> Iterator[None]:
    _check_deadline(deadline)
    connection.execute("BEGIN IMMEDIATE")
    try:
        yield
        _check_deadline(deadline)
        connection.execute("COMMIT")
    except BaseException:
        _rollback(connection)
        raise


def _rollback(connection: sqlite3.Connection) -> None:
    try:
        connection.execute("ROLLBACK")
    except sqlite3.Error:
        # SQLite may already have rolled the transaction back itself (for
        # example after an interrupt); there is nothing left to undo.
        pass


def _safe_close(connection: sqlite3.Connection) -> None:
    """Close the worker connection, letting cleanup failures reach the guard."""

    connection.close()


def _maintain(
    connection: sqlite3.Connection,
    deadline: float,
    _needs_creation: bool,
    now: float,
    ttl_days: int,
    max_entries: int,
) -> None:
    """Validate or create the schema, then prune expired rows and evict excess."""

    # Always re-inspect inside the operation transaction.  The preflight in
    # _connect protects incompatible files from WAL changes; this validation
    # protects the maintenance and lookup/upsert against a schema race.
    _check_deadline(deadline)
    if _inspect_schema(connection):
        _create_schema(connection)

    cutoff = now - ttl_days * SECONDS_PER_DAY
    _check_deadline(deadline)
    connection.execute(_DELETE_EXPIRED_SQL, (cutoff,))
    _enforce_capacity(connection, deadline, max_entries)


def _enforce_capacity(
    connection: sqlite3.Connection, deadline: float, max_entries: int
) -> None:
    """Delete the deterministic oldest rows until the configured bound holds."""

    _check_deadline(deadline)
    row_count = int(_scalar(connection.execute(_COUNT_ROWS_SQL)))
    if row_count > max_entries:
        _check_deadline(deadline)
        connection.execute(_DELETE_OLDEST_SQL, (row_count - max_entries,))


def _check_deadline(deadline: float) -> None:
    if _monotonic() >= deadline:
        raise _CacheFailure("timeout")


# ── value validation ───────────────────────────────────────────


def _policy_enabled(policy: Any) -> bool:
    return getattr(policy, "enabled", None) is True


def _require_enabled(policy: Any) -> None:
    """Reject a disabled policy before any filesystem or SQLite work.

    Endpoint code handles a disabled policy itself: it performs no
    initialization, read, pruning, or write and reports its own header.  A
    disabled policy reaching this module is therefore a caller defect, and a
    loud rejection is safer than inventing an outcome that could be mistaken for
    a miss or a stored row.
    """

    if not _policy_enabled(policy):
        raise DisabledCachePolicyError(
            "a disabled cache policy must not reach the cache module"
        )


def _strict_int(value: Any, bounds: tuple) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise _CacheFailure("corrupt")
    low, high = bounds
    if not low <= value <= high:
        raise _CacheFailure("corrupt")
    return value


def _policy_limits(policy: Any) -> tuple:
    ttl_days = _strict_int(getattr(policy, "ttl_days", None), _TTL_DAYS_RANGE)
    max_entries = _strict_int(getattr(policy, "max_entries", None), _MAX_ENTRIES_RANGE)
    return ttl_days, max_entries


def _require_key(key: Any) -> str:
    if not isinstance(key, str) or _KEY_RE.fullmatch(key) is None:
        raise _CacheFailure("corrupt")
    return key


def _validate_record(key: Any, record: Any) -> CacheRecord:
    stored_key = _require_key(key)
    if not isinstance(record, CacheRecord):
        raise _CacheFailure("corrupt")
    if record.key != stored_key:
        raise _CacheFailure("corrupt")
    if not isinstance(record.operation, str) or record.operation not in OPERATIONS:
        raise _CacheFailure("corrupt")
    if not isinstance(record.text, str) or record.text == "":
        raise _CacheFailure("corrupt")
    if not isinstance(record.model, str):
        raise _CacheFailure("corrupt")
    tokens = record.generation_tokens
    if not isinstance(tokens, int) or isinstance(tokens, bool) or tokens < 0:
        raise _CacheFailure("corrupt")
    return CacheRecord(
        key=stored_key,
        operation=record.operation,
        text=record.text,
        model=record.model,
        generation_tokens=tokens,
        generated_at=_finite_timestamp(record.generated_at),
    )


def _finite_timestamp(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _CacheFailure("corrupt")
    number = float(value)
    if not math.isfinite(number) or number < 0:
        raise _CacheFailure("corrupt")
    return number


def _row_to_record(row: Any, key: str) -> CacheRecord:
    if len(row) != 6:
        raise _CacheFailure("corrupt")
    cache_key, operation, output_text, model, generation_tokens, generated_at = row
    if cache_key != key:
        raise _CacheFailure("corrupt")
    if not isinstance(operation, str) or operation not in OPERATIONS:
        raise _CacheFailure("corrupt")
    if not isinstance(output_text, str) or output_text == "":
        raise _CacheFailure("corrupt")
    if not isinstance(model, str):
        raise _CacheFailure("corrupt")
    if (
        not isinstance(generation_tokens, int)
        or isinstance(generation_tokens, bool)
        or generation_tokens < 0
    ):
        raise _CacheFailure("corrupt")
    return CacheRecord(
        key=key,
        operation=operation,
        text=output_text,
        model=model,
        generation_tokens=generation_tokens,
        generated_at=_finite_timestamp(generated_at),
    )


def _scalar(cursor: Any) -> Any:
    row = cursor.fetchone()
    if row is None:
        raise _CacheFailure("schema")
    return row[0]
