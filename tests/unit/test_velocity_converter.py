"""Synthetic conversion tests. Contains no real repository or benchmark data."""
import copy
import hashlib
import json
import pathlib
import tempfile
import unittest

import importlib.util

_spec = importlib.util.spec_from_file_location("velocity_converter", pathlib.Path(__file__).resolve().parents[2] / "scripts" / "convert-velocity.py")
_converter = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_converter)
ConversionError = _converter.ConversionError
canonical_bytes = _converter.canonical_bytes
convert_baseline = _converter.convert_baseline
main = _converter.main
read_baseline = _converter.read_baseline


def empty_stats():
    return {"n": 0, "mean": None, "median": None, "p90": None, "max": None}


def one_stats(value):
    return {"n": 1, "mean": value, "median": value, "p90": value, "max": value}


def fixture():
    repo = "ExampleOrg/example-repo"
    counts = {
        "prs_created": 2, "prs_merged": 2, "merged_per_week": 4.6667, "open_prs_current": 1,
        "created_cohort_with_pr_ci": 1, "created_cohort_observed_green": 1,
        "created_cohort_no_observed_green": 0, "created_cohort_no_pr_ci": 1,
        "ci_revisions_to_green": one_stats(2), "first_pass_prs": 0, "first_pass_rate_percent": 0.0,
        "hours_open_to_green": one_stats(0.1667),
        "hours_open_to_merge": {"n": 2, "mean": 36.25, "median": 36.25, "p90": 48.5, "max": 48.5},
        "github_reruns_in_created_cohort": 1, "same_sha_fresh_executions_in_created_cohort": 0,
        "deployment_targets": 2, "deployment_targets_observed_success": 1, "deployment_records": 3,
        "production_cd": {"targets": 1, "observed_success": 1, "no_observed_success": 0,
                          "deployment_records": 2, "attempts_to_first_success_within_window": one_stats(2)},
        "preview_cd": {"targets": 1, "observed_success": 0, "no_observed_success": 1,
                       "deployment_records": 1, "attempts_to_first_success_within_window": empty_stats()},
        "other_cd": {"targets": 0, "observed_success": 0, "no_observed_success": 0,
                     "deployment_records": 0, "attempts_to_first_success_within_window": empty_stats()},
    }
    no_ci = {
        "repo": repo, "ci_state": "no_observed_pr_actions", "first_green_at": None,
        "revisions_to_first_green": None, "hours_open_to_first_green": None,
        "first_pass": None, "github_reruns_observed": 0, "same_sha_fresh_executions_observed": 0,
        "attempt_history_complete": True,
    }
    prs = [
        {**no_ci, "number": 1, "created_at": "2026-10-31T04:00:00Z",
         "merged_at": "2026-11-02T04:30:00Z", "closed_at": "2026-11-02T04:30:00Z",
         "current_state": "closed", "in_created_cohort": True, "merged_in_window": True,
         "hours_open_to_merge": 48.5, "ci_state": "observed_green", "revisions_to_first_green": 2,
         "first_green_at": "2026-10-31T04:10:00Z", "hours_open_to_first_green": 0.1667,
         "first_pass": False, "github_reruns_observed": 1, "reruns_before_first_green": 1,
         "fresh_repeats_before_first_green": 0},
        {**no_ci, "number": 2, "created_at": "2026-11-03T04:59:59Z",
         "merged_at": None, "closed_at": None, "current_state": "open",
         "in_created_cohort": True, "merged_in_window": False, "hours_open_to_merge": None},
        {**no_ci, "number": 3, "created_at": "2026-10-30T04:00:00Z",
         "merged_at": "2026-10-31T04:00:00Z", "closed_at": "2026-10-31T04:00:00Z",
         "current_state": "closed", "in_created_cohort": False, "merged_in_window": True,
         "hours_open_to_merge": 24.0},
    ]
    return {
        "metric_version": "observed-development-velocity-v1.0",
        "window": {"start": "2026-10-31T04:00:00Z", "end_exclusive": "2026-11-03T05:00:00Z",
                   "elapsed_hours": 73.0, "timezone": "America/New_York"},
        "recorded_at": "2026-11-03T06:00:00+00:00",
        "summary": {**copy.deepcopy(counts), "repository_count": 1, "owners": {"ExampleOrg": 1},
                    "archived_repositories": 0, "fork_repositories": 0,
                    "repositories_with_pr_activity": 1, "repositories_with_pr_ci_cohort": 1,
                    "repositories_with_deployment_records": 1},
        "collection_errors": [],
        "repositories": [{"repo": repo, "owner": "ExampleOrg", "archived": False, "fork": False,
                          "collected_complete": True, **copy.deepcopy(counts)}],
        "pull_requests": prs,
        "deployment_targets": [
            {"repo": repo, "sha": "a", "environment": "Production", "classification": "production",
             "deployment_records": 2, "first_submitted_at": "2026-11-01T04:00:00Z",
             "first_success_at": "2026-11-01T04:05:00Z", "attempts_to_first_success": 2, "history_complete": True},
            {"repo": repo, "sha": "b", "environment": "Preview", "classification": "preview",
             "deployment_records": 1, "first_submitted_at": "2026-11-03T04:59:00Z",
             "first_success_at": None, "attempts_to_first_success": None, "history_complete": True},
        ],
        "source_hashes": [{"file": "evidence/sample.json", "sha256": "a" * 64}],
    }


