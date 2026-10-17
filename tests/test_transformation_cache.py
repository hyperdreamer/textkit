"""Focused tests for the bounded SQLite transformation cache module.

Every test uses a temporary database path, a deterministic clock, and a
test-owned thread pool.  Nothing here imports ``backend.main``, contacts a
provider, or touches the real ``backend/transformation_cache.db``.
"""

from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import logging
import os
import sqlite3
import stat
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import pytest

from backend import transformation_cache
from backend.transformation_cache import (
    CacheMaintenanceResult,
    CachePolicyView,
    CacheReadResult,
    CacheRecord,
    CacheWriteResult,
    TransformationCache,
)

POSIX_ONLY = pytest.mark.skipif(
    os.name != "posix", reason="private file modes are a POSIX contract"
)

KEY_A = "a" * 64
KEY_B = "b" * 64
KEY_C = "c" * 64
KEY_D = "d" * 64
KEY_E = "e" * 64
KEY_F = "f" * 64
KEY_ZERO = "0" * 64
KEY_MISSING = "9" * 64

SECONDS_PER_DAY = 86_400
BASE_NOW = 1_000_000.0


# ── fixtures and helpers ─────────────────────────────────────────


@dataclass(frozen=True)
class FakePolicy:
    """Structural stand-in for the endpoint's immutable policy snapshot."""

    enabled: bool = True
    ttl_days: int = 30
    max_entries: int = 1000


