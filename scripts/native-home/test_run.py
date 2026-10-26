# Unit tests for the pure parts of run.py (no TV, no sdb, no network).
#
#   npm run native:test        (or: python3 scripts/native-home/test_run.py)
#
# Covers the things that decide whether an operation is allowed to run and
# whether its output counts as finished - the checks a mistake here would turn
# into a wrong write on the TV.
import unittest

import run


class HelperChoice(unittest.TestCase):
    def test_read_only_modes_use_the_query_assembly(self):
        for mode in ("inspect", "query"):
            self.assertEqual(run.helper_name(mode), "Arn0HomeQuery")

    def test_writing_modes_use_the_control_assembly(self):
        for mode in ("verify", "apply", "restore"):
            self.assertEqual(run.helper_name(mode), "Arn0HomeControl")

    def test_every_mode_has_three_files(self):
        for mode in run.MODES:
            names = run.helper_files(mode)
            self.assertEqual(len(names), 3)
            self.assertTrue(names[0].endswith(".dll"))
            self.assertTrue(names[0].startswith(run.helper_name(mode)))


class OutputCheck(unittest.TestCase):
    def test_query_success(self):
        ok, reason = run.check_output("query", "QUERY_BEGIN\nQUERY_END\nARN0_RUN_END\n")
        self.assertTrue(ok, reason)

    def test_query_abort_is_a_failure(self):
        ok, _ = run.check_output("query", "QUERY_ABORTED=bad\nARN0_RUN_END\n")
        self.assertFalse(ok)

    def test_control_success_tokens(self):
        cases = {
            "verify": "ARN0_BASELINE_MATCH={}\nARN0_RUN_END\n",
            "apply": "ARN0_APPLIED={}\nARN0_RUN_END\n",
            "restore": "ARN0_RESTORED={}\nARN0_RUN_END\n",
        }
        for mode, text in cases.items():
            ok, reason = run.check_output(mode, text)
            self.assertTrue(ok, mode + ": " + reason)

    def test_missing_end_marker_is_unknown_not_success(self):
        ok, reason = run.check_output("apply", "ARN0_APPLIED={}\n")
        self.assertFalse(ok)
        self.assertIn("unknown", reason)

    def test_control_abort_is_a_failure(self):
        ok, _ = run.check_output("apply", "ARN0_ABORTED=x\nARN0_RUN_END\n")
        self.assertFalse(ok)


def valid_baseline(**overrides):
    data = {
        "Home": "com.samsung.tv.csfs",
        "Strings": {
            "db/appfw/home_appid": "com.samsung.tv.csfs",
            "db/appfw/startup_appid": "com.samsung.tv.csfs",
            "db/appfw/booting_appid_backup": "com.samsung.tv.csfs",
            "db/first_screen/type": "com.samsung.tv.csfs",
        },
        "Autostart": 1,
    }
    data.update(overrides)
    return data


class BaselineGate(unittest.TestCase):
    def test_a_good_baseline_passes(self):
        self.assertEqual(run.baseline_problems(valid_baseline()), [])

    def test_autostart_zero_is_refused(self):
        problems = run.baseline_problems(valid_baseline(Autostart=0))
        self.assertTrue(any("Autostart is 0" in p for p in problems))

    def test_missing_key_is_refused(self):
        bad = valid_baseline()
        del bad["Strings"]["db/appfw/home_appid"]
        self.assertTrue(run.baseline_problems(bad))

    def test_bad_autostart_type_is_refused(self):
        self.assertTrue(run.baseline_problems(valid_baseline(Autostart=True)))

    def test_non_object_is_refused(self):
        self.assertTrue(run.baseline_problems([]))


class Config(unittest.TestCase):
    def test_env_beats_file(self):
        cfg = run.build_config({"ARN0_TV_IP": "10.0.0.7"}, {"host": "10.0.0.9"})
        self.assertEqual(cfg["host"], "10.0.0.7")

    def test_file_beats_default(self):
        cfg = run.build_config({}, {"host": "10.0.0.9"})
        self.assertEqual(cfg["host"], "10.0.0.9")

    def test_null_file_values_do_not_override_defaults(self):
        cfg = run.build_config({}, {"host": None})
        self.assertEqual(cfg["host"], "")

    def test_bad_host_is_reported(self):
        cfg = run.build_config({}, {"host": "not-an-ip"})
        self.assertTrue(run.config_problems(cfg))

    def test_good_host_passes(self):
        cfg = run.build_config({}, {"host": "10.0.0.9", "sdb": "/x/sdb"})
        self.assertEqual(run.config_problems(cfg), [])


class ModelGuard(unittest.TestCase):
    def test_exact_match(self):
        self.assertFalse(run.model_mismatch("QE65LS03BAUXXU", "QE65LS03BAUXXU"))

    def test_unknown_is_not_a_mismatch(self):
        self.assertFalse(run.model_mismatch("QE65LS03BAUXXU", "Unknown"))
        self.assertFalse(run.model_mismatch("QE65LS03BAUXXU", None))

    def test_clear_mismatch(self):
        self.assertTrue(run.model_mismatch("QE65LS03BAUXXU", "QE65Q70BATXXC"))


class Injection(unittest.TestCase):
    def test_argument_uses_the_reviewed_shape(self):
        arg = run.injection_argument("10.0.0.9", 40000, "/x/a.sh", "abc123")
        self.assertTrue(arg.startswith("0 appinstall tpk new2.tpk`printf${IFS}%s${IFS}"))
        self.assertIn("|base64${IFS}-d|bash`.tpk", arg)

    def test_representative_argument_fits_the_budget(self):
        arg = run.injection_argument("192.168.1.50", 55555, run.STAGE_DIR + "/arn0-" + "a" * 12 + ".sh", "a" * 12)
        self.assertLess(len(arg.encode()), run.MAX_ARGUMENT_BYTES)


if __name__ == "__main__":
    unittest.main(verbosity=2)