def empty_fixture():
    data = fixture()
    data["pull_requests"] = []
    data["deployment_targets"] = []
    zero = {
        "prs_created": 0, "prs_merged": 0, "merged_per_week": 0, "open_prs_current": 0,
        "created_cohort_with_pr_ci": 0, "created_cohort_observed_green": 0,
        "created_cohort_no_observed_green": 0, "created_cohort_no_pr_ci": 0,
        "ci_revisions_to_green": empty_stats(), "first_pass_prs": 0, "first_pass_rate_percent": None,
        "hours_open_to_green": empty_stats(), "hours_open_to_merge": empty_stats(),
        "github_reruns_in_created_cohort": 0, "same_sha_fresh_executions_in_created_cohort": 0,
        "deployment_targets": 0, "deployment_targets_observed_success": 0, "deployment_records": 0,
    }
    for kind in ("production", "preview", "other"):
        zero[kind + "_cd"] = {"targets": 0, "observed_success": 0, "no_observed_success": 0,
                             "deployment_records": 0, "attempts_to_first_success_within_window": empty_stats()}
    data["repositories"][0].update(copy.deepcopy(zero))
    data["summary"].update(copy.deepcopy(zero))
    for key in ("repositories_with_pr_activity", "repositories_with_pr_ci_cohort",
                "repositories_with_deployment_records"):
        data["summary"][key] = 0
    return data


def convert(data):
    raw = json.dumps(data, indent=2).encode()
    return convert_baseline(data, raw)


