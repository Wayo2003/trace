// Unit tests for the pure traceability engine (no Forge needed): node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, traceOf, summarize } from '../src/lib/trace.js';

const T0 = '2026-11-01T10:00:00.000+0000';
const T1 = '2026-11-02T10:00:00.000+0000';
const issue = (key, labels, links = [], { done = false, resolved, changed } = {}) => ({
  key,
  fields: {
    summary: `${key} summary`, labels,
    status: { name: done ? 'Done' : 'To Do', statusCategory: { key: done ? 'done' : 'new' } },
    resolutiondate: resolved || null, updated: resolved || T0,
    issuelinks: links.map((k) => ({ outwardIssue: { key: k } })),
  },
  changelog: { histories: changed ? [{ created: changed, items: [{ field: 'summary' }] }] : [] },
});

const issues = [
  issue('M-1', ['trace-req'], [], { changed: T1 }),                 // stale: changed after test passed
  issue('M-2', ['trace-req']),                                        // untested
  issue('M-3', ['trace-req']),                                        // failing
  issue('M-4', ['trace-req']),                                        // verified
  issue('M-10', ['trace-risk', 'severity-high'], ['M-1']),           // control stale -> unverified control
  issue('M-11', ['trace-risk', 'severity-high']),                    // uncontrolled
  issue('M-12', ['trace-risk', 'severity-low'], ['M-4']),            // fine
  issue('M-20', ['trace-test'], ['M-1'], { done: true, resolved: T0 }),
  issue('M-21', ['trace-test', 'test-failed'], ['M-3']),
  issue('M-22', ['trace-test'], ['M-4'], { done: true, resolved: T0 }),
  issue('M-23', ['trace-test'], [], { done: true, resolved: T0 }),   // orphan
  issue('M-99', ['unrelated'], ['M-4']),                              // ignored
];

test('classifies every requirement state', () => {
  const r = analyze(issues);
  const s = Object.fromEntries(r.matrix.map((m) => [m.key, m.state]));
  assert.deepEqual(s, { 'M-1': 'stale', 'M-2': 'untested', 'M-3': 'failing', 'M-4': 'verified' });
});

test('finds risk and test gaps, blocks release', () => {
  const r = analyze(issues);
  const rules = r.gaps.map((g) => `${g.rule}:${g.key}`).sort();
  assert.deepEqual(rules, ['REQ_NO_TEST:M-2', 'REQ_STALE:M-1', 'REQ_TEST_FAILING:M-3', 'RISK_CONTROL_UNVERIFIED:M-10', 'RISK_NO_CONTROL:M-11', 'TEST_ORPHAN:M-23'].sort());
  assert.equal(r.ready, false);
  assert.equal(r.counts.verified, 1);
  assert.ok(r.score > 0 && r.score < 100);
  assert.equal(r.gaps[0].severity, 'high');
});

test('a clean project is ready at 100%', () => {
  const r = analyze([issue('A-1', ['trace-req']), issue('A-2', ['trace-test'], ['A-1'], { done: true, resolved: T0 }), issue('A-3', ['trace-risk', 'severity-high'], ['A-1'])]);
  assert.equal(r.score, 100);
  assert.equal(r.ready, true);
});

test('impact analysis and summary', () => {
  const t = traceOf(issues, 'M-1');
  assert.equal(t.state, 'stale');
  assert.deepEqual(t.risks.map((x) => x.key), ['M-10']);
  assert.match(summarize(analyze(issues), 'M'), /NOT READY/);
  assert.equal(traceOf(issues, 'M-99'), null);
});
