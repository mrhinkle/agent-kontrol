#!/usr/bin/env python3
"""Phase-1 stop, launch, and finish control for one dispatcher round.

This module is a pure state machine. It does not start a process, import the
running dispatcher, read the environment, open a claim route, or call a signal
syscall. The caller injects the stop predicate, the identity observer, the
signal port, the journal, the clock, and the wait. Tests replace the signal
port with a recording fake.

A stored pid or pgid is not ownership. The signal port is called only for an
identity that is still explicitly registered and that the observer has just
shown to be the same role, phase, birth, ancestry, pid, and pgid. Pid 1 and
below, the controller's own pid, and the controller's own group are never
passed to the port.

If the registered identity is already absent or reused, the id is retired and
not signalled. Group membership is then unknown, because probing that numeric
group could hit a recycled id, so the recovery interlock stays. Group
containment is accepted only when a fresh match is followed by the port
reporting that the group was already gone. That check-to-signal window can
still race; this unit does not claim it can see unregistered descendants,
detached children, or a process selected by name, session, or uid.

Exact issue-to-task matching is not implemented. ``POST /api/tasks/claim`` and
``claimNextTask`` select the next queued row by platform, machine, and an
optional exact project. They take no task id. ``exact_task_match_proven`` is
always false.

``finish`` does not clear the injected journal. It only records that pointer
cleanup and lock release are permitted. The caller performs both actions.
``confirm_cleanup_durable`` then requires an explicit confirmation that both
completed and that the confirmation itself is already durable. That
confirmation is persisted before ``clear``. A missing, partial, or non-durable
confirmation, a failed persist, or a failed clear keeps the journal and
retains recovery. This module does not clean pointers, release a lock, or
decide those facts by inspecting processes.

Nothing here is wired into ``mc_dispatcher`` or ``ak_skill_launch``. Importing
this module reads no file and makes no request.
"""
from __future__ import annotations

import math
import threading
from contextlib import contextmanager
from dataclasses import dataclass

# Request numbers passed to the injected port. This module never imports signal.
SIGTERM = 15
SIGKILL = 9

EXACT_TASK_MATCH_PREREQUISITE = (
    "POST /api/tasks/claim accepts platform, machine, agent_id, and an optional "
    "exact project. claimNextTask filters by platform, machine, and project only. "
    "There is no task-id argument, so a claimed row is not proven to be the task "
    "bound to one issue. Exact matching remains a separate reviewed unit."
)

_ROLES = {"worker": "worker", "reviewer": "review"}


def signal_targets_from_record(record: dict) -> tuple[int, ...]:
    """A journal record never authorizes a signal. Stored ids can be stale."""
    del record
    return ()


@dataclass(frozen=True)
class SelfIdentity:
    pid: int
    pgid: int

    def __post_init__(self) -> None:
        for value in (self.pid, self.pgid):
            if type(value) is not int or value <= 1:
                raise ValueError("self identity must be a pid and a process group above 1")


@dataclass(frozen=True)
class OwnedIdentity:
    pid: int
    pgid: int
    role: str
    phase: str
    birth: str
    ancestry: tuple[int, ...]


@dataclass(frozen=True)
class Observation:
    """What the injected observer saw.

    ``status`` is ``present``, ``absent``, or ``unverifiable``. ``group_status``
    is ``empty``, ``occupied``, or ``unknown``. ``empty`` is honored only when
    the observation also echoes the registered identity and says that identity
    is absent. Leader absence alone does not prove the group is empty.
    """

    status: str
    pid: int | None = None
    pgid: int | None = None
    role: str | None = None
    phase: str | None = None
    birth: str | None = None
    ancestry: tuple[int, ...] | None = None
    group_status: str = "unknown"


@dataclass(frozen=True)
class Decision:
    allowed: bool
    code: str
    recovery_retained: bool
    lock_release_permitted: bool
    pointer_cleanup_permitted: bool
    task_marked_done: bool
    exact_task_match_proven: bool
    claim_left_truthful: bool
    requeue: bool
    phase_finished: bool
    registered_identity_contained: bool
    group_confirmed: bool
    owned_pgids: tuple[int, ...]
    signals: tuple[tuple[int, int], ...]


