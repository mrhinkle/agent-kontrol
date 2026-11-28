#!/usr/bin/env python3
"""Stop, launch, and finish control for one dispatcher round (#211).

This module is a pure state machine. It does not start a process, import the
running dispatcher, read the environment, open a claim route, or call a signal
syscall. The caller injects the stop predicate, the identity observer, the
signal port, the journal, the clock, and the wait. Tests replace the signal
port with a recording fake. Nothing here is wired into a dispatcher, and no
concrete signal port exists in this repository.

A stored pid or pgid is not ownership. The signal port is called only for an
identity that is still registered and that the observer has just shown, under
the injected lock, to be ``present`` with the same role, phase, birth,
ancestry, pid, and pgid. Pid 1 and below, the controller's own pid, and the
controller's own group are never passed to the port. No query on this class
reports a stored id as currently owned.

Observer contract: ``Observation.status`` is exactly ``present``, ``absent``,
or ``unverifiable``. Anything else, a non-``Observation`` value, or an
observer exception is unverifiable. Signal port contract: ``signal_group``
returns exactly ``delivered``, ``absent``, or ``uncertain``. Anything else, or
a port exception, is uncertain.

An absent registered identity is retired and never signalled. Recovery is
released only when the observation echoes every registered field and reports
``group_status == "empty"``, or when a matched signal attempt reports the group
absent and the final observation that follows also shows the registered
identity absent. After every attempted signal a final observation runs before
the group is confirmed. A reused, foreign, or unverifiable identity, a
timeout, an uncertain port result, or a missing or non-confirming final
observation retains recovery and forbids cleanup. The check-to-signal window
can still race; this unit does not see unregistered descendants, detached
children, or a process selected by name, session, or uid.

Claims. ``POST /api/tasks/claim`` accepts an optional ``task_id`` (#173): a
positive safe integer that claims that queued row only. A miss returns
``{ task: null }`` and claims no other row, and a malformed id is rejected
before any query. This module never calls that route. The caller reports the
result through ``note_claimed(task_id, exact_claim=...)``. ``exact_claim`` is
required. Only ``exact_claim=True``, meaning the claim was sent with that
``task_id``, sets ``exact_task_match_proven``. An unfiltered claim passes
``False``. A lost reply goes to ``note_claim_unknown``, which keeps recovery.
A miss has no transition here; the caller reports it as unknown, which fails
closed.

Journal port contract: ``persist(record)`` either stores the record durably
and returns, or raises. ``clear()`` either removes the record and returns, or
raises and leaves the last stored record intact. A ``clear`` that removes the
record and then raises breaks this contract, and the controller cannot detect
it. ``exact_task_match_proven`` is reported to the caller only after a write
that recorded the exact claim succeeded.

``finish`` does not clear the injected journal. It only records that pointer
cleanup and lock release are permitted. The caller performs both actions.
``confirm_cleanup_durable`` then requires an explicit confirmation that both
completed (``"complete"``) and that the confirmation itself is durable
(``durable is True``). That confirmation is persisted before ``clear``. A
missing, partial, or non-durable confirmation, a failed persist, or a failed
clear keeps the journal and retains recovery. A cleanup confirmation is the
caller's attestation, not proof that cleanup happened or that a process was
owned.

Claim permission, the claimed-task record, and launch permission are written
to the journal before the caller is told it may claim, launch, or start
review. If that write fails, the permission is not returned and recovery
stays retained. Every transition holds the injected lock across the state
change and the journal write.

Stop while a claim window is open returns ``claim_unresolved``: the caller was
already released, so the external reply is unknown. The phase is
``claiming``, recovery and the journal stay, and launch and cleanup are
refused until ``note_claimed`` records the late id or ``note_claim_unknown``
records a lost reply. A late success leaves the task claimed and still
refuses launch.

``confirm_ack`` rechecks stop under the same lock before it authorizes
execution. If stop wins, it returns ``ack_after_stop``, the ack stays pending,
the registered identity and recovery stay, and nothing is signalled.
"""
from __future__ import annotations

import math
import threading
from contextlib import contextmanager
from dataclasses import dataclass

# Request numbers passed to the injected port. This module never imports signal.
SIGTERM = 15
SIGKILL = 9

# Largest JavaScript safe integer, the route's upper bound for task_id (#173).
MAX_TASK_ID = 9007199254740991

