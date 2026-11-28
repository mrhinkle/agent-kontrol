#!/usr/bin/env python3
"""No-signal tests for the stop control unit (#211).

These tests are the proof only when tests/unit/run_ak_stop_control_virtual.sh
runs them inside the unprivileged python:3.12-bookworm image. That runner uses
a private PID namespace (this interpreter is PID 1 with parent 0), --network
none, a read-only source mount, and scratch under /tmp.

Ordinary host discovery (``pnpm test`` runs ``unittest discover -s tests/unit``)
skips the whole class because ``os.getpid() != 1 or os.getppid() != 0``. When
the runner sets AK_STOP_CONTROL_VIRTUAL=1 and the process is not that PID 1,
import fails, so a runner that lost its namespace cannot pass by skipping.

Inside the container every signal syscall is replaced before the module is
imported. The module itself has no signal port except the recording fake
passed in here.
"""
from __future__ import annotations

import ast
import inspect
import json
import os
import sys
import threading
import unittest
from pathlib import Path

DISPATCHER_DIR = Path(__file__).resolve().parents[2] / "agents" / "dispatcher"
sys.path.insert(0, str(DISPATCHER_DIR))

IN_PRIVATE_PID_NAMESPACE = os.getpid() == 1 and os.getppid() == 0
if os.environ.get("AK_STOP_CONTROL_VIRTUAL") == "1" and not IN_PRIVATE_PID_NAMESPACE:
    raise RuntimeError("the virtual runner must run this suite as PID 1 in a private PID namespace")


def _forbid_signal(*_args, **_kwargs):
    raise AssertionError("stop control virtual test invoked a signal syscall")


if IN_PRIVATE_PID_NAMESPACE:
    # Only inside the container: host discovery shares this process with other suites.
    os.kill = _forbid_signal
    os.killpg = _forbid_signal

import ak_stop_control as stop  # noqa: E402

SELF_PID = 50
SELF_PGID = 50
TASK_ID = 41


def matching(identity, **overrides):
    fields = {
        "status": "present",
        "pid": identity.pid,
        "pgid": identity.pgid,
        "role": identity.role,
        "phase": identity.phase,
        "birth": identity.birth,
        "ancestry": identity.ancestry,
        "group_status": "unknown",
    }
    fields.update(overrides)
    return stop.Observation(**fields)


def absent_group(identity):
    return matching(identity, status="absent", group_status="empty")


def durable_cleanup():
    return stop.CleanupConfirmation("complete", "complete", True)


class Clock:
    def __init__(self):
        self.now = 0.0

    def monotonic(self):
        return self.now


class Journal:
    def __init__(self, fail=None):
        self.records = []
        self.clears = 0
        self.events = []
        self.fail = fail
        self.fail_clear = False

    def persist(self, record):
        if record.get("signal_authorized") is not False:
            raise AssertionError("journal record authorized a signal")
        if stop.signal_targets_from_record(record) != ():
            raise AssertionError("journal record produced a signal target")
        if record.get("task_marked_done") is not False:
            raise AssertionError("journal recorded task success")
        claim = record.get("claim")
        exact = record.get("exact_task_match_proven")
        if type(exact) is not bool:
            raise AssertionError("journal exact_task_match_proven is not a bool")
        if claim is None and exact:
            raise AssertionError("journal proved an exact match without a claim")
        if claim is not None and claim.get("exact_task_match_proven") is not exact:
            raise AssertionError("journal claim and top-level exact match disagree")
        if record.get("requeue") is not False:
            raise AssertionError("journal recorded a requeue")
        if self.fail and self.fail(record):
            self.events.append(("persist-failed", record.get("outcome")))
            raise OSError("journal failed")
        stored = json.loads(json.dumps(record))
        self.records.append(stored)
        self.events.append(("persist", stored.get("outcome"), stored.get("cleanup_state")))

    def snapshot(self):
        if not self.records:
            raise AssertionError("journal has no record")
        return self.records[-1]

    def clear(self):
        self.events.append(("clear-attempt",))
        if self.fail_clear:
            raise OSError("clear failed")
        self.records.clear()
        self.clears += 1


class GateJournal(Journal):
    """Block the first persist after arm() so another thread can race the lock."""

    def __init__(self):
        super().__init__()
        self.armed = False
        self.used = False
        self.entered = threading.Event()
        self.release = threading.Event()

    def persist(self, record):
        if self.armed and not self.used:
            self.used = True
            self.entered.set()
            if not self.release.wait(5):
                raise TimeoutError("stop persist was not released")
        super().persist(record)


class Observer:
    """Scripted observer. After the fake port reports a group absent, the default is absent."""

    def __init__(self):
        self.calls = []
        self.script = []
        self.gone = False
        self.events = None
        self.lock = None
        self.held = []

    def observe(self, identity):
        self.calls.append(identity)
        if self.events is not None:
            self.events.append(("observe", identity.pgid))
        if self.lock is not None:
            self.held.append(self.lock.locked())
        if self.script:
            step = self.script.pop(0)
            return step(identity) if callable(step) else step
        if self.gone:
            return matching(identity, status="absent")
        return matching(identity)


class Signals:
    def __init__(self, results=None):
        self.calls = []
        self.results = list(results or [])
        self.observer = None
        self.events = None
        self.lock = None
        self.held = []

    def signal_group(self, pgid, sig):
        self.calls.append((pgid, sig))
        if self.events is not None:
            self.events.append(("signal", pgid, sig))
        if self.lock is not None:
            self.held.append(self.lock.locked())
        if pgid <= 1 or pgid == SELF_PGID:
            raise AssertionError(f"fake port was asked to signal {pgid}")
        result = self.results.pop(0) if self.results else "delivered"
        if isinstance(result, BaseException):
            raise result
        if result == "absent" and self.observer is not None:
            self.observer.gone = True
        return result


class ObservableLock:
    def __init__(self):
        self._mutex = threading.Lock()
        self._condition = threading.Condition()
        self.waiters = 0

    def acquire(self, blocking=True, timeout=-1):
        with self._condition:
            self.waiters += 1
            self._condition.notify_all()
        try:
            return self._mutex.acquire(blocking, timeout)
        finally:
            with self._condition:
                self.waiters -= 1
                self._condition.notify_all()

    def release(self):
        self._mutex.release()

    def locked(self):
        return self._mutex.locked()

    def wait_for_waiter(self, timeout, count=1):
        with self._condition:
            return self._condition.wait_for(lambda: self.waiters >= count, timeout)


class Flag:
    def __init__(self, value=False):
        self.value = value

    def __call__(self):
        return self.value


def worker(pid=100, pgid=100, birth="birth-worker"):
    return stop.OwnedIdentity(pid, pgid, "worker", "worker", birth, (SELF_PID,))


def reviewer(pid=200, pgid=200, birth="birth-reviewer"):
    return stop.OwnedIdentity(pid, pgid, "reviewer", "review", birth, (SELF_PID,))


