#!/usr/bin/env python3
"""Allowlisted child environment for dispatcher-launched agent CLIs.

Imports the dispatcher modules the way the other tests/unit files do.
Fixture values are not secrets. No test prints an environment value.
"""
from __future__ import annotations

import contextlib
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

DISPATCHER = Path(__file__).resolve().parents[2] / "agents" / "dispatcher"
sys.path.insert(0, str(DISPATCHER))
import child_env  # noqa: E402
import mc_dispatcher as md  # noqa: E402

FIXTURE = "fixture-value-not-a-secret"

_BASE = (
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "TMPDIR", "TZ",
    "SSH_AUTH_SOCK",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
    "http_proxy", "https_proxy", "no_proxy", "all_proxy",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
)


def _capture(platform: str, parent: dict[str, str]):
    buf = io.StringIO()
    with contextlib.redirect_stderr(buf):
        env = child_env.build_child_env(platform, parent=parent)
    return env, buf.getvalue()


class BuildChildEnvTests(unittest.TestCase):
    def test_base_names_pass(self):
        parent = {name: FIXTURE for name in _BASE}
        parent["Http_Proxy"] = FIXTURE
        parent["NOT_A_BASE"] = FIXTURE
        env, err = _capture("unknown-platform", parent)
        self.assertEqual(set(env), set(_BASE))
        self.assertEqual(env["PATH"], FIXTURE)
        self.assertEqual(env["http_proxy"], FIXTURE)
        self.assertNotIn("Http_Proxy", env)
        self.assertNotIn("NOT_A_BASE", env)
        self.assertEqual(err, "")

    def test_lc_all_and_xdg_config_home_pass(self):
        parent = {
            "LC_ALL": "C",
            "XDG_CONFIG_HOME": "/tmp/xdg-fixture",
            "LC": "no",
            "XDG": "no",
            "PATH": "/bin",
        }
        env, _err = _capture("unknown-platform", parent)
        self.assertEqual(env["LC_ALL"], "C")
        self.assertEqual(env["XDG_CONFIG_HOME"], "/tmp/xdg-fixture")
        self.assertNotIn("LC", env)
        self.assertNotIn("XDG", env)

    def test_credentials_and_unlisted_names_do_not_pass(self):
        parent = {
            "PATH": "/bin",
            "MC_TOKEN": FIXTURE,
            "MC_EVENT_TOKEN": FIXTURE,
            "MC_COOKIE_SECRET": FIXTURE,
            "FOO_API_KEY": FIXTURE,
            "GH_TOKEN": FIXTURE,
        }
        env, err = _capture("claude-code", parent)
        self.assertEqual(list(env), ["PATH"])
        for name in ("MC_TOKEN", "MC_EVENT_TOKEN", "MC_COOKIE_SECRET", "FOO_API_KEY", "GH_TOKEN"):
            self.assertNotIn(name, env)
        self.assertNotIn(FIXTURE, err)

    def test_mc_url_passes(self):
        parent = {"MC_URL": "https://ak.example", "MC_TOKEN": FIXTURE}
        env, _err = _capture("claude-code", parent)
        self.assertEqual(env["MC_URL"], "https://ak.example")
        self.assertNotIn("MC_TOKEN", env)

    def test_other_nonsecret_settings_pass(self):
        parent = {
            "MC_AGENT": "dispatcher",
            "MC_AGENT_NAME": "lane",
            "MC_TRACES": "1",
            "MC_TRACE_CAPTURE_CONTENT": "0",
            "MC_WORKDIR": "/tmp/fixture-work",
        }
        env, _err = _capture("codex", parent)
        self.assertEqual(env["MC_AGENT"], "dispatcher")
        self.assertEqual(env["MC_AGENT_NAME"], "lane")
        self.assertEqual(env["MC_TRACES"], "1")
        self.assertEqual(env["MC_TRACE_CAPTURE_CONTENT"], "0")
        self.assertNotIn("MC_WORKDIR", env)

    def test_anthropic_api_key_passes_for_claude_only(self):
        parent = {
            "PATH": "/bin",
            "ANTHROPIC_API_KEY": FIXTURE,
            "CLAUDE_CONFIG_DIR": "/tmp/claude-fixture",
        }
        for platform in ("claude-code", "claude"):
            env, _err = _capture(platform, parent)
            self.assertEqual(env["ANTHROPIC_API_KEY"], FIXTURE)
            self.assertEqual(env["CLAUDE_CONFIG_DIR"], "/tmp/claude-fixture")
        self.assertEqual(
            child_env.build_child_env("claude", parent=parent),
            child_env.build_child_env("claude-code", parent=parent),
        )
        for platform in ("codex", "grok"):
            env, _err = _capture(platform, parent)
            self.assertNotIn("ANTHROPIC_API_KEY", env)
            self.assertNotIn("CLAUDE_CONFIG_DIR", env)
            self.assertIn("PATH", env)

    def test_openai_api_key_passes_for_codex_only(self):
        parent = {"PATH": "/bin", "OPENAI_API_KEY": FIXTURE, "CODEX_HOME": "/tmp/codex-fixture"}
        env, _err = _capture("codex", parent)
        self.assertEqual(env["OPENAI_API_KEY"], FIXTURE)
        self.assertEqual(env["CODEX_HOME"], "/tmp/codex-fixture")
        for platform in ("claude-code", "claude", "grok", "unknown-platform"):
            env, _err = _capture(platform, parent)
            self.assertNotIn("OPENAI_API_KEY", env)
            self.assertNotIn("CODEX_HOME", env)

    def test_xai_api_key_passes_for_grok_only(self):
        parent = {"PATH": "/bin", "XAI_API_KEY": FIXTURE, "GROK_BASE_URL": "https://api.example"}
        env, _err = _capture("grok", parent)
        self.assertEqual(env["XAI_API_KEY"], FIXTURE)
        self.assertEqual(env["GROK_BASE_URL"], "https://api.example")
        for platform in ("claude-code", "claude", "codex", "unknown-platform"):
            env, _err = _capture(platform, parent)
            self.assertNotIn("XAI_API_KEY", env)
            self.assertNotIn("GROK_BASE_URL", env)

    def test_unknown_platform_gets_base_names_only(self):
        parent = {
            "PATH": "/usr/bin",
            "HOME": "/home/fixture",
            "ANTHROPIC_API_KEY": FIXTURE,
            "OPENAI_API_KEY": FIXTURE,
            "XAI_API_KEY": FIXTURE,
            "GH_TOKEN": FIXTURE,
            "FOO_API_KEY": FIXTURE,
        }
        env, err = _capture("no-such-cli", parent)
        self.assertEqual(env, {"PATH": "/usr/bin", "HOME": "/home/fixture"})
        self.assertEqual(err, "")

    def test_nonsecret_settings_still_pass_for_an_unknown_platform(self):
        parent = {"PATH": "/bin", "MC_URL": "https://ak.example", "ANTHROPIC_API_KEY": FIXTURE}
        env, _err = _capture("no-such-cli", parent)
        self.assertEqual(env["MC_URL"], "https://ak.example")
        self.assertNotIn("ANTHROPIC_API_KEY", env)

    def test_absent_base_name_is_omitted_and_empty_string_is_copied(self):
        env, _err = _capture("codex", {"PATH": ""})
        self.assertEqual(env, {"PATH": ""})
        self.assertNotIn("HOME", env)

    def test_returns_a_new_mapping_and_mutates_neither_parent_nor_environ(self):
        parent = {"PATH": "/usr/bin", "MC_TOKEN": FIXTURE, "HOME": "/home/fixture"}
        snapshot = dict(parent)
        synthetic = {"PATH": "/keep", "MC_TOKEN": FIXTURE, "HOME": "/home/fixture"}
        with mock.patch.dict(os.environ, synthetic, clear=True):
            before = dict(os.environ)
            result = child_env.build_child_env("claude-code", parent=parent)
            from_process = child_env.build_child_env("codex")
            self.assertEqual(dict(os.environ), before)
        self.assertEqual(parent, snapshot)
        self.assertIsNot(result, parent)
        self.assertIsNot(from_process, os.environ)
        result["PATH"] = "changed"
        self.assertEqual(parent["PATH"], "/usr/bin")
        self.assertNotIn("MC_TOKEN", result)
        self.assertNotIn("MC_TOKEN", from_process)
        self.assertEqual(from_process["PATH"], "/keep")