CLAIM_ROUTE = (
    "POST /api/tasks/claim accepts an optional task_id, a positive safe integer "
    "from 1 to 9007199254740991, and then claims that queued row only. A miss "
    "returns task null and claims no other row. A malformed task_id is rejected "
    "before any query. Without task_id the route claims the next queued row, so "
    "only a claim sent with task_id proves an exact task match."
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
    registered_pgids: tuple[int, ...]
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
        self._claim_hold_only = False
        self._claim_id: int | None = None
        self._exact_claim = False
        self._exact_claim_durable = False
        self._journal_failed = False
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
            if self._phase != "idle" or self._claim_id is not None or self._claim_window:
                return self._decision(start, allowed=False, code="invalid_transition")
            if self._recovery_retained:
                return self._decision(start, allowed=False, code="recovery_retained")
            if self._stop_requested():
                return self._stop_before_claim(start)
            self._claim_window = True
            self._outcome = "claim_permitted"
            if not self._persist():
                self._claim_window = False
                return self._journal_failure(start)
            if self._stop_requested():
                # The caller has not been released, so no external claim is in flight.
                self._claim_window = False
                return self._stop_before_claim(start)
            return self._decision(start, allowed=True, code="claim_permitted")

    def note_claimed(self, task_id: int, *, exact_claim: bool) -> Decision:
        """Record a claim the caller already observed. This does not contact the API.

        ``exact_claim`` has no default. Pass ``True`` only when the claim was
        sent with this ``task_id`` (#173), so the route could return no other
        row. Pass ``False`` for an unfiltered claim. Only ``True`` sets
        ``exact_task_match_proven``.

        A stored id reconciles an in-flight window, including one that stop
        already marked unresolved. Recovery held only for that window is
        released after the id is stored. Any other recovery stays.
        """
        with self._hold():
            start = self._mark()
            if not _valid_task_id(task_id):
                return self._decision(start, allowed=False, code="invalid_task")
            if type(exact_claim) is not bool:
                return self._decision(start, allowed=False, code="invalid_claim_kind")
            if not self._claim_window or self._claim_id is not None:
                return self._decision(start, allowed=False, code="invalid_transition")
            self._claim_id = task_id
            self._exact_claim = exact_claim
            self._release_exact_claim_hold()
            if self._stop_requested():
                # A stored id is a known claim, including one reconciled after stop.
                self._phase = "claimed"
                return self._stopped_after_claim(start)
            self._phase = "claimed"
            self._outcome = "claimed"
            if not self._persist():
                return self._journal_failure(start, claim_left_truthful=True)
            if self._stop_requested():
                return self._stopped_after_claim(start)
            return self._decision(start, allowed=True, code="claimed")

    def note_claim_unknown(self) -> Decision:
        """Record that the in-flight claim reply was lost.

        The external claim may have committed. This does not invent a task id,
        does not prove the claim is absent, and does not permit cleanup.
        """
        with self._hold():
            start = self._mark()
            if self._claim_id is not None or not self._claim_window:
                return self._decision(start, allowed=False, code="invalid_transition")
            self._claim_window = False
            self._hold_unresolved_claim()
            self._claim_hold_only = False
            self._outcome = "claim_unknown"
            if not self._persist():
                self._claim_window = True
                return self._journal_failure(start)
            return self._decision(start, allowed=False, code="claim_unknown")

    def begin_launch(self, role: str) -> Decision:
        with self._hold():
            start = self._mark()
            if role not in _ROLES:
                return self._decision(start, allowed=False, code="role")
            if self._stop_requested():
                return self._invalidate_launch(start)
            if self._recovery_retained:
                return self._decision(start, allowed=False, code="recovery_retained")
            if role == "worker":
                if self._phase != "claimed" or self._worker_closed:
                    return self._decision(start, allowed=False, code="invalid_transition")
            elif self._phase != "claimed" or not self._worker_closed or not self._group_confirmed:
                return self._decision(start, allowed=False, code="review_requires_worker_exit")
            if self._ticket is not None or self._owned:
                return self._decision(start, allowed=False, code="launch_in_progress")
            if self._cleanup_state != "none":
                # finish() already reserved cleanup. Launch and cleanup never overlap.
                return self._decision(start, allowed=False, code="cleanup_reserved")
            self._ticket = role
            self._outcome = "launch_open"
            if not self._persist():
                self._ticket = None
                return self._journal_failure(start)
            if self._stop_requested():
                return self._invalidate_launch(start)
            return self._decision(start, allowed=True, code="launch_open")

    def register(self, identity: OwnedIdentity) -> Decision:
        """Persist a directly created child before the caller may exec its payload."""
        with self._hold():
            start = self._mark()
            had_ticket = self._ticket is not None
            if self._stop_requested():
                if had_ticket:
                    self._hold_untracked()
                self._ticket = None
                self._outcome = "launch_after_stop"
                if not self._persist():
                    return self._journal_failure(start)
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
                return self._journal_failure(start)
            if self._stop_requested():
                self._outcome = "launch_after_stop"
                if not self._persist():
                    return self._journal_failure(start)
                return self._decision(start, allowed=False, code="launch_after_stop")
            return self._decision(start, allowed=True, code="registered")

    def confirm_ack(self) -> Decision:
        """Authorize execution only if stop has not won under this lock."""
        with self._hold():
            start = self._mark()
            if self._ack != "pending" or not self._owned:
                return self._decision(start, allowed=False, code="invalid_transition")
            if self._stop_requested():
                return self._cancel_ack_for_stop(start)
            if self._recovery_retained:
                # A journal failure or an unconfirmed exit already holds recovery.
                return self._decision(start, allowed=False, code="recovery_retained")
            self._ack = "confirmed"
            self._outcome = "ack_confirmed"
            if not self._persist():
                self._ack = "failed"
                return self._journal_failure(start)
            if self._stop_requested():
                self._ack = "pending"
                return self._cancel_ack_for_stop(start)
            return self._decision(start, allowed=True, code="ack_confirmed")

    def ack_failed(self) -> Decision:
        with self._hold():
            start = self._mark()
            if self._ack != "pending" or not self._owned:
                return self._decision(start, allowed=False, code="invalid_transition")
            self._ack = "failed"
            self._recovery_retained = True
            self._outcome = "ack_failed"
            if not self._persist():
                return self._journal_failure(start)
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
                return self._journal_failure(start)
            retired_clean = identity.role not in self._owned and not self._recovery_retained
            return self._decision(start, allowed=retired_clean, code=self._outcome)

    def request_stop(self) -> Decision:
        with self._hold():
            start = self._mark()
            if self._cleanup_state == "cleared":
                # The round is over and its journal is gone. Do not recreate it.
                return self._decision(start, allowed=False, code=self._outcome)
            if self._containment_already_proven():
                return self._reuse_containment_proof(start)
            if self._claim_window and self._claim_id is None:
                # The caller was already released. The external claim may have committed.
                self._stopped = True
                if self._ticket is not None and not self._owned:
                    self._hold_untracked()
                self._ticket = None
                self._hold_unresolved_claim()
                self._outcome = "claim_unresolved"
                if not self._persist():
                    return self._journal_failure(start)
                return self._decision(start, allowed=False, code="claim_unresolved")
            if self._outcome == "claim_unknown" and self._claim_id is None:
                self._stopped = True
                self._recovery_retained = True
                self._group_confirmed = False
                self._claim_hold_only = False
                if self._phase == "idle":
                    self._phase = "claiming"
                self._outcome = "claim_unknown"
                if not self._persist():
                    return self._journal_failure(start)
                return self._decision(start, allowed=False, code="claim_unknown")
            had_ticket = self._ticket is not None
            self._stopped = True
            if had_ticket and not self._owned:
                self._hold_untracked()
            self._ticket = None
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
                if not self._persist():
                    return self._journal_failure(start)
                return self._decision(start, allowed=False, code="ambiguous_owner")
            now = self._now()
            self._stop_deadline = now + self._stop_budget if now is not None else 0.0
            if now is None:
                self._recovery_retained = True
                self._outcome = "clock_failed"
                if not self._persist():
                    return self._journal_failure(start)
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

    def _containment_already_proven(self) -> bool:
        """True when a stop has nothing left to contain and the group is confirmed."""
        return (
            self._group_confirmed
            and not self._recovery_retained
            and not self._owned
            and self._ticket is None
            and not self._claim_window
            and self._ack not in ("pending", "failed")
        )

    def _reuse_containment_proof(self, start: int) -> Decision:
        """A stop after confirmed containment keeps that proof.

        No ticket and no identity can appear after a stop, so a repeated stop
        writes nothing. A first stop after a confirmed exit records the stop.
        """
        if self._claim_id is not None:
            self._claim_left_truthful = True
        if self._stopped:
            return self._decision(start, allowed=False, code=self._outcome,
                                  claim_left_truthful=self._claim_left_truthful)
        self._stopped = True
        self._outcome = "stopped_after_exit"
        if not self._persist():
            return self._journal_failure(start, claim_left_truthful=self._claim_left_truthful)
        return self._decision(start, allowed=False, code="stopped_after_exit",
                              claim_left_truthful=self._claim_left_truthful)

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
            if self._ticket is not None:
                return self._decision(start, allowed=False, code="launch_in_progress")
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
        the journal in place and retains recovery. "In place" relies on the
        journal port contract: a ``clear`` that raises must not have removed
        the record.
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
            if self._ticket is not None:
                return self._decision(start, allowed=False, code="launch_in_progress")
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
        """Say whether an id is registered. Never ownership, never authorization.

        A stored pid and pgid can be stale or recycled, so this query never
        reports them as owned, never calls the observer or the port, and
        always returns ``allowed=False``. Only ``request_stop`` signals, and
        only after a fresh matching observation.
        """
        with self._hold():
            start = self._mark()
            if type(pid) is not int or type(pgid) is not int:
                return self._decision(start, allowed=False, code="unknown")
            registered = any(item.pid == pid and item.pgid == pgid for item in self._owned.values())
            return self._decision(start, allowed=False, code="registered_unverified" if registered else "unknown")

    def _contain(self, identity: OwnedIdentity) -> None:
        """SIGTERM, grace, SIGKILL only while the identity still matches, then a final look.

        Every attempted signal is followed by a fresh observation before the
        group can be confirmed. Any timeout, uncertain port result, or final
        observation that does not confirm absence retains recovery.
        """
        if not self._time_left():
            self._hold_after_stop("timeout")
            return
        kind, seen, result = self._attempt(identity, SIGTERM)
        if kind == "late":
            self._hold_after_stop("timeout")
            return
        if result is None and kind == "match":
            self._hold_after_stop("signal_refused")
            return
        if result is None:
            self._close_without_signal(identity, kind, seen)
            return
        if result == "uncertain":
            self._hold_after_stop("signal_uncertain")
            return
        if result == "absent":
            self._final_observation(identity, port_absent=True)
            return
        if not self._pause():
            self._hold_after_stop("timeout")
            return
        kind, seen, result = self._attempt(identity, SIGKILL)
        if kind == "late":
            self._hold_after_stop("timeout")
            return
        if result is None:
            # This observation followed SIGTERM and is its final observation.
            self._finish_after_signal(identity, kind, seen, port_absent=False)
            return
        if result == "uncertain":
            self._hold_after_stop("signal_uncertain")
            return
        if result == "absent":
            self._final_observation(identity, port_absent=True)
            return
        if not self._pause():
            self._hold_after_stop("timeout")
            return
        self._final_observation(identity, port_absent=False)

    def _release_after_containment(self, identity: OwnedIdentity, confirmed: bool, unconfirmed: str) -> str:
        """Retire the identity. Release recovery only for a confirmed group.

        A journal write that ever failed keeps recovery: the stored record may
        not describe what happened. Returns the outcome code.
        """
        released = confirmed and not self._journal_failed
        self._retire(identity, group_confirmed=released)
        self._recovery_retained = not released
        if released:
            return "stopped_group_absent"
        return "retired_after_journal_failure" if confirmed else unconfirmed

    def _hold_after_stop(self, outcome: str) -> None:
        self._recovery_retained = True
        self._group_confirmed = False
        self._outcome = outcome

    def _final_observation(self, identity: OwnedIdentity, *, port_absent: bool) -> None:
        kind, seen = self._observe(identity)
        if not self._time_left():
            # A late answer cannot confirm containment.
            self._hold_after_stop("timeout")
            return
        self._finish_after_signal(identity, kind, seen, port_absent=port_absent)

    def _finish_after_signal(self, identity: OwnedIdentity, kind: str, seen: object, *, port_absent: bool) -> None:
        """Decide from the observation that followed a signal. Never signals."""
        if kind == "match":
            self._hold_after_stop("containment_unconfirmed")
            return
        if kind == "absent":
            confirmed = _attested_group_empty(identity, seen) or (
                port_absent and _attested_absent_after_port(identity, seen)
            )
            self._outcome = self._release_after_containment(identity, confirmed, "retired_unconfirmed_absent")
            return
        if kind == "reused":
            self._retire(identity, group_confirmed=False)
            self._hold_after_stop("retired_unconfirmed_reused")
            return
        self._hold_after_stop("identity_changed_after_signal" if kind == "foreign" else "unconfirmed_" + kind)

    def _close_without_signal(self, identity: OwnedIdentity, kind: str | None = None, seen: object | None = None) -> None:
        """No signal was sent. Retire an absent or reused identity, never signal it."""
        if kind is None:
            kind, seen = self._observe(identity)
        if kind == "match":
            self._outcome = "still_running"
            return
        if kind == "absent":
            confirmed = _attested_group_empty(identity, seen)
            self._outcome = self._release_after_containment(identity, confirmed, "retired_absent")
            return
        if kind == "reused":
            self._retire(identity, group_confirmed=False)
            self._hold_after_stop("retired_reused")
            return
        self._hold_after_stop("unconfirmed_" + kind)

    def _retire(self, identity: OwnedIdentity, *, group_confirmed: bool) -> None:
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

    def _attempt(self, identity: OwnedIdentity, sig: int):
        """Observe immediately and signal only a still-matching owned group.

        The port is not called for any other result. The lock is held, and the
        observer can still change before the port runs; a later observation
        that is no longer a match does not authorize another signal.
        """
        kind, seen = self._observe(identity)
        if not self._time_left():
            # The observer returned after the stop budget. Its answer is stale.
            return "late", seen, None
        if kind != "match" or not self._signal_allowed(identity):
            return kind, seen, None
        if identity.role not in self._owned or self._owned.get(identity.role) != identity:
            return kind, seen, None
        self._signals.append((identity.pgid, sig))
        try:
            result = self._signals_port.signal_group(identity.pgid, sig)
        except Exception:
            return kind, seen, "uncertain"
        if type(result) is not str or result not in ("delivered", "absent", "uncertain"):
            return kind, seen, "uncertain"
        return kind, seen, result

    def _signal_allowed(self, identity: OwnedIdentity) -> bool:
        # The same checks register() applies: pid and pgid above 1, not the
        # controller's own pid or group, a direct child in its role's phase.
        return self._structural_refusal(identity) is None

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

    def _hold_unresolved_claim(self) -> None:
        """The external claim reply is not known. Do not look idle or clean."""
        if not self._recovery_retained:
            self._claim_hold_only = True
        self._recovery_retained = True
        self._group_confirmed = False
        self._registered_contained = False
        if self._phase == "idle":
            self._phase = "claiming"

    def _release_exact_claim_hold(self) -> None:
        """An exact task id is now stored. Drop only the in-flight claim interlock."""
        self._claim_window = False
        if (
            self._claim_hold_only
            and not self._journal_failed
            and not self._owned
            and self._ticket is None
            and not self._ever_registered
            and self._ack not in ("pending", "failed")
        ):
            self._recovery_retained = False
        self._claim_hold_only = False

    def _cancel_ack_for_stop(self, start: int) -> Decision:
        """Stop won before exec was authorized. Keep the registered child."""
        self._recovery_retained = True
        self._group_confirmed = False
        self._outcome = "ack_after_stop"
        if not self._persist():
            return self._journal_failure(start)
        return self._decision(start, allowed=False, code="ack_after_stop")

    def _time_left(self) -> bool:
        now = self._now()
        return now is not None and now < self._stop_deadline

    def _pause(self) -> bool:
        now = self._now()
        if now is None or now >= self._stop_deadline:
            return False
        try:
            self._wait(min(self._grace, self._stop_deadline - now))
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
            self._journal_failed = True
            return False
        if self._claim_id is not None and self._exact_claim is True:
            self._exact_claim_durable = True
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
            "unit": "ak-stop-control",
            "phase": self._phase,
            "stopped": self._stopped,
            "outcome": self._outcome,
            "recovery_retained": self._recovery_retained,
            "group_confirmed": self._group_confirmed,
            "registered_identity_contained": self._registered_contained,
            "ack": self._ack,
            "claim_window": self._claim_window,
            "launch_ticket": self._ticket,
            "signal_authorized": False,
            "claim": None
            if self._claim_id is None
            else {
                "task_id": self._claim_id,
                "exact_task_match_proven": self._exact_claim,
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
            # This record itself carries the exact claim, so it may state it.
            "exact_task_match_proven": self._claim_id is not None and self._exact_claim is True,
            "requeue": False,
            "lock_release_permitted": unlock,
            "pointer_cleanup_permitted": cleanup,
            "cleanup_state": self._cleanup_state,
            "cleanup_confirmation": _confirmation_record(self._cleanup_proof),
            "claim_route": CLAIM_ROUTE,
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
        if not self._persist():
            return self._journal_failure(start)
        return self._decision(start, allowed=False, code="cleanup_unconfirmed")

    def _stop_before_claim(self, start: int) -> Decision:
        self._outcome = "stop_before_claim"
        self._registered_contained = True
        self._group_confirmed = True
        if not self._persist():
            return self._journal_failure(start)
        return self._decision(start, allowed=False, code="stop_before_claim")

    def _stopped_after_claim(self, start: int) -> Decision:
        self._claim_left_truthful = True
        self._outcome = "stopped_after_claim"
        self._registered_contained = True
        # Do not persist a confirmed group while recovery is still held.
        # The in-flight hold is released only after the exact id is stored.
        self._group_confirmed = (
            not self._recovery_retained
            and not self._owned
            and self._ticket is None
            and not self._ever_registered
        )
        if not self._persist():
            return self._journal_failure(start, claim_left_truthful=True)
        return self._decision(start, allowed=False, code="stopped_after_claim", claim_left_truthful=True)

    def _invalidate_launch(self, start: int) -> Decision:
        """Close a launch ticket after stop without forgetting an untracked child.

        The ticket is the only record that a child may exist before register.
        Clearing it without recovery lets a later finish report a clean stop.
        """
        if self._ticket is not None:
            self._hold_untracked()
        self._ticket = None
        self._outcome = "launch_after_stop"
        if not self._persist():
            return self._journal_failure(start)
        return self._decision(start, allowed=False, code="launch_after_stop")

    def _journal_failure(self, start: int, *, claim_left_truthful: bool = False) -> Decision:
        """A journal write failed. Do not permit claim, launch, review, or cleanup."""
        if claim_left_truthful:
            # Set before the fallback write so the record and the decision agree.
            self._claim_left_truthful = True
        self._recovery_retained = True
        self._claim_hold_only = False
        self._group_confirmed = False
        self._outcome = "journal_failed"
        self._persist()
        return self._decision(
            start,
            allowed=False,
            code="journal_failed",
            claim_left_truthful=claim_left_truthful,
        )

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
            exact_task_match_proven=self._exact_match_proven(),
            claim_left_truthful=self._claim_left_truthful,
            requeue=False,
            phase_finished=phase_finished,
            registered_identity_contained=self._registered_contained and not self._owned,
            group_confirmed=self._group_confirmed and not self._recovery_retained and not self._owned,
            registered_pgids=tuple(identity.pgid for identity in self._owned.values()),
            signals=signals,
        )

    def _exact_match_proven(self) -> bool:
        # Reported only after a successful journal write recorded the exact claim.
        return self._exact_claim_durable

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


def _valid_task_id(task_id: object) -> bool:
    return type(task_id) is int and 1 <= task_id <= MAX_TASK_ID


def _echoes(identity: OwnedIdentity, seen: Observation) -> bool:
    return (
        seen.pid == identity.pid
        and seen.pgid == identity.pgid
        and seen.role == identity.role
        and seen.phase == identity.phase
        and seen.birth == identity.birth
        and seen.ancestry == identity.ancestry
    )


def _attested_absent_after_port(identity: OwnedIdentity, seen: object) -> bool:
    """After the port reported the group absent, the final look must agree.

    The observation must say the registered identity is absent, echo every
    registered field, and not report the group occupied.
    """
    if not isinstance(seen, Observation):
        return False
    if seen.status != "absent" or seen.group_status not in ("empty", "unknown"):
        return False
    return _echoes(identity, seen)


def _attested_group_empty(identity: OwnedIdentity, seen: object) -> bool:
    """Honor an empty group only when the observer echoes the registered identity."""
    if not isinstance(seen, Observation):
        return False
    if seen.status != "absent" or seen.group_status != "empty":
        return False
    return _echoes(identity, seen)


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