@dataclass(frozen=True)
class CleanupConfirmation:
    """Caller attestation that pointer cleanup and lock release already finished.

    ``pointer_cleanup`` and ``lock_release`` must be the exact string
    ``complete``. ``durable`` must be ``True``, meaning the caller already
    stored this attestation somewhere that survives this process. This object
    is not an observation of a pid, a lock file, or a pointer table.
    """

    pointer_cleanup: str
    lock_release: str
    durable: bool


class StopController:
    """Serialize stop, launch, and finish for one explicitly owned child at a time."""

    def __init__(
        self,
        *,
        self_identity: SelfIdentity,
        predicate,
        observer,
        signals,
        journal,
        clock,
        wait,
        grace: float = 1.0,
        stop_budget: float = 5.0,
        lock=None,
    ) -> None:
        if not isinstance(self_identity, SelfIdentity):
            raise TypeError("self_identity is required")
        _require_span(grace, "grace")
        _require_span(stop_budget, "stop_budget")
        self._self = self_identity
        self._predicate = predicate
        self._observer = observer
        self._signals_port = signals
        self._journal = journal
        self._clock = clock
        self._wait = wait
        self._grace = float(grace)
        self._stop_budget = float(stop_budget)
        self._lock = lock if lock is not None else threading.Lock()
        self._phase = "idle"
        self._stopped = False
        self._claim_window = False
        self._claim_id: int | None = None
        self._claim_left_truthful = False
        self._ticket: str | None = None
        self._owned: dict[str, OwnedIdentity] = {}
        self._ack = "none"
        self._ever_registered = False
        self._worker_closed = False
        self._recovery_retained = False
        self._journal_open = False
        self._group_confirmed = False
        self._registered_contained = False
        self._outcome = "idle"
        self._signals: list[tuple[int, int]] = []
        self._stop_deadline = 0.0
        self._cleanup_state = "none"
        self._cleanup_proof: CleanupConfirmation | None = None
        self._phase_completed = False

    @property
    def phase(self) -> str:
        return self._phase

    @property
    def stopped(self) -> bool:
        return self._stopped

    def before_claim(self) -> Decision:
        with self._hold():
            start = self._mark()
            if self._phase != "idle" or self._claim_id is not None:
                return self._decision(start, allowed=False, code="invalid_transition")
            if self._stop_requested():
                self._outcome = "stop_before_claim"
                self._registered_contained = True
                self._group_confirmed = True
                self._persist()
                return self._decision(start, allowed=False, code="stop_before_claim")
            self._claim_window = True
            self._outcome = "claim_permitted"
            return self._decision(start, allowed=True, code="claim_permitted")

    def note_claimed(self, task_id: int) -> Decision:
        """Record a claim the caller already observed. This does not contact the API."""
        with self._hold():
            start = self._mark()
            if type(task_id) is not int or task_id <= 0:
                return self._decision(start, allowed=False, code="invalid_task")
            if not self._claim_window or self._claim_id is not None:
                return self._decision(start, allowed=False, code="invalid_transition")
            self._claim_id = task_id
            self._claim_window = False
            if self._stop_requested():
                self._claim_left_truthful = True
                self._outcome = "stopped_after_claim"
                self._registered_contained = True
                self._group_confirmed = True
                self._persist()
                return self._decision(start, allowed=False, code="stopped_after_claim", claim_left_truthful=True)
            self._phase = "claimed"
            self._outcome = "claimed"
            self._persist()
            return self._decision(start, allowed=True, code="claimed")

    def begin_launch(self, role: str) -> Decision:
        with self._hold():
            start = self._mark()
            if role not in _ROLES:
                return self._decision(start, allowed=False, code="role")
            if self._stop_requested():
                self._ticket = None
                self._outcome = "launch_after_stop"
                self._persist()
                return self._decision(start, allowed=False, code="launch_after_stop")
            if self._recovery_retained:
                return self._decision(start, allowed=False, code="recovery_retained")
            if role == "worker":
                if self._phase != "claimed" or self._worker_closed:
                    return self._decision(start, allowed=False, code="invalid_transition")
            elif self._phase != "claimed" or not self._worker_closed or not self._group_confirmed:
                return self._decision(start, allowed=False, code="review_requires_worker_exit")
            if self._ticket is not None or self._owned:
                return self._decision(start, allowed=False, code="launch_in_progress")
            self._ticket = role
            self._outcome = "launch_open"
            return self._decision(start, allowed=True, code="launch_open")

    def register(self, identity: OwnedIdentity) -> Decision:
        """Persist a directly created child before the caller may exec its payload."""
        with self._hold():
            start = self._mark()
            had_ticket = self._ticket is not None
            if self._stop_requested():
                self._ticket = None
                if had_ticket:
                    self._hold_untracked()
                self._outcome = "launch_after_stop"
                return self._decision(start, allowed=False, code="launch_after_stop")
            if isinstance(identity, OwnedIdentity) and (
                identity.role in self._owned or any(item.pid == identity.pid for item in self._owned.values())
            ):
                return self._decision(start, allowed=False, code="duplicate_registration")
            refusal = self._structural_refusal(identity)
            if refusal is not None:
                if had_ticket:
                    self._ticket = None
                    self._hold_untracked()
                return self._decision(start, allowed=False, code=refusal)
            if not had_ticket or identity.role != self._ticket:
                if had_ticket:
                    self._ticket = None
                    self._hold_untracked()
                return self._decision(start, allowed=False, code="invalid_transition" if not had_ticket else "role")
            kind, _seen = self._observe(identity)
            if kind != "match":
                self._ticket = None
                self._hold_untracked()
                return self._decision(start, allowed=False, code="register_" + kind)
            previous_phase = self._phase
            previous_contained = self._registered_contained
            previous_ever = self._ever_registered
            self._owned[identity.role] = identity
            self._phase = identity.phase
            self._ack = "pending"
            self._ticket = None
            self._ever_registered = True
            self._registered_contained = False
            self._group_confirmed = False
            self._outcome = "registered"
            if not self._persist():
                self._owned.pop(identity.role, None)
                self._phase = previous_phase
                self._ack = "none"
                self._ever_registered = previous_ever
                self._registered_contained = previous_contained
                self._recovery_retained = True
                self._outcome = "journal_failed"
                return self._decision(start, allowed=False, code="journal_failed")
            return self._decision(start, allowed=True, code="registered")

    def confirm_ack(self) -> Decision:
        with self._hold():
            start = self._mark()
            if self._ack != "pending" or not self._owned:
                return self._decision(start, allowed=False, code="invalid_transition")
            self._ack = "confirmed"
            self._outcome = "ack_confirmed"
            if not self._persist():
                self._ack = "failed"
                self._recovery_retained = True
                self._outcome = "ack_failed"
                return self._decision(start, allowed=False, code="ack_failed")
            return self._decision(start, allowed=True, code="ack_confirmed")

    def ack_failed(self) -> Decision:
        with self._hold():
            start = self._mark()
            if self._ack != "pending" or not self._owned:
                return self._decision(start, allowed=False, code="invalid_transition")
            self._ack = "failed"
            self._recovery_retained = True
            self._outcome = "ack_failed"
            self._persist()
            return self._decision(start, allowed=False, code="ack_failed")

    def confirm_phase_exit(self, role: str) -> Decision:
        """Retire a registered child that is already gone. Never signals."""
        with self._hold():
            start = self._mark()
            identity = self._owned.get(role)
            if identity is None or self._ack == "none":
                return self._decision(start, allowed=False, code="invalid_transition")
            self._close_without_signal(identity)
            if not self._persist():
                self._recovery_retained = True
                self._group_confirmed = False
                self._outcome = "journal_failed"
            return self._decision(start, allowed=identity.role not in self._owned, code=self._outcome)

    def request_stop(self) -> Decision:
        with self._hold():
            start = self._mark()
            had_ticket = self._ticket is not None
            self._stopped = True
            self._ticket = None
            if had_ticket and not self._owned:
                self._hold_untracked()
            self._outcome = "stopping"
            if not self._persist():
                self._recovery_retained = True
                self._group_confirmed = False
                self._outcome = "journal_failed"
                return self._decision(start, allowed=False, code="journal_failed")
            if self._claim_id is not None and not self._owned:
                self._claim_left_truthful = True
            if not self._owned:
                self._registered_contained = True
                confirmed = not self._ever_registered and not self._recovery_retained
                self._group_confirmed = confirmed
                self._outcome = "stopped_before_launch" if self._claim_id is not None else "stop_before_claim"
                if not confirmed:
                    self._recovery_retained = True
                    self._outcome = "stopped_unconfirmed"
                if not self._persist():
                    self._recovery_retained = True
                    self._group_confirmed = False
                    self._outcome = "journal_failed"
                return self._decision(
                    start,
                    allowed=False,
                    code=self._outcome,
                    claim_left_truthful=self._claim_left_truthful,
                )
            identity = self._active_identity()
            if identity is None:
                self._recovery_retained = True
                self._group_confirmed = False
                self._outcome = "ambiguous_owner"
                self._persist()
                return self._decision(start, allowed=False, code="ambiguous_owner")
            now = self._now()
            self._stop_deadline = now + self._stop_budget if now is not None else 0.0
            if now is None:
                self._recovery_retained = True
                self._outcome = "clock_failed"
                self._persist()
                return self._decision(start, allowed=False, code="clock_failed")
            self._contain(identity)
            if not self._persist():
                self._recovery_retained = True
                self._group_confirmed = False
                self._outcome = "journal_failed"
            return self._decision(
                start,
                allowed=False,
                code=self._outcome,
                claim_left_truthful=self._claim_left_truthful,
            )

    def finish(self, *, phase_completed: bool) -> Decision:
        """Permit cleanup. The recovery journal stays until durable confirmation."""
        with self._hold():
            start = self._mark()
            if type(phase_completed) is not bool:
                return self._decision(start, allowed=False, code="invalid_transition")
            if self._cleanup_state == "cleared":
                return self._decision(
                    start,
                    allowed=True,
                    code=self._outcome,
                    phase_finished=self._phase_is_finished(),
                )
            if self._recovery_retained or self._cleanup_state == "uncertain":
                return self._decision(start, allowed=False, code="recovery_retained")
            if not self._cleanup_base():
                return self._decision(start, allowed=False, code="recovery_retained")
            if self._cleanup_state == "pending":
                return self._decision(start, allowed=True, code="cleanup_pending", phase_finished=False)
            self._phase_completed = phase_completed
            self._cleanup_state = "pending"
            self._outcome = "cleanup_pending"
            if not self._persist():
                self._cleanup_state = "none"
                self._recovery_retained = True
                self._outcome = "journal_failed"
                self._persist()
                return self._decision(start, allowed=False, code="journal_failed")
            return self._decision(start, allowed=True, code="cleanup_pending", phase_finished=False)

    def confirm_cleanup_durable(self, confirmation: CleanupConfirmation) -> Decision:
        """Clear the journal only after an explicit durable cleanup confirmation.

        The caller must already have completed pointer cleanup and lock release.
        This method does not perform either action. The confirmation is written
        into the injected journal first. ``clear`` runs only after that write
        succeeds. Any other confirmation, or a failed write or clear, leaves
        the journal in place and retains recovery.
        """
        with self._hold():
            start = self._mark()
            if self._cleanup_state == "cleared":
                return self._decision(
                    start,
                    allowed=True,
                    code=self._outcome,
                    phase_finished=self._phase_is_finished(),
                )
            if self._recovery_retained or self._cleanup_state in ("uncertain", "confirmed"):
                return self._decision(start, allowed=False, code="recovery_retained")
            if self._cleanup_state != "pending" or not self._cleanup_base():
                return self._reject_cleanup(start)
            if not _explicit_cleanup_confirmation(confirmation):
                self._cleanup_proof = confirmation if type(confirmation) is CleanupConfirmation else None
                return self._reject_cleanup(start)
            self._cleanup_proof = confirmation
            self._cleanup_state = "confirmed"
            self._outcome = "cleanup_confirmed"
            if not self._persist():
                self._recovery_retained = True
                self._cleanup_state = "uncertain"
                self._outcome = "journal_failed"
                self._persist()
                return self._decision(start, allowed=False, code="journal_failed")
            if not self._journal_open or not self._clear_journal():
                self._recovery_retained = True
                self._outcome = "journal_clear_failed"
                self._persist()
                return self._decision(start, allowed=False, code="journal_clear_failed")
            self._cleanup_state = "cleared"
            if self._phase_is_finished():
                self._phase = "finished"
                self._outcome = "phase_finished"
            return self._decision(
                start,
                allowed=True,
                code=self._outcome,
                phase_finished=self._phase_is_finished(),
            )

    def evaluate_target(self, pid: int, pgid: int) -> Decision:
        """Say whether an id is owned. This never signals and never adds a target."""
        with self._hold():
            start = self._mark()
            if type(pid) is not int or type(pgid) is not int:
                return self._decision(start, allowed=False, code="unknown")
            owned = any(item.pid == pid and item.pgid == pgid for item in self._owned.values())
            return self._decision(start, allowed=owned, code="owned" if owned else "unknown")

    def _contain(self, identity: OwnedIdentity) -> None:
        if not self._time_left():
            self._recovery_retained = True
            self._group_confirmed = False
            self._outcome = "timeout"
            return
        kind, seen, result = self._attempt(identity, SIGTERM)
        if result is None:
            self._close_without_signal(identity, kind, seen)
            return
        if result == "absent":
            self._accept_group_gone(identity)
            return
        if result != "delivered":
            self._recovery_retained = True
            self._group_confirmed = False
            self._outcome = "signal_uncertain"
            return
        if not self._pause() or not self._time_left():
            self._recovery_retained = True
            self._group_confirmed = False
            self._outcome = "timeout"
            return
        kind, seen, result = self._attempt(identity, SIGKILL)
        if result is None:
            self._close_without_signal(identity, kind, seen, after_signal=True)
            return
        if result == "absent":
            self._accept_group_gone(identity)
            return
        if result != "delivered":
            self._recovery_retained = True
            self._group_confirmed = False
            self._outcome = "signal_uncertain"
            return
        if not self._pause():
            self._recovery_retained = True
            self._group_confirmed = False
            self._outcome = "timeout"
            return
        kind, seen = self._observe(identity)
        if kind == "match":
            self._recovery_retained = True
            self._group_confirmed = False
            self._outcome = "containment_unconfirmed"
            return
        self._close_without_signal(identity, kind, seen, after_signal=True)

    def _close_without_signal(self, identity: OwnedIdentity, kind: str | None = None, seen: object | None = None, *, after_signal: bool = False) -> None:
        if kind is None or seen is None:
            kind, seen = self._observe(identity)
        if kind == "match" and not after_signal:
            self._outcome = "still_running"
            return
        attested = kind == "absent" and _attested_group_empty(identity, seen)
        if kind in ("absent", "reused"):
            self._retire(identity, kind, group_confirmed=attested and not after_signal)
            self._recovery_retained = not (attested and not after_signal)
            if attested and not after_signal:
                self._outcome = "stopped_group_absent"
            elif after_signal:
                self._outcome = "identity_changed_after_signal" if kind == "foreign" else "retired_unconfirmed_" + kind
            else:
                self._outcome = "retired_" + kind
            return
        self._recovery_retained = True
        self._group_confirmed = False
        self._outcome = "identity_changed_after_signal" if after_signal and kind == "foreign" else "unconfirmed_" + kind

    def _accept_group_gone(self, identity: OwnedIdentity) -> None:
        self._retire(identity, "absent", group_confirmed=True)
        self._recovery_retained = False
        self._outcome = "stopped_group_absent"

    def _retire(self, identity: OwnedIdentity, kind: str, *, group_confirmed: bool) -> None:
        self._owned.pop(identity.role, None)
        self._ack = "none"
        self._registered_contained = True
        self._group_confirmed = group_confirmed
        if identity.role == "worker":
            self._worker_closed = True
            if self._phase == "worker":
                self._phase = "claimed"
        elif identity.role == "reviewer" and self._phase == "review":
            self._phase = "claimed"
        del kind

    def _attempt(self, identity: OwnedIdentity, sig: int):
        """Observe immediately and signal only a still-matching owned group.

        The port is not called for any other result. The lock is held, and the
        observer can still change before the port runs; a later observation
        that is no longer a match does not authorize another signal.
        """
        kind, seen = self._observe(identity)
        if kind != "match" or not self._signal_allowed(identity):
            return kind, seen, None
        if identity.role not in self._owned or self._owned.get(identity.role) != identity:
            return kind, seen, None
        self._signals.append((identity.pgid, sig))
        try:
            result = self._signals_port.signal_group(identity.pgid, sig)
        except Exception:
            return kind, seen, "uncertain"
        if result not in ("delivered", "absent", "uncertain"):
            return kind, seen, "uncertain"
        return kind, seen, result

    def _signal_allowed(self, identity: OwnedIdentity) -> bool:
        if self._structural_refusal(identity) is not None:
            return False
        if identity.pgid <= 1 or identity.pid <= 1:
            return False
        if identity.pid == self._self.pid or identity.pgid == self._self.pgid:
            return False
        return True

    def _observe(self, identity: OwnedIdentity):
        try:
            seen = self._observer.observe(identity)
        except Exception:
            return "unverifiable", None
        return _classify(identity, seen), seen

    def _structural_refusal(self, identity: object) -> str | None:
        if not isinstance(identity, OwnedIdentity):
            return "malformed"
        for value in (identity.pid, identity.pgid):
            if type(value) is not int or value <= 1:
                return "not_a_process"
        if identity.pid == self._self.pid or identity.pgid == self._self.pgid:
            return "self"
        expected = _ROLES.get(identity.role)
        if expected is None or identity.phase != expected:
            return "phase"
        if type(identity.birth) is not str or not identity.birth or len(identity.birth) > 200 or any(
            char in identity.birth for char in "\n\r\x00"
        ):
            return "birth"
        ancestry = identity.ancestry
        if type(ancestry) is not tuple or not ancestry:
            return "ancestry"
        if any(type(item) is not int or item <= 1 or item == identity.pid for item in ancestry):
            return "ancestry"
        if ancestry[0] != self._self.pid:
            return "not_direct_child"
        return None

    def _active_identity(self) -> OwnedIdentity | None:
        if len(self._owned) != 1:
            return None
        identity = next(iter(self._owned.values()))
        if identity.phase != self._phase:
            return None
        return identity

    def _stop_requested(self) -> bool:
        if self._stopped:
            return True
        try:
            flagged = self._predicate()
        except Exception:
            self._stopped = True
            if self._owned or self._ack in ("pending", "failed") or self._ever_registered:
                self._recovery_retained = True
            return True
        if type(flagged) is not bool:
            self._stopped = True
            return True
        if flagged:
            self._stopped = True
        return flagged

    def _hold_untracked(self) -> None:
        """A launch ticket was open, so a process may exist without a verified id."""
        self._recovery_retained = True
        self._group_confirmed = False

    def _time_left(self) -> bool:
        now = self._now()
        return now is not None and now < self._stop_deadline

    def _pause(self) -> bool:
        if not self._time_left():
            return False
        try:
            self._wait(self._grace)
        except Exception:
            return False
        return self._time_left()

    def _now(self) -> float | None:
        try:
            value = self._clock.monotonic()
        except Exception:
            return None
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            return None
        return float(value)

    def _persist(self) -> bool:
        try:
            self._journal.persist(self._record())
        except Exception:
            return False
        self._journal_open = True
        return True

    def _clear_journal(self) -> bool:
        try:
            self._journal.clear()
        except Exception:
            return False
        self._journal_open = False
        return True

    def _record(self) -> dict:
        cleanup, unlock = self._permissions()
        return {
            "version": 1,
            "unit": "ak-stop-control-phase1",
            "phase": self._phase,
            "stopped": self._stopped,
            "outcome": self._outcome,
            "recovery_retained": self._recovery_retained,
            "group_confirmed": self._group_confirmed,
            "registered_identity_contained": self._registered_contained,
            "ack": self._ack,
            "signal_authorized": False,
            "claim": None
            if self._claim_id is None
            else {
                "task_id": self._claim_id,
                "exact_task_match_proven": False,
                "left_truthful": self._claim_left_truthful,
            },
            "owned": [
                {
                    "pid": identity.pid,
                    "pgid": identity.pgid,
                    "role": identity.role,
                    "phase": identity.phase,
                    "birth": identity.birth,
                    "ancestry": list(identity.ancestry),
                }
                for identity in self._owned.values()
            ],
            "task_marked_done": False,
            "exact_task_match_proven": False,
            "requeue": False,
            "lock_release_permitted": unlock,
            "pointer_cleanup_permitted": cleanup,
            "cleanup_state": self._cleanup_state,
            "cleanup_confirmation": _confirmation_record(self._cleanup_proof),
            "prerequisite": EXACT_TASK_MATCH_PREREQUISITE,
        }

    def _cleanup_base(self) -> bool:
        return (
            self._group_confirmed
            and not self._owned
            and not self._recovery_retained
            and self._ack not in ("pending", "failed")
        )

    def _phase_is_finished(self) -> bool:
        return self._phase_completed and not self._stopped and self._worker_closed

    def _reject_cleanup(self, start: int) -> Decision:
        self._recovery_retained = True
        self._cleanup_state = "uncertain"
        self._outcome = "cleanup_unconfirmed"
        self._persist()
        return self._decision(start, allowed=False, code="cleanup_unconfirmed")

    def _permissions(self) -> tuple[bool, bool]:
        # Both actions stay permitted only while finish has a durable pending
        # record and the recovery journal has not been cleared. Clearing the
        # journal is not what grants the permission.
        if self._cleanup_state == "pending" and self._cleanup_base():
            return True, True
        return False, False

    def _decision(
        self,
        start: int,
        *,
        allowed: bool,
        code: str,
        claim_left_truthful: bool = False,
        phase_finished: bool = False,
    ) -> Decision:
        if claim_left_truthful:
            self._claim_left_truthful = True
        cleanup, unlock = self._permissions()
        signals = tuple(self._signals[start:])
        for pgid, _sig in signals:
            if type(pgid) is not int or pgid <= 1 or pgid == self._self.pgid:
                raise RuntimeError("forbidden signal target recorded")
        return Decision(
            allowed=allowed,
            code=code,
            recovery_retained=self._recovery_retained,
            lock_release_permitted=unlock,
            pointer_cleanup_permitted=cleanup,
            task_marked_done=False,
            exact_task_match_proven=False,
            claim_left_truthful=self._claim_left_truthful,
            requeue=False,
            phase_finished=phase_finished,
            registered_identity_contained=self._registered_contained and not self._owned,
            group_confirmed=self._group_confirmed and not self._recovery_retained and not self._owned,
            owned_pgids=tuple(identity.pgid for identity in self._owned.values()),
            signals=signals,
        )

    def _mark(self) -> int:
        return len(self._signals)

    @contextmanager
    def _hold(self):
        self._lock.acquire()
        try:
            yield
        finally:
            self._lock.release()


