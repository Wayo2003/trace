# Trace privacy policy

_Last updated: 29 October 2026_

Trace is an Atlassian Forge app that runs entirely on Atlassian's infrastructure ("Runs on Atlassian").

**What Trace reads.** Jira issues labelled `trace-req`, `trace-risk` and `trace-test` in the project you open (summary, status, labels, issue links, resolution date and change history), and the Confluence spaces you publish to. All requests are made as the signed-in user, so Trace only sees what that user is already allowed to see.

**What Trace writes.** Only when a user clicks a button or confirms a Rovo agent action: Jira tasks for traceability gaps (labelled `trace-fix`), the demo issues when "Load demo" is used, and Confluence pages for the traceability matrix.

**What Trace stores.** Nothing. Trace has no database and no app storage; it does not copy, cache or export your data, and it sends no data to any service outside Atlassian. The app declares no egress (external network access) in its manifest.

**AI.** The Trace Auditor agent runs inside Atlassian Rovo and is subject to Atlassian's AI and data policies. Trace itself does not call any external AI service.

**Contact.** Questions or requests: open an issue at https://github.com/Wayo2003/trace/issues.
