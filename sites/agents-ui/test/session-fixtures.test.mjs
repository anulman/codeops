import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("fleet and cockpit routes use the live broker while retaining the v1 operator contract", async () => {
  const [fleet, cockpit] = await Promise.all([
    readFile(new URL("../src/routes/index.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/routes/sessions.$sessionId.tsx", import.meta.url), "utf8"),
  ]);

  for (const label of ["Active", "Needs attention", "Archived", "Search sessions"]) {
    assert.match(fleet, new RegExp(label));
  }
  for (const label of ["Prompt", "Approve / deny", "Cancel", "Checkpoint", "Hibernate", "Resume", "Fork", "Archive", "Delete", "Protocol diagnostics"]) {
    assert.match(cockpit, new RegExp(label));
  }
  assert.match(cockpit, /grid-cols-2/);
  assert.match(fleet, /getSessionFleet/);
  assert.match(cockpit, /getSessionDetail/);
  assert.match(cockpit, /getSessionEvents/);
  assert.match(cockpit, /executeSessionCommand/);
  assert.match(cockpit, /window\.setInterval/);
  assert.match(cockpit, /type: action, prompt/);
  assert.match(cockpit, /checkpointId: checkpoint\.checkpointId/);
  assert.doesNotMatch(cockpit, /ACP runtime adapter pending/);
  assert.match(cockpit, /session\.capabilities\.map/);
  assert.doesNotMatch(fleet, /sessionFixtures/);
  assert.doesNotMatch(cockpit, /sessionFixtures/);
});
