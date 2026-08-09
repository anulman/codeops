import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("fleet and cockpit routes use the live broker while retaining the v1 operator contract", async () => {
  const [shell, fleet, cockpit] = await Promise.all([
    readFile(new URL("../src/components/AppShell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/routes/index.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/routes/sessions.$sessionId.tsx", import.meta.url), "utf8"),
  ]);

  for (const label of ["Active", "Needs attention", "Archived", "Search sessions"]) {
    assert.match(fleet, new RegExp(label));
  }
  for (const label of ["Prompt", "Approve / deny", "Cancel", "Checkpoint", "Hibernate", "Resume", "Fork", "Archive", "Delete", "Protocol diagnostics"]) {
    assert.match(cockpit, new RegExp(label));
  }
  assert.match(shell, /SessionNavigator/);
  assert.match(shell, /lg:grid-cols-\[304px_minmax\(0,1fr\)\]/);
  assert.match(cockpit, /SessionComposer/);
  assert.match(cockpit, /MessageRow/);
  assert.match(cockpit, /ExecutionRow/);
  assert.match(cockpit, /ActionRow/);
  assert.match(cockpit, /Reasoning/);
  assert.match(cockpit, /Agent attachment/);
  assert.match(cockpit, /External attachment/);
  assert.match(cockpit, /<audio controls/);
  assert.match(cockpit, /update\.status/);
  assert.match(cockpit, /Waiting for agent/);
  assert.match(cockpit, /Prompt submitted\. Waiting for agent\./);
  assert.match(cockpit, /event\.cursor > optimisticPrompt\.afterCursor/);
  assert.match(cockpit, /scrollIntoView\(\{ behavior: "smooth", block: "center" \}\)/);
  assert.match(cockpit, /if \(!accepted\) onSubmissionFailed\(idempotencyKey\)/);
  assert.match(cockpit, /Prompt accepted, but the timeline refresh failed\./);
  const composerSource = cockpit.slice(cockpit.indexOf("function SessionComposer"));
  assert.ok(
    composerSource.indexOf("onSubmissionStarted({ idempotencyKey, text: submittedPrompt });") <
      composerSource.indexOf("await executeSessionCommand"),
    "the optimistic timeline entry must render before the broker request completes",
  );
  assert.match(cockpit, /SteeringSheet/);
  assert.match(cockpit, /request\.options\.map/);
  assert.match(cockpit, /Prompt this live session/);
  assert.match(cockpit, /sticky bottom-0/);
  assert.match(cockpit, /xl:grid-cols-\[minmax\(0,1fr\)_320px\]/);
  assert.match(fleet, /getSessionFleet/);
  assert.match(cockpit, /getSessionDetail/);
  assert.match(cockpit, /getSessionEvents/);
  assert.match(cockpit, /executeSessionCommand/);
  assert.match(cockpit, /window\.setInterval/);
  assert.match(cockpit, /commandForAction/);
  assert.match(cockpit, /checkpointId: checkpoint\.checkpointId/);
  assert.doesNotMatch(cockpit, /window\.prompt|window\.confirm/);
  assert.doesNotMatch(cockpit, /ACP runtime adapter pending/);
  assert.match(cockpit, /session\.capabilities\.map/);
  assert.doesNotMatch(fleet, /sessionFixtures/);
  assert.doesNotMatch(cockpit, /sessionFixtures/);
});
