// Trace project page (Jira > Project > Apps > Trace).
// Shows the audit-readiness score, the open gaps, the traceability matrix and the risk table,
// with one-click actions: create fix tasks, publish the DHF page to Confluence, load demo data.

import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Badge, Box, Button, ButtonGroup, DynamicTable, EmptyState, Heading, Inline, Link, Lozenge,
  ProgressBar, SectionMessage, Spinner, Stack, Strong, Tab, TabList, TabPanel, Tabs, Text,
} from '@forge/react';
import { invoke } from '@forge/bridge';

// Visual mapping of a requirement's verification state.
const STATE = {
  verified: { text: 'Verified', appearance: 'success' },
  failing: { text: 'Test failing', appearance: 'removed' },
  stale: { text: 'Re-verify', appearance: 'removed' },
  unverified: { text: 'Not run', appearance: 'inprogress' },
  untested: { text: 'No test', appearance: 'removed' },
};
const SEVERITY = { high: 'removed', medium: 'moved', low: 'default' };

const App = () => {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null); // name of the running action
  const [notice, setNotice] = useState(null); // { appearance, title, body, link }

  const load = async () => {
    setError(null);
    try {
      setData(await invoke('getReport'));
    } catch (e) {
      setError(e.message || String(e));
    }
  };
  useEffect(() => { load(); }, []);

  // Run a backend action, show its result and reload the report.
  const run = async (name, fn) => {
    setBusy(name);
    setNotice(null);
    try {
      setNotice(await fn());
      await load();
    } catch (e) {
      setNotice({ appearance: 'error', title: 'Something went wrong', body: e.message || String(e) });
    } finally {
      setBusy(null);
    }
  };

  const seed = () => run('seed', async () => {
    const r = await invoke('seedDemo');
    return { appearance: 'success', title: 'Demo project loaded', body: r.message };
  });
  const fixAll = () => run('fix', async () => {
    const r = await invoke('createFixTasks');
    return {
      appearance: 'success',
      title: r.created.length ? `Created ${r.created.length} fix tasks` : 'Nothing new to create',
      body: r.created.length ? r.created.map((c) => `${c.task} → ${c.for}`).join('   ') : 'Every gap already has an open fix task.',
    };
  });
  const dhf = () => run('dhf', async () => {
    const r = await invoke('publishDhf');
    return { appearance: 'success', title: 'Design History File page published', body: `"${r.title}" in space ${r.space}.`, link: r.url };
  });

  if (error) {
    return (
      <SectionMessage appearance="error" title="Trace could not read this project">
        <Text>{error}</Text>
        <Button onClick={load}>Try again</Button>
      </SectionMessage>
    );
  }
  if (!data) return <Spinner label="Reading requirements, risks and tests" />;

  const { projectKey, siteUrl, report: r } = data;
  const issue = (key) => <Link href={`${siteUrl}/browse/${key}`} openNewTab>{key}</Link>;
  const total = r.counts.requirements + r.counts.risks + r.counts.tests;

  const banner = notice && (
    <SectionMessage appearance={notice.appearance} title={notice.title}>
      <Text>{notice.body}</Text>
      {notice.link ? <Link href={notice.link} openNewTab>Open the page in Confluence</Link> : null}
    </SectionMessage>
  );

  // Empty project: explain the convention and offer the demo data.
  if (!total) {
    return (
      <Stack space="space.200">
        {banner}
        <EmptyState
          header="No requirements, risks or tests yet"
          description={`Trace reads Jira issues labelled trace-req (requirements), trace-risk (risks, with severity-high/medium/low) and trace-test (verification tests), and the issue links between them. Load a realistic medical-device project to see it in action.`}
          primaryAction={<Button appearance="primary" onClick={seed} isDisabled={!!busy}>{busy === 'seed' ? 'Loading demo…' : 'Load demo: GlucoFlow insulin pump app'}</Button>}
        />
      </Stack>
    );
  }

  const gapRows = r.gaps.map((g, i) => ({
    key: `g${i}`,
    cells: [
      { key: 'sev', content: <Lozenge appearance={SEVERITY[g.severity]} isBold>{g.severity}</Lozenge> },
      { key: 'item', content: <Stack><Text>{issue(g.key)}</Text><Text size="small">{g.summary}</Text></Stack> },
      { key: 'gap', content: <Stack><Strong>{g.title}</Strong><Text size="small">{g.detail}</Text></Stack> },
      { key: 'fix', content: <Text>{g.fix}</Text> },
    ],
  }));

  const matrixRows = r.matrix.map((m) => ({
    key: m.key,
    cells: [
      { key: 'req', content: <Stack><Text>{issue(m.key)}</Text><Text size="small">{m.summary}</Text></Stack> },
      { key: 'risks', content: m.risks.length ? <Inline space="space.050" shouldWrap>{m.risks.map((x) => <Lozenge key={x.key} appearance={SEVERITY[x.severity]}>{x.key}</Lozenge>)}</Inline> : <Text>-</Text> },
      { key: 'tests', content: m.tests.length ? <Inline space="space.050" shouldWrap>{m.tests.map((t) => <Lozenge key={t.key} appearance={t.failed ? 'removed' : t.done ? 'success' : 'default'}>{`${t.key} ${t.failed ? '✗' : t.done ? '✓' : '…'}`}</Lozenge>)}</Inline> : <Text>-</Text> },
      { key: 'state', content: <Lozenge appearance={STATE[m.state].appearance} isBold>{STATE[m.state].text}</Lozenge> },
    ],
  }));

  const riskRows = r.risks.map((k) => ({
    key: k.key,
    cells: [
      { key: 'risk', content: <Stack><Text>{issue(k.key)}</Text><Text size="small">{k.summary}</Text></Stack> },
      { key: 'sev', content: <Lozenge appearance={SEVERITY[k.severity]} isBold>{k.severity}</Lozenge> },
      { key: 'ctrl', content: k.controls.length ? <Inline space="space.050" shouldWrap>{k.controls.map((c) => <Lozenge key={c.key} appearance={STATE[c.state].appearance}>{`${c.key} · ${STATE[c.state].text}`}</Lozenge>)}</Inline> : <Lozenge appearance="removed" isBold>Uncontrolled</Lozenge> },
    ],
  }));

  return (
    <Stack space="space.300">
      {banner}

      {/* Header: score + verdict + primary actions */}
      <Inline spread="space-between" alignBlock="center" shouldWrap>
        <Stack space="space.100">
          <Inline space="space.100" alignBlock="center">
            <Heading as="h2" size="large">{`Audit readiness: ${r.score}%`}</Heading>
            <Lozenge appearance={r.ready ? 'success' : 'removed'} isBold>{r.ready ? 'Ready for audit' : 'Not ready'}</Lozenge>
          </Inline>
          <Text>{`${projectKey} · ${r.counts.requirements} requirements · ${r.counts.risks} risks · ${r.counts.tests} tests · ${r.coverage}% of requirements have a test`}</Text>
        </Stack>
        <ButtonGroup>
          <Button onClick={load} isDisabled={!!busy}>Refresh</Button>
          <Button onClick={fixAll} isDisabled={!!busy || !r.gaps.length}>{busy === 'fix' ? 'Creating tasks…' : `Create fix tasks (${r.gaps.length})`}</Button>
          <Button appearance="primary" onClick={dhf} isDisabled={!!busy}>{busy === 'dhf' ? 'Publishing…' : 'Publish DHF to Confluence'}</Button>
        </ButtonGroup>
      </Inline>
      <Box>
        <ProgressBar value={r.score / 100} appearance={r.ready ? 'success' : 'default'} ariaLabel="Audit readiness" />
      </Box>

      <Inline space="space.200" shouldWrap>
        <Text><Badge appearance="removed">{r.counts.blockers}</Badge> blocking gaps</Text>
        <Text><Badge appearance="primary">{r.counts.gaps}</Badge> gaps in total</Text>
        <Text><Badge appearance="added">{r.counts.verified}</Badge>{` of ${r.counts.requirements} requirements verified`}</Text>
      </Inline>

      <Tabs id="trace-tabs">
        <TabList>
          <Tab>{`Gaps (${r.gaps.length})`}</Tab>
          <Tab>Traceability matrix</Tab>
          <Tab>Risk controls</Tab>
          <Tab>How it works</Tab>
        </TabList>
        <TabPanel>
          <Box paddingBlock="space.200">
            {r.gaps.length ? (
              <DynamicTable
                head={{ cells: [{ key: 'sev', content: 'Severity' }, { key: 'item', content: 'Item' }, { key: 'gap', content: 'Gap' }, { key: 'fix', content: 'Required action' }] }}
                rows={gapRows}
                rowsPerPage={15}
              />
            ) : (
              <SectionMessage appearance="success" title="No open gaps">
                <Text>Every requirement is verified and every risk is controlled. Publish the DHF page for your design review.</Text>
              </SectionMessage>
            )}
          </Box>
        </TabPanel>
        <TabPanel>
          <Box paddingBlock="space.200">
            <DynamicTable
              head={{ cells: [{ key: 'req', content: 'Requirement' }, { key: 'risks', content: 'Risks controlled' }, { key: 'tests', content: 'Verification' }, { key: 'state', content: 'Status' }] }}
              rows={matrixRows}
              rowsPerPage={20}
            />
          </Box>
        </TabPanel>
        <TabPanel>
          <Box paddingBlock="space.200">
            <DynamicTable
              head={{ cells: [{ key: 'risk', content: 'Risk' }, { key: 'sev', content: 'Severity' }, { key: 'ctrl', content: 'Control measures' }] }}
              rows={riskRows}
              rowsPerPage={20}
            />
          </Box>
        </TabPanel>
        <TabPanel>
          <Box paddingBlock="space.200">
            <Stack space="space.150">
              <Text>Trace turns the Jira work you already do into audit evidence for regulated software (IEC 62304, ISO 14971, FDA design controls).</Text>
              <Text><Strong>Requirements</Strong>: issues labelled trace-req. <Strong>Risks</Strong>: trace-risk plus severity-high, severity-medium or severity-low. <Strong>Tests</Strong>: trace-test; Done means passed, label test-failed means failed.</Text>
              <Text>Link them with any Jira issue link. Trace checks seven rules: untested, failing, unverified and changed-after-verification requirements; uncontrolled risks; unverified risk controls; and orphan tests.</Text>
              <Text>Ask the Trace Auditor agent in Rovo: “Is MED ready for audit?”, “What breaks if we change MED-4?”, “Open tasks for the blocking gaps”, “Write the DHF page”.</Text>
              <Inline>
                <Button onClick={seed} isDisabled={!!busy}>{busy === 'seed' ? 'Loading demo…' : 'Load or repair demo data'}</Button>
              </Inline>
            </Stack>
          </Box>
        </TabPanel>
      </Tabs>
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