class FakeClock:
    """Deterministic UTC clock for ``now`` resolution."""

    def __init__(self, value: float = BASE_NOW) -> None:
        self.value = float(value)

    def __call__(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += seconds


@pytest.fixture
def db_path(tmp_path: Path) -> Path:
    return tmp_path / "transformation_cache.db"


@pytest.fixture
def executor():
    pool = ThreadPoolExecutor(max_workers=2)
    try:
        yield pool
    finally:
        pool.shutdown(wait=True)


def make_cache(db_path: Path, executor, clock: FakeClock | None = None) -> TransformationCache:
    return TransformationCache(db_path, clock=clock or FakeClock(), executor=executor)


def record(
    key: str = KEY_A,
    *,
    operation: str = "format",
    text: str = "formatted output",
    model: str = "test-model",
    generation_tokens: int = 7,
    generated_at: float = BASE_NOW,
) -> CacheRecord:
    return CacheRecord(
        key=key,
        operation=operation,
        text=text,
        model=model,
        generation_tokens=generation_tokens,
        generated_at=generated_at,
    )


def raw_connect(db_path: Path) -> sqlite3.Connection:
    return sqlite3.connect(str(db_path), isolation_level=None, timeout=5.0)


def row_count(db_path: Path) -> int:
    with contextlib.closing(raw_connect(db_path)) as conn:
        return int(conn.execute("SELECT COUNT(*) FROM transformation_cache").fetchone()[0])


def wait_until(predicate, timeout: float = 5.0, interval: float = 0.005) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()


# ── connection seams used to observe the synchronous worker ──────


class RecordingConnection:
    """Delegates to a real connection while recording every statement."""

    def __init__(self, real: sqlite3.Connection) -> None:
        self._real = real
        self.statements: list[str] = []
        self.progress_handler = None
        self.progress_steps: int | None = None
        self.fail_on: str | None = None
        self.closed = False

    def execute(self, sql, params=()):
        self.statements.append(sql)
        if self.fail_on is not None and self.fail_on in sql:
            self.fail_on = None
            raise sqlite3.OperationalError("disk I/O error")
        return self._real.execute(sql, params)

    def set_progress_handler(self, handler, steps):
        self.progress_handler = handler
        self.progress_steps = steps
        self._real.set_progress_handler(handler, steps)

    def close(self) -> None:
        self.closed = True
        self._real.close()


class CloseFailingConnection(RecordingConnection):
    """Raises a SQLite failure after closing to exercise cleanup handling."""

    def close(self) -> None:
        self.closed = True
        self._real.close()
        raise sqlite3.OperationalError("close failed")


class BlockingConnection(RecordingConnection):
    """Blocks inside a chosen statement until the test releases it."""

    def __init__(self, real, *, block_on: str, entered: threading.Event, release: threading.Event):
        super().__init__(real)
        self.block_on = block_on
        self.entered = entered
        self.release = release

    def execute(self, sql, params=()):
        self.statements.append(sql)
        if self.block_on in sql:
            self.entered.set()
            if not self.release.wait(10.0):
                raise AssertionError("test did not release the blocked statement")
        return self._real.execute(sql, params)


class SlowConnection(RecordingConnection):
    """Sleeps once before its first statement to prove off-loop execution."""

    def __init__(self, real, delay: float):
        super().__init__(real)
        self.delay = delay
        self.paused = False

    def execute(self, sql, params=()):
        if not self.paused:
            self.paused = True
            time.sleep(self.delay)
        return super().execute(sql, params)


class SwitchableMonotonic:
    """Monotonic seam that can jump past a deadline on command."""

    def __init__(self, base: float) -> None:
        self.base = base
        self.expired = False

    def __call__(self) -> float:
        return self.base + (30.0 if self.expired else 0.0)


class ProgressSpyConnection(RecordingConnection):
    """Expires the deadline just before the pruning DELETE runs."""

    def __init__(self, real, *, clock: SwitchableMonotonic, handler_results: list[int]):
        super().__init__(real)
        self._clock = clock
        self.handler_results = handler_results

    def execute(self, sql, params=()):
        if "DELETE FROM transformation_cache" in sql and not self._clock.expired:
            self._clock.expired = True
        return super().execute(sql, params)

    def set_progress_handler(self, handler, steps):
        self.progress_handler = handler
        self.progress_steps = steps

        def spy() -> int:
            value = handler()
            self.handler_results.append(value)
            return value

        self._real.set_progress_handler(spy, steps)


def install_connections(monkeypatch, factory) -> list:
    """Replace the module's private connection opener with a wrapper factory."""

    connections: list = []
    original = transformation_cache._open_connection

    def opener(path):
        wrapper = factory(original(path))
        connections.append(wrapper)
        return wrapper

    monkeypatch.setattr(transformation_cache, "_open_connection", opener)
    return connections


# ── step 1: public types, record validation, exact schema ────────


def test_cache_record_rejects_malformed_key_and_values(db_path: Path, executor) -> None:
    assert isinstance(FakePolicy(), CachePolicyView)

    # result objects are immutable and self-validating
    hit = CacheReadResult(status="hit", record=record())
    with pytest.raises(dataclasses.FrozenInstanceError):
        hit.status = "miss"
    with pytest.raises(ValueError):
        CacheReadResult(status="hit")
    with pytest.raises(ValueError):
        CacheReadResult(status="unavailable")
    with pytest.raises(ValueError):
        CacheReadResult(status="miss", reason="busy")
    with pytest.raises(ValueError):
        CacheReadResult(status="unavailable", record=record(), reason="busy")
    with pytest.raises(ValueError):
        CacheReadResult(status="stored")
    with pytest.raises(ValueError):
        CacheReadResult(status="unavailable", reason="disabled")
    with pytest.raises(ValueError):
        CacheWriteResult(status="stored", reason="busy")
    with pytest.raises(ValueError):
        CacheWriteResult(status="unavailable", reason="success")
    with pytest.raises(ValueError):
        CacheWriteResult(status="unavailable")
    with pytest.raises(ValueError):
        CacheMaintenanceResult(status="ready", reason="timeout")
    with pytest.raises(ValueError):
        CacheMaintenanceResult(status="unavailable", reason="whatever")
    with pytest.raises(ValueError):
        CacheMaintenanceResult(status="unavailable")

    cache = make_cache(db_path, executor)
    policy = FakePolicy()
    valid = {
        "operation": "format",
        "text": "formatted output",
        "model": "test-model",
        "generation_tokens": 3,
        "generated_at": BASE_NOW,
    }

    bad_keys = [
        "",
        "a" * 63,
        "a" * 65,
        "A" * 64,
        "g" * 64,
        " " + "a" * 63,
        "a" * 64 + "\n",
        "0x" + "a" * 62,
        KEY_A.upper(),
        None,
        123,
        b"a" * 64,
    ]

    async def run() -> None:
        for key in bad_keys:
            read = await cache.read(key, policy)
            assert isinstance(read, CacheReadResult)
            assert (read.status, read.reason, read.record) == ("unavailable", "corrupt", None)
            stored_key = key if isinstance(key, str) else KEY_A
            write = await cache.write(key, record(stored_key, **valid), policy)
            assert isinstance(write, CacheWriteResult)
            assert (write.status, write.reason) == ("unavailable", "corrupt")

        bad_values = [
            {"operation": "ocr"},
            {"operation": "Format"},
            {"operation": ""},
            {"operation": None},
            {"text": ""},
            {"text": None},
            {"text": b"bytes"},
            {"model": None},
            {"model": 5},
            {"generation_tokens": -1},
            {"generation_tokens": True},
            {"generation_tokens": 1.5},
            {"generation_tokens": "3"},
            {"generated_at": float("nan")},
            {"generated_at": float("inf")},
            {"generated_at": float("-inf")},
            {"generated_at": -1.0},
            {"generated_at": "now"},
            {"generated_at": None},
        ]
        for overrides in bad_values:
            values = dict(valid)
            values.update(overrides)
            write = await cache.write(KEY_A, CacheRecord(key=KEY_A, **values), policy)
            assert (write.status, write.reason) == ("unavailable", "corrupt")

        # the separate key and the record key must agree
        mismatch = await cache.write(KEY_B, record(KEY_A), policy)
        assert (mismatch.status, mismatch.reason) == ("unavailable", "corrupt")

    asyncio.run(run())
    # invalid input is rejected before SQLite ever opens the database file
    assert not db_path.exists()


def test_initialize_creates_exact_version_one_schema(db_path: Path, executor) -> None:
    descriptor = os.open(db_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(descriptor)
    with contextlib.closing(raw_connect(db_path)) as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM sqlite_master").fetchone()[0] == 0

    cache = make_cache(db_path, executor)
    result = asyncio.run(cache.initialize(FakePolicy()))
    assert (result.status, result.reason) == ("ready", None)

    with contextlib.closing(raw_connect(db_path)) as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 1
        assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"

        table_info = conn.execute("PRAGMA table_info(transformation_cache)").fetchall()
        assert [tuple(row) for row in table_info] == [
            (0, "cache_key", "TEXT", 1, None, 1),
            (1, "operation", "TEXT", 1, None, 0),
            (2, "output_text", "TEXT", 1, None, 0),
            (3, "model", "TEXT", 1, None, 0),
            (4, "generation_tokens", "INTEGER", 1, None, 0),
            (5, "generated_at", "REAL", 1, None, 0),
        ]

        objects = conn.execute(
            "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' "
            "ORDER BY type, name"
        ).fetchall()
        assert [tuple(row) for row in objects] == [
            ("index", "idx_transformation_cache_generation"),
            ("table", "transformation_cache"),
        ]

        indexes = [
            row
            for row in conn.execute("PRAGMA index_list(transformation_cache)").fetchall()
            if not str(row[1]).startswith("sqlite_")
        ]
        assert [(row[1], row[2], row[3]) for row in indexes] == [
            ("idx_transformation_cache_generation", 0, "c")
        ]
        index_columns = [
            (row[2], row[3])
            for row in conn.execute(
                "PRAGMA index_xinfo(idx_transformation_cache_generation)"
            ).fetchall()
            if row[5] == 1
        ]
        assert index_columns == [("generated_at", 0), ("cache_key", 0)]

        ddl = " ".join(
            conn.execute(
                "SELECT sql FROM sqlite_master WHERE name = 'transformation_cache'"
            ).fetchone()[0].split()
        )
        assert "cache_key TEXT NOT NULL PRIMARY KEY" in ddl
        assert "operation TEXT NOT NULL CHECK (operation IN ('format', 'translate'))" in ddl
        assert "output_text TEXT NOT NULL" in ddl
        assert "model TEXT NOT NULL" in ddl
        assert "generation_tokens INTEGER NOT NULL CHECK (generation_tokens >= 0)" in ddl
        assert "generated_at REAL NOT NULL CHECK (generated_at >= 0)" in ddl

        # the CHECK constraints are enforced, not just declared
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO transformation_cache VALUES (?, 'ocr', 'x', 'm', 1, 1.0)",
                (KEY_MISSING,),
            )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO transformation_cache (cache_key, operation, output_text, model, "
                "generation_tokens, generated_at) VALUES (?, 'format', 'x', 'm', -1, 1.0)",
                (KEY_MISSING,),
            )


def test_existing_schema_validation_runs_inside_maintenance_transaction(
    db_path: Path, executor, monkeypatch
) -> None:
    cache = make_cache(db_path, executor)
    assert asyncio.run(cache.initialize(FakePolicy())).status == "ready"

    connections = install_connections(monkeypatch, RecordingConnection)
    result = asyncio.run(cache.initialize(FakePolicy()))
    assert (result.status, result.reason) == ("ready", None)

    statements = connections[0].statements
    begin = statements.index("BEGIN IMMEDIATE")
    validation = [
        index for index, statement in enumerate(statements)
        if statement == "PRAGMA user_version"
    ]
    assert len(validation) >= 2
    assert any(index > begin for index in validation)


def test_empty_version_zero_database_is_initialized_transactionally(
    db_path: Path, executor, monkeypatch
) -> None:
    connections = install_connections(monkeypatch, RecordingConnection)
    cache = make_cache(db_path, executor)
    result = asyncio.run(cache.initialize(FakePolicy()))
    assert (result.status, result.reason) == ("ready", None)

    statements = connections[0].statements
    assert statements.count("BEGIN IMMEDIATE") == 1
    assert statements.count("COMMIT") == 1
    begin = statements.index("BEGIN IMMEDIATE")
    commit = statements.index("COMMIT")
    for prefix in (
        "CREATE TABLE transformation_cache",
        "CREATE INDEX idx_transformation_cache_generation",
        "PRAGMA user_version=1",
        "DELETE FROM transformation_cache",
        "SELECT COUNT(*) FROM transformation_cache",
    ):
        position = next(
            index for index, sql in enumerate(statements) if sql.startswith(prefix)
        )
        assert begin < position < commit, prefix

    # a failure inside the initialization transaction leaves nothing behind
    partial_path = db_path.with_name("partial.db")

    def failing_factory(real):
        wrapper = RecordingConnection(real)
        wrapper.fail_on = "CREATE INDEX"
        return wrapper

    failed_connections = install_connections(monkeypatch, failing_factory)
    partial_cache = make_cache(partial_path, executor)
    failed = asyncio.run(partial_cache.initialize(FakePolicy()))
    assert failed.status == "unavailable"
    assert "ROLLBACK" in failed_connections[0].statements
    assert failed_connections[0].closed is True
    with contextlib.closing(raw_connect(partial_path)) as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM sqlite_master").fetchone()[0] == 0


@POSIX_ONLY
def test_incompatible_permissive_file_is_rejected_without_metadata_mutation(
    db_path: Path, executor, monkeypatch
) -> None:
    with contextlib.closing(raw_connect(db_path)) as conn:
        conn.execute(
            "CREATE TABLE transformation_cache (cache_key TEXT, output_text TEXT)"
        )
        conn.execute("PRAGMA user_version = 1")
    os.chmod(db_path, 0o644)
    before_bytes = db_path.read_bytes()
    before_stat = db_path.stat()
    connections = install_connections(monkeypatch, RecordingConnection)

    result = asyncio.run(make_cache(db_path, executor).initialize(FakePolicy()))

    assert (result.status, result.reason) == ("unavailable", "permission")
    assert connections == []
    after_stat = db_path.stat()
    assert db_path.read_bytes() == before_bytes
    assert stat.S_IMODE(after_stat.st_mode) == 0o644
    assert after_stat.st_ino == before_stat.st_ino


def test_incompatible_schema_returns_schema_without_recreating_file(
    db_path: Path, executor
) -> None:
    with contextlib.closing(raw_connect(db_path)) as conn:
        conn.execute(
            "CREATE TABLE transformation_cache (cache_key TEXT, output_text TEXT)"
        )
        conn.execute("PRAGMA user_version = 1")
    os.chmod(db_path, 0o600)
    before_bytes = db_path.read_bytes()
    before_stat = db_path.stat()

    cache = make_cache(db_path, executor)
    result = asyncio.run(cache.initialize(FakePolicy()))
    assert (result.status, result.reason) == ("unavailable", "schema")

    after_stat = db_path.stat()
    assert db_path.read_bytes() == before_bytes
    assert stat.S_IMODE(after_stat.st_mode) == stat.S_IMODE(before_stat.st_mode) == 0o600
    assert after_stat.st_ino == before_stat.st_ino
    with contextlib.closing(raw_connect(db_path)) as conn:
        assert [
            row[1] for row in conn.execute("PRAGMA table_info(transformation_cache)")
        ] == ["cache_key", "output_text"]
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 1


def test_extra_schema_constraint_returns_schema_without_touching_file(
    db_path: Path, executor
) -> None:
    with contextlib.closing(raw_connect(db_path)) as conn:
        conn.execute(
            "CREATE TABLE transformation_cache ("
            "cache_key TEXT NOT NULL PRIMARY KEY,"
            "operation TEXT NOT NULL CHECK (operation IN ('format', 'translate')),"
            "output_text TEXT NOT NULL,"
            "model TEXT NOT NULL,"
            "generation_tokens INTEGER NOT NULL CHECK (generation_tokens >= 0),"
            "generated_at REAL NOT NULL CHECK (generated_at >= 0),"
            "CHECK (length(output_text) > 0)"
            ")"
        )
        conn.execute(
            "CREATE INDEX idx_transformation_cache_generation "
            "ON transformation_cache (generated_at ASC, cache_key ASC)"
        )
        conn.execute("PRAGMA user_version = 1")
    os.chmod(db_path, 0o600)

    result = asyncio.run(make_cache(db_path, executor).initialize(FakePolicy()))

    assert (result.status, result.reason) == ("unavailable", "schema")


def test_unexpected_application_table_returns_schema_without_touching_file(
    db_path: Path, executor
) -> None:
    cache = make_cache(db_path, executor)
    assert asyncio.run(cache.initialize(FakePolicy())).status == "ready"
    with contextlib.closing(raw_connect(db_path)) as conn:
        conn.execute("CREATE TABLE unexpected_cache_metadata (value TEXT)")
    os.chmod(db_path, 0o600)
    before_bytes = db_path.read_bytes()
    before_stat = db_path.stat()

    result = asyncio.run(cache.initialize(FakePolicy()))
    assert (result.status, result.reason) == ("unavailable", "schema")

    after_stat = db_path.stat()
    assert db_path.read_bytes() == before_bytes
    assert stat.S_IMODE(after_stat.st_mode) == stat.S_IMODE(before_stat.st_mode) == 0o600
    assert after_stat.st_ino == before_stat.st_ino
    with contextlib.closing(raw_connect(db_path)) as conn:
        names = [
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' "
                "ORDER BY name"
            )
        ]
        assert names == ["idx_transformation_cache_generation", "transformation_cache",
                         "unexpected_cache_metadata"]


