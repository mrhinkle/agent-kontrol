#!/usr/bin/env python3
"""Deliver a private velocity capture using an existing collector credential.

Usage: python3 scripts/import-velocity.py CAPTURE.json [--config EXISTING_ENV_FILE]
                                 [--url EXPECTED_ORIGIN]

Without --config, read only MC_URL and MC_TOKEN from the existing process
environment. With --config, parse those two assignments as literal data; never
source, execute, expand, create, or modify the file. --url is an origin assertion,
not an alternate destination. No redirects or automatic retries are permitted.
The ingest endpoint performs the authoritative capture-schema validation.
"""
from __future__ import annotations

import argparse
import datetime as dt
import ipaddress
import json
import os
import pathlib
import re
import shlex
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Mapping

MAX_CAPTURE_BYTES = 2 * 1024 * 1024
MAX_RESPONSE_BYTES = 64 * 1024
MAX_CONFIG_BYTES = 256 * 1024
REQUEST_TIMEOUT = 30
METRIC_VERSION = "observed-development-velocity-v1.0"
INGEST_PATH = "/api/velocity/ingest"
HASH_RE = re.compile(r"^[0-9a-fA-F]{64}$")
ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$")
ASSIGNMENT_RE = re.compile(r"^\s*(?:export\s+)?(MC_URL|MC_TOKEN)\s*=(.*)$")
DNS_LABEL_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$")


