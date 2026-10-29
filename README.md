# Trace: audit-ready traceability for regulated software teams

**Codegeist 2026 · Apps for Specialized Industries · Best Agents (Rovo)**

Medical-device and other regulated software teams must prove to auditors (IEC 62304, ISO 14971, FDA design controls) that **every requirement is verified and every risk is controlled**. Today that proof is a spreadsheet rebuilt by hand before every audit, and it takes weeks. It is out of date the moment someone edits a requirement.

**Trace** turns the Jira work teams already do into live audit evidence:

- **Audit readiness score** for any Jira project, with every gap explained and the fix spelled out.
- **Live traceability matrix**: requirements ↔ risks ↔ verification tests, plus a risk-control table.
- **Catches what humans miss**, including the classic audit finding: *a requirement whose wording changed after its tests passed*.
- **One click to fix**: creates a linked Jira task per gap (never duplicates).
- **One click to document**: publishes the Design History File traceability page to Confluence.
- **Trace Auditor, a Rovo agent**: ask "Is MED ready for audit?", "What breaks if we change MED-4?", "Open tasks for the blocking gaps", "Write the DHF page".
- **Issue panel** on every requirement, risk and test showing its trace status.

## How it works

Trace uses plain Jira conventions, so there are no custom fields and nothing to migrate:

| Item | Convention |
|---|---|
| Requirement | issue labelled `trace-req` |
| Risk / hazard | issue labelled `trace-risk` + `severity-high` / `severity-medium` / `severity-low` |
| Verification test | issue labelled `trace-test`; **Done** = passed, label `test-failed` = failed |
| Trace link | any Jira issue link between them |

Seven gap rules: requirement without test · failing test · tests not run · **requirement changed after verification** (from the issue changelog) · uncontrolled risk · unverified risk control · orphan test. High-severity risks escalate their gaps to blockers.

## Try it in 2 minutes

1. Install Trace with the installation link (Jira **and** Confluence on the same site).
2. Create an empty Jira project, open it and choose **Trace** in the project navigation.
3. Click **Load demo: GlucoFlow insulin pump app**. It creates 10 requirements, 6 risks and 9 tests with realistic gaps.
4. Explore the **Gaps**, **Traceability matrix** and **Risk controls** tabs. Click **Create fix tasks** and **Publish DHF to Confluence**.
5. Open Rovo Chat, pick **Trace Auditor** and ask: *"Is MED ready for an audit?"* (use your project key).

## Built with

- **Forge** (Runs on Atlassian, no egress, no storage) · UI Kit
- Modules: `rovo:agent` + 4 `action`s, `jira:projectPage`, `jira:issueContext`
- Jira REST API v3 (`search/jql` with changelog, bulk create, issue links, transitions) and Confluence REST API v2 (pages)
- All calls made `asUser()`, so Jira and Confluence permissions are always respected

## Develop

```bash
npm install
npm test                      # unit tests for the traceability engine
forge deploy -e development
forge install --site <your-site>.atlassian.net --product jira
forge install --site <your-site>.atlassian.net --product confluence
```

## Privacy

See [PRIVACY.md](PRIVACY.md). Trace stores nothing and sends nothing outside Atlassian.

## License

MIT