def test_version_zero_database_with_application_tables_is_not_initialized(
    db_path: Path, executor
) -> None:
    # A foreign database that merely reports user_version=0 must never be
    # adopted: the module creates a schema only in a file with no objects.
    with contextlib.closing(raw_connect(db_path)) as conn:
        conn.execute("CREATE TABLE somebody_elses_data (value TEXT)")
        conn.execute("INSERT INTO somebody_elses_data VALUES ('keep me')")
        conn.execute("PRAGMA user_version = 0")
    os.chmod(db_path, 0o600)
    before_bytes = db_path.read_bytes()
    before_stat = db_path.stat()

    cache = make_cache(db_path, executor)
    result = asyncio.run(cache.initialize(FakePolicy()))
    assert (result.status, result.reason) == ("unavailable", "schema")

    after_stat = db_path.stat()
    assert db_path.read_bytes() == before_bytes
    assert after_stat.st_ino == before_stat.st_ino
    with contextlib.closing(raw_connect(db_path)) as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 0
        assert [row[0] for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name"
        )] == ["somebody_elses_data"]
        assert conn.execute("SELECT value FROM somebody_elses_data").fetchall() == [("keep me",)]


def test_malformed_existing_row_returns_corrupt_not_miss(db_path: Path, executor) -> None:
    cache = make_cache(db_path, executor)
    assert asyncio.run(cache.write(KEY_B, record(KEY_B), FakePolicy(), now=BASE_NOW)).status == "stored"

    with contextlib.closing(raw_connect(db_path)) as conn:
        conn.execute(
            "INSERT INTO transformation_cache "
            "(cache_key, operation, output_text, model, generation_tokens, generated_at) "
            "VALUES (?, 'format', '', 'model', 'not-a-number', ?)",
            (KEY_A, BASE_NOW),
        )

    result = asyncio.run(cache.read(KEY_A, FakePolicy(), now=BASE_NOW))
    assert (result.status, result.reason, result.record) == ("unavailable", "corrupt", None)
    # the corrupt row is scoped to its own identity; healthy rows still hit
    healthy = asyncio.run(cache.read(KEY_B, FakePolicy(), now=BASE_NOW))
    assert healthy.status == "hit"


