"""
AGENTS.md skill-pointer block for dispatched worktrees. Stdlib only.

apply_pointer_block mirrors applyPointerBlock in src/lib/skills/agents-md.ts:
insert, replace, or remove the block between the ak-skills markers, keep
everything outside them unchanged, keep CRLF files CRLF, collapse duplicate
blocks, and refuse an unpaired or nested marker instead of guessing.

inject / cleanup are the file side. The block is temporary dispatch metadata:
inject writes it before the worker runs and cleanup takes it out afterwards,
putting back what the managed region held before, while leaving the worker's
edits elsewhere in the file alone. Both refuse rather than overwrite a file
that changed under them.
"""
from __future__ import annotations

import os
import stat
import tempfile
from pathlib import Path

POINTERS_BEGIN = "<!-- ak-skills:begin -->"
POINTERS_END = "<!-- ak-skills:end -->"
AGENTS_MD = "AGENTS.md"
MAX_AGENTS_MD_BYTES = 1_000_000


class MalformedBlockError(ValueError):
    def __init__(self, detail: str) -> None:
        super().__init__(f"malformed ak-skills block: {detail}")


class PointerFileError(RuntimeError):
    """The file cannot be read or written safely. The file was not changed."""


# --- pure marker logic (parity with agents-md.ts) ---------------------------

def apply_pointer_block(content: str | None, block: str) -> tuple[str | None, bool]:
    """Return (new_content, changed). new_content None means no file should exist."""
    if content is None:
        if block == "":
            return None, False
        return f"{_normalise(block, chr(10))}\n", True
    eol = _detect_eol(content)
    spans = find_spans(content)
    if block == "":
        return _finish(content, _remove_spans(content, spans, eol))
    rendered = _normalise(block, eol)
    if not spans:
        return _finish(content, _append_block(content, rendered, eol))
    rest = spans[1:]
    without_extras = _remove_spans(content, rest, eol) if rest else content
    start, end = spans[0]
    return _finish(content, without_extras[:start] + rendered + without_extras[end:])


def _finish(before: str, after: str) -> tuple[str, bool]:
    return after, after != before


def _detect_eol(text: str) -> str:
    first = text.find("\n")
    return "\r\n" if first > 0 and text[first - 1] == "\r" else "\n"


def _normalise(block: str, eol: str) -> str:
    return block.replace("\r\n", "\n").replace("\n", eol)


def _marker_lines(text: str) -> list[tuple[str, int, int]]:
    """A marker counts only when it is alone on its line. Quoted markers are prose."""
    found: list[tuple[str, int, int]] = []
    offset = 0
    for line in text.split("\n"):
        bare = line[:-1] if line.endswith("\r") else line
        if bare == POINTERS_BEGIN:
            found.append(("begin", offset, offset + len(bare)))
        elif bare == POINTERS_END:
            found.append(("end", offset, offset + len(bare)))
        offset += len(line) + 1
    return found


def find_spans(text: str) -> list[tuple[int, int]]:
    """(start, end) of each block; end excludes the end marker's line break."""
    spans: list[tuple[int, int]] = []
    open_at: int | None = None
    for kind, start, end in _marker_lines(text):
        if kind == "begin":
            if open_at is not None:
                raise MalformedBlockError("nested begin marker")
            open_at = start
        else:
            if open_at is None:
                raise MalformedBlockError("end marker without begin")
            spans.append((open_at, end))
            open_at = None
    if open_at is not None:
        raise MalformedBlockError("begin marker without end")
    return spans


def _append_block(text: str, rendered: str, eol: str) -> str:
    if text == "":
        return f"{rendered}{eol}"
    tail = "" if text.endswith(eol) else eol
    return f"{text}{tail}{eol}{rendered}{eol}"


def _remove_spans(text: str, spans: list[tuple[int, int]], eol: str) -> str:
    out = text
    for start, end in reversed(spans):
        if out.startswith(eol, end):
            end += len(eol)
        before = out[:start]
        after = out[end:]
        if before == "":
            if after.startswith(eol):
                after = after[len(eol):]
        elif before.endswith(eol + eol) and (after == "" or after.startswith(eol)):
            before = before[: -len(eol)]
        out = before + after
    return out


def is_rendered_block(block: str) -> bool:
    """True when block is exactly one begin..end span, as renderPointers produces."""
    if not block.startswith(POINTERS_BEGIN) or not block.endswith(POINTERS_END):
        return False
    try:
        spans = find_spans(block)
    except MalformedBlockError:
        return False
    return spans == [(0, len(block))]


