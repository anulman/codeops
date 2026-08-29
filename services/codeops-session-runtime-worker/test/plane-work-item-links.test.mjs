import assert from "node:assert/strict";
import test from "node:test";
import { linkTrustedPlaneWorkItemReferences } from "../dist/plane-work-item-links.js";

function binding(overrides = {}) {
  return {
    version: "codeops.trusted-plane-work-item-reference/v1",
    apiOrigin: "https://plane.example.com/",
    workspaceSlug: "engineering",
    workspaceId: "11111111-1111-4111-8111-111111111111",
    projectId: "22222222-2222-4222-8222-222222222222",
    projectIdentifier: "COAUTO",
    workItemId: "33333333-3333-4333-8333-333333333333",
    sequenceId: 19,
    reference: "COAUTO-19",
    ...overrides,
  };
}

const linked =
  "[COAUTO-19](https://plane.example.com/engineering/browse/COAUTO-19)";

test("links repeated trusted references in prose", () => {
  const markdown = "Fix COAUTO-19, then verify COAUTO-19.\nFinal COAUTO-19.";
  assert.equal(
    linkTrustedPlaneWorkItemReferences(markdown, [binding()]),
    `Fix ${linked}, then verify ${linked}.\nFinal ${linked}.`,
  );
});

test("keeps references plain without one canonical trusted identity", () => {
  assert.equal(linkTrustedPlaneWorkItemReferences("COAUTO-19", []), "COAUTO-19");
  for (const conflict of [
    { apiOrigin: "https://other-plane.example.com/" },
    { workspaceSlug: "other-workspace" },
    { workspaceId: "44444444-4444-4444-8444-444444444444" },
    { projectId: "55555555-5555-4555-8555-555555555555" },
    { workItemId: "66666666-6666-4666-8666-666666666666" },
  ]) {
    assert.equal(
      linkTrustedPlaneWorkItemReferences("COAUTO-19", [
        binding(),
        binding(conflict),
      ]),
      "COAUTO-19",
    );
  }
  assert.equal(
    linkTrustedPlaneWorkItemReferences("COAUTO-19", [binding(), binding()]),
    linked,
  );
});

test("preserves recognized CommonMark and GFM protected syntax", () => {
  const markdown = [
    "`COAUTO-19` and `` COAUTO-19 ``",
    "[existing COAUTO-19](https://example.com/COAUTO-19)",
    "[reference COAUTO-19][ticket]",
    "![image COAUTO-19](https://example.com/COAUTO-19.png)",
    "<https://example.com/COAUTO-19>",
    "www.example.com/COAUTO-19 and https://example.com/COAUTO-19",
    "COAUTO-19@example.com and user@COAUTO-19.example",
    "",
    "[ticket]: https://example.com/COAUTO-19 \"COAUTO-19 title\"",
    "",
    "```md",
    "COAUTO-19",
    "```",
    "",
    "    COAUTO-19",
    "",
    "Outside COAUTO-19.",
  ].join("\n");
  assert.equal(
    linkTrustedPlaneWorkItemReferences(markdown, [binding()]),
    markdown.replace("Outside COAUTO-19.", `Outside ${linked}.`),
  );
});

test("uses CommonMark parsing for unresolved and malformed link-like prose", () => {
  const markdown = [
    "[unresolved COAUTO-19]",
    "[broken](COAUTO-19",
    "COAUTO-19@example",
  ].join("\n");
  assert.equal(
    linkTrustedPlaneWorkItemReferences(markdown, [binding()]),
    [
      `[unresolved ${linked}]`,
      `[broken](${linked}`,
      `${linked}@example`,
    ].join("\n"),
  );
});

test("preserves text in unclosed inline HTML", () => {
  const markdown = "<span>COAUTO-19";
  assert.equal(
    linkTrustedPlaneWorkItemReferences(markdown, [binding()]),
    markdown,
  );
});

test("preserves text in nested unclosed inline HTML", () => {
  const markdown = "<span><em>COAUTO-19";
  assert.equal(
    linkTrustedPlaneWorkItemReferences(markdown, [binding()]),
    markdown,
  );
});

test("uses HTML5 recovery for mismatched inline HTML", () => {
  const markdown =
    "<span>COAUTO-19</em> COAUTO-19</span> Outside COAUTO-19.";
  assert.equal(
    linkTrustedPlaneWorkItemReferences(markdown, [binding()]),
    `<span>COAUTO-19</em> COAUTO-19</span> Outside ${linked}.`,
  );
});

