// Trace issue context panel (right-hand side of every Jira issue).
// For a requirement: its verification state, linked risks and tests.
// For a risk: its control measures. For a test: which requirements it verifies.

import React, { useEffect, useState } from 'react';
import ForgeReconciler, { Inline, Lozenge, SectionMessage, Spinner, Stack, Strong, Text } from '@forge/react';
import { invoke } from '@forge/bridge';

const STATE = {
  verified: ['Verified', 'success', 'All linked tests passed after the last change.'],
  failing: ['Test failing', 'removed', 'A linked test is failing. This blocks the release.'],
  stale: ['Re-verify', 'removed', 'The wording changed after the tests passed. Re-run them.'],
  unverified: ['Not run', 'inprogress', 'Linked tests have not passed yet.'],
  untested: ['No test', 'removed', 'Nothing verifies this requirement. Link a trace-test issue.'],
};
const SEVERITY = { high: 'removed', medium: 'moved', low: 'default' };
const TEST = { passed: 'success', failed: 'removed', 'not run': 'default' };

const Row = ({ label, children }) => (
  <Stack space="space.050">
    <Strong>{label}</Strong>
    {children}
  </Stack>
);

const App = () => {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { invoke('getIssueTrace').then(setData).catch((e) => setError(e.message || String(e))); }, []);

  if (error) return <SectionMessage appearance="error"><Text>{error}</Text></SectionMessage>;
  if (!data) return <Spinner label="Tracing" />;
  const t = data.trace;
  if (!t) {
    return <Text>Not traced. Add the label trace-req, trace-risk or trace-test to include this issue in the audit matrix.</Text>;
  }

  if (t.kind === 'req') {
    const [text, appearance, why] = STATE[t.state];
    return (
      <Stack space="space.150">
        <Inline space="space.100" alignBlock="center"><Text>Requirement</Text><Lozenge appearance={appearance} isBold>{text}</Lozenge></Inline>
        <Text size="small">{why}</Text>
        <Row label="Controls risks">
          {t.risks.length ? <Inline space="space.050" shouldWrap>{t.risks.map((r) => <Lozenge key={r.key} appearance={SEVERITY[r.severity]}>{`${r.key} · ${r.severity}`}</Lozenge>)}</Inline> : <Text size="small">None</Text>}
        </Row>
        <Row label="Verified by">
          {t.tests.length ? <Inline space="space.050" shouldWrap>{t.tests.map((x) => <Lozenge key={x.key} appearance={TEST[x.status]}>{`${x.key} · ${x.status}`}</Lozenge>)}</Inline> : <Text size="small">No tests</Text>}
        </Row>
        {t.risks.some((r) => r.severity === 'high') ? <Text size="small">Changing this requirement affects a high-severity risk control: re-verify before release.</Text> : null}
      </Stack>
    );
  }

  if (t.kind === 'risk') {
    return (
      <Stack space="space.150">
        <Inline space="space.100" alignBlock="center"><Text>Risk</Text><Lozenge appearance={SEVERITY[t.severity]} isBold>{t.severity}</Lozenge></Inline>
        <Row label="Control measures">
          {t.controls.length
            ? <Inline space="space.050" shouldWrap>{t.controls.map((c) => <Lozenge key={c.key} appearance={STATE[c.state][1]}>{`${c.key} · ${STATE[c.state][0]}`}</Lozenge>)}</Inline>
            : <Lozenge appearance="removed" isBold>Uncontrolled</Lozenge>}
        </Row>
      </Stack>
    );
  }

  return (
    <Stack space="space.150">
      <Inline space="space.100" alignBlock="center"><Text>Test</Text><Lozenge appearance={TEST[t.status]} isBold>{t.status}</Lozenge></Inline>
      <Row label="Verifies">
        {t.verifies.length ? <Inline space="space.050" shouldWrap>{t.verifies.map((r) => <Lozenge key={r.key}>{r.key}</Lozenge>)}</Inline> : <Text size="small">Nothing: orphan test</Text>}
      </Row>
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
