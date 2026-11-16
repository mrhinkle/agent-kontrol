"""Offline activity collector contract tests; all GitHub responses are synthetic."""
from contextlib import redirect_stderr, redirect_stdout
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("progress_activity", Path(__file__).resolve().parents[2] / "scripts" / "collect-progress-activity.py")
activity = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(activity)
NOW = datetime(2026, 11, 4, 16, tzinfo=timezone.utc)
OLD = "2026-10-01T00:00:00Z"
TOKEN = "synthetic-credential-never-print-this"


def owners(*names):
    return {"owners": [{"owner": name, "include_forks": False, "include_archived": False} for name in names]}


def retained(*names):
    return {"repos": [{"repo": name} for name in names]}


def repo(number, owner="example"):
    return {"id": "node-" + str(number), "nameWithOwner": owner + "/repo-" + str(number),
            "isArchived": False, "isFork": False, "pushedAt": OLD,
            "openPullRequests": {"totalCount": 0}, "openIssues": {"totalCount": 0},
            "latestPullRequest": {"totalCount": 0, "nodes": []}, "latestIssue": {"totalCount": 0, "nodes": []}}


def page(nodes, *, total=None, more=False, cursor="last", owner="example"):
    return {"data": {"repositoryOwner": {"login": owner, "repositories": {
        "totalCount": len(nodes) if total is None else total, "nodes": nodes,
        "pageInfo": {"hasNextPage": more, "endCursor": cursor}}}}}


class Queries:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, query, variables):
        self.calls.append((query, variables.copy()))
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