class AllowListTests(unittest.TestCase):
    def test_allow_exact_name_passes(self):
        parent = {"PATH": "/bin", "CUSTOM_NAME": "kept", "MC_CHILD_ENV_ALLOW": "CUSTOM_NAME"}
        env, err = _capture("unknown-platform", parent)
        self.assertEqual(env["CUSTOM_NAME"], "kept")
        self.assertNotIn("MC_CHILD_ENV_ALLOW", env)
        self.assertEqual(err, "")

    def test_allow_prefix_passes_fleet_dispatch_token(self):
        parent = {
            "PATH": "/bin",
            "FLEET": "no",
            "FLEET_DISPATCH_TOKEN": "kept",
            "MC_CHILD_ENV_ALLOW": "FLEET_*",
        }
        env, err = _capture("unknown-platform", parent)
        self.assertEqual(env["FLEET_DISPATCH_TOKEN"], "kept")
        self.assertNotIn("FLEET", env)
        self.assertEqual(err, "")

    def test_allow_entries_ignore_surrounding_space(self):
        parent = {
            "PATH": "/bin",
            "CUSTOM_NAME": "kept",
            "FLEET_DISPATCH_TOKEN": "kept",
            "MC_CHILD_ENV_ALLOW": "  CUSTOM_NAME  ,  FLEET_*  , , ",
        }
        env, err = _capture("grok", parent)
        self.assertEqual(env["CUSTOM_NAME"], "kept")
        self.assertEqual(env["FLEET_DISPATCH_TOKEN"], "kept")
        self.assertEqual(err, "")

    def test_bare_star_passes_nothing_extra(self):
        parent = {
            "PATH": "/bin",
            "FOO_API_KEY": FIXTURE,
            "GH_TOKEN": FIXTURE,
            "MC_CHILD_ENV_ALLOW": "*",
        }
        env, err = _capture("unknown-platform", parent)
        self.assertEqual(list(env), ["PATH"])
        self.assertIn("*", err)
        self.assertNotIn(FIXTURE, err)

    def test_allow_list_cannot_pass_mc_token_or_mc_event_token(self):
        parent = {
            "PATH": "/bin",
            "MC_TOKEN": FIXTURE,
            "MC_EVENT_TOKEN": FIXTURE,
            "MC_URL": "https://ak.example",
            "MC_CHILD_ENV_ALLOW": "MC_TOKEN,MC_*",
        }
        env, err = _capture("claude-code", parent)
        self.assertNotIn("MC_TOKEN", env)
        self.assertNotIn("MC_EVENT_TOKEN", env)
        self.assertNotIn("MC_CHILD_ENV_ALLOW", env)
        self.assertEqual(env["MC_URL"], "https://ak.example")
        self.assertIn("MC_TOKEN", err)
        self.assertIn("MC_EVENT_TOKEN", err)
        self.assertNotIn(FIXTURE, err)

    def test_allow_list_name_is_never_in_the_result(self):
        parent = {"PATH": "/bin", "MC_CHILD_ENV_ALLOW": "MC_CHILD_ENV_ALLOW,PATH"}
        env, err = _capture("codex", parent)
        self.assertNotIn("MC_CHILD_ENV_ALLOW", env)
        self.assertIn("PATH", env)
        self.assertIn("MC_CHILD_ENV_ALLOW", err)

    def test_invalid_allow_entry_is_reported_once_and_omits_values(self):
        parent = {
            "PATH": "/bin",
            "FOO_API_KEY": FIXTURE,
            "MC_CHILD_ENV_ALLOW": "*,  * , *middle, ok*",
        }
        env, err = _capture("unknown-platform", parent)
        self.assertEqual(list(env), ["PATH"])
        self.assertEqual(err.count("child_env: ignoring invalid MC_CHILD_ENV_ALLOW entry: *\n"), 1)
        self.assertIn("child_env: ignoring invalid MC_CHILD_ENV_ALLOW entry: *middle\n", err)
        self.assertNotIn("ok*", err)
        self.assertNotIn(FIXTURE, err)

    def test_unset_allow_list_adds_nothing(self):
        parent = {"PATH": "/bin", "FOO_API_KEY": FIXTURE, "MC_URL": "https://ak.example"}
        env, err = _capture("unknown-platform", parent)
        self.assertEqual(env, {"PATH": "/bin", "MC_URL": "https://ak.example"})
        self.assertEqual(err, "")