# ── step 2: maintenance, ordering, upserts, WAL, permissions ─────


def test_expiry_boundary_uses_greater_equal(db_path: Path, executor) -> None:
    cache = make_cache(db_path, executor)
    policy = FakePolicy(ttl_days=1)
    assert asyncio.run(
        cache.write(KEY_A, record(generated_at=BASE_NOW), policy, now=BASE_NOW)
    ).status == "stored"

    just_before = asyncio.run(
        cache.read(KEY_A, policy, now=BASE_NOW + SECONDS_PER_DAY - 1)
    )
    assert just_before.status == "hit"

    at_boundary = asyncio.run(cache.read(KEY_A, policy, now=BASE_NOW + SECONDS_PER_DAY))
    assert (at_boundary.status, at_boundary.reason) == ("miss", None)
    assert row_count(db_path) == 0


def test_capacity_evicts_oldest_with_key_tie_breaker(db_path: Path, executor) -> None:
    cache = make_cache(db_path, executor)
    generation_now = 1_000.0
    seeds = [(KEY_ZERO, 400.0), (KEY_F, 500.0), (KEY_E, 500.0), (KEY_D, 500.0)]
    for key, generated_at in seeds:
        assert asyncio.run(
            cache.write(
                key,
                record(key, generated_at=generated_at),
                FakePolicy(max_entries=10),
                now=generation_now,
            )
        ).status == "stored"
    assert row_count(db_path) == 4

    small = FakePolicy(max_entries=2)
    assert asyncio.run(cache.read(KEY_F, small, now=generation_now)).status == "hit"
    assert row_count(db_path) == 2
    assert asyncio.run(cache.read(KEY_E, small, now=generation_now)).status == "hit"
    assert asyncio.run(cache.read(KEY_D, small, now=generation_now)).status == "miss"
    assert asyncio.run(cache.read(KEY_ZERO, small, now=generation_now)).status == "miss"


def test_write_enforces_capacity_immediately(db_path: Path, executor) -> None:
    cache = make_cache(db_path, executor)
    policy = FakePolicy(max_entries=2)

    for key, generated_at in (
        (KEY_A, BASE_NOW - 300),
        (KEY_B, BASE_NOW - 200),
        (KEY_C, BASE_NOW - 100),
    ):
        assert asyncio.run(
            cache.write(
                key,
                record(key, generated_at=generated_at),
                policy,
                now=BASE_NOW,
            )
        ).status == "stored"
        assert row_count(db_path) <= policy.max_entries

    assert row_count(db_path) == 2


def test_capacity_is_shared_between_operations_on_read_and_write(
    db_path: Path, executor
) -> None:
    cache = make_cache(db_path, executor)
    generation_now = BASE_NOW
    big = FakePolicy(max_entries=10)
    seeds = [
        (KEY_A, "format", generation_now - 300),
        (KEY_B, "translate", generation_now - 200),
        (KEY_C, "format", generation_now - 100),
    ]
    for key, operation, generated_at in seeds:
        assert asyncio.run(
            cache.write(
                key,
                record(key, operation=operation, generated_at=generated_at),
                big,
                now=generation_now,
            )
        ).status == "stored"

    small = FakePolicy(max_entries=2)
    assert asyncio.run(cache.read(KEY_C, small, now=generation_now)).status == "hit"
    assert row_count(db_path) == 2
    assert asyncio.run(cache.read(KEY_A, small, now=generation_now)).status == "miss"
    assert asyncio.run(cache.read(KEY_B, small, now=generation_now)).status == "hit"

    # a write enforces the same shared capacity
    assert asyncio.run(
        cache.write(KEY_D, record(KEY_D, generated_at=generation_now), small, now=generation_now)
    ).status == "stored"
    assert asyncio.run(cache.read(KEY_B, small, now=generation_now)).status == "miss"
    assert asyncio.run(cache.read(KEY_C, small, now=generation_now)).status == "hit"
    assert asyncio.run(cache.read(KEY_D, small, now=generation_now)).status == "hit"
    assert row_count(db_path) == 2


