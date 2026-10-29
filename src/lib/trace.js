// Trace core: turns a flat list of Jira issues into a traceability graph and an
// audit-readiness report. This file is pure (no Forge calls) so it can be unit
// tested with plain Node and reused by the UI, the Rovo actions and the DHF export.
//
// Conventions (kept deliberately simple so any Jira project can adopt them):
//   - label `trace-req`  -> a requirement (software requirement / user need)
//   - label `trace-risk` -> a hazard / risk (ISO 14971); severity via `severity-high|medium|low`
//   - label `trace-test` -> a verification test; Done = passed, label `test-failed` = failed
//   - any Jira issue link between two of those issues is a trace link.

export const LABELS = { req: 'trace-req', risk: 'trace-risk', test: 'trace-test', failed: 'test-failed' };

// Gap rules. Each one maps to an expectation an auditor (IEC 62304 / ISO 14971 / FDA design
// controls) actually checks. `weight` drives the readiness score; `fix` is the task we propose.
export const RULES = {
  REQ_NO_TEST: { title: 'Requirement has no verification test', severity: 'high', weight: 3, fix: 'Write and link a verification test' },
  REQ_TEST_FAILING: { title: 'Linked test is failing', severity: 'high', weight: 3, fix: 'Fix the defect and re-run the test' },
  REQ_UNVERIFIED: { title: 'Linked tests have not passed yet', severity: 'medium', weight: 2, fix: 'Execute the linked tests' },
  REQ_STALE: { title: 'Requirement changed after it was verified', severity: 'high', weight: 3, fix: 'Re-verify: re-run the linked tests against the new wording' },
  RISK_NO_CONTROL: { title: 'Risk has no control measure (requirement)', severity: 'high', weight: 3, fix: 'Define a risk control requirement and link it' },
  RISK_CONTROL_UNVERIFIED: { title: 'Risk control is not verified', severity: 'medium', weight: 2, fix: 'Verify the requirements that control this risk' },
  TEST_ORPHAN: { title: 'Test is not linked to any requirement', severity: 'low', weight: 1, fix: 'Link the test to the requirement it verifies' },
};

const has = (issue, label) => (issue.fields?.labels || []).includes(label);
const kindOf = (issue) => (has(issue, LABELS.req) ? 'req' : has(issue, LABELS.risk) ? 'risk' : has(issue, LABELS.test) ? 'test' : null);
const isDone = (issue) => issue.fields?.status?.statusCategory?.key === 'done';
const severityOf = (issue) => ((issue.fields?.labels || []).find((l) => l.startsWith('severity-')) || 'severity-medium').slice(9);

// Last time the requirement's *content* (summary/description) changed, from the changelog.
// Link changes or comments must not count as a change of the requirement itself.
function contentChangedAt(issue) {
  let last = 0;
  for (const h of issue.changelog?.histories || []) {
    if ((h.items || []).some((it) => it.field === 'summary' || it.field === 'description')) {
      last = Math.max(last, Date.parse(h.created));
    }
  }
  return last;
}

// When a test passed: its resolution date (falls back to last update).
const passedAt = (test) => Date.parse(test.fields?.resolutiondate || test.fields?.updated || 0) || 0;

// Build nodes + adjacency from issues (only issues carrying a trace label are nodes).
export function buildGraph(issues) {
  const nodes = new Map();
  for (const issue of issues) {
    const kind = kindOf(issue);
    if (!kind) continue;
    nodes.set(issue.key, {
      key: issue.key,
      kind,
      summary: issue.fields?.summary || '',
      status: issue.fields?.status?.name || '',
      done: isDone(issue),
      failed: has(issue, LABELS.failed),
      severity: kind === 'risk' ? severityOf(issue) : null,
      changedAt: kind === 'req' ? contentChangedAt(issue) : 0,
      passedAt: kind === 'test' && isDone(issue) ? passedAt(issue) : 0,
      links: new Set(),
    });
  }
  // Issue links are reported on both ends; a Set dedupes them.
  for (const issue of issues) {
    const a = nodes.get(issue.key);
    if (!a) continue;
    for (const l of issue.fields?.issuelinks || []) {
      const other = (l.outwardIssue || l.inwardIssue)?.key;
      const b = other && nodes.get(other);
      if (b) { a.links.add(b.key); b.links.add(a.key); }
    }
  }
  return nodes;
}

const linked = (nodes, node, kind) => [...node.links].map((k) => nodes.get(k)).filter((n) => n && n.kind === kind);

// Verification state of one requirement: verified | failing | stale | unverified | untested
export function reqState(nodes, req) {
  const tests = linked(nodes, req, 'test');
  if (!tests.length) return 'untested';
  if (tests.some((t) => t.failed)) return 'failing';
  if (!tests.every((t) => t.done)) return 'unverified';
  const lastPass = Math.min(...tests.map((t) => t.passedAt));
  if (req.changedAt && req.changedAt > lastPass) return 'stale';
  return 'verified';
}