class NeverNameWarningTests(unittest.TestCase):
    def test_never_name_warning_names_the_variable_not_the_value(self):
        parent = {
            "MC_EVENT_TOKEN": FIXTURE,
            "PATH": "/usr/bin",
            "MC_TOKEN": FIXTURE,
            "MC_CHILD_ENV_ALLOW": "MC_TOKEN,MC_EVENT_TOKEN",
        }
        env, err = _capture("claude-code", parent)
        self.assertNotIn("MC_TOKEN", env)
        self.assertNotIn("MC_EVENT_TOKEN", env)
        self.assertIn("PATH", env)
        self.assertLess(err.index("MC_EVENT_TOKEN"), err.index("MC_TOKEN"))
        self.assertEqual(err.count("MC_TOKEN"), 1)
        self.assertEqual(err.count("MC_EVENT_TOKEN"), 1)
        self.assertNotIn(FIXTURE, err)
        for line in err.splitlines():
            self.assertNotIn("=", line)


class StripSecretEnvTests(unittest.TestCase):
    def test_strip_secret_env_removes_credentials_and_keeps_the_rest(self):
        env = {
            "PATH": "/usr/bin",
            "MC_TOKEN": FIXTURE,
            "FLEET_DISPATCH_TOKEN": "kept",
            "MC_EVENT_TOKEN": FIXTURE,
            "MC_CHILD_ENV_ALLOW": "FLEET_*",
            "CRON_SECRET": FIXTURE,
            "MC_WORKDIR": "/tmp/fixture-work",
            "HOME": "/home/fixture",
        }
        removed = child_env.strip_secret_env(env)
        self.assertEqual(removed, [
            "MC_TOKEN", "MC_EVENT_TOKEN", "MC_CHILD_ENV_ALLOW", "CRON_SECRET", "MC_WORKDIR",
        ])
        self.assertEqual(env["PATH"], "/usr/bin")
        self.assertEqual(env["FLEET_DISPATCH_TOKEN"], "kept")
        self.assertEqual(env["HOME"], "/home/fixture")
        self.assertNotIn("MC_TOKEN", env)
        self.assertNotIn("MC_EVENT_TOKEN", env)