class SafeImportError(Exception):
    """Contains only a fixed, non-sensitive failure category."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class SafeArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        # argparse's default echoes unrecognized argument values.
        self.exit(2, "Import failed: invalid arguments.\n")


def bounded_file(path: pathlib.Path, maximum: int, category: str) -> bytes:
    try:
        with path.open("rb") as handle:
            data = handle.read(maximum + 1)
    except (OSError, ValueError):
        raise SafeImportError(category) from None
    if not data or len(data) > maximum:
        raise SafeImportError(category)
    return data


def strict_json(raw: bytes) -> Any:
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate key")
            result[key] = value
        return result

    def constant(value):
        raise ValueError("non-finite constant")

    return json.loads(raw.decode("utf-8"), object_pairs_hook=pairs, parse_constant=constant)


def iso_instant(value: Any) -> bool:
    if not isinstance(value, str) or ISO_RE.fullmatch(value) is None:
        return False
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.tzinfo is not None
    except ValueError:
        return False


def read_capture(path: pathlib.Path) -> bytes:
    raw = bounded_file(path, MAX_CAPTURE_BYTES, "invalid capture")
    try:
        data = strict_json(raw)
        valid = (
            isinstance(data, dict)
            and type(data.get("schemaVersion")) is int and data["schemaVersion"] == 1
            and data.get("metricVersion") == METRIC_VERSION
            and iso_instant(data.get("capturedAt"))
            and data.get("captureKind") in ("observed", "reconstructed")
            and type(data.get("inventoryComplete")) is bool
            and all(isinstance(data.get(key), dict) for key in ("window", "scope", "source"))
            and isinstance(data.get("repositories"), list)
        )
    except (ValueError, UnicodeError, RecursionError, TypeError):
        raise SafeImportError("invalid capture") from None
    if not valid:
        raise SafeImportError("invalid capture")
    return raw


def configured_values(config: pathlib.Path | None, environ: Mapping[str, str]) -> tuple[str, str]:
    if config is None:
        values = {key: environ.get(key) for key in ("MC_URL", "MC_TOKEN")}
    else:
        raw = bounded_file(config, MAX_CONFIG_BYTES, "invalid configuration")
        try:
            text = raw.decode("utf-8-sig")
            values = {}
            for line in text.splitlines():
                matched = ASSIGNMENT_RE.fullmatch(line)
                if matched is None:
                    continue
                key, literal = matched.groups()
                if key in values:
                    raise ValueError("duplicate recognized assignment")
                # shlex parses quoting only. It performs no substitutions or execution.
                parts = shlex.split(literal, comments=True, posix=True)
                if len(parts) != 1:
                    raise ValueError("invalid literal assignment")
                values[key] = parts[0]
        except (UnicodeError, ValueError):
            raise SafeImportError("invalid configuration") from None
    url, token = values.get("MC_URL"), values.get("MC_TOKEN")
    if not isinstance(url, str) or not isinstance(token, str) or not token or len(token) > 16384:
        raise SafeImportError("invalid configuration")
    # Prevent header injection and implicit credential normalization.
    if any(ord(ch) < 33 or ord(ch) > 126 for ch in token):
        raise SafeImportError("invalid configuration")
    return url, token


def origin(value: str) -> tuple[str, tuple[str, str, int]]:
    """Return a canonical origin and comparable (scheme, host, port) tuple."""
    try:
        if not isinstance(value, str) or not value or any(ord(ch) <= 32 or ord(ch) >= 127 for ch in value):
            raise ValueError("invalid origin")
        if "?" in value or "#" in value or "\\" in value:
            raise ValueError("invalid origin")
        parsed = urllib.parse.urlsplit(value)
        if (parsed.scheme not in ("https", "http") or not parsed.netloc or parsed.path
                or parsed.query or parsed.fragment or parsed.username is not None or parsed.password is not None):
            raise ValueError("origin-only URL required")
        host = parsed.hostname
        if not host or "%" in host:
            raise ValueError("invalid host")
        loopback = host.lower() == "localhost"
        try:
            address = ipaddress.ip_address(host)
            host = address.compressed
            loopback = address.is_loopback
            serialized_host = "[" + host + "]" if address.version == 6 else host
        except ValueError:
            host = host.lower()
            if len(host) > 253 or any(DNS_LABEL_RE.fullmatch(label) is None for label in host.split(".")):
                raise ValueError("invalid DNS host")
            serialized_host = host
        if parsed.scheme == "http" and not loopback:
            raise ValueError("HTTPS required")
        default_port = 443 if parsed.scheme == "https" else 80
        port = parsed.port if parsed.port is not None else default_port
        if not 1 <= port <= 65535:
            raise ValueError("invalid port")
        canonical = parsed.scheme + "://" + serialized_host
        if port != default_port:
            canonical += ":" + str(port)
        return canonical, (parsed.scheme, host, port)
    except (ValueError, TypeError, AttributeError):
        raise SafeImportError("invalid configuration") from None


def default_opener():
    # No ambient proxy routing and no redirect handler may relocate the bearer.
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())


def receipt_fields(body: bytes, token: str) -> dict:
    try:
        data = strict_json(body)
        if (not isinstance(data, dict) or data.get("ok") is not True
                or not isinstance(data.get("id"), str) or HASH_RE.fullmatch(data["id"]) is None
                or not isinstance(data.get("scopeKey"), str) or HASH_RE.fullmatch(data["scopeKey"]) is None
                or type(data.get("duplicate")) is not bool or not iso_instant(data.get("recordedAt"))):
            raise ValueError("invalid receipt")
        safe = {key: data[key] for key in ("ok", "id", "scopeKey", "duplicate", "recordedAt")}
        if token in json.dumps(safe, separators=(",", ":")):
            raise ValueError("receipt echoes credential")
        return safe
    except (ValueError, UnicodeError, RecursionError, TypeError):
        raise SafeImportError("invalid response") from None


def deliver(raw: bytes, configured_url: str, token: str, expected_url: str | None = None, opener=None) -> dict:
    target, identity = origin(configured_url)
    if expected_url is not None and origin(expected_url)[1] != identity:
        raise SafeImportError("target origin does not match configuration")
    endpoint = target + INGEST_PATH
    request = urllib.request.Request(endpoint, data=raw, method="POST",
                                     headers={"Authorization": "Bearer " + token,
                                              "Content-Type": "application/json", "Accept": "application/json"})
    transport = opener if opener is not None else default_opener()
    try:
        with transport.open(request, timeout=REQUEST_TIMEOUT) as response:
            status = response.getcode()
            if type(status) is not int or not 200 <= status < 300:
                if type(status) is int and 100 <= status <= 599:
                    raise SafeImportError("HTTP " + str(status))
                raise SafeImportError("invalid response")
            # Defense in depth for custom transports: default transport never redirects.
            if response.geturl() != endpoint:
                raise SafeImportError("invalid response")
            # One extra sentinel byte detects oversized responses; accepted bodies <=64 KiB.
            body = response.read(MAX_RESPONSE_BYTES + 1)
            if not isinstance(body, bytes) or len(body) > MAX_RESPONSE_BYTES:
                raise SafeImportError("invalid response")
            return receipt_fields(body, token)
    except urllib.error.HTTPError as exc:
        code = exc.code
        exc.close()
        if type(code) is int and 100 <= code <= 599:
            raise SafeImportError("HTTP " + str(code)) from None
        raise SafeImportError("request could not be completed") from None
    except SafeImportError:
        raise
    except Exception:
        # Transport errors may embed request URLs, headers, or echoed credentials.
        raise SafeImportError("request could not be completed") from None


def main(argv: list[str] | None = None, *, environ: Mapping[str, str] | None = None, opener=None) -> int:
    parser = SafeArgumentParser(description=__doc__)
    parser.add_argument("capture", type=pathlib.Path)
    parser.add_argument("--config", type=pathlib.Path, help="Existing collector env file; read two literal assignments only")
    parser.add_argument("--url", help="Assert this exact origin matches configured MC_URL")
    args = parser.parse_args(argv)
    try:
        raw = read_capture(args.capture)
        configured_url, token = configured_values(args.config, os.environ if environ is None else environ)
        receipt = deliver(raw, configured_url, token, args.url, opener)
        print(json.dumps(receipt, separators=(",", ":")))
        return 0
    except SafeImportError as exc:
        print("Import failed: " + str(exc) + ".", file=sys.stderr)
        return 1
    except Exception:
        print("Import failed: request could not be completed.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
