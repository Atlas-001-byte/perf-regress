"""perf-regress collect 的行为测试。"""

import json
import os
import sys
import tempfile
import unittest

from perf_regress.cli import main
from perf_regress.collect import summarize

PY = sys.executable


def sh_command(code: str) -> str:
    """构造跨平台的 shell 命令字符串。"""
    return f'"{PY}" -c "{code}"'


class CollectTestCase(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmpdir.cleanup)
        self.output = os.path.join(self.tmpdir.name, "result.json")

    def run_collect(self, *argv):
        return main(["collect", *argv])

    def read_output(self):
        with open(self.output, encoding="utf-8") as fh:
            return json.load(fh)

    def test_success_exit_0_and_schema(self):
        code = self.run_collect(
            "--command", sh_command("pass"),
            "--runs", "3",
            "--warmup", "1",
            "--timeout-ms", "5000",
            "--output", self.output,
        )
        self.assertEqual(code, 0)
        doc = self.read_output()
        self.assertEqual(
            list(doc.keys()),
            ["command", "runs", "warmup", "timeout_ms", "unit",
             "samples", "summary", "errors"],
        )
        self.assertEqual(doc["unit"], "ns")
        self.assertEqual(doc["runs"], 3)
        self.assertEqual(doc["warmup"], 1)
        self.assertEqual(doc["timeout_ms"], 5000)
        self.assertEqual(doc["errors"], [])
        self.assertEqual(len(doc["samples"]), 3)
        self.assertEqual(doc["summary"]["count"], 3)
        for i, sample in enumerate(doc["samples"]):
            self.assertEqual(sample["index"], i)
            self.assertTrue(sample["started_at"].endswith("Z"))
            self.assertIsInstance(sample["duration_ns"], int)
            self.assertGreater(sample["duration_ns"], 0)
            self.assertEqual(sample["exit_code"], 0)
        for key in ("min", "max", "mean", "median", "p95", "stddev"):
            self.assertIn(key, doc["summary"])

    def test_warmup_defaults_to_zero(self):
        code = self.run_collect(
            "--command", sh_command("pass"),
            "--runs", "1",
            "--output", self.output,
        )
        self.assertEqual(code, 0)
        self.assertEqual(self.read_output()["warmup"], 0)

    def test_measure_nonzero_exit_gives_exit_3(self):
        code = self.run_collect(
            "--command", sh_command("import sys; sys.exit(7)"),
            "--runs", "2",
            "--output", self.output,
        )
        self.assertEqual(code, 3)
        doc = self.read_output()
        self.assertEqual(doc["samples"], [])
        self.assertEqual(doc["summary"]["count"], 0)
        self.assertEqual(len(doc["errors"]), 2)
        for i, err in enumerate(doc["errors"]):
            self.assertEqual(err["stage"], "measure")
            self.assertEqual(err["index"], i)
            self.assertEqual(err["reason"], "nonzero_exit")
            self.assertEqual(err["exit_code"], 7)

    def test_measure_timeout_gives_exit_3(self):
        code = self.run_collect(
            "--command", sh_command("import time; time.sleep(5)"),
            "--runs", "1",
            "--timeout-ms", "200",
            "--output", self.output,
        )
        self.assertEqual(code, 3)
        doc = self.read_output()
        self.assertEqual(len(doc["errors"]), 1)
        err = doc["errors"][0]
        self.assertEqual(err["stage"], "measure")
        self.assertEqual(err["reason"], "timeout")
        self.assertIsNone(err["exit_code"])

    def test_warmup_error_recorded_but_exit_0(self):
        # 前两次（warmup）失败，之后成功
        marker = os.path.join(self.tmpdir.name, "marker")
        code_str = (
            "import os,sys; "
            f"m={marker!r}; "
            "n=int(open(m).read()) if os.path.exists(m) else 0; "
            "open(m,'w').write(str(n+1)); "
            "sys.exit(1 if n < 2 else 0)"
        )
        code = self.run_collect(
            "--command", sh_command(code_str),
            "--runs", "2",
            "--warmup", "2",
            "--output", self.output,
        )
        self.assertEqual(code, 0)
        doc = self.read_output()
        self.assertEqual(len(doc["samples"]), 2)
        self.assertEqual(len(doc["errors"]), 2)
        for i, err in enumerate(doc["errors"]):
            self.assertEqual(err["stage"], "warmup")
            self.assertEqual(err["index"], i)
            self.assertEqual(err["reason"], "nonzero_exit")

    def test_invalid_args_exit_2_and_no_output(self):
        cases = [
            ["--command", "true", "--runs", "0", "--output", self.output],
            ["--command", "true", "--runs", "1", "--warmup", "-1",
             "--output", self.output],
            ["--command", "true", "--runs", "1", "--timeout-ms", "0",
             "--output", self.output],
            ["--command", "", "--runs", "1", "--output", self.output],
            ["--command", "true", "--runs", "1", "--output", ""],
            ["--command", "true", "--runs", "abc", "--output", self.output],
        ]
        for argv in cases:
            with self.subTest(argv=argv):
                if os.path.exists(self.output):
                    os.remove(self.output)
                try:
                    code = self.run_collect(*argv)
                except SystemExit as exc:  # argparse 解析失败
                    code = exc.code
                self.assertEqual(code, 2)
                self.assertFalse(os.path.exists(self.output))

    def test_spawn_failure_exit_2_and_no_output(self):
        # 通过不可执行的 shell 包装触发 OSError 比较困难，
        # 这里直接验证 collect 对无法启动情形的处理。
        from unittest import mock
        from perf_regress import collect as collect_mod

        with mock.patch.object(
            collect_mod.subprocess, "run", side_effect=OSError("no exec")
        ):
            code = collect_mod.collect("whatever", 1, 0, 1000, self.output)
        self.assertEqual(code, 2)
        self.assertFalse(os.path.exists(self.output))

    def test_write_failure_exit_4(self):
        missing_dir = os.path.join(self.tmpdir.name, "no-such-dir", "out.json")
        code = self.run_collect(
            "--command", sh_command("pass"),
            "--runs", "1",
            "--output", missing_dir,
        )
        self.assertEqual(code, 4)