// The full report: matrix rows, gaps, score. `issues` are raw Jira issues (fields + changelog).
export function analyze(issues) {
  const nodes = buildGraph(issues);
  const all = [...nodes.values()];
  const reqs = all.filter((n) => n.kind === 'req');
  const risks = all.filter((n) => n.kind === 'risk');
  const tests = all.filter((n) => n.kind === 'test');
  const gaps = [];
  const gap = (rule, node, detail) => gaps.push({ rule, key: node.key, summary: node.summary, detail, ...RULES[rule] });

  const matrix = reqs.map((r) => {
    const state = reqState(nodes, r);
    const rTests = linked(nodes, r, 'test');
    if (state === 'untested') gap('REQ_NO_TEST', r, 'No test is linked to this requirement.');
    if (state === 'failing') gap('REQ_TEST_FAILING', r, `Failing: ${rTests.filter((t) => t.failed).map((t) => t.key).join(', ')}`);
    if (state === 'unverified') gap('REQ_UNVERIFIED', r, `Not passed yet: ${rTests.filter((t) => !t.done).map((t) => t.key).join(', ')}`);
    if (state === 'stale') gap('REQ_STALE', r, `Wording changed ${new Date(r.changedAt).toISOString().slice(0, 10)}, after tests passed.`);
    return {
      key: r.key,
      summary: r.summary,
      state,
      risks: linked(nodes, r, 'risk').map((x) => ({ key: x.key, severity: x.severity })),
      tests: rTests.map((t) => ({ key: t.key, done: t.done, failed: t.failed })),
    };
  });

  for (const risk of risks) {
    const controls = linked(nodes, risk, 'req');
    if (!controls.length) gap('RISK_NO_CONTROL', risk, `${risk.severity} severity risk with no control requirement.`);
    else if (controls.some((c) => reqState(nodes, c) !== 'verified')) {
      gap('RISK_CONTROL_UNVERIFIED', risk, `Controls not verified: ${controls.filter((c) => reqState(nodes, c) !== 'verified').map((c) => c.key).join(', ')}`);
    }
  }
  for (const t of tests) if (!linked(nodes, t, 'req').length) gap('TEST_ORPHAN', t, 'Not linked to any requirement.');

  // High-severity risks escalate their gaps: an uncontrolled high hazard blocks a release.
  for (const g of gaps) {
    const n = nodes.get(g.key);
    if (n.kind === 'risk' && n.severity === 'high') { g.severity = 'high'; g.weight += 2; }
  }
  const order = { high: 0, medium: 1, low: 2 };
  gaps.sort((a, b) => order[a.severity] - order[b.severity] || a.key.localeCompare(b.key, undefined, { numeric: true }));

  // Readiness: share of "checks" that pass, weighted. Each requirement and risk is one check
  // worth its rule weight; each gap removes its weight.
  const possible = reqs.length * 3 + risks.length * 3 + tests.length * 1;
  const lost = gaps.reduce((s, g) => s + g.weight, 0);
  const score = possible ? Math.max(0, Math.round(100 * (1 - lost / possible))) : 0;
  const verified = matrix.filter((m) => m.state === 'verified').length;
  const blockers = gaps.filter((g) => g.severity === 'high').length;

  return {
    score,
    ready: possible > 0 && blockers === 0 && score >= 90,
    counts: { requirements: reqs.length, risks: risks.length, tests: tests.length, verified, gaps: gaps.length, blockers },
    coverage: reqs.length ? Math.round((100 * matrix.filter((m) => m.tests.length).length) / reqs.length) : 0,
    matrix,
    risks: risks.map((r) => ({ key: r.key, summary: r.summary, severity: r.severity, controls: linked(nodes, r, 'req').map((c) => ({ key: c.key, state: reqState(nodes, c) })) })),
    gaps,
  };
}

// What depends on one issue (impact analysis for "what breaks if we change REQ-4?").
export function traceOf(issues, key) {
  const nodes = buildGraph(issues);
  const n = nodes.get(key);
  if (!n) return null;
  const out = { key, kind: n.kind, summary: n.summary, status: n.status };
  if (n.kind === 'req') {
    out.state = reqState(nodes, n);
    out.risks = linked(nodes, n, 'risk').map((r) => ({ key: r.key, summary: r.summary, severity: r.severity }));
    out.tests = linked(nodes, n, 'test').map((t) => ({ key: t.key, summary: t.summary, status: t.failed ? 'failed' : t.done ? 'passed' : 'not run' }));
  } else if (n.kind === 'risk') {
    out.severity = n.severity;
    out.controls = linked(nodes, n, 'req').map((r) => ({ key: r.key, summary: r.summary, state: reqState(nodes, r) }));
  } else {
    out.status = n.failed ? 'failed' : n.done ? 'passed' : 'not run';
    out.verifies = linked(nodes, n, 'req').map((r) => ({ key: r.key, summary: r.summary }));
  }
  return out;
}

// Short plain-text summary that a Rovo agent can reason over without huge payloads.
export function summarize(report, projectKey) {
  const c = report.counts;
  const lines = [
    `Project ${projectKey}: audit readiness ${report.score}% (${report.ready ? 'READY' : 'NOT READY'}).`,
    `${c.requirements} requirements (${c.verified} verified, ${report.coverage}% have tests), ${c.risks} risks, ${c.tests} tests.`,
    `${c.gaps} gaps, ${c.blockers} blocking:`,
    ...report.gaps.map((g) => `- [${g.severity.toUpperCase()}] ${g.key} "${g.summary}": ${g.title}. ${g.detail} Fix: ${g.fix}.`),
  ];
  return lines.join('\n');
}