test("links eligible prose after br and img void elements", () => {
  const markdown = '<br>COAUTO-19 <img alt="COAUTO-19"> COAUTO-19';
  assert.equal(
    linkTrustedPlaneWorkItemReferences(markdown, [binding()]),
    `<br>${linked} <img alt="COAUTO-19"> ${linked}`,
  );
});

test("preserves valid balanced inline HTML ancestry", () => {
  const markdown =
    '<span title="COAUTO-19"><span>COAUTO-19</span> COAUTO-19</span> Outside COAUTO-19.';
  assert.equal(
    linkTrustedPlaneWorkItemReferences(markdown, [binding()]),
    '<span title="COAUTO-19"><span>COAUTO-19</span> COAUTO-19</span> ' +
      `Outside ${linked}.`,
  );
});

test("preserves raw HTML blocks", () => {
  const markdown = [
    "<div>",
    "COAUTO-19 remains in HTML",
    "</div>",
    "",
    "Outside block COAUTO-19.",
  ].join("\n");
  assert.equal(
    linkTrustedPlaneWorkItemReferences(markdown, [binding()]),
    markdown.replace("Outside block COAUTO-19.", `Outside block ${linked}.`),
  );
});

test("links eligible GFM table, task-list, and strikethrough text", () => {
  const markdown = [
    "| Work item |",
    "| --- |",
    "| COAUTO-19 |",
    "",
    "- [x] Complete COAUTO-19",
    "- ~~Supersede COAUTO-19~~",
  ].join("\n");
  assert.equal(
    linkTrustedPlaneWorkItemReferences(markdown, [binding()]),
    markdown.replaceAll("COAUTO-19", linked),
  );
});

test("preserves raw HTML ancestry inside a GFM table cell", () => {
  const markdown = [
    "| Raw HTML | Prose |",
    "| --- | --- |",
    "| <span>COAUTO-19</span> | COAUTO-19 |",
  ].join("\n");
  assert.equal(
    linkTrustedPlaneWorkItemReferences(markdown, [binding()]),
    markdown.replace("| COAUTO-19 |", `| ${linked} |`),
  );
});

test("preserves every source byte outside inserted links", () => {
  const markdown =
    "Lead\t*Before*  COAUTO-19\r\nEscaped COAUTO\\-19 &amp; COAUTO-19\r\n";
  assert.equal(
    linkTrustedPlaneWorkItemReferences(markdown, [binding()]),
    `Lead\t*Before*  ${linked}\r\nEscaped COAUTO\\-19 &amp; ${linked}\r\n`,
  );
});

test("links only exact trusted reference tokens", () => {
  const markdown = [
    "COAUTO-19",
    "X-COAUTO-19",
    "_COAUTO-19",
    "LONG-IDENTIFIER-COAUTO-19",
    "COAUTO-19-more",
    "COAUTO-19_more",
    "COAUTO-19X",
  ].join(" ");
  assert.equal(
    linkTrustedPlaneWorkItemReferences(markdown, [binding()]),
    [
      linked,
      "X-COAUTO-19",
      "_COAUTO-19",
      "LONG-IDENTIFIER-COAUTO-19",
      "COAUTO-19-more",
      "COAUTO-19_more",
      "COAUTO-19X",
    ].join(" "),
  );
});

test("uses Unicode-aware exact-token boundaries on both sides", () => {
  const continuations = [
    "é",
    "Ж",
    "中",
    "Ａ",
    "１",
    "\u0301",
    "‿",
    "＿",
    "\u200d",
    "\u2060",
  ];
  for (const continuation of continuations) {
    for (const markdown of [
      `${continuation}COAUTO-19`,
      `COAUTO-19${continuation}`,
    ]) {
      assert.equal(
        linkTrustedPlaneWorkItemReferences(markdown, [binding()]),
        markdown,
      );
    }
  }
  for (const [left, right] of [
    ["(", ")"],
    ["“", "”"],
    ["—", "…"],
    [" ", "\n"],
  ]) {
    assert.equal(
      linkTrustedPlaneWorkItemReferences(`${left}COAUTO-19${right}`, [binding()]),
      `${left}${linked}${right}`,
    );
  }
});