@unittest.skipUnless(
    IN_PRIVATE_PID_NAMESPACE,
    "stop control tests run only as PID 1 in tests/unit/run_ak_stop_control_virtual.sh",
)
class StopControlTests(unittest.TestCase):
    def controller(self, *, predicate=None, observer=None, signals=None, journal=None, clock=None,
                   grace=1.0, stop_budget=5.0, lock=None):
        clock = clock or Clock()
        journal = journal or Journal()
        observer = observer or Observer()
        signals = signals or Signals()
        if signals.observer is None:
            signals.observer = observer

        def wait(seconds):
            if not isinstance(seconds, (int, float)) or isinstance(seconds, bool) or seconds < 0:
                raise AssertionError("bad wait")
            clock.now += seconds

        ctl = stop.StopController(
            self_identity=stop.SelfIdentity(SELF_PID, SELF_PGID),
            predicate=predicate or Flag(False),
            observer=observer,
            signals=signals,
            journal=journal,
            clock=clock,
            wait=wait,
            grace=grace,
            stop_budget=stop_budget,
            lock=lock,
        )
        return ctl, signals, observer, journal, clock

    def claim(self, ctl):
        opened = ctl.before_claim()
        self.assertEqual(opened.code, "claim_permitted")
        claimed = ctl.note_claimed(TASK_ID, exact_claim=True)
        self.assertEqual(claimed.code, "claimed")
        self.assertTrue(claimed.exact_task_match_proven)
        self.assertFalse(claimed.task_marked_done)
        return claimed

    def register_worker(self, ctl):
        self.claim(ctl)
        self.assertEqual(ctl.begin_launch("worker").code, "launch_open")
        registered = ctl.register(worker())
        self.assertEqual(registered.code, "registered", registered.code)
        self.assertEqual(ctl.confirm_ack().code, "ack_confirmed")
        return registered

    def assert_no_task_success(self, decision):
        self.assertFalse(decision.task_marked_done)
        self.assertFalse(decision.requeue)

    def assert_signal_log(self, fake, expected):
        self.assertEqual(tuple(fake.calls), tuple(expected))
        for pgid, sig in fake.calls:
            self.assertIs(type(pgid), int)
            self.assertGreater(pgid, 1)
            self.assertNotEqual(pgid, SELF_PGID)
            self.assertIn(sig, (stop.SIGTERM, stop.SIGKILL))

    def test_process_is_container_init(self):
        self.assertEqual(os.getpid(), 1, "virtual tests must be PID 1 in a private container namespace")
        self.assertEqual(os.getppid(), 0)

    def test_sources_do_not_invoke_signal_syscalls(self):
        product = ast.parse(inspect.getsource(stop))
        self.assert_no_signal_ops(product, allow_os=False)
        own = ast.parse(inspect.getsource(sys.modules[__name__]))
        self.assert_no_signal_ops(own, allow_os=True)
        text = inspect.getsource(stop)
        self.assertNotIn("dispatcher-held-unit2", text)
        self.assertNotIn("mc_dispatcher", text.split('"""', 2)[2] if text.count('"""') >= 2 else text)
        self.assertIn("exact_task_match_proven", text)
        self.assertNotIn("EXACT_TASK_MATCH_PREREQUISITE", text)
        self.assertIn("task_id", stop.CLAIM_ROUTE)
        self.assertIn("claims no other row", stop.CLAIM_ROUTE)

    def assert_no_signal_ops(self, tree, *, allow_os):
        forbidden_roots = {
            "signal", "subprocess", "socket", "ctypes", "multiprocessing", "pty",
            "mc_dispatcher", "ak_skill_launch", "ak_pointers", "dispatch_ready_bridge",
            "urllib", "http", "requests", "importlib",
        }
        if not allow_os:
            forbidden_roots |= {"os", "pathlib", "io", "shutil", "tempfile"}
        forbidden_calls = {"kill", "killpg", "pthread_kill", "system", "Popen", "popen", "execvp", "execve", "fork"}
        if not allow_os:
            forbidden_calls |= {"open", "getenv", "__import__", "eval", "exec", "compile"}
        problems = []

        class Visitor(ast.NodeVisitor):
            def visit_Import(self, node):
                for alias in node.names:
                    root = alias.name.split(".")[0]
                    if root in forbidden_roots:
                        problems.append(alias.name)
                self.generic_visit(node)

            def visit_ImportFrom(self, node):
                root = (node.module or "").split(".")[0]
                if root in forbidden_roots:
                    problems.append(node.module)
                self.generic_visit(node)

            def visit_Call(self, node):
                name = None
                if isinstance(node.func, ast.Name):
                    name = node.func.id
                elif isinstance(node.func, ast.Attribute):
                    name = node.func.attr
                if name in forbidden_calls:
                    problems.append(name)
                self.generic_visit(node)

            def visit_Attribute(self, node):
                if not allow_os and node.attr in {"kill", "killpg", "environ", "getenv"}:
                    problems.append(node.attr)
                self.generic_visit(node)

        Visitor().visit(tree)
        self.assertEqual(problems, [])

    def test_stop_before_claim_skips_claim_and_signals_nothing(self):
        ctl, fake, _observer, journal, _clock = self.controller(predicate=Flag(True))
        decision = ctl.before_claim()
        self.assertEqual(decision.code, "stop_before_claim")
        self.assertFalse(decision.allowed)
        self.assert_signal_log(fake, [])
        self.assert_no_task_success(decision)
        finished = ctl.finish(phase_completed=False)
        self.assertEqual(finished.code, "cleanup_pending")
        self.assertTrue(finished.lock_release_permitted)
        self.assertTrue(finished.pointer_cleanup_permitted)
        self.assertFalse(finished.phase_finished)
        self.assertEqual(journal.clears, 0)
        self.assertEqual(journal.snapshot()["cleanup_state"], "pending")
        self.assertIsNone(journal.snapshot()["cleanup_confirmation"])
        self.assertEqual(ctl.note_claimed(TASK_ID, exact_claim=True).code, "invalid_transition")
        cleared = ctl.confirm_cleanup_durable(durable_cleanup())
        self.assertEqual(cleared.code, "cleanup_confirmed")
        self.assertFalse(cleared.phase_finished)
        self.assertEqual(journal.clears, 1)
        self.assertEqual(journal.records, [])
        self.assertEqual(
            [event for event in journal.events if event == ("clear-attempt",) or event[0] == "persist"][-2:],
            [("persist", "cleanup_confirmed", "confirmed"), ("clear-attempt",)],
        )

    def test_stop_after_claim_leaves_claim_truthful(self):
        flag = Flag(False)
        ctl, fake, _observer, _journal, _clock = self.controller(predicate=flag)
        self.assertEqual(ctl.before_claim().code, "claim_permitted")
        flag.value = True
        decision = ctl.note_claimed(TASK_ID, exact_claim=True)
        self.assertEqual(decision.code, "stopped_after_claim")
        self.assertTrue(decision.claim_left_truthful)
        self.assertFalse(decision.allowed)
        self.assert_signal_log(fake, [])
        self.assert_no_task_success(decision)
        self.assertEqual(ctl.begin_launch("worker").code, "launch_after_stop")

    def test_stop_before_worker_refuses_launch(self):
        ctl, fake, _observer, _journal, _clock = self.controller()
        self.claim(ctl)
        decision = ctl.request_stop()
        self.assertEqual(decision.code, "stopped_before_launch")
        self.assertTrue(decision.claim_left_truthful)
        self.assert_signal_log(fake, [])
        self.assert_no_task_success(decision)
        self.assertEqual(ctl.begin_launch("worker").code, "launch_after_stop")
        self.assertEqual(ctl.evaluate_target(100, 100).code, "unknown")

    def test_launch_after_stop_is_refused(self):
        flag = Flag(False)
        ctl, fake, _observer, _journal, _clock = self.controller(predicate=flag)
        self.claim(ctl)
        flag.value = True
        decision = ctl.begin_launch("worker")
        self.assertEqual(decision.code, "launch_after_stop")
        self.assertFalse(decision.allowed)
        self.assert_signal_log(fake, [])
        self.assertEqual(ctl.register(worker()).code, "launch_after_stop")
        self.assertEqual(tuple(ctl.evaluate_target(100, 100).registered_pgids), ())

    def test_stop_during_worker_signals_only_owned_group(self):
        ctl, fake, _observer, _journal, _clock = self.controller()
        fake.results = ["absent"]
        self.register_worker(ctl)
        decision = ctl.request_stop()
        self.assertEqual(decision.code, "stopped_group_absent")
        self.assertTrue(decision.group_confirmed)
        self.assertFalse(decision.recovery_retained)
        self.assert_signal_log(fake, [(100, stop.SIGTERM)])
        self.assert_no_task_success(decision)
        finished = ctl.finish(phase_completed=True)
        self.assertEqual(finished.code, "cleanup_pending")
        self.assertTrue(finished.lock_release_permitted)
        self.assertFalse(finished.phase_finished)
        self.assertFalse(finished.task_marked_done)
        self.assertEqual(_journal.clears, 0)
        self.assertTrue(_journal.records)

    def test_verified_empty_group_permits_cleanup_without_a_signal(self):
        ctl, fake, observer, _journal, _clock = self.controller()
        self.register_worker(ctl)
        observer.script.append(absent_group)
        decision = ctl.confirm_phase_exit("worker")
        self.assertEqual(decision.code, "stopped_group_absent")
        self.assertTrue(decision.allowed)
        self.assertTrue(decision.group_confirmed)
        self.assertFalse(decision.recovery_retained)
        self.assert_signal_log(fake, [])
        pending = ctl.finish(phase_completed=True)
        self.assertEqual(pending.code, "cleanup_pending")
        self.assertFalse(pending.phase_finished)
        self.assertTrue(pending.lock_release_permitted)
        self.assertTrue(pending.pointer_cleanup_permitted)
        self.assertEqual(_journal.clears, 0)
        self.assertIsNone(_journal.snapshot()["cleanup_confirmation"])
        finished = ctl.confirm_cleanup_durable(durable_cleanup())
        self.assertTrue(finished.phase_finished)
        self.assertEqual(finished.code, "phase_finished")
        self.assertEqual(_journal.clears, 1)
        self.assert_no_task_success(finished)

    def test_stop_during_review_does_not_signal_worker(self):
        ctl, fake, observer, _journal, _clock = self.controller()
        self.register_worker(ctl)
        observer.script.append(absent_group)
        self.assertEqual(ctl.confirm_phase_exit("worker").code, "stopped_group_absent")
        self.assertEqual(ctl.begin_launch("reviewer").code, "launch_open")
        registered = ctl.register(reviewer())
        self.assertEqual(registered.code, "registered")
        self.assertEqual(ctl.confirm_ack().code, "ack_confirmed")
        fake.results = ["absent"]
        decision = ctl.request_stop()
        self.assertEqual(decision.code, "stopped_group_absent")
        self.assert_signal_log(fake, [(200, stop.SIGTERM)])
        self.assertNotIn(100, [pgid for pgid, _sig in fake.calls])
        self.assert_no_task_success(decision)

    def test_review_refused_while_worker_uncontained(self):
        ctl, fake, observer, _journal, _clock = self.controller()
        self.register_worker(ctl)
        self.assertEqual(ctl.begin_launch("reviewer").code, "review_requires_worker_exit")
        observer.script.append(lambda identity: matching(identity, status="absent"))
        retired = ctl.confirm_phase_exit("worker")
        self.assertEqual(retired.code, "retired_absent")
        self.assertFalse(retired.allowed)
        self.assertTrue(retired.recovery_retained)
        self.assertFalse(retired.group_confirmed)
        self.assertEqual(ctl.begin_launch("reviewer").code, "recovery_retained")
        self.assert_signal_log(fake, [])

    def test_concurrent_launch_after_stop_is_refused(self):
        journal = GateJournal()
        lock = ObservableLock()
        ctl, fake, _observer, _stored, _clock = self.controller(journal=journal, lock=lock)
        self.claim(ctl)
        journal.armed = True
        found = {}

        def run_stop():
            found["stop"] = ctl.request_stop()

        stopper = threading.Thread(target=run_stop)
        stopper.start()
        self.assertTrue(journal.entered.wait(5))

        def run_launch():
            found["launch"] = ctl.begin_launch("worker")

        launcher = threading.Thread(target=run_launch)
        launcher.start()
        self.assertTrue(lock.wait_for_waiter(5))
        journal.release.set()
        stopper.join(5)
        launcher.join(5)
        self.assertFalse(stopper.is_alive())
        self.assertFalse(launcher.is_alive())
        self.assertEqual(found["stop"].code, "stopped_before_launch")
        self.assertEqual(found["launch"].code, "launch_after_stop")
        self.assert_signal_log(fake, [])
        self.assert_no_task_success(found["stop"])
        self.assert_no_task_success(found["launch"])

    def test_concurrent_finish_keeps_recovery_when_stop_is_uncertain(self):
        lock = ObservableLock()
        observer = Observer()
        entered = threading.Event()
        release = threading.Event()

        def blocking(_identity):
            entered.set()
            if not release.wait(5):
                raise TimeoutError("observer was not released")
            return stop.Observation("unverifiable")

        observer.script.extend([matching, blocking])
        ctl, fake, _observer, journal, _clock = self.controller(observer=observer, lock=lock)
        self.register_worker(ctl)
        found = {}

        def run_stop():
            found["stop"] = ctl.request_stop()

        stopper = threading.Thread(target=run_stop)
        stopper.start()
        self.assertTrue(entered.wait(5))

        def run_finish():
            found["finish"] = ctl.finish(phase_completed=True)

        finisher = threading.Thread(target=run_finish)
        finisher.start()
        self.assertTrue(lock.wait_for_waiter(5))
        release.set()
        stopper.join(5)
        finisher.join(5)
        self.assertFalse(stopper.is_alive())
        self.assertFalse(finisher.is_alive())
        self.assertEqual(found["stop"].code, "unconfirmed_unverifiable")
        self.assertTrue(found["stop"].recovery_retained)
        self.assertFalse(found["stop"].lock_release_permitted)
        self.assertEqual(found["finish"].code, "recovery_retained")
        self.assertFalse(found["finish"].lock_release_permitted)
        self.assertFalse(found["finish"].pointer_cleanup_permitted)
        self.assertEqual(journal.clears, 0)
        self.assert_signal_log(fake, [])

    def test_duplicate_registration_refused(self):
        ctl, fake, _observer, _journal, _clock = self.controller()
        self.register_worker(ctl)
        duplicate = ctl.register(worker(pid=101, pgid=101, birth="birth-other"))
        self.assertEqual(duplicate.code, "duplicate_registration")
        self.assertEqual(duplicate.registered_pgids, (100,))
        same = ctl.register(worker())
        self.assertEqual(same.code, "duplicate_registration")
        self.assert_signal_log(fake, [])
        self.assertEqual(ctl.evaluate_target(101, 101).code, "unknown")

    def test_absent_identity_retires_without_signal_and_keeps_recovery(self):
        ctl, fake, observer, _journal, _clock = self.controller()
        self.register_worker(ctl)
        observer.script.append(lambda identity: matching(identity, status="absent"))
        decision = ctl.request_stop()
        self.assertEqual(decision.code, "retired_absent")
        self.assertTrue(decision.recovery_retained)
        self.assertFalse(decision.group_confirmed)
        self.assertFalse(decision.lock_release_permitted)
        self.assert_signal_log(fake, [])
        self.assertEqual(ctl.finish(phase_completed=True).code, "recovery_retained")

    def test_reused_pid_is_not_signalled(self):
        ctl, fake, observer, _journal, _clock = self.controller()
        self.register_worker(ctl)
        observer.script.append(lambda identity: matching(identity, birth="recycled-birth"))
        decision = ctl.request_stop()
        self.assertEqual(decision.code, "retired_reused")
        self.assertTrue(decision.recovery_retained)
        self.assertFalse(decision.pointer_cleanup_permitted)
        self.assert_signal_log(fake, [])
        self.assertEqual(ctl.evaluate_target(100, 100).code, "unknown")

    def test_foreign_ancestry_keeps_recovery(self):
        ctl, fake, observer, _journal, _clock = self.controller()
        self.register_worker(ctl)
        observer.script.append(lambda identity: matching(identity, ancestry=(99,)))
        decision = ctl.request_stop()
        self.assertEqual(decision.code, "unconfirmed_foreign")
        self.assertTrue(decision.recovery_retained)
        self.assertEqual(decision.registered_pgids, (100,))
        self.assert_signal_log(fake, [])

    def test_unverifiable_identity_keeps_recovery(self):
        ctl, fake, observer, _journal, _clock = self.controller()
        self.register_worker(ctl)
        observer.script.append(stop.Observation("unverifiable"))
        decision = ctl.request_stop()
        self.assertEqual(decision.code, "unconfirmed_unverifiable")
        self.assertTrue(decision.recovery_retained)
        self.assert_signal_log(fake, [])

    def test_self_pid_and_own_group_refused(self):
        ctl, fake, observer, _journal, _clock = self.controller()
        self.claim(ctl)
        self.assertEqual(ctl.begin_launch("worker").code, "launch_open")
        own_pid = ctl.register(worker(pid=SELF_PID, pgid=180))
        self.assertEqual(own_pid.code, "self")
        self.assertTrue(own_pid.recovery_retained)
        self.assertEqual(observer.calls, [])
        self.assert_signal_log(fake, [])
        ctl, fake, observer, _journal, _clock = self.controller()
        self.claim(ctl)
        ctl.begin_launch("worker")
        own_group = ctl.register(worker(pid=180, pgid=SELF_PGID))
        self.assertEqual(own_group.code, "self")
        self.assert_signal_log(fake, [])
        self.assertEqual(observer.calls, [])

    def test_pid_and_group_at_or_below_one_refused(self):
        for pid, pgid in ((1, 100), (0, 100), (-3, 100), (100, 1), (100, 0), (100, -2)):
            ctl, fake, observer, _journal, _clock = self.controller()
            self.claim(ctl)
            ctl.begin_launch("worker")
            decision = ctl.register(worker(pid=pid, pgid=pgid))
            self.assertEqual(decision.code, "not_a_process", (pid, pgid, decision.code))
            self.assertTrue(decision.recovery_retained)
            self.assertEqual(observer.calls, [])
            self.assert_signal_log(fake, [])
            self.assertEqual(ctl.begin_launch("worker").code, "recovery_retained")

    def test_unknown_pid_is_not_signalled(self):
        ctl, fake, _observer, _journal, _clock = self.controller()
        self.claim(ctl)
        decision = ctl.evaluate_target(999, 999)
        self.assertEqual(decision.code, "unknown")
        self.assertFalse(decision.allowed)
        self.assert_signal_log(fake, [])
        self.assertEqual(ctl.request_stop().signals, ())
        self.assertEqual(fake.calls, [])

    def test_register_journal_failure_does_not_allowlist(self):
        journal = Journal(fail=lambda record: record.get("outcome") == "registered")
        ctl, fake, _observer, _stored, _clock = self.controller(journal=journal)
        self.claim(ctl)
        ctl.begin_launch("worker")
        decision = ctl.register(worker())
        self.assertEqual(decision.code, "journal_failed")
        self.assertTrue(decision.recovery_retained)
        self.assertEqual(decision.registered_pgids, ())
        self.assertEqual(ctl.evaluate_target(100, 100).code, "unknown")
        self.assert_signal_log(fake, [])
        self.assertEqual(ctl.request_stop().signals, ())

    def test_stop_journal_failure_does_not_signal(self):
        journal = Journal(fail=lambda record: record.get("outcome") == "stopping")
        ctl, fake, _observer, _stored, _clock = self.controller(journal=journal)
        self.register_worker(ctl)
        decision = ctl.request_stop()
        self.assertEqual(decision.code, "journal_failed")
        self.assertTrue(decision.recovery_retained)
        self.assertFalse(decision.lock_release_permitted)
        self.assert_signal_log(fake, [])

    def test_ack_failure_retains_recovery(self):
        ctl, fake, _observer, journal, _clock = self.controller()
        self.claim(ctl)
        ctl.begin_launch("worker")
        self.assertEqual(ctl.register(worker()).code, "registered")
        decision = ctl.ack_failed()
        self.assertEqual(decision.code, "ack_failed")
        self.assertTrue(decision.recovery_retained)
        self.assertFalse(decision.lock_release_permitted)
        self.assert_signal_log(fake, [])
        self.assertEqual(journal.snapshot()["ack"], "failed")
        self.assertEqual(journal.snapshot()["signal_authorized"], False)

    def test_journal_clear_failure_retains_recovery(self):
        journal = Journal()
        journal.fail_clear = True
        ctl, fake, _observer, _stored, _clock = self.controller(journal=journal)
        fake.results = ["absent"]
        self.register_worker(ctl)
        stopped = ctl.request_stop()
        self.assertTrue(stopped.group_confirmed)
        pending = ctl.finish(phase_completed=True)
        self.assertEqual(pending.code, "cleanup_pending")
        self.assertEqual(journal.clears, 0)
        self.assertTrue(journal.records)
        decision = ctl.confirm_cleanup_durable(durable_cleanup())
        self.assertEqual(decision.code, "journal_clear_failed")
        self.assertTrue(decision.recovery_retained)
        self.assertFalse(decision.lock_release_permitted)
        self.assertFalse(decision.pointer_cleanup_permitted)
        self.assertEqual(journal.clears, 0)
        self.assertTrue(journal.records)
        self.assertEqual(journal.snapshot()["outcome"], "journal_clear_failed")
        self.assertTrue(journal.snapshot()["recovery_retained"])
        self.assertTrue(any(
            record["cleanup_state"] == "confirmed"
            and record["cleanup_confirmation"]["durable"] is True
            and record["cleanup_confirmation"]["pointer_cleanup"] == "complete"
            and record["cleanup_confirmation"]["lock_release"] == "complete"
            for record in journal.records
        ))
        self.assertEqual(ctl.finish(phase_completed=True).code, "recovery_retained")
        self.assertEqual(ctl.confirm_cleanup_durable(durable_cleanup()).code, "recovery_retained")
        self.assertEqual(journal.clears, 0)
        self.assertTrue(journal.records)
        self.assert_signal_log(fake, [(100, stop.SIGTERM)])

    def test_timeout_with_no_budget_does_not_signal(self):
        ctl, fake, observer, _journal, _clock = self.controller(stop_budget=0)
        self.register_worker(ctl)
        before = len(observer.calls)
        decision = ctl.request_stop()
        self.assertEqual(decision.code, "timeout")
        self.assertTrue(decision.recovery_retained)
        self.assertEqual(len(observer.calls), before)
        self.assert_signal_log(fake, [])

    def test_timeout_after_term_does_not_escalate(self):
        clock = Clock()
        ctl, fake, _observer, _journal, _clock = self.controller(clock=clock, grace=10, stop_budget=5)
        fake.results = ["delivered", "delivered"]
        self.register_worker(ctl)
        decision = ctl.request_stop()
        self.assertEqual(decision.code, "timeout")
        self.assertTrue(decision.recovery_retained)
        self.assertFalse(decision.group_confirmed)
        self.assert_signal_log(fake, [(100, stop.SIGTERM)])

    def test_uncertain_signal_result_keeps_recovery(self):
        ctl, fake, _observer, _journal, _clock = self.controller()
        fake.results = ["uncertain"]
        self.register_worker(ctl)
        decision = ctl.request_stop()
        self.assertEqual(decision.code, "signal_uncertain")
        self.assertTrue(decision.recovery_retained)
        self.assert_signal_log(fake, [(100, stop.SIGTERM)])
        self.assertEqual(ctl.finish(phase_completed=True).code, "recovery_retained")

    def test_kill_without_group_absence_keeps_recovery(self):
        ctl, fake, _observer, _journal, _clock = self.controller(grace=0, stop_budget=30)
        fake.results = ["delivered", "delivered"]
        self.register_worker(ctl)
        decision = ctl.request_stop()
        self.assertEqual(decision.code, "containment_unconfirmed")
        self.assertTrue(decision.recovery_retained)
        self.assert_signal_log(fake, [(100, stop.SIGTERM), (100, stop.SIGKILL)])

    def test_identity_change_after_signal_does_not_signal_again(self):
        ctl, fake, observer, _journal, _clock = self.controller(grace=0, stop_budget=30)
        fake.results = ["delivered", "delivered"]
        self.register_worker(ctl)
        observer.script.append(matching)
        observer.script.append(lambda identity: matching(identity, ancestry=(77,)))
        decision = ctl.request_stop()
        self.assertEqual(decision.code, "identity_changed_after_signal")
        self.assertTrue(decision.recovery_retained)
        self.assert_signal_log(fake, [(100, stop.SIGTERM)])

    def test_post_signal_journal_failure_keeps_recovery(self):
        journal = Journal(fail=lambda record: record.get("outcome") == "stopped_group_absent")
        ctl, fake, _observer, _stored, _clock = self.controller(journal=journal)
        fake.results = ["absent"]
        self.register_worker(ctl)
        decision = ctl.request_stop()
        self.assertEqual(decision.code, "journal_failed")
        self.assertTrue(decision.recovery_retained)
        self.assertFalse(decision.lock_release_permitted)
        self.assert_signal_log(fake, [(100, stop.SIGTERM)])

    def test_not_direct_child_is_rejected(self):
        ctl, fake, observer, _journal, _clock = self.controller()
        self.claim(ctl)
        ctl.begin_launch("worker")
        decision = ctl.register(stop.OwnedIdentity(100, 100, "worker", "worker", "birth-worker", (99,)))
        self.assertEqual(decision.code, "not_direct_child")
        self.assertTrue(decision.recovery_retained)
        self.assertEqual(observer.calls, [])
        self.assert_signal_log(fake, [])

    def test_predicate_failure_fails_closed(self):
        def boom():
            raise RuntimeError("predicate unavailable")

        ctl, fake, _observer, _journal, _clock = self.controller(predicate=boom)
        decision = ctl.before_claim()
        self.assertEqual(decision.code, "stop_before_claim")
        self.assert_signal_log(fake, [])
        self.assert_no_task_success(decision)

        ctl, fake, _observer, _journal, _clock = self.controller(predicate=lambda: "yes")
        decision = ctl.before_claim()
        self.assertEqual(decision.code, "stop_before_claim")
        self.assertEqual(fake.calls, [])

    def test_open_launch_ticket_stop_keeps_recovery(self):
        ctl, fake, _observer, _journal, _clock = self.controller()
        self.claim(ctl)
        self.assertEqual(ctl.begin_launch("worker").code, "launch_open")
        decision = ctl.request_stop()
        self.assertEqual(decision.code, "stopped_unconfirmed")
        self.assertTrue(decision.recovery_retained)
        self.assertFalse(decision.lock_release_permitted)
        self.assert_signal_log(fake, [])

    def test_finish_leaves_journal_until_cleanup_is_confirmed(self):
        ctl, fake, _observer, journal, _clock = self.controller()
        fake.results = ["absent"]
        self.register_worker(ctl)
        self.assertEqual(ctl.request_stop().code, "stopped_group_absent")
        pending = ctl.finish(phase_completed=False)
        self.assertEqual(pending.code, "cleanup_pending")
        self.assertFalse(pending.recovery_retained)
        self.assertEqual(journal.clears, 0)
        self.assertEqual(journal.snapshot()["cleanup_state"], "pending")
        self.assertIsNone(journal.snapshot()["cleanup_confirmation"])
        self.assertNotIn("clear-attempt", [event[0] for event in journal.events])
        again = ctl.finish(phase_completed=False)
        self.assertEqual(again.code, "cleanup_pending")
        self.assertEqual(journal.clears, 0)
        self.assertEqual([event for event in journal.events if event[0] == "persist" and event[1] == "cleanup_pending"], [
            ("persist", "cleanup_pending", "pending"),
        ])
        self.assert_signal_log(fake, [(100, stop.SIGTERM)])

    def test_partial_cleanup_confirmation_retains_journal(self):
        ctl, fake, _observer, journal, _clock = self.controller()
        self._pending_cleanup(ctl, fake)
        for confirmation in (
            stop.CleanupConfirmation("complete", "unknown", True),
            stop.CleanupConfirmation("partial", "complete", True),
            stop.CleanupConfirmation("complete", "complete", False),
            stop.CleanupConfirmation("done", "done", True),
            None,
            {"pointer_cleanup": "complete", "lock_release": "complete", "durable": True},
        ):
            with self.subTest(confirmation=confirmation):
                fresh, fresh_fake, _observer, fresh_journal, _clock = self.controller()
                self._pending_cleanup(fresh, fresh_fake)
                decision = fresh.confirm_cleanup_durable(confirmation)
                self.assertEqual(decision.code, "cleanup_unconfirmed")
                self.assertTrue(decision.recovery_retained)
                self.assertFalse(decision.lock_release_permitted)
                self.assertFalse(decision.pointer_cleanup_permitted)
                self.assertEqual(fresh_journal.clears, 0)
                self.assertTrue(fresh_journal.records)
                self.assertEqual(fresh_journal.snapshot()["outcome"], "cleanup_unconfirmed")
                self.assertTrue(fresh_journal.snapshot()["recovery_retained"])
                self.assertEqual(fresh.confirm_cleanup_durable(durable_cleanup()).code, "recovery_retained")
                self.assertEqual(fresh_journal.clears, 0)
                self.assertTrue(fresh_journal.records)
                self.assert_signal_log(fresh_fake, [(100, stop.SIGTERM)])
        self.assertEqual(journal.clears, 0)

    def test_non_durable_confirmation_is_not_repaired_by_a_later_proof(self):
        ctl, fake, _observer, journal, _clock = self.controller()
        self._pending_cleanup(ctl, fake)
        rejected = ctl.confirm_cleanup_durable(stop.CleanupConfirmation("complete", "complete", False))
        self.assertEqual(rejected.code, "cleanup_unconfirmed")
        self.assertTrue(rejected.recovery_retained)
        self.assertEqual(journal.clears, 0)
        repaired = ctl.confirm_cleanup_durable(durable_cleanup())
        self.assertEqual(repaired.code, "recovery_retained")
        self.assertTrue(repaired.recovery_retained)
        self.assertEqual(journal.clears, 0)
        self.assertGreaterEqual(len(journal.records), 1)
        self.assert_signal_log(fake, [(100, stop.SIGTERM)])

    def test_confirmation_before_pending_retains_recovery(self):
        ctl, fake, _observer, journal, _clock = self.controller()
        fake.results = ["absent"]
        self.register_worker(ctl)
        stopped = ctl.request_stop()
        self.assertEqual(stopped.code, "stopped_group_absent")
        before = len(journal.records)
        decision = ctl.confirm_cleanup_durable(durable_cleanup())
        self.assertEqual(decision.code, "cleanup_unconfirmed")
        self.assertTrue(decision.recovery_retained)
        self.assertEqual(journal.clears, 0)
        self.assertGreater(len(journal.records), before)
        self.assertEqual(journal.snapshot()["cleanup_state"], "uncertain")
        self.assertEqual(ctl.finish(phase_completed=True).code, "recovery_retained")
        self.assertEqual(journal.clears, 0)
        self.assert_signal_log(fake, [(100, stop.SIGTERM)])

    def test_unconfirmed_stop_rejects_a_durable_cleanup_claim(self):
        ctl, fake, observer, journal, _clock = self.controller()
        self.register_worker(ctl)
        observer.script.append(lambda identity: matching(identity, status="absent"))
        self.assertEqual(ctl.request_stop().code, "retired_absent")
        before = list(journal.records)
        decision = ctl.confirm_cleanup_durable(durable_cleanup())
        self.assertEqual(decision.code, "recovery_retained")
        self.assertTrue(decision.recovery_retained)
        self.assertFalse(decision.pointer_cleanup_permitted)
        self.assertEqual(journal.clears, 0)
        self.assertEqual(journal.records, before)
        self.assert_signal_log(fake, [])

    def test_cleanup_confirmation_persist_failure_does_not_clear(self):
        journal = Journal(fail=lambda record: record.get("outcome") == "cleanup_confirmed")
        ctl, fake, _observer, _stored, _clock = self.controller(journal=journal)
        self._pending_cleanup(ctl, fake)
        decision = ctl.confirm_cleanup_durable(durable_cleanup())
        self.assertEqual(decision.code, "journal_failed")
        self.assertTrue(decision.recovery_retained)
        self.assertEqual(journal.clears, 0)
        self.assertTrue(journal.records)
        self.assertNotIn("cleanup_confirmed", [record["outcome"] for record in journal.records])
        self.assertEqual(journal.snapshot()["outcome"], "journal_failed")
        self.assertTrue(journal.snapshot()["recovery_retained"])
        self.assertIn(("persist-failed", "cleanup_confirmed"), journal.events)
        self.assertNotIn(("clear-attempt",), journal.events)
        self.assertEqual(ctl.confirm_cleanup_durable(durable_cleanup()).code, "recovery_retained")
        self.assertEqual(journal.clears, 0)
        self.assert_signal_log(fake, [(100, stop.SIGTERM)])

    def test_cleanup_pending_persist_failure_does_not_clear(self):
        journal = Journal(fail=lambda record: record.get("outcome") == "cleanup_pending")
        ctl, fake, _observer, _stored, _clock = self.controller(journal=journal)
        fake.results = ["absent"]
        self.register_worker(ctl)
        self.assertEqual(ctl.request_stop().code, "stopped_group_absent")
        decision = ctl.finish(phase_completed=True)
        self.assertEqual(decision.code, "journal_failed")
        self.assertTrue(decision.recovery_retained)
        self.assertFalse(decision.pointer_cleanup_permitted)
        self.assertEqual(journal.clears, 0)
        self.assertTrue(journal.records)
        self.assertNotIn("cleanup_pending", [record["outcome"] for record in journal.records])
        self.assertEqual(ctl.confirm_cleanup_durable(durable_cleanup()).code, "recovery_retained")
        self.assertNotIn(("clear-attempt",), journal.events)
        self.assert_signal_log(fake, [(100, stop.SIGTERM)])

    def test_clear_interruption_keeps_the_confirmed_record(self):
        journal = Journal()
        journal.fail_clear = True
        ctl, fake, _observer, _stored, _clock = self.controller(journal=journal)
        self._pending_cleanup(ctl, fake)
        decision = ctl.confirm_cleanup_durable(durable_cleanup())
        self.assertEqual(decision.code, "journal_clear_failed")
        self.assertTrue(decision.recovery_retained)
        confirmed = [record for record in journal.records if record["outcome"] == "cleanup_confirmed"]
        self.assertEqual(len(confirmed), 1)
        self.assertEqual(confirmed[0]["cleanup_confirmation"]["durable"], True)
        self.assertLess(
            journal.events.index(("persist", "cleanup_confirmed", "confirmed")),
            journal.events.index(("clear-attempt",)),
        )
        self.assertEqual(journal.events.count(("clear-attempt",)), 1)
        self.assertEqual(journal.clears, 0)
        self.assert_no_task_success(decision)
        self.assertTrue(decision.exact_task_match_proven)
        self.assert_signal_log(fake, [(100, stop.SIGTERM)])

    def _pending_cleanup(self, ctl, fake):
        fake.results = ["absent"]
        self.register_worker(ctl)
        self.assertEqual(ctl.request_stop().code, "stopped_group_absent")
        pending = ctl.finish(phase_completed=False)
        self.assertEqual(pending.code, "cleanup_pending")
        self.assertTrue(pending.pointer_cleanup_permitted)
        self.assertTrue(pending.lock_release_permitted)

    def test_duplicate_before_claim_opens_one_window(self):
        ctl, fake, _observer, journal, _clock = self.controller()
        first = ctl.before_claim()
        self.assertEqual(first.code, "claim_permitted")
        self.assertTrue(first.allowed)
        second = ctl.before_claim()
        self.assertEqual(second.code, "invalid_transition")
        self.assertFalse(second.allowed)
        self.assertEqual(
            [record["outcome"] for record in journal.records if record["outcome"] == "claim_permitted"],
            ["claim_permitted"],
        )
        self.assertEqual(sum(1 for record in journal.records if record["claim_window"] is True), 1)
        self.assertEqual(ctl.note_claimed(TASK_ID, exact_claim=True).code, "claimed")
        self.assertEqual(ctl.note_claimed(TASK_ID + 1, exact_claim=True).code, "invalid_transition")
        self.assert_signal_log(fake, [])
        self.assertEqual(journal.clears, 0)

    def test_concurrent_before_claim_serializes_to_one_window(self):
        journal = GateJournal()
        lock = ObservableLock()
        ctl, fake, _observer, _stored, _clock = self.controller(journal=journal, lock=lock)
        journal.armed = True
        found = {}

        def run(name):
            found[name] = ctl.before_claim()

        first = threading.Thread(target=run, args=("first",))
        first.start()
        self.assertTrue(journal.entered.wait(5))
        second = threading.Thread(target=run, args=("second",))
        second.start()
        self.assertTrue(lock.wait_for_waiter(5))
        journal.release.set()
        first.join(5)
        second.join(5)
        self.assertFalse(first.is_alive())
        self.assertFalse(second.is_alive())
        codes = sorted(decision.code for decision in found.values())
        self.assertEqual(codes, ["claim_permitted", "invalid_transition"])
        self.assertEqual(sum(1 for decision in found.values() if decision.allowed), 1)
        self.assertEqual(
            [record["outcome"] for record in journal.records if record["outcome"] == "claim_permitted"],
            ["claim_permitted"],
        )
        self.assertEqual(ctl.note_claimed(TASK_ID, exact_claim=True).code, "claimed")
        self.assertEqual(ctl.before_claim().code, "invalid_transition")
        self.assert_signal_log(fake, [])
        self.assertEqual(journal.clears, 0)

    def test_always_failing_journal_permits_no_external_action(self):
        journal = Journal(fail=lambda _record: True)
        ctl, fake, _observer, _stored, _clock = self.controller(journal=journal)
        first = ctl.before_claim()
        self.assertEqual(first.code, "journal_failed")
        self.assertFalse(first.allowed)
        self.assertTrue(first.recovery_retained)
        self.assertFalse(first.pointer_cleanup_permitted)
        self.assertFalse(first.lock_release_permitted)
        second = ctl.before_claim()
        self.assertNotEqual(second.code, "claim_permitted")
        self.assertFalse(second.allowed)
        self.assertTrue(second.recovery_retained)
        claimed = ctl.note_claimed(TASK_ID, exact_claim=True)
        self.assertFalse(claimed.allowed)
        self.assertNotEqual(claimed.code, "claimed")
        self.assert_no_launch_review_or_cleanup(ctl, fake, journal)
        self.assertEqual(journal.records, [])
        self.assertEqual(journal.clears, 0)

    def test_journal_failure_at_each_transition_blocks_external_actions(self):
        cases = (
            ("claim_permitted", self._fail_before_claim),
            ("stop_before_claim", self._fail_stop_before_claim),
            ("claimed", self._fail_note_claimed),
            ("stopped_after_claim", self._fail_stopped_after_claim),
            ("launch_open", self._fail_worker_launch),
            ("review_launch_open", self._fail_review_launch),
            ("launch_after_stop", self._fail_launch_after_stop),
            ("registered", self._fail_register),
            ("ack_confirmed", self._fail_ack_confirmed),
            ("ack_after_stop", self._fail_ack_after_stop),
            ("ack_failed", self._fail_ack_failed),
            ("claim_unresolved", self._fail_claim_unresolved),
            ("claim_unknown", self._fail_claim_unknown),
            ("stopped_group_absent", self._fail_phase_exit),
            ("stopping", self._fail_request_stop),
            ("cleanup_pending", self._fail_cleanup_pending),
            ("cleanup_confirmed", self._fail_cleanup_confirmed),
            ("cleanup_unconfirmed", self._fail_cleanup_unconfirmed),
        )
        for name, setup in cases:
            with self.subTest(transition=name):
                decision, ctl, fake, journal, prior_signals = setup()
                self.assertFalse(decision.allowed)
                self.assertTrue(decision.recovery_retained)
                self.assertFalse(decision.pointer_cleanup_permitted)
                self.assertFalse(decision.lock_release_permitted)
                self.assertNotIn(decision.code, ("claim_permitted", "claimed", "launch_open", "cleanup_pending"))
                self.assert_no_launch_review_or_cleanup(ctl, fake, journal, prior_signals=prior_signals)

    def test_open_ticket_invalidated_by_stop_keeps_untracked_recovery(self):
        flag = Flag(False)
        ctl, fake, _observer, journal, _clock = self.controller(predicate=flag)
        self.claim(ctl)
        opened = ctl.begin_launch("worker")
        self.assertEqual(opened.code, "launch_open")
        self.assertTrue(opened.allowed)
        flag.value = True
        second = ctl.begin_launch("worker")
        self.assertEqual(second.code, "launch_after_stop")
        self.assertFalse(second.allowed)
        self.assertTrue(second.recovery_retained)
        self.assertFalse(second.group_confirmed)
        self.assertFalse(second.pointer_cleanup_permitted)
        self.assertFalse(second.lock_release_permitted)
        stopped = ctl.request_stop()
        self.assertEqual(stopped.code, "stopped_unconfirmed")
        self.assertTrue(stopped.recovery_retained)
        self.assertFalse(stopped.group_confirmed)
        self.assertTrue(stopped.claim_left_truthful)
        self.assertFalse(stopped.pointer_cleanup_permitted)
        self.assertFalse(stopped.lock_release_permitted)
        finished = ctl.finish(phase_completed=False)
        self.assertEqual(finished.code, "recovery_retained")
        self.assertTrue(finished.recovery_retained)
        self.assertFalse(finished.pointer_cleanup_permitted)
        self.assertFalse(finished.lock_release_permitted)
        confirmed = ctl.confirm_cleanup_durable(durable_cleanup())
        self.assertEqual(confirmed.code, "recovery_retained")
        self.assertEqual(journal.clears, 0)
        self.assertTrue(journal.records)
        self.assert_signal_log(fake, [])
        self.assert_no_task_success(stopped)
        self.assert_no_task_success(finished)

        flag = Flag(False)
        ctl, fake, observer, journal, _clock = self.controller(predicate=flag)
        self.register_worker(ctl)
        observer.script.append(absent_group)
        self.assertEqual(ctl.confirm_phase_exit("worker").code, "stopped_group_absent")
        self.assertEqual(ctl.begin_launch("reviewer").code, "launch_open")
        flag.value = True
        second = ctl.begin_launch("reviewer")
        self.assertEqual(second.code, "launch_after_stop")
        self.assertTrue(second.recovery_retained)
        self.assertFalse(second.pointer_cleanup_permitted)
        stopped = ctl.request_stop()
        self.assertEqual(stopped.code, "stopped_unconfirmed")
        self.assertFalse(stopped.group_confirmed)
        self.assertTrue(stopped.recovery_retained)
        finished = ctl.finish(phase_completed=True)
        self.assertFalse(finished.pointer_cleanup_permitted)
        self.assertFalse(finished.lock_release_permitted)
        self.assertEqual(journal.clears, 0)
        self.assert_signal_log(fake, [])

    def test_stop_during_launch_persist_does_not_grant_launch(self):
        flag = Flag(False)
        journal = GateJournal()
        lock = ObservableLock()
        ctl, fake, _observer, _stored, _clock = self.controller(
            predicate=flag, journal=journal, lock=lock
        )
        self.claim(ctl)
        journal.armed = True
        found = {}

        def run_first():
            found["first"] = ctl.begin_launch("worker")

        first = threading.Thread(target=run_first)
        first.start()
        self.assertTrue(journal.entered.wait(5))
        flag.value = True

        def run_second():
            found["second"] = ctl.begin_launch("worker")

        second = threading.Thread(target=run_second)
        second.start()
        self.assertTrue(lock.wait_for_waiter(5))
        journal.release.set()
        first.join(5)
        second.join(5)
        self.assertFalse(first.is_alive())
        self.assertFalse(second.is_alive())
        self.assertEqual(found["first"].code, "launch_after_stop")
        self.assertFalse(found["first"].allowed)
        self.assertTrue(found["first"].recovery_retained)
        self.assertNotEqual(found["second"].code, "launch_open")
        self.assertFalse(found["second"].allowed)
        self.assertTrue(found["second"].recovery_retained)
        stopped = ctl.request_stop()
        self.assertEqual(stopped.code, "stopped_unconfirmed")
        self.assertFalse(stopped.group_confirmed)
        self.assertTrue(stopped.recovery_retained)
        finished = ctl.finish(phase_completed=False)
        self.assertFalse(finished.pointer_cleanup_permitted)
        self.assertFalse(finished.lock_release_permitted)
        self.assertEqual(journal.clears, 0)
        self.assert_signal_log(fake, [])

    def assert_no_launch_review_or_cleanup(self, ctl, fake, journal, prior_signals=()):
        worker_launch = ctl.begin_launch("worker")
        self.assertFalse(worker_launch.allowed)
        self.assertNotEqual(worker_launch.code, "launch_open")
        self.assertFalse(worker_launch.pointer_cleanup_permitted)
        review_launch = ctl.begin_launch("reviewer")
        self.assertFalse(review_launch.allowed)
        self.assertNotEqual(review_launch.code, "launch_open")
        self.assertFalse(review_launch.pointer_cleanup_permitted)
        finished = ctl.finish(phase_completed=True)
        self.assertNotEqual(finished.code, "cleanup_pending")
        self.assertFalse(finished.pointer_cleanup_permitted)
        self.assertFalse(finished.lock_release_permitted)
        self.assertFalse(finished.phase_finished)
        confirmed = ctl.confirm_cleanup_durable(durable_cleanup())
        self.assertNotIn(confirmed.code, ("cleanup_confirmed", "phase_finished", "cleanup_pending"))
        self.assertFalse(confirmed.pointer_cleanup_permitted)
        self.assertFalse(confirmed.lock_release_permitted)
        self.assertFalse(confirmed.phase_finished)
        self.assertEqual(journal.clears, 0)
        self.assertEqual(tuple(fake.calls), tuple(prior_signals))
        self.assert_no_task_success(finished)
        self.assert_no_task_success(confirmed)

    def _fail_on(self, predicate):
        return Journal(fail=predicate)

    def _fail_before_claim(self):
        journal = self._fail_on(lambda record: record.get("outcome") == "claim_permitted")
        ctl, fake, _observer, _stored, _clock = self.controller(journal=journal)
        return ctl.before_claim(), ctl, fake, journal, ()

    def _fail_stop_before_claim(self):
        journal = self._fail_on(lambda record: record.get("outcome") == "stop_before_claim")
        ctl, fake, _observer, _stored, _clock = self.controller(predicate=Flag(True), journal=journal)
        return ctl.before_claim(), ctl, fake, journal, ()

    def _fail_note_claimed(self):
        journal = self._fail_on(lambda record: record.get("outcome") == "claimed")
        ctl, fake, _observer, _stored, _clock = self.controller(journal=journal)
        self.assertEqual(ctl.before_claim().code, "claim_permitted")
        decision = ctl.note_claimed(TASK_ID, exact_claim=True)
        self.assertTrue(decision.claim_left_truthful)
        self.assertNotEqual(decision.code, "claimed")
        return decision, ctl, fake, journal, ()

    def _fail_stopped_after_claim(self):
        flag = Flag(False)
        journal = self._fail_on(lambda record: record.get("outcome") == "stopped_after_claim")
        ctl, fake, _observer, _stored, _clock = self.controller(predicate=flag, journal=journal)
        self.assertEqual(ctl.before_claim().code, "claim_permitted")
        flag.value = True
        decision = ctl.note_claimed(TASK_ID, exact_claim=True)
        self.assertTrue(decision.claim_left_truthful)
        self.assertNotEqual(decision.code, "stopped_after_claim")
        return decision, ctl, fake, journal, ()

    def _fail_worker_launch(self):
        journal = self._fail_on(lambda record: record.get("outcome") == "launch_open")
        ctl, fake, _observer, _stored, _clock = self.controller(journal=journal)
        self.claim(ctl)
        decision = ctl.begin_launch("worker")
        self.assertNotEqual(decision.code, "launch_open")
        return decision, ctl, fake, journal, ()

    def _fail_review_launch(self):
        journal = self._fail_on(
            lambda record: record.get("outcome") == "launch_open" and record.get("launch_ticket") == "reviewer"
        )
        ctl, fake, observer, _stored, _clock = self.controller(journal=journal)
        self.register_worker(ctl)
        observer.script.append(absent_group)
        self.assertEqual(ctl.confirm_phase_exit("worker").code, "stopped_group_absent")
        decision = ctl.begin_launch("reviewer")
        self.assertNotEqual(decision.code, "launch_open")
        return decision, ctl, fake, journal, ()

    def _fail_launch_after_stop(self):
        flag = Flag(False)
        journal = self._fail_on(lambda record: record.get("outcome") == "launch_after_stop")
        ctl, fake, _observer, _stored, _clock = self.controller(predicate=flag, journal=journal)
        self.claim(ctl)
        self.assertEqual(ctl.begin_launch("worker").code, "launch_open")
        flag.value = True
        decision = ctl.begin_launch("worker")
        self.assertNotEqual(decision.code, "launch_open")
        self.assertTrue(decision.recovery_retained)
        return decision, ctl, fake, journal, ()

    def _fail_register(self):
        journal = self._fail_on(lambda record: record.get("outcome") == "registered")
        ctl, fake, _observer, _stored, _clock = self.controller(journal=journal)
        self.claim(ctl)
        self.assertEqual(ctl.begin_launch("worker").code, "launch_open")
        decision = ctl.register(worker())
        self.assertEqual(decision.registered_pgids, ())
        return decision, ctl, fake, journal, ()

    def _fail_ack_confirmed(self):
        journal = self._fail_on(lambda record: record.get("outcome") == "ack_confirmed")
        ctl, fake, _observer, _stored, _clock = self.controller(journal=journal)
        self.claim(ctl)
        self.assertEqual(ctl.begin_launch("worker").code, "launch_open")
        self.assertEqual(ctl.register(worker()).code, "registered")
        return ctl.confirm_ack(), ctl, fake, journal, ()

    def _fail_ack_failed(self):
        journal = self._fail_on(lambda record: record.get("outcome") == "ack_failed")
        ctl, fake, _observer, _stored, _clock = self.controller(journal=journal)
        self.claim(ctl)
        self.assertEqual(ctl.begin_launch("worker").code, "launch_open")
        self.assertEqual(ctl.register(worker()).code, "registered")
        return ctl.ack_failed(), ctl, fake, journal, ()

    def _fail_phase_exit(self):
        journal = self._fail_on(lambda record: record.get("outcome") == "stopped_group_absent")
        ctl, fake, observer, _stored, _clock = self.controller(journal=journal)
        self.register_worker(ctl)
        observer.script.append(absent_group)
        decision = ctl.confirm_phase_exit("worker")
        self.assertFalse(decision.group_confirmed)
        return decision, ctl, fake, journal, ()

    def _fail_request_stop(self):
        journal = self._fail_on(lambda record: record.get("outcome") == "stopping")
        ctl, fake, _observer, _stored, _clock = self.controller(journal=journal)
        self.register_worker(ctl)
        return ctl.request_stop(), ctl, fake, journal, ()

    def _fail_cleanup_pending(self):
        journal = self._fail_on(lambda record: record.get("outcome") == "cleanup_pending")
        ctl, fake, _observer, _stored, _clock = self.controller(journal=journal)
        fake.results = ["absent"]
        self.register_worker(ctl)
        self.assertEqual(ctl.request_stop().code, "stopped_group_absent")
        return ctl.finish(phase_completed=False), ctl, fake, journal, ((100, stop.SIGTERM),)

    def _fail_cleanup_confirmed(self):
        journal = self._fail_on(lambda record: record.get("outcome") == "cleanup_confirmed")
        ctl, fake, _observer, _stored, _clock = self.controller(journal=journal)
        self._pending_cleanup(ctl, fake)
        decision = ctl.confirm_cleanup_durable(durable_cleanup())
        self.assertEqual(journal.clears, 0)
        self.assertNotIn(("clear-attempt",), journal.events)
        return decision, ctl, fake, journal, ((100, stop.SIGTERM),)

    def _fail_cleanup_unconfirmed(self):
        journal = self._fail_on(lambda record: record.get("outcome") == "cleanup_unconfirmed")
        ctl, fake, _observer, _stored, _clock = self.controller(journal=journal)
        self._pending_cleanup(ctl, fake)
        decision = ctl.confirm_cleanup_durable(stop.CleanupConfirmation("partial", "complete", True))
        self.assertEqual(journal.clears, 0)
        self.assertNotIn(("clear-attempt",), journal.events)
        return decision, ctl, fake, journal, ((100, stop.SIGTERM),)

    def test_stop_during_open_claim_keeps_recovery_until_late_success(self):
        ctl, fake, _observer, journal, _clock = self.controller()
        self.assertEqual(ctl.before_claim().code, "claim_permitted")
        stopped = ctl.request_stop()
        self.assertEqual(stopped.code, "claim_unresolved")
        self.assertNotEqual(stopped.code, "stop_before_claim")
        self.assertFalse(stopped.allowed)
        self.assertTrue(stopped.recovery_retained)
        self.assertFalse(stopped.group_confirmed)
        self.assertFalse(stopped.claim_left_truthful)
        self.assertFalse(stopped.pointer_cleanup_permitted)
        self.assertFalse(stopped.lock_release_permitted)
        self.assertEqual(ctl.phase, "claiming")
        self.assertNotEqual(ctl.phase, "idle")
        self.assertEqual(journal.snapshot()["outcome"], "claim_unresolved")
        self.assertEqual(journal.snapshot()["phase"], "claiming")
        self.assertTrue(journal.snapshot()["claim_window"])
        self.assertIsNone(journal.snapshot()["claim"])
        self.assertTrue(journal.snapshot()["recovery_retained"])
        self.assertFalse(journal.snapshot()["group_confirmed"])
        finished = ctl.finish(phase_completed=False)
        self.assertEqual(finished.code, "recovery_retained")
        self.assertFalse(finished.pointer_cleanup_permitted)
        self.assertFalse(finished.lock_release_permitted)
        confirmed = ctl.confirm_cleanup_durable(durable_cleanup())
        self.assertEqual(confirmed.code, "recovery_retained")
        self.assertEqual(journal.clears, 0)
        self.assertTrue(journal.records)
        late = ctl.note_claimed(TASK_ID, exact_claim=True)
        self.assertEqual(late.code, "stopped_after_claim")
        self.assertTrue(late.claim_left_truthful)
        self.assertFalse(late.allowed)
        self.assertFalse(late.recovery_retained)
        self.assertTrue(late.group_confirmed)
        self.assertEqual(ctl.phase, "claimed")
        self.assertEqual(journal.snapshot()["claim"]["task_id"], TASK_ID)
        self.assertFalse(journal.snapshot()["claim_window"])
        self.assertTrue(journal.snapshot()["claim"]["exact_task_match_proven"])
        self.assertEqual(ctl.begin_launch("worker").code, "launch_after_stop")
        self.assertEqual(journal.clears, 0)
        pending = ctl.finish(phase_completed=False)
        self.assertEqual(pending.code, "cleanup_pending")
        self.assertEqual(journal.clears, 0)
        cleared = ctl.confirm_cleanup_durable(durable_cleanup())
        self.assertEqual(cleared.code, "cleanup_confirmed")
        self.assertEqual(journal.clears, 1)
        self.assert_signal_log(fake, [])
        self.assert_no_task_success(stopped)
        self.assert_no_task_success(late)

    def test_lost_claim_reply_keeps_recovery_and_journal(self):
        ctl, fake, _observer, journal, _clock = self.controller()
        self.assertEqual(ctl.before_claim().code, "claim_permitted")
        self.assertEqual(ctl.request_stop().code, "claim_unresolved")
        unknown = ctl.note_claim_unknown()
        self.assertEqual(unknown.code, "claim_unknown")
        self.assertFalse(unknown.allowed)
        self.assertTrue(unknown.recovery_retained)
        self.assertFalse(unknown.group_confirmed)
        self.assertFalse(unknown.claim_left_truthful)
        self.assertEqual(ctl.phase, "claiming")
        self.assertNotEqual(ctl.phase, "idle")
        self.assertIsNone(journal.snapshot()["claim"])
        self.assertFalse(journal.snapshot()["claim_window"])
        self.assertEqual(journal.snapshot()["outcome"], "claim_unknown")
        self.assertTrue(journal.snapshot()["recovery_retained"])
        self.assertFalse(journal.snapshot()["group_confirmed"])
        finished = ctl.finish(phase_completed=False)
        self.assertEqual(finished.code, "recovery_retained")
        self.assertFalse(finished.pointer_cleanup_permitted)
        self.assertFalse(finished.lock_release_permitted)
        confirmed = ctl.confirm_cleanup_durable(durable_cleanup())
        self.assertEqual(confirmed.code, "recovery_retained")
        self.assertEqual(journal.clears, 0)
        self.assertTrue(journal.records)
        self.assertEqual(ctl.note_claimed(TASK_ID, exact_claim=True).code, "invalid_transition")
        self.assertIsNone(journal.snapshot()["claim"])
        repeated = ctl.note_claim_unknown()
        self.assertEqual(repeated.code, "invalid_transition")
        self.assertTrue(repeated.recovery_retained)
        again = ctl.request_stop()
        self.assertEqual(again.code, "claim_unknown")
        self.assertNotEqual(again.code, "stop_before_claim")
        self.assertTrue(again.recovery_retained)
        self.assertFalse(again.group_confirmed)
        self.assertFalse(again.pointer_cleanup_permitted)
        self.assertNotEqual(ctl.phase, "idle")
        self.assertEqual(journal.clears, 0)
        self.assert_signal_log(fake, [])
        self.assert_no_task_success(unknown)

        lost, lost_fake, _observer, lost_journal, _clock = self.controller()
        self.assertEqual(lost.before_claim().code, "claim_permitted")
        decision = lost.note_claim_unknown()
        self.assertEqual(decision.code, "claim_unknown")
        self.assertTrue(decision.recovery_retained)
        self.assertEqual(lost.phase, "claiming")
        self.assertNotEqual(lost.before_claim().code, "claim_permitted")
        self.assertNotEqual(lost.begin_launch("worker").code, "launch_open")
        self.assertEqual(lost.finish(phase_completed=False).code, "recovery_retained")
        self.assertEqual(lost.confirm_cleanup_durable(durable_cleanup()).code, "recovery_retained")
        self.assertEqual(lost_journal.clears, 0)
        self.assertTrue(lost_journal.records)
        self.assert_signal_log(lost_fake, [])

    def test_stop_and_late_claim_are_serialized(self):
        journal = GateJournal()
        lock = ObservableLock()
        ctl, fake, _observer, _stored, _clock = self.controller(journal=journal, lock=lock)
        self.assertEqual(ctl.before_claim().code, "claim_permitted")
        journal.armed = True
        found = {}

        def run_stop():
            found["stop"] = ctl.request_stop()

        def run_late():
            found["late"] = ctl.note_claimed(TASK_ID, exact_claim=True)

        stopper = threading.Thread(target=run_stop)
        stopper.start()
        self.assertTrue(journal.entered.wait(5))
        later = threading.Thread(target=run_late)
        later.start()
        self.assertTrue(lock.wait_for_waiter(5))
        journal.release.set()
        stopper.join(5)
        later.join(5)
        self.assertFalse(stopper.is_alive())
        self.assertFalse(later.is_alive())
        self.assertEqual(found["stop"].code, "claim_unresolved")
        self.assertTrue(found["stop"].recovery_retained)
        self.assertFalse(found["stop"].group_confirmed)
        self.assertEqual(found["late"].code, "stopped_after_claim")
        self.assertTrue(found["late"].claim_left_truthful)
        self.assertFalse(found["late"].recovery_retained)
        outcomes = [record["outcome"] for record in journal.records]
        self.assertLess(outcomes.index("claim_unresolved"), outcomes.index("stopped_after_claim"))
        self.assertEqual(journal.clears, 0)
        self.assert_signal_log(fake, [])

    def test_stop_after_register_before_ack_denies_exec(self):
        flag = Flag(False)
        ctl, fake, _observer, journal, _clock = self.controller(predicate=flag)
        self.claim(ctl)
        self.assertEqual(ctl.begin_launch("worker").code, "launch_open")
        self.assertEqual(ctl.register(worker()).code, "registered")
        flag.value = True
        decision = ctl.confirm_ack()
        self.assertEqual(decision.code, "ack_after_stop")
        self.assertFalse(decision.allowed)
        self.assertTrue(decision.recovery_retained)
        self.assertFalse(decision.group_confirmed)
        self.assertEqual(decision.registered_pgids, (100,))
        self.assertEqual(journal.snapshot()["ack"], "pending")
        self.assertEqual(journal.snapshot()["outcome"], "ack_after_stop")
        self.assertTrue(journal.snapshot()["recovery_retained"])
        self.assertNotIn("confirmed", [record["ack"] for record in journal.records])
        self.assertEqual(ctl.evaluate_target(100, 100).code, "registered_unverified")
        again = ctl.confirm_ack()
        self.assertEqual(again.code, "ack_after_stop")
        self.assertFalse(again.allowed)
        self.assertEqual(again.registered_pgids, (100,))
        finished = ctl.finish(phase_completed=False)
        self.assertNotEqual(finished.code, "cleanup_pending")
        self.assertFalse(finished.pointer_cleanup_permitted)
        self.assertFalse(finished.lock_release_permitted)
        self.assertEqual(ctl.confirm_cleanup_durable(durable_cleanup()).code, "recovery_retained")
        self.assertEqual(journal.clears, 0)
        self.assertTrue(journal.records)
        self.assert_signal_log(fake, [])
        self.assert_no_task_success(decision)

        class RaiseWhenArmed:
            def __init__(self):
                self.armed = False

            def __call__(self):
                if self.armed:
                    raise RuntimeError("predicate unavailable")
                return False

        predicate = RaiseWhenArmed()
        ctl, fake, _observer, journal, _clock = self.controller(predicate=predicate)
        self.claim(ctl)
        self.assertEqual(ctl.begin_launch("worker").code, "launch_open")
        self.assertEqual(ctl.register(worker()).code, "registered")
        predicate.armed = True
        decision = ctl.confirm_ack()
        self.assertEqual(decision.code, "ack_after_stop")
        self.assertFalse(decision.allowed)
        self.assertTrue(decision.recovery_retained)
        self.assertEqual(decision.registered_pgids, (100,))
        self.assertEqual(journal.snapshot()["ack"], "pending")
        self.assert_signal_log(fake, [])

    def test_stop_during_ack_persist_denies_exec(self):
        flag = Flag(False)
        journal = GateJournal()
        lock = ObservableLock()
        ctl, fake, _observer, _stored, _clock = self.controller(
            predicate=flag, journal=journal, lock=lock
        )
        self.claim(ctl)
        self.assertEqual(ctl.begin_launch("worker").code, "launch_open")
        self.assertEqual(ctl.register(worker()).code, "registered")
        journal.armed = True
        found = {}

        def run_first():
            found["first"] = ctl.confirm_ack()

        first = threading.Thread(target=run_first)
        first.start()
        self.assertTrue(journal.entered.wait(5))
        flag.value = True

        def run_second():
            found["second"] = ctl.confirm_ack()

        second = threading.Thread(target=run_second)
        second.start()
        self.assertTrue(lock.wait_for_waiter(5))
        journal.release.set()
        first.join(5)
        second.join(5)
        self.assertFalse(first.is_alive())
        self.assertFalse(second.is_alive())
        self.assertEqual(found["first"].code, "ack_after_stop")
        self.assertFalse(found["first"].allowed)
        self.assertTrue(found["first"].recovery_retained)
        self.assertEqual(found["first"].registered_pgids, (100,))
        self.assertEqual(found["second"].code, "ack_after_stop")
        self.assertFalse(found["second"].allowed)
        self.assertTrue(found["second"].recovery_retained)
        self.assertEqual(found["second"].registered_pgids, (100,))
        self.assertEqual(journal.snapshot()["ack"], "pending")
        self.assertEqual(journal.snapshot()["outcome"], "ack_after_stop")
        self.assertEqual(ctl.evaluate_target(100, 100).code, "registered_unverified")
        self.assertNotEqual(ctl.finish(phase_completed=False).code, "cleanup_pending")
        self.assertEqual(journal.clears, 0)
        self.assert_signal_log(fake, [])

    def test_stop_before_release_is_not_an_in_flight_claim(self):
        """Stop during claim permission, before the caller is released, is not in flight."""
        flag = Flag(False)
        journal = GateJournal()
        lock = ObservableLock()
        ctl, fake, _observer, _stored, _clock = self.controller(
            predicate=flag, journal=journal, lock=lock
        )
        journal.armed = True
        found = {}

        def run_claim():
            found["claim"] = ctl.before_claim()

        claim = threading.Thread(target=run_claim)
        claim.start()
        self.assertTrue(journal.entered.wait(5))
        flag.value = True

        def run_stop():
            found["stop"] = ctl.request_stop()

        def run_late():
            found["late"] = ctl.note_claimed(TASK_ID, exact_claim=True)

        stopper = threading.Thread(target=run_stop)
        later = threading.Thread(target=run_late)
        stopper.start()
        later.start()
        self.assertTrue(lock.wait_for_waiter(5, count=2))
        journal.release.set()
        claim.join(5)
        stopper.join(5)
        later.join(5)
        self.assertFalse(claim.is_alive())
        self.assertFalse(stopper.is_alive())
        self.assertFalse(later.is_alive())
        self.assertEqual(found["claim"].code, "stop_before_claim")
        self.assertNotEqual(found["claim"].code, "claim_unresolved")
        self.assertFalse(found["claim"].allowed)
        self.assertFalse(found["claim"].recovery_retained)
        self.assertTrue(found["claim"].group_confirmed)
        self.assertEqual(found["stop"].code, "stop_before_claim")
        self.assertNotEqual(found["stop"].code, "claim_unresolved")
        self.assertFalse(found["stop"].recovery_retained)
        self.assertEqual(found["late"].code, "invalid_transition")
        self.assertIsNone(journal.snapshot()["claim"])
        self.assertFalse(journal.snapshot()["claim_window"])
        self.assertEqual(journal.snapshot()["outcome"], "stop_before_claim")
        self.assertNotIn("claim_unresolved", [record["outcome"] for record in journal.records])
        self.assertEqual(ctl.phase, "idle")
        self.assert_signal_log(fake, [])
        finished = ctl.finish(phase_completed=False)
        self.assertEqual(finished.code, "cleanup_pending")
        self.assertEqual(journal.clears, 0)
        self.assert_no_task_success(found["claim"])
        self.assert_no_task_success(found["late"])

    def test_finish_during_unresolved_claim_cannot_cleanup(self):
        journal = GateJournal()
        lock = ObservableLock()
        ctl, fake, _observer, _stored, _clock = self.controller(journal=journal, lock=lock)
        self.assertEqual(ctl.before_claim().code, "claim_permitted")
        journal.armed = True
        found = {}

        def run_stop():
            found["stop"] = ctl.request_stop()

        stopper = threading.Thread(target=run_stop)
        stopper.start()
        self.assertTrue(journal.entered.wait(5))

        def run_finish():
            found["finish"] = ctl.finish(phase_completed=False)

        finisher = threading.Thread(target=run_finish)
        finisher.start()
        self.assertTrue(lock.wait_for_waiter(5))
        journal.release.set()
        stopper.join(5)
        finisher.join(5)
        self.assertFalse(stopper.is_alive())
        self.assertFalse(finisher.is_alive())
        self.assertEqual(found["stop"].code, "claim_unresolved")
        self.assertNotEqual(found["stop"].code, "stop_before_claim")
        self.assertTrue(found["stop"].recovery_retained)
        self.assertFalse(found["stop"].group_confirmed)
        self.assertFalse(found["stop"].pointer_cleanup_permitted)
        self.assertFalse(found["stop"].lock_release_permitted)
        self.assertEqual(found["finish"].code, "recovery_retained")
        self.assertTrue(found["finish"].recovery_retained)
        self.assertFalse(found["finish"].pointer_cleanup_permitted)
        self.assertFalse(found["finish"].lock_release_permitted)
        self.assertEqual(ctl.phase, "claiming")
        self.assertNotEqual(ctl.phase, "idle")
        self.assertTrue(journal.snapshot()["claim_window"])
        self.assertIsNone(journal.snapshot()["claim"])
        self.assertEqual(journal.clears, 0)
        self.assertEqual(ctl.confirm_cleanup_durable(durable_cleanup()).code, "recovery_retained")
        self.assertEqual(journal.clears, 0)
        self.assert_signal_log(fake, [])
        self.assert_no_task_success(found["stop"])
        self.assert_no_task_success(found["finish"])

    def test_finish_during_lost_claim_reply_cannot_cleanup(self):
        journal = GateJournal()
        lock = ObservableLock()
        ctl, fake, _observer, _stored, _clock = self.controller(journal=journal, lock=lock)
        self.assertEqual(ctl.before_claim().code, "claim_permitted")
        journal.armed = True
        found = {}

        def run_unknown():
            found["unknown"] = ctl.note_claim_unknown()

        unknown = threading.Thread(target=run_unknown)
        unknown.start()
        self.assertTrue(journal.entered.wait(5))

        def run_finish():
            found["finish"] = ctl.finish(phase_completed=False)

        finisher = threading.Thread(target=run_finish)
        finisher.start()
        self.assertTrue(lock.wait_for_waiter(5))
        journal.release.set()
        unknown.join(5)
        finisher.join(5)
        self.assertFalse(unknown.is_alive())
        self.assertFalse(finisher.is_alive())
        self.assertEqual(found["unknown"].code, "claim_unknown")
        self.assertNotEqual(found["unknown"].code, "stop_before_claim")
        self.assertFalse(found["unknown"].allowed)
        self.assertTrue(found["unknown"].recovery_retained)
        self.assertFalse(found["unknown"].group_confirmed)
        self.assertFalse(found["unknown"].claim_left_truthful)
        self.assertEqual(found["finish"].code, "recovery_retained")
        self.assertTrue(found["finish"].recovery_retained)
        self.assertFalse(found["finish"].pointer_cleanup_permitted)
        self.assertFalse(found["finish"].lock_release_permitted)
        self.assertEqual(ctl.phase, "claiming")
        self.assertNotEqual(ctl.phase, "idle")
        self.assertFalse(journal.snapshot()["claim_window"])
        self.assertIsNone(journal.snapshot()["claim"])
        self.assertTrue(journal.snapshot()["recovery_retained"])
        self.assertFalse(journal.snapshot()["group_confirmed"])
        self.assertEqual(ctl.note_claimed(TASK_ID, exact_claim=True).code, "invalid_transition")
        self.assertEqual(ctl.confirm_cleanup_durable(durable_cleanup()).code, "recovery_retained")
        self.assertEqual(journal.clears, 0)
        self.assertTrue(journal.records)
        self.assert_signal_log(fake, [])
        self.assert_no_task_success(found["unknown"])
        self.assert_no_task_success(found["finish"])

    def test_pre_ack_stop_denies_exec_until_fake_containment(self):
        flag = Flag(False)
        ctl, fake, _observer, journal, _clock = self.controller(predicate=flag)
        self.claim(ctl)
        self.assertEqual(ctl.begin_launch("worker").code, "launch_open")
        registered = ctl.register(worker())
        self.assertEqual(registered.code, "registered")
        self.assertTrue(registered.allowed)
        flag.value = True
        denied = ctl.confirm_ack()
        self.assertEqual(denied.code, "ack_after_stop")
        self.assertFalse(denied.allowed)
        self.assertTrue(denied.recovery_retained)
        self.assertFalse(denied.group_confirmed)
        self.assertEqual(denied.registered_pgids, (100,))
        self.assertEqual(journal.snapshot()["ack"], "pending")
        self.assertNotEqual(journal.snapshot()["ack"], "confirmed")
        self.assert_signal_log(fake, [])
        still = ctl.confirm_phase_exit("worker")
        self.assertEqual(still.code, "still_running")
        self.assertFalse(still.allowed)
        self.assertEqual(still.registered_pgids, (100,))
        self.assertEqual(ctl.evaluate_target(100, 100).code, "registered_unverified")
        blocked = ctl.finish(phase_completed=False)
        self.assertNotEqual(blocked.code, "cleanup_pending")
        self.assertFalse(blocked.pointer_cleanup_permitted)
        self.assertFalse(blocked.lock_release_permitted)
        self.assertEqual(ctl.confirm_cleanup_durable(durable_cleanup()).code, "recovery_retained")
        self.assertEqual(journal.clears, 0)
        retry = ctl.confirm_ack()
        self.assertEqual(retry.code, "ack_after_stop")
        self.assertFalse(retry.allowed)
        self.assert_signal_log(fake, [])
        fake.results = ["absent"]
        stopped = ctl.request_stop()
        self.assertEqual(stopped.code, "stopped_group_absent")
        self.assertTrue(stopped.group_confirmed)
        self.assertFalse(stopped.recovery_retained)
        self.assert_signal_log(fake, [(100, stop.SIGTERM)])
        late_exec = ctl.confirm_ack()
        self.assertNotEqual(late_exec.code, "ack_confirmed")
        self.assertFalse(late_exec.allowed)
        self.assertEqual(late_exec.registered_pgids, ())
        self.assertEqual(ctl.evaluate_target(100, 100).code, "unknown")
        pending = ctl.finish(phase_completed=False)
        self.assertEqual(pending.code, "cleanup_pending")
        self.assertEqual(journal.clears, 0)
        self.assert_no_task_success(denied)
        self.assert_no_task_success(stopped)

    def _fail_ack_after_stop(self):
        flag = Flag(False)
        journal = self._fail_on(lambda record: record.get("outcome") == "ack_after_stop")
        ctl, fake, _observer, _stored, _clock = self.controller(predicate=flag, journal=journal)
        self.claim(ctl)
        self.assertEqual(ctl.begin_launch("worker").code, "launch_open")
        self.assertEqual(ctl.register(worker()).code, "registered")
        flag.value = True
        decision = ctl.confirm_ack()
        self.assertFalse(decision.allowed)
        self.assertNotEqual(decision.code, "ack_confirmed")
        self.assertEqual(decision.registered_pgids, (100,))
        return decision, ctl, fake, journal, ()

    def _fail_claim_unresolved(self):
        journal = self._fail_on(lambda record: record.get("outcome") == "claim_unresolved")
        ctl, fake, _observer, _stored, _clock = self.controller(journal=journal)
        self.assertEqual(ctl.before_claim().code, "claim_permitted")
        decision = ctl.request_stop()
        self.assertNotEqual(decision.code, "stop_before_claim")
        self.assertTrue(decision.recovery_retained)
        return decision, ctl, fake, journal, ()

    def _fail_claim_unknown(self):
        journal = self._fail_on(lambda record: record.get("outcome") == "claim_unknown")
        ctl, fake, _observer, _stored, _clock = self.controller(journal=journal)
        self.assertEqual(ctl.before_claim().code, "claim_permitted")
        decision = ctl.note_claim_unknown()
        self.assertNotEqual(decision.code, "claim_unknown")
        self.assertTrue(decision.recovery_retained)
        return decision, ctl, fake, journal, ()


    # ---- #211: exact claims (C1, C7, H1) ----

    def test_exact_claim_proves_task_match_in_decision_and_journal(self):
        ctl, fake, _observer, journal, _clock = self.controller()
        self.assertEqual(ctl.before_claim().code, "claim_permitted")
        self.assertFalse(journal.snapshot()["exact_task_match_proven"])
        claimed = ctl.note_claimed(TASK_ID, exact_claim=True)
        self.assertEqual(claimed.code, "claimed")
        self.assertTrue(claimed.allowed)
        self.assertTrue(claimed.exact_task_match_proven)
        self.assertEqual(journal.snapshot()["claim"]["task_id"], TASK_ID)
        self.assertIs(journal.snapshot()["claim"]["exact_task_match_proven"], True)
        self.assertIs(journal.snapshot()["exact_task_match_proven"], True)
        self.assertFalse(claimed.task_marked_done)
        self.assert_signal_log(fake, [])

    def test_unfiltered_claim_does_not_prove_task_match(self):
        ctl, fake, _observer, journal, _clock = self.controller()
        self.assertEqual(ctl.before_claim().code, "claim_permitted")
        claimed = ctl.note_claimed(TASK_ID, exact_claim=False)
        self.assertEqual(claimed.code, "claimed")
        self.assertFalse(claimed.exact_task_match_proven)
        self.assertEqual(journal.snapshot()["claim"]["task_id"], TASK_ID)
        self.assertIs(journal.snapshot()["claim"]["exact_task_match_proven"], False)
        self.assertIs(journal.snapshot()["exact_task_match_proven"], False)
        self.assertEqual(ctl.begin_launch("worker").code, "launch_open")
        self.assertFalse(ctl.request_stop().exact_task_match_proven)
        self.assert_signal_log(fake, [])

    def test_note_claimed_requires_explicit_exact_claim(self):
        ctl, fake, _observer, journal, _clock = self.controller()
        self.assertEqual(ctl.before_claim().code, "claim_permitted")
        with self.assertRaises(TypeError):
            ctl.note_claimed(TASK_ID)  # noqa: the keyword has no default
        for kind in (None, 1, 0, "true", "yes", 1.0):
            with self.subTest(exact_claim=kind):
                refused = ctl.note_claimed(TASK_ID, exact_claim=kind)
                self.assertEqual(refused.code, "invalid_claim_kind")
                self.assertFalse(refused.allowed)
                self.assertFalse(refused.exact_task_match_proven)
                self.assertIsNone(journal.snapshot()["claim"])
                self.assertEqual(ctl.phase, "idle")
        self.assertEqual(ctl.note_claimed(TASK_ID, exact_claim=True).code, "claimed")
        self.assert_signal_log(fake, [])

    def test_malformed_task_id_is_rejected_before_any_claim(self):
        ctl, fake, _observer, journal, _clock = self.controller()
        self.assertEqual(ctl.before_claim().code, "claim_permitted")
        before = len(journal.records)
        for bad in (None, 0, -1, 41.0, 1.5, True, False, "41", stop.MAX_TASK_ID + 1, 2 ** 64, [41]):
            for exact in (True, False):
                with self.subTest(task_id=bad, exact_claim=exact):
                    refused = ctl.note_claimed(bad, exact_claim=exact)
                    self.assertEqual(refused.code, "invalid_task")
                    self.assertFalse(refused.allowed)
                    self.assertFalse(refused.exact_task_match_proven)
                    self.assertEqual(ctl.phase, "idle")
        self.assertEqual(len(journal.records), before)
        self.assertIsNone(journal.snapshot()["claim"])
        largest = ctl.note_claimed(stop.MAX_TASK_ID, exact_claim=True)
        self.assertEqual(largest.code, "claimed")
        self.assertEqual(journal.snapshot()["claim"]["task_id"], stop.MAX_TASK_ID)
        self.assert_signal_log(fake, [])

    def test_stop_with_claim_in_flight_refuses_launch_and_cleanup(self):
        ctl, fake, _observer, journal, _clock = self.controller()
        self.assertEqual(ctl.before_claim().code, "claim_permitted")
        stopped = ctl.request_stop()
        self.assertEqual(stopped.code, "claim_unresolved")
        self.assertEqual(ctl.phase, "claiming")
        self.assertTrue(stopped.recovery_retained)
        launch = ctl.begin_launch("worker")
        self.assertFalse(launch.allowed)
        self.assertNotEqual(launch.code, "launch_open")
        self.assertEqual(ctl.finish(phase_completed=False).code, "recovery_retained")
        self.assertEqual(ctl.confirm_cleanup_durable(durable_cleanup()).code, "recovery_retained")
        self.assertEqual(journal.clears, 0)
        late = ctl.note_claimed(TASK_ID, exact_claim=False)
        self.assertEqual(late.code, "stopped_after_claim")
        self.assertEqual(ctl.phase, "claimed")
        self.assertTrue(late.claim_left_truthful)
        self.assertFalse(late.exact_task_match_proven)
        self.assertEqual(ctl.begin_launch("worker").code, "launch_after_stop")
        self.assert_signal_log(fake, [])

    # ---- #211: a stored id is never ownership (AC3, H2) ----

    def test_target_query_never_reports_ownership(self):
        ctl, fake, observer, _journal, _clock = self.controller()
        self.register_worker(ctl)
        calls = len(observer.calls)
        for pid, pgid in ((100, 100), (100, 101), (999, 999)):
            with self.subTest(pid=pid, pgid=pgid):
                decision = ctl.evaluate_target(pid, pgid)
                self.assertFalse(decision.allowed)
                self.assertNotEqual(decision.code, "owned")
        self.assertEqual(ctl.evaluate_target(100, 100).code, "registered_unverified")
        self.assertEqual(ctl.evaluate_target("100", 100).code, "unknown")
        self.assertEqual(len(observer.calls), calls)
        self.assert_signal_log(fake, [])

    def test_retired_identity_is_never_signalled(self):
        ctl, fake, observer, journal, _clock = self.controller()
        self.register_worker(ctl)
        self.assertIn(100, [item["pid"] for item in journal.snapshot()["owned"]])
        observer.script.append(lambda identity: matching(identity, status="absent"))
        self.assertEqual(ctl.confirm_phase_exit("worker").code, "retired_absent")
        self.assertTrue(any(item["pid"] == 100 for record in journal.records for item in record["owned"]))
        decision = ctl.request_stop()
        self.assertEqual(decision.signals, ())
        self.assertTrue(decision.recovery_retained)
        self.assertEqual(stop.signal_targets_from_record(journal.records[0]), ())
        self.assert_signal_log(fake, [])

    def test_attempt_refuses_an_identity_that_is_not_registered(self):
        """Defense in depth below request_stop: the port needs the registered identity itself."""
        ctl, fake, observer, _journal, _clock = self.controller()
        self.register_worker(ctl)
        stranger = worker(pid=101, pgid=101, birth="birth-stranger")
        ctl._stop_deadline = float("inf")
        kind, _seen, result = ctl._attempt(stranger, stop.SIGTERM)
        self.assertEqual(kind, "match")
        self.assertIsNone(result)
        self.assertEqual(observer.calls[-1], stranger)
        self.assert_signal_log(fake, [])

    def test_refused_signal_for_a_live_match_keeps_recovery(self):
        """Defense in depth: a match the port may not be called for is not a clean stop."""
        ctl, fake, _observer, journal, _clock = self.controller()
        self.register_worker(ctl)
        ctl._signal_allowed = lambda _identity: False
        decision = ctl.request_stop()
        self.assertEqual(decision.code, "signal_refused")
        self.assertTrue(decision.recovery_retained)
        self.assertEqual(decision.registered_pgids, (100,))
        self.assertEqual(ctl.finish(phase_completed=True).code, "recovery_retained")
        self.assertEqual(journal.clears, 0)
        self.assert_signal_log(fake, [])

    # ---- #211: fresh re-observation before each signal (AC3, C5, H4) ----

    def test_each_identity_field_mismatch_blocks_the_signal(self):
        cases = (
            ("role", {"role": "reviewer"}, "unconfirmed_foreign"),
            ("phase", {"phase": "review"}, "unconfirmed_foreign"),
            ("pid", {"pid": 101}, "unconfirmed_foreign"),
            ("pgid", {"pgid": 101}, "unconfirmed_foreign"),
            ("ancestry", {"ancestry": (SELF_PID, 7)}, "unconfirmed_foreign"),
            ("birth", {"birth": "other-birth"}, "retired_reused"),
        )
        for field, overrides, code in cases:
            with self.subTest(field=field):
                ctl, fake, observer, _journal, _clock = self.controller()
                self.register_worker(ctl)
                observer.script.append(lambda identity, o=overrides: matching(identity, **o))
                decision = ctl.request_stop()
                self.assertEqual(decision.code, code)
                self.assertTrue(decision.recovery_retained)
                self.assertFalse(decision.group_confirmed)
                self.assertFalse(decision.pointer_cleanup_permitted)
                self.assert_signal_log(fake, [])

    def test_non_present_observation_blocks_the_signal(self):
        def raises(_identity):
            raise OSError("observer unavailable")

        cases = (
            ("unverifiable", lambda identity: matching(identity, status="unverifiable")),
            ("upper-case", lambda identity: matching(identity, status="PRESENT")),
            ("blank", lambda identity: matching(identity, status="")),
            ("none", lambda identity: matching(identity, status=None)),
            ("running", lambda identity: matching(identity, status="running")),
            ("pid-bool", lambda identity: matching(identity, pid=True)),
            ("not-an-observation", lambda identity: {"status": "present", "pid": identity.pid}),
            ("observer-raises", raises),
        )
        for name, step in cases:
            with self.subTest(observation=name):
                ctl, fake, observer, _journal, _clock = self.controller()
                self.register_worker(ctl)
                observer.script.append(step)
                decision = ctl.request_stop()
                self.assertTrue(decision.code.startswith("unconfirmed_"), decision.code)
                self.assertTrue(decision.recovery_retained)
                self.assertEqual(decision.registered_pgids, (100,))
                self.assert_signal_log(fake, [])

    def test_observer_runs_under_lock_immediately_before_each_signal(self):
        lock = ObservableLock()
        events = []
        observer = Observer()
        signals = Signals(["delivered", "delivered"])
        for fake in (observer, signals):
            fake.events = events
            fake.lock = lock
        ctl, _fake, _observer, _journal, _clock = self.controller(
            observer=observer, signals=signals, lock=lock, grace=0, stop_budget=30
        )
        self.register_worker(ctl)
        del events[:]
        del observer.held[:]
        decision = ctl.request_stop()
        self.assertEqual(decision.code, "containment_unconfirmed")
        self.assertEqual(events, [
            ("observe", 100),
            ("signal", 100, stop.SIGTERM),
            ("observe", 100),
            ("signal", 100, stop.SIGKILL),
            ("observe", 100),
        ])
        self.assertEqual(observer.held, [True, True, True])
        self.assertEqual(signals.held, [True, True])

    def test_port_result_outside_contract_is_uncertain(self):
        for result in (None, "ok", "DELIVERED", 1, True, OSError("port failed"), RuntimeError("port")):
            with self.subTest(result=result):
                ctl, fake, _observer, journal, _clock = self.controller()
                fake.results = [result]
                self.register_worker(ctl)
                decision = ctl.request_stop()
                self.assertEqual(decision.code, "signal_uncertain")
                self.assertTrue(decision.recovery_retained)
                self.assertFalse(decision.group_confirmed)
                self.assertEqual(decision.registered_pgids, (100,))
                self.assertEqual(ctl.finish(phase_completed=True).code, "recovery_retained")
                self.assertEqual(journal.clears, 0)
                self.assert_signal_log(fake, [(100, stop.SIGTERM)])

    # ---- #211: final observation after every signal (AC4, C4, H5, H6) ----

    def test_port_absent_still_requires_a_final_observation(self):
        ctl, fake, observer, journal, _clock = self.controller()
        self.register_worker(ctl)
        fake.results = ["absent"]
        observer.script.extend([matching, matching])
        before = len(observer.calls)
        decision = ctl.request_stop()
        self.assertEqual(len(observer.calls) - before, 2)
        self.assertEqual(decision.code, "containment_unconfirmed")
        self.assertTrue(decision.recovery_retained)
        self.assertFalse(decision.group_confirmed)
        self.assertEqual(decision.registered_pgids, (100,))
        self.assertEqual(ctl.finish(phase_completed=True).code, "recovery_retained")
        self.assertEqual(journal.clears, 0)
        self.assert_signal_log(fake, [(100, stop.SIGTERM)])

    def test_port_absent_with_a_non_confirming_final_observation_keeps_recovery(self):
        def raises(_identity):
            raise OSError("observer unavailable")

        cases = (
            ("unverifiable", stop.Observation("unverifiable"), "unconfirmed_unverifiable"),
            ("raises", raises, "unconfirmed_unverifiable"),
            ("group-occupied", lambda identity: matching(identity, status="absent", group_status="occupied"),
             "retired_unconfirmed_absent"),
            ("no-echo", stop.Observation("absent", group_status="empty"), "retired_unconfirmed_absent"),
            ("other-birth-absent", lambda identity: matching(identity, status="absent", birth="x"),
             "retired_unconfirmed_absent"),
            ("reused", lambda identity: matching(identity, birth="recycled"), "retired_unconfirmed_reused"),
            ("foreign", lambda identity: matching(identity, ancestry=(77,)), "identity_changed_after_signal"),
        )
        for name, final, code in cases:
            with self.subTest(final=name):
                ctl, fake, observer, journal, _clock = self.controller()
                self.register_worker(ctl)
                fake.results = ["absent"]
                observer.script.extend([matching, final])
                decision = ctl.request_stop()
                self.assertEqual(decision.code, code)
                self.assertTrue(decision.recovery_retained)
                self.assertFalse(decision.group_confirmed)
                self.assertFalse(decision.pointer_cleanup_permitted)
                self.assertEqual(ctl.finish(phase_completed=True).code, "recovery_retained")
                self.assertEqual(journal.clears, 0)
                self.assert_signal_log(fake, [(100, stop.SIGTERM)])

    def test_term_then_empty_group_confirms_without_kill(self):
        ctl, fake, observer, _journal, _clock = self.controller(grace=0, stop_budget=30)
        self.register_worker(ctl)
        fake.results = ["delivered"]
        observer.script.extend([matching, absent_group])
        decision = ctl.request_stop()
        self.assertEqual(decision.code, "stopped_group_absent")
        self.assertFalse(decision.recovery_retained)
        self.assertTrue(decision.group_confirmed)
        self.assertEqual(decision.registered_pgids, ())
        self.assert_signal_log(fake, [(100, stop.SIGTERM)])

    def test_term_then_absent_leader_without_empty_group_keeps_recovery(self):
        ctl, fake, observer, journal, _clock = self.controller(grace=0, stop_budget=30)
        self.register_worker(ctl)
        fake.results = ["delivered"]
        observer.script.extend([matching, lambda identity: matching(identity, status="absent")])
        decision = ctl.request_stop()
        self.assertEqual(decision.code, "retired_unconfirmed_absent")
        self.assertTrue(decision.recovery_retained)
        self.assertFalse(decision.group_confirmed)
        self.assertEqual(decision.registered_pgids, ())
        self.assertEqual(ctl.finish(phase_completed=True).code, "recovery_retained")
        self.assertEqual(journal.clears, 0)
        self.assert_signal_log(fake, [(100, stop.SIGTERM)])

    def test_kill_then_final_observation_decides_the_group(self):
        cases = (
            ("empty", absent_group, "stopped_group_absent", False),
            ("leader-only", lambda identity: matching(identity, status="absent"), "retired_unconfirmed_absent", True),
            ("present", matching, "containment_unconfirmed", True),
        )
        for name, final, code, retained in cases:
            with self.subTest(final=name):
                ctl, fake, observer, _journal, _clock = self.controller(grace=0, stop_budget=30)
                self.register_worker(ctl)
                fake.results = ["delivered", "delivered"]
                observer.script.extend([matching, matching, final])
                decision = ctl.request_stop()
                self.assertEqual(decision.code, code)
                self.assertEqual(decision.recovery_retained, retained)
                self.assertEqual(decision.group_confirmed, not retained)
                self.assert_signal_log(fake, [(100, stop.SIGTERM), (100, stop.SIGKILL)])

    def test_kill_port_absent_requires_a_final_observation(self):
        ctl, fake, observer, _journal, _clock = self.controller(grace=0, stop_budget=30)
        self.register_worker(ctl)
        fake.results = ["delivered", "absent"]
        observer.script.extend([matching, matching, matching])
        decision = ctl.request_stop()
        self.assertEqual(decision.code, "containment_unconfirmed")
        self.assertTrue(decision.recovery_retained)
        self.assert_signal_log(fake, [(100, stop.SIGTERM), (100, stop.SIGKILL)])

    def test_absent_without_full_echo_keeps_recovery_even_if_group_empty(self):
        for field, value in (("pid", None), ("pgid", 101), ("role", None), ("phase", "review"),
                             ("birth", None), ("ancestry", None)):
            with self.subTest(field=field):
                ctl, fake, observer, journal, _clock = self.controller()
                self.register_worker(ctl)
                observer.script.append(
                    lambda identity, f=field, v=value: matching(identity, status="absent", group_status="empty", **{f: v})
                )
                decision = ctl.confirm_phase_exit("worker")
                self.assertEqual(decision.code, "retired_absent")
                self.assertTrue(decision.recovery_retained)
                self.assertFalse(decision.group_confirmed)
                self.assertEqual(ctl.finish(phase_completed=True).code, "recovery_retained")
                self.assertEqual(journal.clears, 0)
                self.assert_signal_log(fake, [])

    def test_journal_failure_is_not_cleared_by_later_containment(self):
        journal = Journal(fail=lambda record: record.get("outcome") == "ack_confirmed")
        ctl, fake, observer, _stored, _clock = self.controller(journal=journal)
        self.claim(ctl)
        self.assertEqual(ctl.begin_launch("worker").code, "launch_open")
        self.assertEqual(ctl.register(worker()).code, "registered")
        self.assertEqual(ctl.confirm_ack().code, "journal_failed")
        observer.script.append(absent_group)
        decision = ctl.confirm_phase_exit("worker")
        self.assertEqual(decision.code, "retired_after_journal_failure")
        self.assertTrue(decision.recovery_retained)
        self.assertFalse(decision.group_confirmed)
        self.assertEqual(ctl.finish(phase_completed=True).code, "recovery_retained")
        self.assertEqual(journal.clears, 0)
        self.assert_signal_log(fake, [])

    # ---- #211: no wiring (C14, H12) ----

    def test_dispatcher_entry_points_do_not_import_stop_control(self):
        # #212 D20: the bridge-enabled dispatcher path is wired through StopController.
        # ak_skill_launch and the handoff module still are not.
        for name in ("ak_skill_launch.py", "dispatch_ready_bridge.py"):
            with self.subTest(file=name):
                path = DISPATCHER_DIR / name
                self.assertTrue(path.is_file(), f"{path} is not mounted; the check would be vacuous")
                self.assertNotIn("ak_stop_control", path.read_text(encoding="utf-8"))
                self.assertNotIn("StopController", path.read_text(encoding="utf-8"))
        path = DISPATCHER_DIR / "mc_dispatcher.py"
        self.assertTrue(path.is_file(), f"{path} is not mounted; the check would be vacuous")
        tree = ast.parse(path.read_text(encoding="utf-8"))
        imports = {alias.name for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names}
        self.assertIn("ak_stop_control", imports)
        defs = {node.name: node for node in tree.body if isinstance(node, (ast.ClassDef, ast.FunctionDef))}
        self.assertIn("BridgeDispatcher", defs)
        constructed = [
            item for item in ast.walk(defs["BridgeDispatcher"])
            if isinstance(item, ast.Call) and isinstance(item.func, ast.Attribute) and item.func.attr == "StopController"
        ]
        self.assertEqual(len(constructed), 1, "the bridge path builds exactly one StopController per round")
        ports = {kw.arg: kw.value for kw in constructed[0].keywords}
        for port in ("observer", "signals", "journal", "predicate", "clock", "wait", "self_identity"):
            self.assertIn(port, ports)
        direct = {"killpg", "stop_group", "stop_group_id", "stop_lane_group", "_lane_op", "kill",
                  "terminate", "send_signal"}
        for name, node in defs.items():
            if not (name.startswith("Bridge") or name.startswith("bridge_")):
                continue
            for method in ast.walk(node):
                if not isinstance(method, ast.FunctionDef):
                    continue
                for item in ast.walk(method):
                    if not isinstance(item, ast.Call):
                        continue
                    func = item.func
                    called = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", "")
                    if called in direct:
                        self.assertEqual((name, method.name), ("BridgeSignalPort", "signal_group"),
                                         f"{called} outside the injected signal port")

    # ---- #214 review (CodeRabbit) ----

    def test_ack_refused_while_recovery_is_retained(self):
        journal = Journal(fail=lambda record: record.get("outcome") == "still_running")
        ctl, fake, _observer, _stored, _clock = self.controller(journal=journal)
        self.claim(ctl)
        self.assertEqual(ctl.begin_launch("worker").code, "launch_open")
        self.assertEqual(ctl.register(worker()).code, "registered")
        failed = ctl.confirm_phase_exit("worker")
        self.assertEqual(failed.code, "journal_failed")
        self.assertTrue(failed.recovery_retained)
        decision = ctl.confirm_ack()
        self.assertFalse(decision.allowed)
        self.assertEqual(decision.code, "recovery_retained")
        self.assertTrue(decision.recovery_retained)
        self.assertNotIn("confirmed", [record["ack"] for record in journal.records])
        self.assert_signal_log(fake, [])

    def test_repeated_stop_keeps_confirmed_containment(self):
        ctl, fake, _observer, journal, _clock = self.controller()
        fake.results = ["absent"]
        self.register_worker(ctl)
        first = ctl.request_stop()
        self.assertEqual(first.code, "stopped_group_absent")
        before = len(journal.records)
        again = ctl.request_stop()
        self.assertEqual(again.code, "stopped_group_absent")
        self.assertFalse(again.recovery_retained)
        self.assertTrue(again.group_confirmed)
        self.assertEqual(len(journal.records), before)
        self.assertEqual(ctl.finish(phase_completed=False).code, "cleanup_pending")
        self.assertEqual(ctl.confirm_cleanup_durable(durable_cleanup()).code, "cleanup_confirmed")
        self.assertEqual(journal.records, [])
        late = ctl.request_stop()
        self.assertFalse(late.allowed)
        self.assertEqual(journal.records, [])
        self.assertEqual(journal.clears, 1)
        self.assert_signal_log(fake, [(100, stop.SIGTERM)])

    def test_stop_after_confirmed_exit_reuses_the_proof(self):
        ctl, fake, observer, journal, _clock = self.controller()
        self.register_worker(ctl)
        observer.script.append(absent_group)
        self.assertEqual(ctl.confirm_phase_exit("worker").code, "stopped_group_absent")
        decision = ctl.request_stop()
        self.assertEqual(decision.code, "stopped_after_exit")
        self.assertFalse(decision.recovery_retained)
        self.assertTrue(decision.group_confirmed)
        self.assertTrue(decision.claim_left_truthful)
        self.assertEqual(journal.snapshot()["outcome"], "stopped_after_exit")
        self.assertTrue(journal.snapshot()["stopped"])
        self.assertEqual(ctl.begin_launch("reviewer").code, "launch_after_stop")
        self.assertEqual(ctl.finish(phase_completed=True).code, "cleanup_pending")
        self.assert_signal_log(fake, [])

    def test_stop_after_a_cleared_journal_writes_nothing(self):
        ctl, fake, observer, journal, _clock = self.controller()
        self.register_worker(ctl)
        observer.script.append(absent_group)
        self.assertEqual(ctl.confirm_phase_exit("worker").code, "stopped_group_absent")
        self.assertEqual(ctl.finish(phase_completed=True).code, "cleanup_pending")
        self.assertEqual(ctl.confirm_cleanup_durable(durable_cleanup()).code, "phase_finished")
        self.assertEqual(journal.records, [])
        decision = ctl.request_stop()
        self.assertFalse(decision.allowed)
        self.assertEqual(journal.records, [])
        self.assertEqual(journal.clears, 1)
        self.assertEqual(ctl.phase, "finished")
        self.assert_signal_log(fake, [])

    def test_observer_answer_after_the_budget_does_not_signal(self):
        ctl, fake, observer, journal, clock = self.controller(stop_budget=5)
        self.register_worker(ctl)

        def slow_match(identity):
            clock.now += 6
            return matching(identity)

        observer.script.append(slow_match)
        decision = ctl.request_stop()
        self.assertEqual(decision.code, "timeout")
        self.assertTrue(decision.recovery_retained)
        self.assertEqual(decision.registered_pgids, (100,))
        self.assertEqual(ctl.finish(phase_completed=True).code, "recovery_retained")
        self.assertEqual(journal.clears, 0)
        self.assert_signal_log(fake, [])

    def test_late_final_observation_does_not_confirm_containment(self):
        ctl, fake, observer, journal, clock = self.controller(stop_budget=5)
        self.register_worker(ctl)
        fake.results = ["absent"]

        def slow_absent(identity):
            clock.now += 6
            return absent_group(identity)

        observer.script.extend([matching, slow_absent])
        decision = ctl.request_stop()
        self.assertEqual(decision.code, "timeout")
        self.assertTrue(decision.recovery_retained)
        self.assertFalse(decision.group_confirmed)
        self.assertEqual(ctl.finish(phase_completed=True).code, "recovery_retained")
        self.assertEqual(journal.clears, 0)
        self.assert_signal_log(fake, [(100, stop.SIGTERM)])

    def test_wait_is_capped_at_the_remaining_budget(self):
        ctl, fake, _observer, _journal, clock = self.controller(grace=10, stop_budget=5)
        fake.results = ["delivered"]
        self.register_worker(ctl)
        start = clock.now
        decision = ctl.request_stop()
        self.assertEqual(decision.code, "timeout")
        self.assertEqual(clock.now - start, 5)
        self.assert_signal_log(fake, [(100, stop.SIGTERM)])

    def _worker_exited(self):
        ctl, fake, observer, journal, _clock = self.controller()
        self.register_worker(ctl)
        observer.script.append(absent_group)
        self.assertEqual(ctl.confirm_phase_exit("worker").code, "stopped_group_absent")
        return ctl, fake, journal

    def test_open_reviewer_ticket_blocks_cleanup(self):
        ctl, fake, journal = self._worker_exited()
        self.assertEqual(ctl.begin_launch("reviewer").code, "launch_open")
        finished = ctl.finish(phase_completed=True)
        self.assertFalse(finished.allowed)
        self.assertEqual(finished.code, "launch_in_progress")
        self.assertFalse(finished.pointer_cleanup_permitted)
        self.assertFalse(finished.lock_release_permitted)
        confirmed = ctl.confirm_cleanup_durable(durable_cleanup())
        self.assertFalse(confirmed.allowed)
        self.assertEqual(confirmed.code, "launch_in_progress")
        self.assertEqual(journal.clears, 0)
        self.assertEqual(journal.snapshot()["cleanup_state"], "none")
        self.assertEqual(ctl.register(reviewer()).code, "registered")
        self.assert_signal_log(fake, [])

    def test_cleanup_reservation_blocks_reviewer_launch(self):
        ctl, fake, journal = self._worker_exited()
        self.assertEqual(ctl.finish(phase_completed=False).code, "cleanup_pending")
        launch = ctl.begin_launch("reviewer")
        self.assertFalse(launch.allowed)
        self.assertEqual(launch.code, "cleanup_reserved")
        self.assertIsNone(journal.snapshot()["launch_ticket"])
        self.assertEqual(ctl.confirm_cleanup_durable(durable_cleanup()).code, "cleanup_confirmed")
        self.assertEqual(ctl.begin_launch("reviewer").code, "cleanup_reserved")
        self.assert_signal_log(fake, [])

    def test_failed_claim_record_states_the_claim_left_truthful(self):
        journal = Journal(fail=lambda record: record.get("outcome") == "claimed")
        ctl, fake, _observer, _stored, _clock = self.controller(journal=journal)
        self.assertEqual(ctl.before_claim().code, "claim_permitted")
        decision = ctl.note_claimed(TASK_ID, exact_claim=True)
        self.assertEqual(decision.code, "journal_failed")
        self.assertTrue(decision.claim_left_truthful)
        fallback = journal.snapshot()
        self.assertEqual(fallback["outcome"], "journal_failed")
        self.assertEqual(fallback["claim"]["task_id"], TASK_ID)
        self.assertIs(fallback["claim"]["left_truthful"], True)
        self.assert_signal_log(fake, [])

    def test_exact_claim_not_reported_without_a_durable_write(self):
        journal = Journal(fail=lambda record: record.get("claim") is not None)
        ctl, fake, _observer, _stored, _clock = self.controller(journal=journal)
        self.assertEqual(ctl.before_claim().code, "claim_permitted")
        decision = ctl.note_claimed(TASK_ID, exact_claim=True)
        self.assertEqual(decision.code, "journal_failed")
        self.assertFalse(decision.exact_task_match_proven)
        self.assertIsNone(journal.snapshot()["claim"])
        self.assertFalse(ctl.request_stop().exact_task_match_proven)

        journal = Journal(fail=lambda record: record.get("outcome") == "claimed")
        ctl, _fake, _observer, _stored, _clock = self.controller(journal=journal)
        self.assertEqual(ctl.before_claim().code, "claim_permitted")
        decision = ctl.note_claimed(TASK_ID, exact_claim=True)
        self.assertEqual(decision.code, "journal_failed")
        self.assertIs(journal.snapshot()["claim"]["exact_task_match_proven"], True)
        self.assertTrue(decision.exact_task_match_proven)
        self.assert_signal_log(fake, [])

if __name__ == "__main__":
    unittest.main()