class ConverterTests(unittest.TestCase):
    def test_dst_window_daily_buckets_and_different_cohorts(self):
        result, receipt = convert(fixture())
        row = result["repositories"][0]
        self.assertEqual(result["window"]["days"], 3)
        self.assertEqual(row["prs"]["daily"], [
            {"date": "2026-10-31", "opened": 1, "merged": 1},
            {"date": "2026-11-01", "opened": 0, "merged": 1},
            {"date": "2026-11-02", "opened": 1, "merged": 0},
        ])
        self.assertEqual(row["prs"]["mergeHours"], [24.0, 48.5])
        self.assertEqual(row["ci"]["revisionSamples"], [2])
        self.assertEqual((row["ci"]["covered"], row["ci"]["noCI"]), (1, 1))
        self.assertEqual(row["cd"]["production"], {"targets": 1, "records": 2, "attempts": [2]})
        self.assertEqual(row["cd"]["preview"], {"targets": 1, "records": 1, "attempts": []})
        self.assertEqual(result["scope"]["owners"], ["exampleorg"])
        self.assertEqual(row["repo"], "exampleorg/example-repo")
        self.assertTrue(result["inventoryComplete"])
        self.assertEqual(receipt["exactAnchors"]["dailyMerged"], 2)

    def test_hashes_bind_exact_input_bytes_original_manifest_and_output(self):
        data = fixture()
        raw = json.dumps(data, indent=2).encode()
        result, receipt = convert_baseline(data, raw)
        expected_manifest = json.dumps(data["source_hashes"], sort_keys=True, separators=(",", ":")).encode()
        self.assertEqual(result["source"]["artifactSha256"], hashlib.sha256(raw).hexdigest())
        self.assertEqual(result["source"]["evidenceSha256"], hashlib.sha256(expected_manifest).hexdigest())
        self.assertEqual(receipt["outputSnapshotSha256"], hashlib.sha256(canonical_bytes(result) + b"\n").hexdigest())
        self.assertEqual(result["capturedAt"], data["recorded_at"])
        self.assertEqual(result["captureKind"], "observed")

    def test_unsupported_metric_version_is_rejected(self):
        data = fixture()
        data["metric_version"] = "unrelated-v9"
        with self.assertRaisesRegex(ConversionError, "Unsupported"):
            convert(data)

    def test_source_count_corruption_is_rejected_before_output_write(self):
        data = fixture()
        data["repositories"][0]["prs_created"] = 3
        with tempfile.TemporaryDirectory() as temp:
            base, output = pathlib.Path(temp) / "input.json", pathlib.Path(temp) / "output.json"
            base.write_text(json.dumps(data))
            self.assertEqual(main([str(base), str(output)]), 2)
            self.assertFalse(output.exists())

    def test_created_cohort_flag_must_match_timestamps(self):
        data = fixture()
        data["pull_requests"][0]["in_created_cohort"] = False
        with self.assertRaisesRegex(ConversionError, "created-cohort"):
            convert(data)

    def test_end_boundary_is_exclusive(self):
        data = fixture()
        data["pull_requests"][1]["created_at"] = data["window"]["end_exclusive"]
        with self.assertRaisesRegex(ConversionError, "created-cohort"):
            convert(data)

    def test_success_after_cutoff_is_rejected(self):
        data = fixture()
        data["pull_requests"][0]["first_green_at"] = data["window"]["end_exclusive"]
        with self.assertRaisesRegex(ConversionError, "green timestamp"):
            convert(data)

    def test_case_variant_duplicate_repository_is_rejected(self):
        data = fixture()
        duplicate = copy.deepcopy(data["repositories"][0])
        duplicate["repo"] = duplicate["repo"].upper()
        data["repositories"].append(duplicate)
        with self.assertRaisesRegex(ConversionError, "Duplicate repository"):
            convert(data)

    def test_deployment_attempts_cannot_exceed_source_records(self):
        data = fixture()
        data["deployment_targets"][0]["attempts_to_first_success"] = 3
        with self.assertRaisesRegex(ConversionError, "exceed records"):
            convert(data)

    def test_partial_attempt_history_stays_partial(self):
        data = fixture()
        data["repositories"][0]["collected_complete"] = False
        data["collection_errors"] = [{"repo": "ExampleOrg/example-repo", "collection": {},
                                      "history": [{"run": 123, "attempt": 1, "error": "unavailable"}],
                                      "complete": True}]
        result, _ = convert(data)
        self.assertFalse(result["inventoryComplete"])
        self.assertEqual(result["repositories"][0]["coverage"],
                         {"prs": "complete", "ci": "partial", "cd": "complete"})
        self.assertEqual(result["repositories"][0]["ci"]["revisionSamples"], [2])

    def test_failed_ci_collection_is_null_not_measured_zero(self):
        data = empty_fixture()
        data["repositories"][0]["collected_complete"] = False
        data["collection_errors"] = [{"repo": "ExampleOrg/example-repo",
                                      "collection": {"runs": "unavailable"}, "history": [], "complete": False}]
        result, _ = convert(data)
        row = result["repositories"][0]
        self.assertEqual(row["coverage"]["ci"], "unavailable")
        self.assertIsNone(row["ci"])
        self.assertIsNotNone(row["prs"])
        self.assertFalse(result["inventoryComplete"])

    def test_successful_empty_collection_retains_empty_samples(self):
        result, _ = convert(empty_fixture())
        row = result["repositories"][0]
        self.assertEqual(row["ci"]["revisionSamples"], [])
        self.assertEqual(len(row["prs"]["daily"]), 3)
        self.assertTrue(result["inventoryComplete"])

    def test_window_must_be_complete_local_days(self):
        data = fixture()
        data["window"]["start"] = "2026-10-31T05:00:00Z"
        with self.assertRaisesRegex(ConversionError, "complete local"):
            convert(data)

    def test_nonfinite_and_duplicate_json_keys_are_rejected(self):
        with self.assertRaises(ConversionError):
            read_baseline(b'{"x":NaN}')
        with self.assertRaises(ConversionError):
            read_baseline(b'{"x":1,"x":2}')

    def test_input_cannot_be_overwritten(self):
        with tempfile.TemporaryDirectory() as temp:
            source = pathlib.Path(temp) / "source.json"
            content = json.dumps(fixture())
            source.write_text(content)
            self.assertEqual(main([str(source), str(source)]), 2)
            self.assertEqual(source.read_text(), content)


if __name__ == "__main__":
    unittest.main()
