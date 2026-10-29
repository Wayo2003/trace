// Entry points of the Trace Forge app.
//  - `resolver`: backend functions called by the UI Kit pages via invoke() from @forge/bridge
//  - the other exports are Rovo agent actions (declared under `action:` in manifest.yml)

import Resolver from '@forge/resolver';
import { report, seedDemo, createFixTasks, publishDhf, fetchTraceIssues, projectKeyOfIssue } from './lib/jira.js';
import { traceOf, summarize } from './lib/trace.js';

// ---------------------------------------------------------------- UI resolvers

const resolver = new Resolver();

// The project the UI is rendered in (project page) or the project of the open issue (issue panel).
async function contextProject(context, payload) {
  if (payload?.projectKey) return payload.projectKey;
  const ext = context.extension || {};
  if (ext.project?.key) return ext.project.key;
  if (ext.issue?.key) return projectKeyOfIssue(ext.issue.key);
  throw new Error('No Jira project in context');
}

resolver.define('getReport', async ({ payload, context }) => {
  const projectKey = await contextProject(context, payload);
  return { projectKey, siteUrl: context.siteUrl, report: await report(projectKey) };
});

// Called once per phase by the UI ('issues' -> 'links' -> 'finish'); see seedDemo.
resolver.define('seedDemo', async ({ payload, context }) => seedDemo(await contextProject(context, payload), payload?.phase, payload?.keys));

resolver.define('createFixTasks', async ({ payload, context }) => createFixTasks(await contextProject(context, payload), payload?.keys));

resolver.define('publishDhf', async ({ payload, context }) => publishDhf(await contextProject(context, payload), payload?.spaceKey, context.siteUrl));

resolver.define('getIssueTrace', async ({ context }) => {
  const issueKey = context.extension?.issue?.key;
  const projectKey = await projectKeyOfIssue(issueKey);
  const issues = await fetchTraceIssues(projectKey);
  return { issueKey, trace: traceOf(issues, issueKey) };
});

export const handler = resolver.getDefinitions();

// ---------------------------------------------------------------- Rovo agent actions
// Rovo passes the action inputs on the payload, plus `context` describing where the chat is
// open (e.g. the Jira issue being viewed). Actions return plain text the agent reasons over.

async function actionProject(payload) {
  const key = payload.projectKey || payload.context?.jira?.projectKey;
  if (key) return String(key).toUpperCase().trim();
  const issueKey = payload.issueKey || payload.context?.jira?.issueKey;
  if (issueKey) return projectKeyOfIssue(issueKey);
  throw new Error('Tell me which Jira project to check (for example: MED).');
}

const safe = (fn) => async (payload) => {
  try {
    return await fn(payload);
  } catch (e) {
    console.error(e);
    return `Error: ${e.message}`;
  }
};

// "Are we audit-ready?" -> score, counts and every gap with its fix.
export const auditReadiness = safe(async (payload) => {
  const projectKey = await actionProject(payload);
  return summarize(await report(projectKey), projectKey);
});

// "What breaks if we change REQ-04?" -> linked risks/tests of one issue.
export const traceIssue = safe(async (payload) => {
  const issueKey = String(payload.issueKey || payload.context?.jira?.issueKey || '').toUpperCase().trim();
  if (!issueKey) return 'Error: tell me which issue to trace (for example: MED-4).';
  const issues = await fetchTraceIssues(await projectKeyOfIssue(issueKey));
  const t = traceOf(issues, issueKey);
  return t ? JSON.stringify(t) : `${issueKey} is not a Trace requirement, risk or test (it has no trace-req / trace-risk / trace-test label).`;
});

// "Open tasks for the gaps" -> one linked Jira task per gap (no duplicates).
export const createGapTasks = safe(async (payload) => {
  const projectKey = await actionProject(payload);
  const keys = payload.issueKeys ? String(payload.issueKeys).split(/[\s,]+/).filter(Boolean).map((k) => k.toUpperCase()) : undefined;
  const r = await createFixTasks(projectKey, keys);
  if (!r.created.length) return `No new tasks needed${r.skipped.length ? ` (open fix tasks already exist for ${r.skipped.join(', ')})` : ''}.`;
  return `Created ${r.created.length} tasks:\n${r.created.map((c) => `- ${c.task} for ${c.for}: ${c.rule}`).join('\n')}${r.skipped.length ? `\nSkipped (already tracked): ${r.skipped.join(', ')}` : ''}`;
});

// "Write the DHF" -> Confluence page with the full traceability matrix.
export const generateDhf = safe(async (payload) => {
  const projectKey = await actionProject(payload);
  const page = await publishDhf(projectKey, payload.spaceKey, payload.context?.siteUrl);
  return `Published "${page.title}" in Confluence space ${page.space} (readiness ${page.score}%): ${page.url}`;
});