class RunContainedEnvTests(unittest.TestCase):
    def test_run_contained_child_does_not_see_parent_credentials(self):
        script = "import os; print('\\n'.join(sorted(os.environ)))"
        added = {
            "MC_TOKEN": FIXTURE,
            "MC_EVENT_TOKEN": FIXTURE,
            "FOO_API_KEY": FIXTURE,
            "MC_CHILD_ENV_ALLOW": "",
        }
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, added, clear=False):
            code, out, err = md.run_contained(
                [sys.executable, "-c", script], Path(tmp), 30,
                env=child_env.build_child_env("claude-code"),
            )
        self.assertEqual(code, 0, err)
        names = out.splitlines()
        self.assertNotIn("MC_TOKEN", names)
        self.assertNotIn("MC_EVENT_TOKEN", names)
        self.assertNotIn("FOO_API_KEY", names)
        self.assertIn("PATH", names)
        self.assertNotIn(FIXTURE, out)
        self.assertNotIn(FIXTURE, err)

    def test_run_cli_passes_build_child_env_for_worker_and_review(self):
        synthetic = {
            "PATH": "/usr/bin",
            "HOME": "/home/fixture",
            "MC_TOKEN": FIXTURE,
            "MC_EVENT_TOKEN": FIXTURE,
            "ANTHROPIC_API_KEY": FIXTURE,
            "GH_TOKEN": FIXTURE,
            "FOO_API_KEY": FIXTURE,
            "MC_URL": "https://ak.example",
        }
        for review in (False, True):
            with self.subTest(review=review):
                with mock.patch.dict(os.environ, synthetic, clear=True):
                    expected = child_env.build_child_env("claude-code")
                    with mock.patch.object(md, "run_contained", return_value=(0, "{}", "")) as run, \
                            mock.patch.object(md, "ingest"):
                        md.run_cli("claude-code", "prompt", Path("."), review=review)
                env = run.call_args.kwargs["env"]
                self.assertNotIn("MC_TOKEN", env)
                self.assertNotIn("MC_EVENT_TOKEN", env)
                self.assertNotIn("GH_TOKEN", env)
                self.assertNotIn("FOO_API_KEY", env)
                self.assertEqual(env, expected)
                self.assertIn("ANTHROPIC_API_KEY", env)
                self.assertEqual(env["MC_URL"], "https://ak.example")


if __name__ == "__main__":
    unittest.main()