class SummarizeTestCase(unittest.TestCase):
    @staticmethod
    def samples(durations):
        return [
            {"index": i, "started_at": "2026-01-01T00:00:00Z",
             "duration_ns": d, "exit_code": 0}
            for i, d in enumerate(durations)
        ]

    def test_empty(self):
        summary = summarize([])
        self.assertEqual(summary["count"], 0)
        for key in ("min", "max", "mean", "median", "p95", "stddev"):
            self.assertIsNone(summary[key])

    def test_odd_count(self):
        summary = summarize(self.samples([30, 10, 20]))
        self.assertEqual(summary["count"], 3)
        self.assertEqual(summary["min"], 10)
        self.assertEqual(summary["max"], 30)
        self.assertEqual(summary["mean"], 20)
        self.assertEqual(summary["median"], 20)
        # ceil(0.95 * 3) = 3 → 排序后第 3 项
        self.assertEqual(summary["p95"], 30)
        self.assertAlmostEqual(summary["stddev"], 8.164966, places=6)

    def test_even_count_median_average(self):
        summary = summarize(self.samples([10, 20, 31, 40]))
        # 中间两值 (20 + 31) / 2
        self.assertEqual(summary["median"], 25.5)
        self.assertEqual(summary["mean"], 25.25)
        # ceil(0.95 * 4) = 4 → 排序后第 4 项
        self.assertEqual(summary["p95"], 40)

    def test_population_stddev(self):
        summary = summarize(self.samples([2, 4, 4, 4, 5, 5, 7, 9]))
        self.assertEqual(summary["stddev"], 2.0)

    def test_p95_index_rule(self):
        durations = list(range(1, 21))  # 1..20
        summary = summarize(self.samples(durations))
        # ceil(0.95 * 20) = 19 → 排序后第 19 项
        self.assertEqual(summary["p95"], 19)


if __name__ == "__main__":
    unittest.main()