def test_last_successful_write_wins_for_one_key(db_path: Path, executor) -> None:
    cache = make_cache(db_path, executor)
    policy = FakePolicy()
    first = record(
        KEY_A, text="first result", model="model-one", generation_tokens=1, generated_at=BASE_NOW - 10
    )
    second = record(
        KEY_A,
        operation="translate",
        text="second result",
        model="model-two",
        generation_tokens=42,
        generated_at=BASE_NOW,
    )
    assert asyncio.run(cache.write(KEY_A, first, policy, now=BASE_NOW)).status == "stored"
    assert asyncio.run(cache.write(KEY_A, second, policy, now=BASE_NOW)).status == "stored"

    result = asyncio.run(cache.read(KEY_A, policy, now=BASE_NOW))
    assert result.status == "hit"
    assert result.record == second
    with contextlib.closing(raw_connect(db_path)) as conn:
        stored = conn.execute(
            "SELECT operation, output_text, model, generation_tokens, generated_at "
            "FROM transformation_cache WHERE cache_key = ?",
            (KEY_A,),
        ).fetchall()
    assert stored == [("translate", "second result", "model-two", 42, BASE_NOW)]


def test_failed_or_ineligible_write_preserves_the_old_row(
    db_path: Path, executor, monkeypatch
) -> None:
    cache = make_cache(db_path, executor)
    policy = FakePolicy()
    good = record(KEY_A, text="verified result", model="model-good", generated_at=BASE_NOW - 5)
    assert asyncio.run(cache.write(KEY_A, good, policy, now=BASE_NOW)).status == "stored"

    # an invalid record is rejected before any transaction starts
    ineligible = CacheRecord(
        key=KEY_A,
        operation="format",
        text="",
        model="model-bad",
        generation_tokens=1,
        generated_at=BASE_NOW,
    )
    rejected = asyncio.run(cache.write(KEY_A, ineligible, policy, now=BASE_NOW))
    assert (rejected.status, rejected.reason) == ("unavailable", "corrupt")

    # a write that fails inside its transaction is rolled back
    def factory(real):
        wrapper = RecordingConnection(real)
        wrapper.fail_on = "INSERT INTO transformation_cache"
        return wrapper

    connections = install_connections(monkeypatch, factory)
    failed = asyncio.run(
        cache.write(KEY_A, record(KEY_A, text="replacement", model="model-bad"), policy, now=BASE_NOW)
    )
    assert (failed.status, failed.reason) == ("unavailable", "corrupt")
    assert "ROLLBACK" in connections[0].statements
    assert connections[0].closed is True

    survivor = asyncio.run(cache.read(KEY_A, policy, now=BASE_NOW))
    assert (survivor.status, survivor.record) == ("hit", good)
    with contextlib.closing(raw_connect(db_path)) as conn:
        assert conn.execute(
            "SELECT output_text, model FROM transformation_cache WHERE cache_key = ?",
            (KEY_A,),
        ).fetchall() == [("verified result", "model-good")]