# --- file side ---------------------------------------------------------------

class Snapshot:
    """What was on disk: content None means no file. ident pins the inode."""

    def __init__(self, raw: bytes | None, ident: tuple | None, mode: int | None) -> None:
        self.raw = raw
        self.ident = ident
        self.mode = mode

    @property
    def text(self) -> str | None:
        return None if self.raw is None else self.raw.decode("utf-8")


def read_snapshot(path: Path) -> Snapshot:
    """Read a regular AGENTS.md as strict UTF-8. A symlink, directory, or special file is refused."""
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return Snapshot(None, None, None)
    if not stat.S_ISREG(st.st_mode):
        raise PointerFileError(f"{path.name} is not a regular file (symlink, directory, or special file)")
    if st.st_size > MAX_AGENTS_MD_BYTES:
        raise PointerFileError(f"{path.name} is larger than {MAX_AGENTS_MD_BYTES} bytes")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        fd = os.open(path, flags)
    except OSError as e:
        raise PointerFileError(f"cannot open {path.name}: {e.strerror}") from e
    try:
        fst = os.fstat(fd)
        if not stat.S_ISREG(fst.st_mode) or (fst.st_dev, fst.st_ino) != (st.st_dev, st.st_ino):
            raise PointerFileError(f"{path.name} changed while it was opened")
        chunks = []
        remaining = MAX_AGENTS_MD_BYTES + 1
        while remaining > 0:
            chunk = os.read(fd, min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        raw = b"".join(chunks)
    finally:
        os.close(fd)
    if len(raw) > MAX_AGENTS_MD_BYTES:
        raise PointerFileError(f"{path.name} is larger than {MAX_AGENTS_MD_BYTES} bytes")
    try:
        raw.decode("utf-8")
    except UnicodeDecodeError as e:
        raise PointerFileError(f"{path.name} is not valid UTF-8") from e
    ident = (fst.st_dev, fst.st_ino, fst.st_size, fst.st_mtime_ns)
    return Snapshot(raw, ident, stat.S_IMODE(fst.st_mode))


def _unchanged(path: Path, expected: Snapshot) -> bool:
    try:
        now = read_snapshot(path)
    except PointerFileError:
        return False
    return now.raw == expected.raw and now.ident == expected.ident


def write_replacing(path: Path, expected: Snapshot, new_text: str | None, mode: int | None) -> None:
    """Swap the file from expected to new_text (None deletes it), or raise and change nothing.

    The new bytes go to a temp file in the same directory, then os.replace. Just
    before the swap the file is read again; if it is not byte- and inode-identical
    to expected, the swap is refused. A brand-new file is placed with os.link,
    which fails rather than overwrite a file that appeared in the meantime.
    """
    directory = path.parent
    if new_text is None:
        if expected.raw is None:
            return
        if not _unchanged(path, expected):
            raise PointerFileError(f"{path.name} changed during dispatch; left as it is")
        os.unlink(path)
        return
    data = new_text.encode("utf-8")
    fd, tmp = tempfile.mkstemp(prefix=".AGENTS.md.ak-", dir=str(directory))
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            if mode is not None:
                os.fchmod(fh.fileno(), mode)
            else:
                umask = os.umask(0)
                os.umask(umask)
                os.fchmod(fh.fileno(), 0o666 & ~umask)
            os.fsync(fh.fileno())
        if expected.raw is None:
            if os.path.lexists(path):
                raise PointerFileError(f"{path.name} appeared during dispatch; left as it is")
            try:
                os.link(tmp, path)
            except FileExistsError as e:
                raise PointerFileError(f"{path.name} appeared during dispatch; left as it is") from e
        else:
            if not _unchanged(path, expected):
                raise PointerFileError(f"{path.name} changed during dispatch; left as it is")
            os.replace(tmp, path)
            tmp = ""
    finally:
        if tmp:
            try:
                os.unlink(tmp)
            except FileNotFoundError:
                pass


class Injection:
    """Enough to undo one inject: the before/after text and the block written."""

    def __init__(self, path: Path, original: str | None, injected: str | None, block: str) -> None:
        self.path = path
        self.original = original
        self.injected = injected
        self.block = block

    @property
    def changed(self) -> bool:
        return self.injected != self.original


def inject(worktree: Path, block: str) -> Injection:
    """Write block into worktree/AGENTS.md. Missing file + empty block creates nothing."""
    path = worktree / AGENTS_MD
    snap = read_snapshot(path)
    original = snap.text
    try:
        new_text, changed = apply_pointer_block(original, block)
    except MalformedBlockError as e:
        raise PointerFileError(f"{AGENTS_MD}: {e}; fix or remove the marker by hand") from e
    if changed:
        write_replacing(path, snap, new_text, snap.mode)
    return Injection(path, original, new_text, block)


def _common_ends(original: str, injected: str) -> tuple[int, int]:
    """Length of the shared prefix and the shared suffix (never overlapping)."""
    limit = min(len(original), len(injected))
    p = 0
    while p < limit and original[p] == injected[p]:
        p += 1
    s = 0
    while s < limit - p and original[-1 - s] == injected[-1 - s]:
        s += 1
    return p, s


def cleanup(inj: Injection) -> str:
    """Take the injected block out again. Returns a one-line note; raises PointerFileError.

    inject turned original = P + O + S into injected = P + W + S. W, the written
    slice, is widened to cover the whole block when one was written. The worker's
    file must still hold W intact; cleanup swaps it back for O and keeps every
    other byte the worker wrote. If W cannot be found unambiguously, or the
    markers are now malformed, the file is left as the worker left it and the
    caller fails the task.
    """
    if not inj.changed or inj.injected is None:
        return "no pointer block was written"
    path = inj.path
    snap = read_snapshot(path)
    current = snap.text
    if current is None:
        return f"{AGENTS_MD} was deleted by the worker; nothing to remove"
    if current == inj.injected:
        write_replacing(path, snap, inj.original, snap.mode)
        return f"{AGENTS_MD} restored byte for byte"
    keep = "left as the worker left it"
    try:
        spans = find_spans(current)
    except MalformedBlockError as e:
        raise PointerFileError(f"{AGENTS_MD} now has a {e}; {keep}") from e
    original = inj.original if inj.original is not None else ""
    injected = inj.injected
    original_spans = find_spans(original)
    injected_spans = find_spans(injected)
    p, s = _common_ends(original, injected)
    w_start, w_end = p, len(injected) - s
    if injected_spans:
        b_start, b_end = injected_spans[0]
        w_start, w_end = min(w_start, b_start), max(w_end, b_end)
        if not spans:
            if not original_spans:
                return f"the worker removed the pointer block from {AGENTS_MD}; nothing to remove"
            raise PointerFileError(
                f"the worker removed the pointer block from {AGENTS_MD}, so the original managed "
                f"block cannot be put back in place; {keep}"
            )
        if len(spans) != 1 or current[spans[0][0]:spans[0][1]] != injected[b_start:b_end]:
            raise PointerFileError(f"the pointer block in {AGENTS_MD} was edited; {keep}")
        candidates = [spans[0][0] - (b_start - w_start)]
    else:
        # Empty block: inject only removed a stale block. Anchor on the untouched side.
        if spans:
            raise PointerFileError(f"the worker added an ak-skills block to {AGENTS_MD}; {keep}")
        candidates = []
        if current.startswith(injected[:w_start]):
            candidates.append(w_start)
        if current.endswith(injected[w_end:]):
            candidates.append(len(current) - (len(injected) - w_end) - (w_end - w_start))
    written = injected[w_start:w_end]
    o_start, o_end = w_start, len(original) - (len(injected) - w_end)

    def fits(c: int) -> bool:
        # W must match and sit against the same neighbouring character on each side,
        # so a worker line typed into the separator is not merged with it.
        end = c + len(written)
        return (
            c >= 0
            and current[c:end] == written
            and (w_start == 0 or (c > 0 and current[c - 1] == injected[w_start - 1]))
            and (w_end == len(injected) or current[end:end + 1] == injected[w_end:w_end + 1])
        )

    at = next((c for c in candidates if fits(c)), None)
    if at is None:
        raise PointerFileError(f"text next to the pointer block in {AGENTS_MD} was edited; {keep}")
    restored = current[:at] + original[o_start:o_end] + current[at + len(written):]
    try:
        same = [restored[a:b] for a, b in find_spans(restored)] == [original[a:b] for a, b in original_spans]
    except MalformedBlockError:
        same = False
    if not same:
        raise PointerFileError(f"cannot put the managed block in {AGENTS_MD} back; {keep}")
    if inj.original is None and restored == "":
        write_replacing(path, snap, None, None)
        return f"{AGENTS_MD} removed again (it did not exist before dispatch)"
    write_replacing(path, snap, restored, snap.mode)
    return f"pointer block removed from {AGENTS_MD}; worker edits kept"