class TestProgressActivity(unittest.TestCase):
    def collect(self, responses, known=None, owner_names=("example",), clock=lambda: NOW):
        query = Queries(responses)
        result = activity.collect(owners(*owner_names), retained("example/known") if known is None else known,
                                  query_fn=query, clock=clock)
        self.assertNotIn(TOKEN, json.dumps(result))
        return result, query

    def assert_failed_owner(self, responses, code=None):
        result, query = self.collect(responses)
        discovery = result["discovery"]["results"][0]
        self.assertFalse(discovery["ok"])
        self.assertNotIn("repos", discovery)
        self.assertEqual(result["snapshot"]["repos"], [activity.unavailable("example/known", "2026-11-04T16:00:00Z", discovery["error"])])
        self.assertEqual(result["summary"]["repositories_complete"], 0)
        if code:
            self.assertEqual(discovery["error"], code)
        return result, query

    def test_paginates_more_than_one_thousand_and_preserves_all_flags(self):
        nodes = [repo(i) for i in range(1001)]
        nodes[0].update(isArchived=True, isFork=True, pushedAt=None)
        responses = [page(nodes[start:start+50], total=len(nodes), more=start+50 < len(nodes), cursor="c" + str(start))
                     for start in range(0, len(nodes), 50)]
        result, query = self.collect(responses, retained())
        self.assertEqual(len(query.calls), 21)
        self.assertIsNone(query.calls[0][1]["cursor"])
        self.assertEqual(query.calls[-1][1]["cursor"], "c950")
        discovery = result["discovery"]["results"][0]
        self.assertTrue(discovery["ok"])
        self.assertFalse(discovery["truncated"])
        self.assertEqual(len(discovery["repos"]), 1001)
        self.assertEqual(discovery["repos"][0], {"name": "repo-0", "pushedAt": None, "isArchived": True, "isFork": True})
        self.assertEqual(result["summary"]["repositories_complete"], 1001)

    def test_zero_counts_and_known_null_are_complete_without_root_issue_counters(self):
        node = repo(1)
        node["pushedAt"] = None
        result, _ = self.collect([page([node])], retained("EXAMPLE/Repo-1"))
        row = result["snapshot"]["repos"][0]
        self.assertEqual(set(row), {"repo", "open_prs", "detail"})
        self.assertEqual(row["repo"], "EXAMPLE/Repo-1")
        self.assertEqual(row["open_prs"], 0)
        self.assertEqual(row["detail"]["activity"], {"status": "complete", "checked_at": "2026-11-04T16:00:00Z",
                         "pushed_at": None, "pr_updated_at": None, "issue_updated_at": None, "open_issues": 0})
        self.assertEqual(result["snapshot"]["kind"], "activity")
        self.assertNotIn("open_issues", row)
        self.assertNotIn("merged_prs", row)

    def test_current_counts_and_latest_closed_item_updates_are_retained(self):
        node = repo(1)
        node["openPullRequests"]["totalCount"] = 3
        node["openIssues"]["totalCount"] = 4
        node["latestPullRequest"] = {"totalCount": 10, "nodes": [{"updatedAt": "2026-11-04T15:59:59Z"}]}
        node["latestIssue"] = {"totalCount": 11, "nodes": [{"updatedAt": "2026-11-04T16:00:00Z"}]}
        result, _ = self.collect([page([node])], retained())
        row = result["snapshot"]["repos"][0]
        self.assertEqual(row["open_prs"], 3)
        self.assertEqual(row["detail"]["activity"]["open_issues"], 4)
        self.assertEqual(row["detail"]["activity"]["issue_updated_at"], "2026-11-04T16:00:00Z")

    def test_failed_later_page_discards_partial_discovery_and_marks_all_known_unavailable(self):
        first = page([repo(i) for i in range(50)], total=51, more=True, cursor="c1")
        known = {"repos": [{"repo": "example/repo-1", "hidden": True}, {"repo": "example/old", "origin": "auto"},
                            {"repo": "example/gone", "gone": True}]}
        result, query = self.collect([first, {"data": {"repositoryOwner": None}, "errors": [{"message": TOKEN}]}], known)
        self.assertEqual(len(query.calls), 2)
        self.assertFalse(result["discovery"]["results"][0]["ok"])
        self.assertNotIn("repos", result["discovery"]["results"][0])
        self.assertEqual({r["repo"] for r in result["snapshot"]["repos"]}, {"example/repo-1", "example/old"})
        self.assertTrue(all(r["open_prs"] is None and r["detail"]["activity"]["status"] == "unavailable" for r in result["snapshot"]["repos"]))

    def test_empty_owner_cannot_publish_successful_zero_discovery(self):
        self.assert_failed_owner([page([], total=0, cursor=None)], "empty_owner_inventory")

    def test_invalid_pagination_is_never_complete(self):
        first = page([repo(i) for i in range(50)], total=51, more=True, cursor="c1")
        variants = [page([repo(50)], total=51, cursor="c1"), page([repo(50)], total=52, cursor="c2"),
                    page([], total=51, cursor="c2"), page([repo(50)], total=51, more=True, cursor="c2"),
                    page([repo(50)], total=51, cursor=None)]
        for second in variants:
            with self.subTest(second=second):
                self.assert_failed_owner([deepcopy(first), second], "pagination_incomplete")
        self.assert_failed_owner([page([repo(1)], total=51, more=True)], "pagination_incomplete")
        self.assert_failed_owner([page([repo(1)], total=True)])

    def test_duplicate_names_and_ids_across_pages_fail(self):
        first = page([repo(i) for i in range(50)], total=51, more=True, cursor="c1")
        for changes in ({"nameWithOwner": "EXAMPLE/REPO-1"}, {"id": "node-1"}):
            node = repo(50)
            node.update(changes)
            self.assert_failed_owner([deepcopy(first), page([node], total=51, cursor="c2")], "duplicate_repository")

    def test_missing_malformed_and_future_fields_are_unknown_not_zero(self):
        mutations = [lambda n: n.pop("pushedAt"), lambda n: n.update(isFork=1),
                     lambda n: n.update(pushedAt="2026-11-04T16:00:00.000001Z"),
                     lambda n: n.update(pushedAt="2026-02-30T00:00:00Z"),
                     lambda n: n.update(pushedAt="2026-11-04T16:00:00+01:00"),
                     lambda n: n["openPullRequests"].update(totalCount=True),
                     lambda n: n["openIssues"].update(totalCount=-1),
                     lambda n: n["latestPullRequest"].pop("nodes"),
                     lambda n: n["latestPullRequest"].update(totalCount=1, nodes=[]),
                     lambda n: n["latestIssue"].update(totalCount=1, nodes=[{}]),
                     lambda n: n["latestIssue"].update(totalCount=1, nodes=[{"updatedAt": None}]),
                     lambda n: n["latestIssue"].update(totalCount=1, nodes=[{"updatedAt": "2026-11-05T00:00:00Z"}]),
                     lambda n: n["openPullRequests"].update(totalCount=1)]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                node = repo(1)
                mutate(node)
                self.assert_failed_owner([page([node])])

    def test_owner_identity_and_repository_owner_must_match(self):
        self.assert_failed_owner([page([repo(1)], owner="other")])
        self.assert_failed_owner([page([repo(1, "other")])], "repository_identity_changed")

    def test_manual_and_retained_removed_owner_fallback_skip_gone_keep_hidden(self):
        known = {"repos": [{"repo": "Manual/Repo-1", "hidden": True}, {"repo": "retired/repo-2", "origin": "auto"},
                            {"repo": "removed/repo-3", "gone": True}]}
        result, query = self.collect([{"data": {"repository": repo(1, "manual")}}, {"data": {"repository": repo(2, "retired")}}], known, ())
        self.assertEqual(result["discovery"]["results"], [])
        self.assertEqual(result["summary"]["direct_queries"], 2)
        self.assertEqual({r["repo"] for r in result["snapshot"]["repos"]}, {"Manual/Repo-1", "retired/repo-2"})
        self.assertTrue(all(call[0] == activity.REPO_QUERY for call in query.calls))

    def test_manual_rename_and_read_failure_are_unavailable(self):
        for response in ({"data": {"repository": repo(1, "renamed")}}, RuntimeError(TOKEN), {"data": {"repository": None}}):
            with self.subTest(response=type(response)):
                result, _ = self.collect([response], retained("manual/repo-1"), ())
                self.assertEqual(result["snapshot"]["repos"][0]["repo"], "manual/repo-1")
                self.assertIsNone(result["snapshot"]["repos"][0]["open_prs"])
                self.assertEqual(result["summary"]["repositories_unavailable"], 1)

    def test_absent_known_row_is_unavailable_without_fabricated_direct_success(self):
        result, query = self.collect([page([repo(1)])])
        row = next(r for r in result["snapshot"]["repos"] if r["repo"] == "example/known")
        self.assertEqual(row["detail"]["activity"]["error"], "missing_from_inventory")
        self.assertEqual(len(query.calls), 1)

    def test_one_failed_owner_does_not_discard_another_owner(self):
        result, _ = self.collect([RuntimeError(TOKEN), page([repo(1, "second")], owner="second")],
                                 retained("example/known", "second/repo-1"), ("example", "second"))
        self.assertEqual([d["ok"] for d in result["discovery"]["results"]], [False, True])
        self.assertEqual(result["summary"]["repositories_complete"], 1)
        self.assertEqual(result["summary"]["repositories_unavailable"], 1)

    def test_timestamps_are_taken_after_responses_and_collection_after_all_reads(self):
        events, counter = [], iter(range(4))
        def clock():
            n = next(counter)
            events.append("clock" + str(n))
            return NOW + timedelta(seconds=n)
        query = Queries([page([repo(i) for i in range(50)], total=51, more=True, cursor="c1"),
                         page([repo(50)], total=51, cursor="c2")])
        def read(q, v):
            events.append("response")
            return query(q, v)
        result = activity.collect(owners("example"), retained(), query_fn=read, clock=clock)
        self.assertEqual(events, ["clock0", "response", "clock1", "response", "clock2", "clock3"])
        self.assertEqual(result["snapshot"]["collected_at"], "2026-11-04T16:00:03Z")
        by_name = {r["repo"]: r["detail"]["activity"]["checked_at"] for r in result["snapshot"]["repos"]}
        self.assertEqual(by_name["example/repo-1"], "2026-11-04T16:00:01Z")
        self.assertEqual(by_name["example/repo-50"], "2026-11-04T16:00:02Z")

    def test_subprocess_is_bounded_query_only_and_stderr_is_discarded(self):
        response = SimpleNamespace(returncode=0, stdout=json.dumps(page([repo(1)])).encode())
        with patch.object(activity.subprocess, "run", return_value=response) as run:
            activity.github_query(activity.OWNER_QUERY, {"owner": "example", "cursor": None})
        args, kwargs = run.call_args
        self.assertEqual(args[0][:5], ["gh", "api", "--hostname", "github.com", "graphql"])
        self.assertIn("query=query ProgressOwnerActivity", args[0][6])
        self.assertNotIn("mutation", " ".join(args[0]))
        self.assertEqual(kwargs["timeout"], 45)
        self.assertIs(kwargs["stderr"], subprocess.DEVNULL)
        self.assertNotIn("env", kwargs)
        for error in (subprocess.TimeoutExpired(TOKEN, 45), OSError(TOKEN)):
            with patch.object(activity.subprocess, "run", side_effect=error), self.assertRaises(activity.ReadFailed) as caught:
                activity.github_query(activity.OWNER_QUERY, {"owner": "example"})
            self.assertEqual(caught.exception.code, "github_read_failed")

    def test_cli_emits_partial_json_with_zero_exit_but_malformed_input_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            owner_path, repo_path = Path(directory) / "owners.json", Path(directory) / "repos.json"
            owner_path.write_text(json.dumps(owners("example")))
            repo_path.write_text(json.dumps(retained("example/known")))
            args = ["--owners", str(owner_path), "--repos", str(repo_path)]
            out, err = io.StringIO(), io.StringIO()
            with patch.object(activity, "github_query", side_effect=RuntimeError(TOKEN)), redirect_stdout(out), redirect_stderr(err):
                code = activity.main(args)
            self.assertEqual(code, 0)
            self.assertEqual(err.getvalue(), "")
            self.assertEqual(json.loads(out.getvalue())["summary"]["repositories_unavailable"], 1)
            self.assertNotIn(TOKEN, out.getvalue())
            owner_path.write_text('{"owners":[],"owners":[]}')
            out, err = io.StringIO(), io.StringIO()
            with patch.object(activity, "github_query") as query, redirect_stdout(out), redirect_stderr(err):
                self.assertEqual(activity.main(args), 1)
            self.assertFalse(query.called)
            self.assertEqual(out.getvalue(), "")

    def test_invalid_settings_are_rejected_before_queries(self):
        cases = [(owners("example", "EXAMPLE"), retained()), (owners("bad/owner"), retained()),
                 (owners(), retained("Example/One", "example/one")),
                 (owners(), {"repos": [{"repo": "example/one", "gone": "false"}]})]
        for owner_settings, repo_settings in cases:
            with self.subTest(settings=owner_settings), self.assertRaises(Exception):
                activity.collect(owner_settings, repo_settings, query_fn=lambda *_: self.fail("unexpected query"), clock=lambda: NOW)


if __name__ == "__main__":
    unittest.main()