def test_read_hit_does_not_extend_ttl(db_path: Path, executor) -> None:
    cache = make_cache(db_path, executor)
    policy = FakePolicy(ttl_days=1)
    generated_at = BASE_NOW
    assert asyncio.run(
        cache.write(KEY_A, record(generated_at=generated_at), policy, now=generated_at)
    ).status == "stored"

    hit = asyncio.run(
        cache.read(KEY_A, policy, now=generated_at + SECONDS_PER_DAY // 2)
    )
    assert hit.status == "hit"
    with contextlib.closing(raw_connect(db_path)) as conn:
        assert conn.execute(
            "SELECT generated_at FROM transformation_cache WHERE cache_key = ?", (KEY_A,)
        ).fetchone()[0] == generated_at

    expired = asyncio.run(cache.read(KEY_A, policy, now=generated_at + SECONDS_PER_DAY))
    assert expired.status == "miss"


def test_policy_edit_applies_on_next_enabled_access(db_path: Path, executor) -> None:
    cache = make_cache(db_path, executor)
    generated_at = BASE_NOW
    assert asyncio.run(
        cache.write(
            KEY_A, record(generated_at=generated_at), FakePolicy(ttl_days=30), now=generated_at
        )
    ).status == "stored"

    # a shorter TTL expires the stored row on the next enabled access
    later = generated_at + 2 * SECONDS_PER_DAY
    assert asyncio.run(cache.read(KEY_A, FakePolicy(ttl_days=1), now=later)).status == "miss"
    assert row_count(db_path) == 0
    # restoring the longer TTL cannot restore a pruned row
    assert asyncio.run(cache.read(KEY_A, FakePolicy(ttl_days=30), now=generated_at)).status == "miss"

    # a lower capacity applies on the next enabled access, even to a hit
    for key, offset in ((KEY_A, 300), (KEY_B, 200), (KEY_C, 100)):
        assert asyncio.run(
            cache.write(
                key,
                record(key, generated_at=generated_at - offset),
                FakePolicy(max_entries=10),
                now=generated_at,
            )
        ).status == "stored"
    assert row_count(db_path) == 3
    hit = asyncio.run(cache.read(KEY_C, FakePolicy(max_entries=1), now=generated_at))
    assert (hit.status, hit.record.text) == ("hit", "formatted output")
    assert row_count(db_path) == 1
    assert asyncio.run(cache.read(KEY_A, FakePolicy(max_entries=1), now=generated_at)).status == "miss"


class ExplodingExecutor:
    """Fails loudly if a disabled policy submits any worker job."""

    def submit(self, *args, **kwargs):
        raise AssertionError("a disabled cache policy must not submit worker work")


def test_disabled_policy_retains_rows_and_does_no_database_work(
    db_path: Path, executor
) -> None:
    disabled = FakePolicy(enabled=False)
    missing_path = db_path.with_name("never-created.db")
    disabled_cache = TransformationCache(
        missing_path, clock=FakeClock(), executor=ExplodingExecutor()
    )

    # a disabled policy never enters this module: the endpoint owns that branch,
    # and every operation refuses before queueing or touching the filesystem
    with pytest.raises(transformation_cache.DisabledCachePolicyError):
        asyncio.run(disabled_cache.initialize(disabled))
    with pytest.raises(transformation_cache.DisabledCachePolicyError):
        asyncio.run(disabled_cache.read(KEY_A, disabled))
    with pytest.raises(transformation_cache.DisabledCachePolicyError):
        asyncio.run(disabled_cache.write(KEY_A, record(), disabled))
    assert not missing_path.exists()

    cache = make_cache(db_path, executor)
    assert asyncio.run(cache.write(KEY_A, record(), FakePolicy(), now=BASE_NOW)).status == "stored"
    before = db_path.read_bytes()
    before_stat = db_path.stat()

    with pytest.raises(transformation_cache.DisabledCachePolicyError):
        asyncio.run(disabled_cache.read(KEY_A, disabled))
    with pytest.raises(transformation_cache.DisabledCachePolicyError):
        asyncio.run(disabled_cache.initialize(disabled))
    with pytest.raises(transformation_cache.DisabledCachePolicyError):
        asyncio.run(disabled_cache.write(KEY_B, record(KEY_B), disabled))

    # existing rows are neither pruned nor overwritten while caching is disabled
    assert db_path.read_bytes() == before
    assert db_path.stat().st_mtime_ns == before_stat.st_mtime_ns
    assert asyncio.run(cache.read(KEY_A, FakePolicy(), now=BASE_NOW)).status == "hit"


@POSIX_ONLY
def test_wal_sidecars_are_private_after_a_real_write(
    db_path: Path, executor, monkeypatch
) -> None:
    # An existing permissive database is rejected rather than narrowed.
    with contextlib.closing(raw_connect(db_path)):
        pass
    os.chmod(db_path, 0o644)
    before_bytes = db_path.read_bytes()
    before_stat = db_path.stat()
    connections = install_connections(monkeypatch, RecordingConnection)

    cache = make_cache(db_path, executor)
    rejected = asyncio.run(cache.initialize(FakePolicy()))
    assert (rejected.status, rejected.reason) == ("unavailable", "permission")
    assert connections == []
    assert db_path.read_bytes() == before_bytes
    assert stat.S_IMODE(db_path.stat().st_mode) == stat.S_IMODE(before_stat.st_mode) == 0o644

    os.chmod(db_path, 0o600)
    assert asyncio.run(cache.initialize(FakePolicy())).status == "ready"

    witness = raw_connect(db_path)
    try:
        witness.execute("PRAGMA journal_mode=WAL").fetchone()
        result = asyncio.run(cache.write(KEY_A, record(), FakePolicy(), now=BASE_NOW))
        assert result.status == "stored"

        assert stat.S_IMODE(db_path.stat().st_mode) == 0o600
        sidecars = [
            db_path.with_name(db_path.name + suffix) for suffix in ("-wal", "-shm")
        ]
        for sidecar in sidecars:
            assert sidecar.exists(), f"{sidecar.name} missing after a WAL write"
            info = os.lstat(sidecar)
            assert stat.S_ISREG(info.st_mode)
            assert not stat.S_ISLNK(info.st_mode)
            assert stat.S_IMODE(info.st_mode) == 0o600
            assert info.st_uid == os.geteuid()
    finally:
        witness.close()


@POSIX_ONLY
def test_permissive_sidecars_and_symlinks_are_rejected(
    db_path: Path, executor, monkeypatch
) -> None:
    cache = make_cache(db_path, executor)
    connections = install_connections(monkeypatch, RecordingConnection)
    assert asyncio.run(cache.initialize(FakePolicy())).status == "ready"
    # keep the WAL and SHM sidecars alive with a second connection
    witness = raw_connect(db_path)
    try:
        witness.execute("PRAGMA journal_mode=WAL").fetchone()
        assert asyncio.run(cache.write(KEY_A, record(), FakePolicy(), now=BASE_NOW)).status == "stored"
        wal = db_path.with_name(db_path.name + "-wal")
        shm = db_path.with_name(db_path.name + "-shm")
        assert wal.exists() and shm.exists()

        # a permissive sidecar is rejected without opening the database
        os.chmod(wal, 0o666)
        os.chmod(shm, 0o666)
        connection_count = len(connections)
        rejected = asyncio.run(cache.read(KEY_A, FakePolicy(), now=BASE_NOW))
        assert (rejected.status, rejected.reason) == ("unavailable", "permission")
        assert len(connections) == connection_count
        assert stat.S_IMODE(os.lstat(wal).st_mode) == 0o666
        assert stat.S_IMODE(os.lstat(shm).st_mode) == 0o666

        # a symlinked sidecar is refused rather than followed to another file
        os.chmod(wal, 0o600)
        os.unlink(shm)
        target = db_path.with_name("attacker-controlled-shm")
        target.write_bytes(b"")
        os.chmod(target, 0o600)
        os.symlink(target, shm)
        connection_count = len(connections)
        symlinked = asyncio.run(cache.read(KEY_A, FakePolicy(), now=BASE_NOW))
        assert (symlinked.status, symlinked.reason) == ("unavailable", "permission")
        assert len(connections) == connection_count
    finally:
        witness.close()


def test_independent_handles_share_committed_rows(db_path: Path, executor) -> None:
    first_cache = make_cache(db_path, executor)
    second_cache = make_cache(db_path, executor)
    stored = record(KEY_A, text="shared across handles", generated_at=BASE_NOW - 5)
    assert asyncio.run(first_cache.write(KEY_A, stored, FakePolicy(), now=BASE_NOW)).status == "stored"

    result = asyncio.run(second_cache.read(KEY_A, FakePolicy(), now=BASE_NOW))
    assert (result.status, result.record) == ("hit", stored)

    other = asyncio.run(second_cache.read(KEY_B, FakePolicy(), now=BASE_NOW))
    assert (other.status, other.reason, other.record) == ("miss", None, None)


# ── step 3: contention, deadlines, cancellation, sanitized errors ─


def test_busy_timeout_is_bounded_and_returns_busy(db_path: Path, executor, monkeypatch) -> None:
    assert transformation_cache.BUSY_TIMEOUT_MS <= 100
    assert transformation_cache.BUDGET_SECONDS == 0.5

    cache = make_cache(db_path, executor)
    assert asyncio.run(cache.initialize(FakePolicy())).status == "ready"

    connections = install_connections(monkeypatch, RecordingConnection)
    blocker = raw_connect(db_path)
    try:
        blocker.execute("BEGIN EXCLUSIVE")
        started = time.monotonic()
        result = asyncio.run(cache.read(KEY_A, FakePolicy(), now=BASE_NOW))
        elapsed = time.monotonic() - started
    finally:
        with contextlib.suppress(sqlite3.Error):
            blocker.execute("ROLLBACK")
        blocker.close()

    assert (result.status, result.reason) == ("unavailable", "busy")
    assert elapsed <= 0.4
    assert "PRAGMA busy_timeout=100" in connections[0].statements
    assert connections[0].closed is True


def test_queue_delay_counts_against_the_500ms_budget(db_path: Path) -> None:
    pool = ThreadPoolExecutor(max_workers=1)
    gate = threading.Event()
    entered = threading.Event()

    def hogs_the_only_worker() -> None:
        entered.set()
        gate.wait(10.0)

    try:
        cache = TransformationCache(db_path, clock=FakeClock(), executor=pool)
        assert asyncio.run(cache.initialize(FakePolicy())).status == "ready"

        pool.submit(hogs_the_only_worker)
        assert entered.wait(5.0)

        started = time.monotonic()
        result = asyncio.run(cache.read(KEY_A, FakePolicy(), now=BASE_NOW))
        elapsed = time.monotonic() - started
    finally:
        gate.set()
        pool.shutdown(wait=True)

    assert (result.status, result.reason) == ("unavailable", "timeout")
    assert 0.4 <= elapsed <= 2.0


def test_progress_handler_interrupts_sql_work(db_path: Path, executor, monkeypatch) -> None:
    cache = make_cache(db_path, executor)
    assert asyncio.run(cache.initialize(FakePolicy(max_entries=100_000))).status == "ready"

    # enough rows that the pruning DELETE executes well over one progress step
    with contextlib.closing(raw_connect(db_path)) as conn:
        conn.execute("BEGIN IMMEDIATE")
        conn.executemany(
            "INSERT INTO transformation_cache VALUES (?, 'format', 'seed text', 'model', 1, ?)",
            ((f"{index:064x}", float(index)) for index in range(20_000)),
        )
        conn.execute("COMMIT")
    assert row_count(db_path) == 20_000

    # one-day TTL with a much later ``now`` makes the pruning DELETE touch every
    # seeded row, so the deadline has to be enforced inside the statement
    monotonic = SwitchableMonotonic(time.monotonic())
    monkeypatch.setattr(transformation_cache, "_monotonic", monotonic)
    handler_results: list[int] = []

    def factory(real):
        return ProgressSpyConnection(real, clock=monotonic, handler_results=handler_results)

    connections = install_connections(monkeypatch, factory)
    result = asyncio.run(
        cache.read(KEY_MISSING, FakePolicy(ttl_days=1, max_entries=100_000), now=1_000_000.0)
    )

    assert (result.status, result.reason) == ("unavailable", "timeout")
    connection = connections[0]
    assert connection.progress_steps == transformation_cache.PROGRESS_HANDLER_STEPS
    assert connection.progress_handler is not None
    assert 1 in handler_results
    assert connection.closed is True
    # the interrupted maintenance transaction rolled back
    assert row_count(db_path) == 20_000


def test_cancelled_read_reraises_and_closes_worker_connection(
    db_path: Path, monkeypatch
) -> None:
    pool = ThreadPoolExecutor(max_workers=1)
    entered = threading.Event()
    release = threading.Event()
    try:
        cache = TransformationCache(db_path, clock=FakeClock(), executor=pool)
        assert asyncio.run(cache.initialize(FakePolicy())).status == "ready"

        def factory(real):
            return BlockingConnection(
                real,
                block_on="FROM transformation_cache WHERE cache_key",
                entered=entered,
                release=release,
            )

        connections = install_connections(monkeypatch, factory)

        async def scenario() -> None:
            task = asyncio.create_task(cache.read(KEY_A, FakePolicy(), now=BASE_NOW))
            assert await asyncio.to_thread(entered.wait, 5.0)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert task.cancelled()

        asyncio.run(scenario())
        assert connections[0].closed is False
        release.set()
        assert wait_until(lambda: connections[0].closed)
    finally:
        release.set()
        pool.shutdown(wait=True)


def test_eligible_write_may_finish_after_caller_cancellation(
    db_path: Path, monkeypatch
) -> None:
    pool = ThreadPoolExecutor(max_workers=1)
    entered = threading.Event()
    release = threading.Event()
    stored_text = "committed after caller cancellation"
    try:
        cache = TransformationCache(db_path, clock=FakeClock(), executor=pool)
        assert asyncio.run(cache.initialize(FakePolicy())).status == "ready"

        def factory(real):
            return BlockingConnection(
                real,
                block_on="INSERT INTO transformation_cache",
                entered=entered,
                release=release,
            )

        connections = install_connections(monkeypatch, factory)
        eligible = record(KEY_A, text=stored_text)

        async def scenario() -> None:
            task = asyncio.create_task(cache.write(KEY_A, eligible, FakePolicy(), now=BASE_NOW))
            assert await asyncio.to_thread(entered.wait, 5.0)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

        asyncio.run(scenario())
        release.set()
        assert wait_until(lambda: connections[0].closed)
    finally:
        release.set()
        pool.shutdown(wait=True)

    reader = TransformationCache(db_path, clock=FakeClock())
    result = asyncio.run(reader.read(KEY_A, FakePolicy(), now=BASE_NOW))
    assert (result.status, result.record.text) == ("hit", stored_text)


def test_unexpected_worker_failure_is_allowlisted(
    db_path: Path, executor, monkeypatch
) -> None:
    def exploding_opener(path):
        raise RuntimeError("worker secret should not escape")

    monkeypatch.setattr(transformation_cache, "_open_connection", exploding_opener)
    result = asyncio.run(make_cache(db_path, executor).read(KEY_A, FakePolicy()))

    assert (result.status, result.reason) == ("unavailable", "corrupt")


def test_cache_work_does_not_block_the_event_loop(db_path: Path, executor, monkeypatch) -> None:
    def factory(real):
        return SlowConnection(real, delay=0.05)

    install_connections(monkeypatch, factory)
    cache = make_cache(db_path, executor)

    async def scenario():
        ticks = 0
        running = True

        async def ticker() -> None:
            nonlocal ticks
            while running:
                ticks += 1
                await asyncio.sleep(0.002)

        task = asyncio.create_task(ticker())
        try:
            result = await cache.initialize(FakePolicy())
        finally:
            running = False
            await task
        return result, ticks

    result, ticks = asyncio.run(scenario())
    assert (result.status, result.reason) == ("ready", None)
    assert ticks >= 5


@POSIX_ONLY
def test_permission_schema_and_corrupt_failures_are_allowlisted(
    db_path: Path, executor, monkeypatch
) -> None:
    cache = make_cache(db_path, executor)

    # a directory is not a usable private database file
    directory = db_path.with_name("cache-as-directory")
    directory.mkdir()
    permission = asyncio.run(
        TransformationCache(directory, clock=FakeClock(), executor=executor).read(
            KEY_A, FakePolicy()
        )
    )
    assert (permission.status, permission.reason) == ("unavailable", "permission")

    # a symlink is rejected rather than followed
    real_path = db_path.with_name("real.db")
    assert asyncio.run(
        TransformationCache(real_path, clock=FakeClock(), executor=executor).initialize(FakePolicy())
    ).status == "ready"
    link = db_path.with_name("link.db")
    os.symlink(real_path, link)
    symlinked = asyncio.run(
        TransformationCache(link, clock=FakeClock(), executor=executor).read(KEY_A, FakePolicy())
    )
    assert (symlinked.status, symlinked.reason) == ("unavailable", "permission")

    # a file owned by another user is rejected
    foreign = db_path.with_name("foreign.db")
    with contextlib.closing(raw_connect(foreign)):
        pass
    os.chmod(foreign, 0o600)
    real_geteuid = os.geteuid
    monkeypatch.setattr(transformation_cache.os, "geteuid", lambda: real_geteuid() + 1)
    unowned = asyncio.run(
        TransformationCache(foreign, clock=FakeClock(), executor=executor).initialize(FakePolicy())
    )
    monkeypatch.undo()
    assert (unowned.status, unowned.reason) == ("unavailable", "permission")

    # a schema version the module does not own
    versioned = db_path.with_name("versioned.db")
    with contextlib.closing(raw_connect(versioned)) as conn:
        conn.execute("CREATE TABLE transformation_cache (cache_key TEXT)")
        conn.execute("PRAGMA user_version = 2")
    os.chmod(versioned, 0o600)
    schema = asyncio.run(
        TransformationCache(versioned, clock=FakeClock(), executor=executor).initialize(FakePolicy())
    )
    assert (schema.status, schema.reason) == ("unavailable", "schema")

    # a file that is not a SQLite database at all
    garbage = db_path.with_name("garbage.db")
    garbage.write_bytes(b"this is not a sqlite database" * 64)
    os.chmod(garbage, 0o600)
    corrupt = asyncio.run(
        TransformationCache(garbage, clock=FakeClock(), executor=executor).read(KEY_A, FakePolicy())
    )
    assert (corrupt.status, corrupt.reason) == ("unavailable", "corrupt")

    reasons = {permission.reason, symlinked.reason, unowned.reason, schema.reason, corrupt.reason}
    assert reasons <= transformation_cache.FAILURE_REASONS


class CapturingHandler(logging.Handler):
    def __init__(self) -> None:
        super().__init__()
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)


