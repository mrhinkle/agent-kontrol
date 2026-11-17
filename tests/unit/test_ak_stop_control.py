#!/usr/bin/env python3
"""Virtual no-signal tests for the phase-1 stop control seam.

These tests are the proof only when run by tests/unit/run_ak_stop_control_virtual.sh
inside the local unprivileged python:3.12-bookworm image. That runner uses a
private PID namespace, --network none, a read-only source mount, and scratch
under /tmp. A host interpreter may syntax-check the modules; it is not this run.

Every signal syscall is replaced before the seam is imported. The seam itself
has no signal port except the recording fake passed in here.
"""
from __future__ import annotations

import ast
import inspect
import json
import os
import sys
import threading
import unittest


def _forbid_signal(*_args, **_kwargs):
    raise AssertionError("phase-1 virtual test invoked a signal syscall")


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
        if record.get("exact_task_match_proven") is not False or record.get("task_marked_done") is not False:
            raise AssertionError("journal recorded task success or an exact task match")
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
    def __init__(self):
        self.calls = []
        self.script = []

    def observe(self, identity):
        self.calls.append(identity)
        if self.script:
            step = self.script.pop(0)
            return step(identity) if callable(step) else step
        return matching(identity)


class Signals:
    def __init__(self, results=None):
        self.calls = []
        self.results = list(results or [])

    def signal_group(self, pgid, sig):
        self.calls.append((pgid, sig))
        if pgid <= 1 or pgid == SELF_PGID:
            raise AssertionError(f"fake port was asked to signal {pgid}")
        if self.results:
            return self.results.pop(0)
        return "delivered"


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

    def wait_for_waiter(self, timeout):
        with self._condition:
            return self._condition.wait_for(lambda: self.waiters >= 1, timeout)


class Flag:
    def __init__(self, value=False):
        self.value = value

    def __call__(self):
        return self.value


def worker(pid=100, pgid=100, birth="birth-worker"):
    return stop.OwnedIdentity(pid, pgid, "worker", "worker", birth, (SELF_PID,))


def reviewer(pid=200, pgid=200, birth="birth-reviewer"):
    return stop.OwnedIdentity(pid, pgid, "reviewer", "review", birth, (SELF_PID,))


class StopControlTests(unittest.TestCase):
    def controller(self, *, predicate=None, observer=None, signals=None, journal=None, clock=None,
                   grace=1.0, stop_budget=5.0, lock=None):
        clock = clock or Clock()
        journal = journal or Journal()
        observer = observer or Observer()
        signals = signals or Signals()

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
        claimed = ctl.note_claimed(TASK_ID)
        self.assertEqual(claimed.code, "claimed")
        self.assertFalse(claimed.exact_task_match_proven)
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
        self.assertFalse(decision.exact_task_match_proven)
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
        self.assertIn("no task-id", stop.EXACT_TASK_MATCH_PREREQUISITE)

    def assert_no_signal_ops(self, tree, *, allow_os):
        forbidden_roots = {
            "signal", "subprocess", "socket", "ctypes", "multiprocessing", "pty",
            "mc_dispatcher", "ak_skill_launch", "ak_pointers",
        }
        if not allow_os:
            forbidden_roots.add("os")
        forbidden_calls = {"kill", "killpg", "pthread_kill", "system", "Popen", "popen", "execvp", "execve", "fork"}
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
                if not allow_os and node.attr in {"kill", "killpg"}:
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
        self.assertEqual(ctl.note_claimed(TASK_ID).code, "invalid_transition")
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
        decision = ctl.note_claimed(TASK_ID)
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
        self.assertEqual(tuple(ctl.evaluate_target(100, 100).owned_pgids), ())

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
        self.assertEqual(duplicate.owned_pgids, (100,))
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
        self.assertEqual(decision.owned_pgids, (100,))
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
        self.assertEqual(decision.owned_pgids, ())
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
        self.assertFalse(decision.exact_task_match_proven)
        self.assert_signal_log(fake, [(100, stop.SIGTERM)])

    def _pending_cleanup(self, ctl, fake):
        fake.results = ["absent"]
        self.register_worker(ctl)
        self.assertEqual(ctl.request_stop().code, "stopped_group_absent")
        pending = ctl.finish(phase_completed=False)
        self.assertEqual(pending.code, "cleanup_pending")
        self.assertTrue(pending.pointer_cleanup_permitted)
        self.assertTrue(pending.lock_release_permitted)

    def test_exact_task_match_is_never_proven(self):
        ctl, _fake, _observer, journal, _clock = self.controller()
        self.claim(ctl)
        self.assertFalse(any(record["exact_task_match_proven"] for record in journal.records))
        self.assertEqual(ctl.note_claimed(TASK_ID).code, "invalid_transition")
        self.assertIn("no task-id", journal.snapshot()["prerequisite"])
        self.assertFalse(journal.snapshot()["claim"]["exact_task_match_proven"])


if __name__ == "__main__":
    unittest.main()
