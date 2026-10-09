import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ZSTACK = Path(__file__).resolve().parent.parent / "bin/zstack"

FAKE_JEV = """#!/usr/bin/env python3
import json, sys
req = json.load(sys.stdin)
open(sys.argv[0] + ".last", "w").write(json.dumps(req))
print(json.dumps({
  "intent": {"type": "choice", "choice": "execute", "confidence": 0.9, "probabilities": {"execute": 0.9, "question": 0.1}},
  "tier": {"type": "choice", "choice": "%(tier)s", "confidence": 0.85, "probabilities": {"%(tier)s": 0.85, "pair": 0.15}},
  "risky": {"type": "noul", "noul": %(risky)s},
  "ambiguous": {"type": "noul", "noul": 0.1},
  "ui": {"type": "noul", "noul": 0.0}}))
"""


class ZstackTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.repo = self.home / "repo"
        self.repo.mkdir()
        self.env = {**os.environ, "ZSTACK_HOME": str(self.home)}
        self.env.pop("ZSTACK_RUN", None)
        self.env.pop("ZSTACK_AGENT", None)

    def tearDown(self):
        self.tmp.cleanup()

    def z(self, *args, ok=True, stdin=None):
        p = subprocess.run([sys.executable, str(ZSTACK), *args], capture_output=True, text=True,
                           env=self.env, input=stdin)
        if ok:
            self.assertEqual(p.returncode, 0, p.stderr)
        return p

    def init(self, *extra):
        return self.z("init", "--goal", "test goal", "--repo", str(self.repo), *extra).stdout.strip()

    def fake_jev(self, tier="squad", risky=0.1):
        path = self.home / "jev"
        path.write_text(FAKE_JEV % {"tier": tier, "risky": risky})
        path.chmod(0o755)
        self.env["ZSTACK_JEV"] = str(path)
        return path

    def test_agent_cap_never_exceeds_100(self):
        self.init("--max-agents", "500", "--max-parallel", "200")
        meta = json.loads(self.z("--json", "status").stdout)["run"]
        self.assertEqual(meta["max_agents"], 100)
        for _ in range(100):
            self.z("agent", "add", "--role", "worker", "--planned")
        p = self.z("agent", "add", "--role", "worker", "--planned", ok=False)
        self.assertEqual(p.returncode, 1)
        self.assertIn("agent cap reached: 100/100", p.stderr)

    def test_parallel_cap_blocks_extra_running_agents(self):
        self.init("--max-parallel", "2")
        self.z("agent", "add", "--role", "worker")
        self.z("agent", "add", "--role", "reviewer")
        p = self.z("agent", "add", "--role", "tester", ok=False)
        self.assertIn("parallel cap reached", p.stderr)
        self.z("agent", "add", "--role", "tester", "--planned")
        self.z("agent", "set", "worker-1", "--state", "done")
        self.z("agent", "set", "tester-1", "--state", "running")

    def test_peer_messages_reach_agent_role_and_broadcast(self):
        self.init()
        self.z("agent", "add", "--role", "worker")
        self.z("agent", "add", "--role", "reviewer")
        self.z("--as", "worker-1", "msg", "send", "--to", "reviewer-1", "--kind", "review-request", "--ref", "t1", "--body", "diff ready")
        self.z("msg", "send", "--to", "role:reviewer", "--kind", "steer", "--body", "focus on contracts")
        self.z("msg", "send", "--to", "all", "--kind", "steer", "--body", "freeze scope")
        got = json.loads(self.z("--as", "reviewer-1", "--json", "msg", "inbox").stdout)
        self.assertEqual([m["body"] for m in got], ["diff ready", "focus on contracts", "freeze scope"])
        again = json.loads(self.z("--as", "reviewer-1", "--json", "msg", "inbox").stdout)
        self.assertEqual(again, [])
        worker = json.loads(self.z("--as", "worker-1", "--json", "msg", "inbox").stdout)
        self.assertEqual([m["body"] for m in worker], ["freeze scope"])

    def test_msg_wait_returns_when_peer_writes(self):
        rid = self.init()
        self.z("agent", "add", "--role", "tester")
        waiter = subprocess.Popen([sys.executable, str(ZSTACK), "--run", rid, "--as", "tester-1", "--json",
                                   "msg", "wait", "--timeout", "20", "--interval", "0.2"],
                                  stdout=subprocess.PIPE, text=True, env=self.env)
        time.sleep(0.6)
        self.z("msg", "send", "--to", "tester-1", "--kind", "test-request", "--body", "run e2e")
        stdout, _ = waiter.communicate(timeout=20)
        self.assertEqual(waiter.returncode, 0)
        self.assertEqual(json.loads(stdout)[0]["kind"], "test-request")

    def test_msg_wait_times_out_with_exit_2(self):
        self.init()
        p = self.z("msg", "wait", "--timeout", "0.3", "--interval", "0.1", ok=False)
        self.assertEqual(p.returncode, 2)

    def test_unknown_recipient_rejected(self):
        self.init()
        p = self.z("msg", "send", "--to", "ghost-9", "--kind", "x", "--body", "y", ok=False)
        self.assertIn("unknown recipient", p.stderr)

    def test_task_deps_overlap_and_evidence_gate(self):
        self.init()
        self.z("task", "add", "--title", "api", "--paths", "internal/api")
        self.z("task", "add", "--title", "handler", "--paths", "internal/api/handler.go")
        self.z("task", "add", "--title", "docs", "--deps", "t1", "--paths", "docs")
        self.z("task", "claim", "t1", "--owner", "worker-1")
        p = self.z("task", "claim", "t2", "--owner", "worker-2", ok=False)
        self.assertIn("overlap", p.stderr)
        p = self.z("task", "claim", "t3", "--owner", "worker-3", ok=False)
        self.assertIn("unfinished dependencies", p.stderr)
        p = self.z("task", "set", "t1", "--state", "done", ok=False)
        self.assertIn("without evidence", p.stderr)
        self.z("task", "set", "t1", "--state", "done", "--evidence", "go test ./... ok")
        self.z("task", "claim", "t3", "--owner", "worker-3")
        ready = json.loads(self.z("--json", "task", "list", "--ready").stdout)
        self.assertEqual(list(ready), ["t2"])

    def test_review_rounds_warn_after_limit(self):
        self.init()
        self.z("task", "add", "--title", "x")
        self.z("task", "claim", "t1", "--owner", "worker-1")
        for _ in range(3):
            self.assertNotIn("escalate", self.z("task", "set", "t1", "--state", "review").stdout)
            self.z("task", "set", "t1", "--state", "doing")
        self.assertIn("escalate", self.z("task", "set", "t1", "--state", "review").stdout)

    def test_size_uses_jev_tier_and_logs_decision(self):
        self.init()
        jev = self.fake_jev(tier="team")
        facts = {"request": "split billing into 6 services", "units": 6, "repos": ["api"]}
        r = json.loads(self.z("size", stdin=json.dumps(facts)).stdout)
        self.assertEqual((r["intent"], r["tier"], r["flow"]), ("execute", "team", "plan-gate"))
        self.assertEqual(r["counts"]["worker"], 6)
        self.assertLessEqual(r["total"], 100)
        self.assertFalse(r["needs_more_evidence"])
        sent = json.loads(Path(str(jev) + ".last").read_text())
        self.assertEqual(set(sent["questions"]), {"intent", "tier", "risky", "ambiguous", "ui"})
        self.assertIn("| manager | size | execute/team/plan-gate", self.z("report").stdout)

    def test_size_swarm_fits_inside_budget(self):
        self.init()
        self.fake_jev(tier="swarm", risky=0.9)
        r = json.loads(self.z("size", stdin=json.dumps({"request": "audit 200 generators", "units": 200})).stdout)
        self.assertLessEqual(r["total"], 90)   # 100 minus reserve 10
        self.assertGreater(r["counts"]["worker"], 30)

    def test_size_user_override_caps_agents(self):
        self.init()
        self.fake_jev(tier="team")
        facts = {"request": "x", "units": 10, "override": {"agents": 5}}
        r = json.loads(self.z("size", stdin=json.dumps(facts)).stdout)
        self.assertEqual(r["total"], 5)
        self.assertGreaterEqual(r["counts"]["worker"], 1)
        self.assertGreaterEqual(r["counts"]["reviewer"], 1)

    def test_size_without_jev_takes_strict_path(self):
        self.init()
        self.env["ZSTACK_JEV"] = str(self.home / "missing-jev")
        r = json.loads(self.z("size", stdin=json.dumps({"request": "x", "units": 3})).stdout)
        self.assertTrue(r["jev"].startswith("unavailable"))
        self.assertTrue(r["needs_more_evidence"])
        self.assertEqual(r["flow"], "ask-user")

    def test_rules_are_injected_into_briefs(self):
        self.init()
        self.z("rule", "add", "never put code in cmd/", "--project", "--repo", str(self.repo))
        self.z("rule", "add", "no alpine images")
        self.z("task", "add", "--title", "build x", "--paths", "x/")
        self.z("agent", "add", "--role", "worker", "--harness", "codex", "--task", "t1")
        brief = self.z("brief", "worker-1").stdout
        for needle in ("never put code in cmd/", "no alpine images", "Never commit docs", "## Role", "owned paths: x/"):
            self.assertIn(needle, brief)
        self.z("rule", "forget", "alpine")
        self.assertNotIn("no alpine images", self.z("brief", "worker-1").stdout)

    def test_harness_override_uses_that_harness_default_model(self):
        self.init()
        a = json.loads(self.z("--json", "agent", "add", "--role", "verifier", "--harness", "codex").stdout)
        self.assertEqual(a["model"], "gpt-6-sol")
        b = json.loads(self.z("--json", "agent", "add", "--role", "verifier").stdout)
        self.assertEqual(b["model"], "opus")

    def test_spawn_dry_run_uses_readonly_template_for_reviewers(self):
        self.init()
        self.z("agent", "add", "--role", "reviewer", "--harness", "codex", "--model", "gpt-6-sol")
        self.z("agent", "add", "--role", "worker", "--harness", "omp", "--model", "deepseek")
        rev = json.loads(self.z("--json", "spawn", "reviewer-1", "--dry-run").stdout)
        cwd = rev["argv"][rev["argv"].index("-C") + 1]
        self.assertTrue(cwd.endswith(json.loads(self.z("--json", "status").stdout)["run"]["id"]))
        self.assertTrue(rev["stdin"])
        wk = json.loads(self.z("--json", "spawn", "worker-1", "--dry-run").stdout)
        self.assertEqual(wk["argv"][:2], ["omp", "-p"])
        self.assertTrue(any(a.startswith("@") and a.endswith("worker-1.md") for a in wk["argv"]))

    def test_headless_run_posts_done_to_manager(self):
        self.init()
        bindir = self.home / "bin"
        bindir.mkdir()
        fake = bindir / "pi"
        fake.write_text("#!/bin/sh\necho 'changed x.go; go test ./... ok'\n")
        fake.chmod(0o755)
        self.env["PATH"] = f"{bindir}:{self.env['PATH']}"
        self.z("agent", "add", "--role", "worker", "--harness", "pi", "--model", "m")
        self.z("spawn", "worker-1")
        for _ in range(50):
            msgs = json.loads(self.z("--json", "msg", "inbox", "--peek").stdout)
            if msgs:
                break
            time.sleep(0.1)
        self.assertEqual(msgs[0]["kind"], "done")
        self.assertIn("go test ./... ok", msgs[0]["body"])
        agents = json.loads(self.z("--json", "agent", "list").stdout)
        self.assertEqual(agents["worker-1"]["state"], "done")


if __name__ == "__main__":
    unittest.main()
