// Everything that talks to Jira / Confluence REST APIs lives here.
// We call the APIs "as the user" (asUser) so Jira's own permission checks apply:
// Trace can never show or change anything the current user could not see or change.

import api, { route } from '@forge/api';
import { LABELS, RULES, analyze } from './trace.js';

const jira = () => api.asUser();

async function json(res, what) {
  const text = await res.text();
  if (!res.ok) throw new Error(`${what} failed (${res.status}): ${text.slice(0, 300)}`);
  // Some endpoints (e.g. create issue link) answer 201 with an empty body.
  return text ? JSON.parse(text) : null;
}

// Atlassian Document Format paragraph(s) from plain text, for descriptions/comments.
export const adf = (text) => ({
  type: 'doc',
  version: 1,
  content: String(text).split('\n').map((line) => ({ type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [] })),
});

// ---------------------------------------------------------------- reading

// All trace issues of a project, with links and content changelog (for staleness).
export async function fetchTraceIssues(projectKey) {
  const jql = `project = "${projectKey}" AND labels in (${LABELS.req}, ${LABELS.risk}, ${LABELS.test}) ORDER BY key ASC`;
  const issues = [];
  let nextPageToken;
  do {
    const body = { jql, maxResults: 100, fields: ['summary', 'status', 'labels', 'issuelinks', 'resolutiondate', 'updated'], expand: 'changelog' };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const res = await jira().requestJira(route`/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const page = await json(res, 'Jira search');
    issues.push(...(page.issues || []));
    nextPageToken = page.nextPageToken;
  } while (nextPageToken && issues.length < 2000);
  return issues;
}

export async function report(projectKey) {
  return analyze(await fetchTraceIssues(projectKey));
}

export async function projectKeyOfIssue(issueKey) {
  const res = await jira().requestJira(route`/rest/api/3/issue/${issueKey}?fields=project`, { headers: { Accept: 'application/json' } });
  return (await json(res, 'Read issue')).fields.project.key;
}

// ---------------------------------------------------------------- helpers for writing

async function project(projectKey) {
  const res = await jira().requestJira(route`/rest/api/3/project/${projectKey}`, { headers: { Accept: 'application/json' } });
  return json(res, 'Read project');
}

// A plain issue type available in the project: prefer Task, then Story, then any non-subtask.
async function taskTypeId(projectKey) {
  const p = await project(projectKey);
  const types = (p.issueTypes || []).filter((t) => !t.subtask);
  const pick = types.find((t) => t.name === 'Task') || types.find((t) => t.name === 'Story') || types[0];
  if (!pick) throw new Error(`No usable issue type in project ${projectKey}`);
  return { projectId: p.id, issueTypeId: pick.id };
}

// "Relates" exists on every Jira site by default; fall back to the first link type.
async function linkTypeName() {
  const res = await jira().requestJira(route`/rest/api/3/issueLinkType`, { headers: { Accept: 'application/json' } });
  const types = (await json(res, 'Read link types')).issueLinkTypes || [];
  return (types.find((t) => t.name === 'Relates') || types[0])?.name;
}

async function link(type, a, b) {
  const res = await jira().requestJira(route`/rest/api/3/issueLink`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: { name: type }, inwardIssue: { key: a }, outwardIssue: { key: b } }),
  });
  await json(res, `Link ${a}-${b}`);
}

// Move an issue to the first transition that lands in the "Done" status category.
async function transitionToDone(key) {
  const res = await jira().requestJira(route`/rest/api/3/issue/${key}/transitions`, { headers: { Accept: 'application/json' } });
  const t = ((await json(res, 'Read transitions')).transitions || []).find((x) => x.to?.statusCategory?.key === 'done');
  if (!t) return false;
  const r2 = await jira().requestJira(route`/rest/api/3/issue/${key}/transitions`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ transition: { id: t.id } }),
  });
  await json(r2, `Transition ${key}`);
  return true;
}

async function createIssues(projectKey, items) {
  const { projectId, issueTypeId } = await taskTypeId(projectKey);
  const keys = [];
  // The bulk endpoint accepts up to 50 issues per call.
  for (let i = 0; i < items.length; i += 50) {
    const issueUpdates = items.slice(i, i + 50).map((it) => ({
      fields: { project: { id: projectId }, issuetype: { id: issueTypeId }, summary: it.summary, labels: it.labels, description: adf(it.description || it.summary) },
    }));
    const res = await jira().requestJira(route`/rest/api/3/issue/bulk`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ issueUpdates }),
    });
    const out = await json(res, 'Create issues');
    if (out.errors?.length) throw new Error(`Create issues: ${JSON.stringify(out.errors[0]).slice(0, 300)}`);
    keys.push(...out.issues.map((x) => x.key));
  }
  return keys;
}

// ---------------------------------------------------------------- demo data

// A realistic medical-device software project: "GlucoFlow", an insulin pump companion app
// (IEC 62304 software safety class C). It is seeded with a few deliberate gaps so judges
// and new users see Trace catch exactly what an auditor would.
const DEMO = {
  reqs: [
    ['REQ-01 Bolus dose shall never exceed the configured maximum bolus', 'Hard limit enforced on the device and in the app before any dose is sent.'],
    ['REQ-02 App shall alert the user within 5 s when glucose < 70 mg/dL', 'Audible + visual alert, repeated every 60 s until acknowledged.'],
    ['REQ-03 Dose commands shall be confirmed by the user before delivery', 'Two-step confirmation with the dose amount shown in large type.'],
    ['REQ-04 Bluetooth link loss shall be detected within 10 s', 'On loss, the app shows a persistent banner and blocks new dose commands.'],
    ['REQ-05 Insulin-on-board shall be included in every bolus suggestion', 'Bolus calculator subtracts active insulin using the configured action time.'],
    ['REQ-06 All dose events shall be written to a tamper-evident log', 'Hash-chained log, exportable for clinicians.'],
    ['REQ-07 Glucose units shall follow the user locale (mg/dL or mmol/L)', 'Unit is shown next to every value; conversions use 18.0182.'],
    ['REQ-08 App shall lock after 2 minutes of inactivity', 'Biometric or PIN unlock required.'],
    ['REQ-09 Sensor readings older than 15 min shall be marked stale', 'Stale values are greyed out and excluded from bolus suggestions.'],
    ['REQ-10 Battery below 10% shall trigger a pump battery warning', 'Warning repeats at 5%.'],
  ],
  risks: [
    ['HAZ-01 Insulin overdose leading to severe hypoglycaemia', 'high'],
    ['HAZ-02 Missed hypoglycaemia alert', 'high'],
    ['HAZ-03 Dose delivered without user intent', 'high'],
    ['HAZ-04 Decision made on outdated glucose data', 'medium'],
    ['HAZ-05 Misreading glucose units', 'medium'],
    ['HAZ-06 Unauthorised person changes therapy settings', 'high'],
  ],
  tests: [
    ['TC-01 Bolus above max limit is rejected', [0], 'pass'],
    ['TC-02 Low glucose alert fires within 5 s', [1], 'pass'],
    ['TC-03 Dose confirmation dialog shows amount', [2], 'pass'],
    ['TC-04 BLE disconnect detected within 10 s', [3], 'fail'],
    ['TC-05 IOB subtracted from bolus suggestion', [4], 'pass'],
    ['TC-06 Dose log hash chain verifies', [5], 'todo'],
    ['TC-07 Unit display follows locale', [6], 'pass'],
    ['TC-08 Stale sensor value is excluded', [8], 'pass'],
    ['TC-09 Legacy export button works', [], 'pass'],
  ],
  // risk index -> requirement indexes that control it
  controls: [[0, [0, 4]], [1, [1]], [2, [2]], [3, [8, 3]], [4, [6]]], // HAZ-06 deliberately uncontrolled
  staleReq: 0, // REQ-01 wording changes after TC-01 passed
};

const STALE_SUMMARY = 'REQ-01 Bolus dose shall never exceed the configured maximum bolus or 25 U, whichever is lower';
const codeOf = (summary) => String(summary).split(' ')[0]; // "REQ-01", "HAZ-03", "TC-07"

// Run `fn` over `items` with at most `size` requests in flight (fast, but polite to rate limits).
async function pool(items, size, fn) {
  const out = [];
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

// Current fields of a known set of issues, read directly (not via search, which is eventually
// consistent and may not see issues created a moment ago).
const readIssues = (keys, fields) => pool(keys, 6, async (k) => {
  const res = await jira().requestJira(route`/rest/api/3/issue/${k}?fields=${fields}`, { headers: { Accept: 'application/json' } });
  return json(res, `Read ${k}`);
});

// Demo seeding runs in three short phases, each a separate call from the UI, because a Forge
// function invocation must finish within 25 seconds. Every phase is idempotent, so a retry or a
// double click never creates duplicates.
//   'issues' -> creates missing demo issues, returns { keys: { "REQ-01": "MED-1", ... } }
//   'links'  -> creates the missing trace links between them
//   'finish' -> passes the tests that passed, then edits REQ-01 after its test passed (stale)
export async function seedDemo(projectKey, phase = 'issues', keys) {
  if (phase === 'issues') {
    const existing = await fetchTraceIssues(projectKey);
    const demoCodes = new Set([...DEMO.reqs, ...DEMO.risks, ...DEMO.tests].map(([s]) => codeOf(s)));
    if (existing.some((i) => !demoCodes.has(codeOf(i.fields.summary)))) {
      return { done: true, created: 0, message: `Project ${projectKey} already has its own trace issues; demo data was not added. Use an empty project for the demo.` };
    }
    const keyOf = Object.fromEntries(existing.map((i) => [codeOf(i.fields.summary), i.key]));
    const missing = [
      ...DEMO.reqs.map(([s, d]) => ({ summary: s, description: d, labels: [LABELS.req] })),
      ...DEMO.risks.map(([s, sev]) => ({ summary: s, description: `Hazard analysed per ISO 14971. Severity: ${sev}.`, labels: [LABELS.risk, `severity-${sev}`] })),
      ...DEMO.tests.map(([s, , r]) => ({ summary: s, description: 'Verification test (IEC 62304 §5.7).', labels: r === 'fail' ? [LABELS.test, LABELS.failed] : [LABELS.test] })),
    ].filter((it) => !keyOf[codeOf(it.summary)]);
    const newKeys = missing.length ? await createIssues(projectKey, missing) : [];
    missing.forEach((it, n) => { keyOf[codeOf(it.summary)] = newKeys[n]; });
    return { done: false, created: newKeys.length, keys: keyOf };
  }

  const k = (row) => keys[codeOf(row[0])];
  if (!keys || Object.keys(keys).length < DEMO.reqs.length + DEMO.risks.length + DEMO.tests.length) throw new Error('Demo issues are missing; run the issues phase first.');

  if (phase === 'links') {
    const issues = await readIssues(Object.values(keys), 'issuelinks');
    const linked = new Set();
    for (const i of issues) for (const l of i.fields.issuelinks || []) {
      const other = (l.outwardIssue || l.inwardIssue)?.key;
      if (other) { linked.add(`${i.key}|${other}`); linked.add(`${other}|${i.key}`); }
    }
    const pairs = [
      ...DEMO.controls.flatMap(([ri, qs]) => qs.map((q) => [k(DEMO.risks[ri]), k(DEMO.reqs[q])])),
      ...DEMO.tests.flatMap((t, ti) => t[1].map((q) => [k(DEMO.tests[ti]), k(DEMO.reqs[q])])),
    ].filter(([a, b]) => !linked.has(`${a}|${b}`));
    const type = await linkTypeName();
    await pool(pairs, 5, ([a, b]) => link(type, a, b));
    return { done: false, links: pairs.length };
  }

  // phase 'finish'
  const passKeys = DEMO.tests.filter((t) => t[2] === 'pass').map((t) => k(t));
  const tests = await readIssues(passKeys, 'status');
  const todo = tests.filter((i) => i.fields.status?.statusCategory?.key !== 'done').map((i) => i.key);
  await pool(todo, 5, transitionToDone);
  const staleKey = k(DEMO.reqs[DEMO.staleReq]);
  const [req] = await readIssues([staleKey], 'summary');
  if (req.fields.summary !== STALE_SUMMARY) {
    await jira().requestJira(route`/rest/api/3/issue/${staleKey}`, {
      method: 'PUT',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { summary: STALE_SUMMARY } }),
    }).then((r) => json(r, `Update ${staleKey}`));
  }
  return { done: true, message: `GlucoFlow demo ready in ${projectKey}: 10 requirements, 6 risks and 9 tests with realistic audit gaps.` };
}

// ---------------------------------------------------------------- fixing gaps

// Open fix tasks already linked to an issue, so we never create duplicates.
async function openFixTasks(issueKey) {
  const jql = `labels = trace-fix AND statusCategory != Done AND issue in linkedIssues("${issueKey}")`;
  const res = await jira().requestJira(route`/rest/api/3/search/jql`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jql, maxResults: 20, fields: ['summary'] }),
  });
  return ((await json(res, 'Search fix tasks')).issues || []).map((i) => i.fields.summary);
}

// Create one Jira task per gap (optionally only for some issue keys), linked to the gap's issue.
export async function createFixTasks(projectKey, onlyKeys) {
  const r = await report(projectKey);
  const gaps = r.gaps.filter((g) => !onlyKeys?.length || onlyKeys.includes(g.key));
  const type = await linkTypeName();
  const created = [];
  const skipped = [];
  const todo = [];
  // Duplicate check for all gaps in parallel (each is one JQL search).
  const existing = await pool(gaps, 6, (g) => openFixTasks(g.key));
  gaps.forEach((g, i) => {
    const summary = `[Trace] ${g.fix}: ${g.key}`;
    if (existing[i].includes(summary)) skipped.push(g.key);
    else todo.push({ g, summary });
  });
  if (todo.length) {
    const keys = await createIssues(projectKey, todo.map(({ g, summary }) => ({
      summary,
      labels: ['trace-fix', `trace-gap-${g.rule.toLowerCase()}`],
      description: `Audit gap found by Trace on ${g.key} "${g.summary}".\nRule: ${g.title} (${g.severity}).\n${g.detail}\nWhy it matters: auditors expect every requirement verified and every risk controlled (IEC 62304, ISO 14971).`,
    })));
    await pool(keys, 5, (key, i) => link(type, key, todo[i].g.key));
    keys.forEach((key, i) => created.push({ task: key, for: todo[i].g.key, rule: todo[i].g.title }));
  }
  return { created, skipped };
}

// ---------------------------------------------------------------- Confluence: DHF export

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const STATE_LABEL = { verified: ['Green', 'VERIFIED'], failing: ['Red', 'FAILING'], stale: ['Red', 'RE-VERIFY'], unverified: ['Yellow', 'NOT RUN'], untested: ['Red', 'NO TEST'] };
const status = (colour, title) => `<ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">${colour}</ac:parameter><ac:parameter ac:name="title">${esc(title)}</ac:parameter></ac:structured-macro>`;

// Confluence storage-format body for the traceability section of a Design History File.
export function dhfBody(projectKey, r, siteUrl) {
  const issue = (k) => (siteUrl ? `<a href="${esc(siteUrl)}/browse/${esc(k)}">${esc(k)}</a>` : esc(k));
  const now = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const rows = r.matrix.map((m) => {
    const [c, t] = STATE_LABEL[m.state];
    return `<tr><td>${issue(m.key)}</td><td>${esc(m.summary)}</td><td>${m.risks.map((x) => issue(x.key)).join(', ') || '-'}</td><td>${m.tests.map((x) => `${issue(x.key)} ${x.failed ? '✗' : x.done ? '✓' : '…'}`).join(', ') || '-'}</td><td>${status(c, t)}</td></tr>`;
  }).join('');
  const riskRows = r.risks.map((k) => `<tr><td>${issue(k.key)}</td><td>${esc(k.summary)}</td><td>${esc(k.severity)}</td><td>${k.controls.map((c) => `${issue(c.key)} (${c.state})`).join(', ') || status('Red', 'UNCONTROLLED')}</td></tr>`).join('');
  const gapRows = r.gaps.map((g) => `<tr><td>${status(g.severity === 'high' ? 'Red' : g.severity === 'medium' ? 'Yellow' : 'Grey', g.severity.toUpperCase())}</td><td>${issue(g.key)}</td><td>${esc(g.title)}</td><td>${esc(g.detail)}</td><td>${esc(g.fix)}</td></tr>`).join('');
  return [
    `<ac:structured-macro ac:name="info"><ac:rich-text-body><p>Generated by <strong>Trace</strong> from live Jira data for project <strong>${esc(projectKey)}</strong> on ${now}. Regenerate before each design review; do not edit by hand.</p></ac:rich-text-body></ac:structured-macro>`,
    `<h2>1. Summary</h2><p>Audit readiness: <strong>${r.score}%</strong> ${status(r.ready ? 'Green' : 'Red', r.ready ? 'READY' : 'NOT READY')}</p>`,
    `<ul><li>${r.counts.requirements} requirements, ${r.counts.verified} verified (${r.coverage}% have at least one test)</li><li>${r.counts.risks} risks</li><li>${r.counts.tests} verification tests</li><li>${r.counts.gaps} open gaps, ${r.counts.blockers} blocking</li></ul>`,
    `<h2>2. Requirements traceability matrix</h2><table><tbody><tr><th>Requirement</th><th>Description</th><th>Risks controlled</th><th>Verification</th><th>Status</th></tr>${rows}</tbody></table>`,
    `<h2>3. Risk control traceability (ISO 14971)</h2><table><tbody><tr><th>Risk</th><th>Hazard</th><th>Severity</th><th>Control measures</th></tr>${riskRows}</tbody></table>`,
    `<h2>4. Open gaps</h2>${r.gaps.length ? `<table><tbody><tr><th>Severity</th><th>Item</th><th>Gap</th><th>Detail</th><th>Required action</th></tr>${gapRows}</tbody></table>` : '<p>No open gaps.</p>'}`,
    `<h2>5. Method</h2><p>Requirements, risks and tests are Jira issues labelled <code>${LABELS.req}</code>, <code>${LABELS.risk}</code> and <code>${LABELS.test}</code>; trace links are Jira issue links. A requirement is verified when all linked tests are Done, none is labelled <code>${LABELS.failed}</code>, and its wording has not changed since the tests passed. Rules: ${Object.values(RULES).map((x) => esc(x.title)).join('; ')}.</p>`,
  ].join('');
}

async function confluenceSpace(spaceKey) {
  const conf = api.asUser();
  const res = spaceKey
    ? await conf.requestConfluence(route`/wiki/api/v2/spaces?keys=${spaceKey}`, { headers: { Accept: 'application/json' } })
    : await conf.requestConfluence(route`/wiki/api/v2/spaces?type=global&limit=25`, { headers: { Accept: 'application/json' } });
  // 401/403 here almost always means Trace is installed in Jira but not yet in Confluence.
  if (res.status === 401 || res.status === 403) {
    throw new Error('Trace is not installed in Confluence on this site yet. Open the Trace installation link again, choose Confluence and install, then retry.');
  }
  const spaces = (await json(res, 'Read Confluence spaces')).results || [];
  if (!spaces.length) throw new Error(spaceKey ? `Confluence space ${spaceKey} not found` : 'No Confluence space found. Create one first.');
  return spaces[0];
}

// Publish the matrix as a new Confluence page; returns its URL.
export async function publishDhf(projectKey, spaceKey, siteUrl) {
  const r = await report(projectKey);
  const space = await confluenceSpace(spaceKey);
  const title = `${projectKey} Traceability Matrix (DHF) ${new Date().toISOString().replace('T', ' ').slice(0, 16)}`;
  const res = await api.asUser().requestConfluence(route`/wiki/api/v2/pages`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ spaceId: space.id, status: 'current', title, body: { representation: 'storage', value: dhfBody(projectKey, r, siteUrl) } }),
  });
  const page = await json(res, 'Create Confluence page');
  const url = page._links?.base && page._links?.webui ? page._links.base + page._links.webui : siteUrl ? `${siteUrl}/wiki${page._links?.webui || ''}` : page._links?.webui;
  return { title, url, space: space.key, score: r.score };
}