def test_cleanup_failure_is_mapped_once(
    db_path: Path, executor, monkeypatch, caplog
) -> None:
    install_connections(monkeypatch, CloseFailingConnection)
    caplog.set_level(logging.WARNING, logger=transformation_cache.logger.name)

    result = asyncio.run(make_cache(db_path, executor).initialize(FakePolicy()))

    assert (result.status, result.reason) == ("unavailable", "corrupt")
    cache_records = [
        item for item in caplog.records
        if item.name == transformation_cache.logger.name
    ]
    assert len(cache_records) == 1
    assert cache_records[0].getMessage() == transformation_cache.FAILURE_MESSAGE
    assert cache_records[0].reason == "corrupt"


@POSIX_ONLY
def test_cache_failure_logs_no_identity_text_or_raw_exception(
    tmp_path: Path, executor
) -> None:
    logger = transformation_cache.logger
    handler = CapturingHandler()
    previous_level = logger.level
    logger.addHandler(handler)
    logger.setLevel(logging.DEBUG)
    try:
        secret_dir = tmp_path / "SECRET-PROMPT-must-not-be-logged" / "nested"
        secret_dir.mkdir(parents=True)

        unusable_directory = secret_dir / "transformation_cache.db"
        unusable_directory.mkdir()
        permission = asyncio.run(
            TransformationCache(
                unusable_directory, clock=FakeClock(), executor=executor
            ).read(KEY_A, FakePolicy())
        )

        corrupt_path = secret_dir / "corrupt_cache.db"
        corrupt_path.write_bytes(b"not a database" * 128)
        os.chmod(corrupt_path, 0o600)
        corrupt = asyncio.run(
            TransformationCache(corrupt_path, clock=FakeClock(), executor=executor).read(
                KEY_A, FakePolicy()
            )
        )
    finally:
        logger.removeHandler(handler)
        logger.setLevel(previous_level)

    assert (permission.status, permission.reason) == ("unavailable", "permission")
    assert (corrupt.status, corrupt.reason) == ("unavailable", "corrupt")
    assert len(handler.records) == 2
    for log_record, expected_reason in zip(handler.records, ("permission", "corrupt")):
        assert log_record.getMessage() == transformation_cache.FAILURE_MESSAGE
        assert getattr(log_record, "reason") == expected_reason
        assert log_record.reason in transformation_cache.FAILURE_REASONS
        assert log_record.exc_info is None
        rendered = log_record.getMessage() + repr(log_record.__dict__)
        assert "SECRET-PROMPT" not in rendered
        assert KEY_A not in rendered
        assert "not a database" not in rendered
        assert "transformation_cache.db" not in rendered