def _explicit_cleanup_confirmation(confirmation: object) -> bool:
    if type(confirmation) is not CleanupConfirmation:
        return False
    if type(confirmation.durable) is not bool or confirmation.durable is not True:
        return False
    return confirmation.pointer_cleanup == "complete" and confirmation.lock_release == "complete"


def _confirmation_record(confirmation: CleanupConfirmation | None) -> dict | None:
    if type(confirmation) is not CleanupConfirmation:
        return None
    return {
        "pointer_cleanup": confirmation.pointer_cleanup,
        "lock_release": confirmation.lock_release,
        "durable": confirmation.durable is True,
    }


def _attested_group_empty(identity: OwnedIdentity, seen: object) -> bool:
    """Honor an empty group only when the observer echoes the registered identity."""
    if not isinstance(seen, Observation):
        return False
    if seen.status != "absent" or seen.group_status != "empty":
        return False
    return (
        seen.pid == identity.pid
        and seen.pgid == identity.pgid
        and seen.role == identity.role
        and seen.phase == identity.phase
        and seen.birth == identity.birth
        and seen.ancestry == identity.ancestry
    )


def _classify(identity: OwnedIdentity, seen: object) -> str:
    if not isinstance(seen, Observation):
        return "unverifiable"
    if seen.status == "absent":
        return "absent"
    if seen.status != "present":
        return "unverifiable"
    if (
        type(seen.pid) is not int
        or type(seen.pgid) is not int
        or type(seen.birth) is not str
        or type(seen.ancestry) is not tuple
        or not seen.birth
    ):
        return "unverifiable"
    if seen.birth != identity.birth:
        return "reused"
    if (
        seen.pid != identity.pid
        or seen.pgid != identity.pgid
        or seen.role != identity.role
        or seen.phase != identity.phase
        or seen.ancestry != identity.ancestry
    ):
        return "foreign"
    return "match"


def _require_span(value: float, name: str) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise ValueError(f"{name} must be a finite number >= 0")
