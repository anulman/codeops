import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import {
  githubPullRequestCreateInputSchema,
  linkTrustedPlaneWorkItemReferences,
} from "@codeops/codeops-contracts";

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

test("links only unprotected prose in generated pull-request Markdown", () => {
  const markdown = [
    "Fixes COAUTO-19 and repeats COAUTO-19.",
    "Bare https://tracker.invalid/COAUTO-19 stays bare.",
    "`COAUTO-19` and `` COAUTO-19 `` stay code.",
    "[existing COAUTO-19](https://example.com) [COAUTO-19][ticket] [COAUTO-19]",
    "<span>COAUTO-19</span>",
    "<hr>",
    "COAUTO-19 inside an HTML block",
    "",
    "- nested fence:",
    "  ~~~",
    "  COAUTO-19",
    "  ~~~",
    "",
    "> - ```ts",
    ">   COAUTO-19",
    ">   ```",
    "",
    "- > ~~~",
    "- > COAUTO-19",
    "- > ~~~",
    "",
    "    COAUTO-19",
    "",
    "[ticket]:",
    "  https://plane.example.com/engineering/browse/COAUTO-19",
    "  \"COAUTO-19 title\"",
    "",
    "<?processing",
    "COAUTO-19",
    "?>",
    "",
    "<![CDATA[",
    "COAUTO-19",
    "]]>",
    "",
    "</section>",
    "COAUTO-19 in a closing-tag HTML block",
    "",
    "Final COAUTO-19.",
  ].join("\n");
  const url = "https://plane.example.com/engineering/browse/COAUTO-19";
  const result = linkTrustedPlaneWorkItemReferences(markdown, [binding()]);
  assert.equal(result.match(new RegExp(`\\[COAUTO-19\\]\\(${url}\\)`, "g")).length, 3);
  assert.match(result, /`COAUTO-19`/);
  assert.match(result, />   COAUTO-19/);
  assert.match(result, /^    COAUTO-19$/m);
  assert.match(result, /<span>COAUTO-19<\/span>/);
  assert.match(result, /COAUTO-19 inside an HTML block/);
  assert.match(result, /nested fence:[\s\S]*  COAUTO-19/);
  assert.match(result, /\[ticket\]:\n  https:\/\/plane\.example\.com/);
  assert.match(result, /"COAUTO-19 title"/);
  assert.match(result, /<\?processing\nCOAUTO-19\n\?>/);
  assert.match(result, /<!\[CDATA\[\nCOAUTO-19\n\]\]>/);
  assert.match(result, /<\/section>\nCOAUTO-19 in a closing-tag HTML block/);
});

test("keeps plain text without a binding and for every ambiguous canonical origin dimension", () => {
  assert.equal(linkTrustedPlaneWorkItemReferences("COAUTO-19", []), "COAUTO-19");
  for (const conflict of [
    { apiOrigin: "https://other-plane.example.com/" },
    { workspaceSlug: "other-workspace" },
    { workspaceId: "44444444-4444-4444-8444-444444444444" },
    { projectId: "55555555-5555-4555-8555-555555555555" },
    { workItemId: "66666666-6666-4666-8666-666666666666" },
  ]) {
    assert.equal(
      linkTrustedPlaneWorkItemReferences("COAUTO-19", [binding(), binding(conflict)]),
      "COAUTO-19",
    );
  }
});

test("preserves CommonMark and GFM protected forms", () => {
  const markdown = [
    "0. nested fence",
    "   ```md",
    "   COAUTO-19",
    "   ```",
    "",
    "```~valid-info",
    "COAUTO-19",
    "```",
    "",
    "[balanced](https://example.com/a_(COAUTO-19) \"COAUTO-19 title\")",
    "[multiline](https://example.com/a_(COAUTO-19)\n  \"COAUTO-19 title\")",
    "![image COAUTO-19](https://example.com/image_(COAUTO-19).png)",
    "[reference COAUTO-19][ticket] and [shortcut COAUTO-19]",
    "[escaped COAUTO-19][ticket\\]]",
    "<https://example.com/COAUTO-19>",
    "www.example.com/COAUTO-19 and https://example.com/COAUTO-19",
    "<span title=\"COAUTO-19\">COAUTO-19</span>",
    "`COAUTO-19`",
    "",
    "[ticket]: https://example.com/a_(COAUTO-19) \"COAUTO-19 title\"",
    "[ticket\\]]: https://example.com/COAUTO-19",
    "",
    "> 0. ~~~",
    ">    COAUTO-19",
    ">    ~~~",
    "",
    "Link only COAUTO-19.",
  ].join("\n");
  const expected = markdown.replace(
    "Link only COAUTO-19.",
    "Link only [COAUTO-19](https://plane.example.com/engineering/browse/COAUTO-19).",
  );
  assert.equal(
    linkTrustedPlaneWorkItemReferences(markdown, [binding()]),
    expected,
  );
});

test("closes fenced blocks under wide ordered-list continuation indentation", () => {
  const markdown = [
    "123. ```md",
    "     COAUTO-19",
    "     ```",
    "After COAUTO-19.",
    "",
    "> 123) ~~~~",
    ">      COAUTO-19",
    ">      ~~~~",
    "> After COAUTO-19.",
    "",
    "- > 123. ```",
    "  >      COAUTO-19",
    "  >      ```",
    "After nested COAUTO-19.",
  ].join("\n");
  const linked = "[COAUTO-19](https://plane.example.com/engineering/browse/COAUTO-19)";
  assert.equal(
    linkTrustedPlaneWorkItemReferences(markdown, [binding()]),
    markdown
      .replace("After COAUTO-19.", `After ${linked}.`)
      .replace("> After COAUTO-19.", `> After ${linked}.`)
      .replace("After nested COAUTO-19.", `After nested ${linked}.`),
  );
});

test("ends reference definitions after their destination and optional title", () => {
  const markdown = [
    "[ticket\\]]: https://example.com/COAUTO-19",
    "Following COAUTO-19.",
    "",
    "[angle]: <https://example.com/COAUTO-19>",
    "  'COAUTO-19 title'",
    "After title COAUTO-19.",
    "",
    "[multiline]:",
    "  https://example.com/a_(COAUTO-19)",
    "  \"COAUTO-19 title\"",
    "After multiline COAUTO-19.",
  ].join("\n");
  const linked = "[COAUTO-19](https://plane.example.com/engineering/browse/COAUTO-19)";
  assert.equal(
    linkTrustedPlaneWorkItemReferences(markdown, [binding()]),
    markdown
      .replace("Following COAUTO-19.", `Following ${linked}.`)
      .replace("After title COAUTO-19.", `After title ${linked}.`)
      .replace("After multiline COAUTO-19.", `After multiline ${linked}.`),
  );
});

test("scopes block and inline HTML to one container and inline block", () => {
  const markdown = [
    "> <div>",
    "> COAUTO-19 remains HTML",
    "Outside quote COAUTO-19.",
    "> > <div>",
    "> > COAUTO-19 remains nested HTML",
    "> Outer quote COAUTO-19.",
    "Outside nested quote COAUTO-19.",
    "> <span><span>COAUTO-19</span> COAUTO-19</span>",
    "Outside inline COAUTO-19.",
  ].join("\n");
  const linked = "[COAUTO-19](https://plane.example.com/engineering/browse/COAUTO-19)";
  assert.equal(
    linkTrustedPlaneWorkItemReferences(markdown, [binding()]),
    markdown
      .replace("Outside quote COAUTO-19.", `Outside quote ${linked}.`)
      .replace("> Outer quote COAUTO-19.", `> Outer quote ${linked}.`)
      .replace(
        "Outside nested quote COAUTO-19.",
        `Outside nested quote ${linked}.`,
      )
      .replace("Outside inline COAUTO-19.", `Outside inline ${linked}.`),
  );
});

test("resets paragraph precedence at new list and quote containers", () => {
  const markdown = [
    "Outer paragraph",
    "-     COAUTO-19 is list-item code",
    "After list COAUTO-19.",
    "Outer paragraph again",
    ">     COAUTO-19 is quote code",
    "After quote COAUTO-19.",
  ].join("\n");
  const linked = "[COAUTO-19](https://plane.example.com/engineering/browse/COAUTO-19)";
  assert.equal(
    linkTrustedPlaneWorkItemReferences(markdown, [binding()]),
    markdown
      .replace("After list COAUTO-19.", `After list ${linked}.`)
      .replace("After quote COAUTO-19.", `After quote ${linked}.`),
  );
});

test("does not let a reference definition interrupt a paragraph", () => {
  const markdown = [
    "Active paragraph",
    '[ticket]: https://example.com "COAUTO-19 paragraph title"',
    "",
    '[valid]: https://example.com "COAUTO-19 definition title"',
    "After definition COAUTO-19.",
  ].join("\n");
  const linked = "[COAUTO-19](https://plane.example.com/engineering/browse/COAUTO-19)";
  assert.equal(
    linkTrustedPlaneWorkItemReferences(markdown, [binding()]),
    markdown
      .replace("COAUTO-19 paragraph title", `${linked} paragraph title`)
      .replace("After definition COAUTO-19.", `After definition ${linked}.`),
  );
});

test("validates CommonMark inline and type-7 HTML attributes", () => {
  const markdown = [
    "<x-tag =broken>",
    "Malformed block COAUTO-19.",
    "",
    "Before <x-tag =broken> malformed inline COAUTO-19.",
    "Before <span",
    ' data-note="> COAUTO-19">COAUTO-19</span> after COAUTO-19.',
    "",
    "<x-tag data-one=plain data-two='> COAUTO-19'>",
    "COAUTO-19 remains valid type-7 HTML",
    "",
    "<?ticket COAUTO-19?> <!DOCTYPE COAUTO-19>",
    "Outside declarations COAUTO-19.",
  ].join("\n");
  const linked = "[COAUTO-19](https://plane.example.com/engineering/browse/COAUTO-19)";
  assert.equal(
    linkTrustedPlaneWorkItemReferences(markdown, [binding()]),
    markdown
      .replace("Malformed block COAUTO-19.", `Malformed block ${linked}.`)
      .replace("malformed inline COAUTO-19.", `malformed inline ${linked}.`)
      .replace("after COAUTO-19.", `after ${linked}.`)
      .replace("Outside declarations COAUTO-19.", `Outside declarations ${linked}.`),
  );
});

test("covers the extended CommonMark container-transition matrix", () => {
  const protectedToken = "COAUTO-19";
  const linked = "[COAUTO-19](https://plane.example.com/engineering/browse/COAUTO-19)";
  const cases = [
    ["> <div>\n> COAUTO-19\nOutside COAUTO-19", `> <div>\n> ${protectedToken}\nOutside ${linked}`],
    ["> > <div>\n> > COAUTO-19\n> COAUTO-19", `> > <div>\n> > ${protectedToken}\n> ${linked}`],
    ["Paragraph\n-     COAUTO-19\nAfter COAUTO-19", `Paragraph\n-     ${protectedToken}\nAfter ${linked}`],
    ["Paragraph\n>     COAUTO-19\nAfter COAUTO-19", `Paragraph\n>     ${protectedToken}\nAfter ${linked}`],
    ["- > <div>\n  > COAUTO-19\nOutside COAUTO-19", `- > <div>\n  > ${protectedToken}\nOutside ${linked}`],
    ["# Heading COAUTO-19\n    COAUTO-19\nAfter COAUTO-19", `# Heading ${linked}\n    ${protectedToken}\nAfter ${linked}`],
    ["---\n    COAUTO-19\nAfter COAUTO-19", `---\n    ${protectedToken}\nAfter ${linked}`],
    ["Paragraph COAUTO-19\n\n    COAUTO-19\nAfter COAUTO-19", `Paragraph ${linked}\n\n    ${protectedToken}\nAfter ${linked}`],
    ["<x-tag good='>'>\nCOAUTO-19\n\nAfter COAUTO-19", `<x-tag good='>'>\n${protectedToken}\n\nAfter ${linked}`],
    ["<x-tag =bad>\nAfter COAUTO-19", `<x-tag =bad>\nAfter ${linked}`],
    ['[valid]: /url "COAUTO-19"\nAfter COAUTO-19', `[valid]: /url "${protectedToken}"\nAfter ${linked}`],
    ['Paragraph\n[not-definition]: /url "COAUTO-19"', `Paragraph\n[not-definition]: /url "${linked}"`],
  ];
  for (const [markdown, expected] of cases) {
    assert.equal(
      linkTrustedPlaneWorkItemReferences(markdown, [binding()]),
      expected,
      markdown,
    );
  }
});

test("protects balanced nested same-name inline HTML elements", () => {
  const markdown = [
    "<span><span>COAUTO-19</span> COAUTO-19</span>",
    "<SPAN title=\">\"><span /> COAUTO-19</SPAN>",
    "Outside COAUTO-19.",
  ].join("\n");
  assert.equal(
    linkTrustedPlaneWorkItemReferences(markdown, [binding()]),
    markdown.replace(
      "Outside COAUTO-19.",
      "Outside [COAUTO-19](https://plane.example.com/engineering/browse/COAUTO-19).",
    ),
  );
});

test("keeps quoted greater-than characters inside complete HTML tags", () => {
  const markdown = [
    '<span title="> COAUTO-19">COAUTO-19</span>',
    '<widget data-note="> COAUTO-19" /> Outside COAUTO-19.',
    "",
    '<custom-element title="> COAUTO-19">',
    "COAUTO-19 in a type-7 block",
    "",
    "After COAUTO-19.",
  ].join("\n");
  const linked = "[COAUTO-19](https://plane.example.com/engineering/browse/COAUTO-19)";
  assert.equal(
    linkTrustedPlaneWorkItemReferences(markdown, [binding()]),
    markdown
      .replace("Outside COAUTO-19.", `Outside ${linked}.`)
      .replace("After COAUTO-19.", `After ${linked}.`),
  );
});

test("preserves CommonMark autolinks, processing instructions, and declarations", () => {
  const markdown = [
    "<https://example.com/COAUTO-19>",
    "<irc://irc.example.com/COAUTO-19>",
    "<mailto:COAUTO-19@example.com>",
    "<COAUTO-19@example.com>",
    "<?ticket COAUTO-19?>",
    "<!DOCTYPE COAUTO-19>",
    "Outside COAUTO-19.",
  ].join("\n");
  assert.equal(
    linkTrustedPlaneWorkItemReferences(markdown, [binding()]),
    markdown.replace(
      "Outside COAUTO-19.",
      "Outside [COAUTO-19](https://plane.example.com/engineering/browse/COAUTO-19).",
    ),
  );
});

test("preserves a trusted reference anywhere in a GFM extended email autolink", () => {
  const markdown = [
    "Contact COAUTO-19@example.com.",
    "Local prefix.COAUTO-19@example-domain.test remains exact.",
    "Domain user@COAUTO-19.example remains exact.",
    "Suffix user@example.COAUTO-19 remains exact.",
    "Multiple COAUTO-19@example.com and user@COAUTO-19.example stay exact.",
  ].join("\n");
  assert.equal(
    linkTrustedPlaneWorkItemReferences(markdown, [binding()]),
    markdown,
  );
});

test("implements the bounded GFM extended email autolink grammar", () => {
  const linked = "[COAUTO-19](https://plane.example.com/engineering/browse/COAUTO-19)";
  const protectedCases = [
    "COAUTO-19@example.com",
    "first.last+COAUTO-19@example-domain.test",
    "user@COAUTO-19.example",
    "user@example.COAUTO-19",
    "a_b-c.COAUTO-19@a_b-c.d",
    "(COAUTO-19@example.com),",
    "éCOAUTO-19@example.com中",
    "\\COAUTO-19@example.com",
    "COAUTO-19@example.com COAUTO-19@second.example",
  ];
  for (const markdown of protectedCases) {
    assert.equal(
      linkTrustedPlaneWorkItemReferences(markdown, [binding()]),
      markdown,
      markdown,
    );
  }

  const linkableCases = [
    ["COAUTO-19", linked],
    ["COAUTO-19@example", `${linked}@example`],
    ["COAUTO-19@mail+xyz.example", `${linked}@mail+xyz.example`],
    ["COAUTO-19@example.com-", `${linked}@example.com-`],
    ["COAUTO-19@example.com_", `${linked}@example.com_`],
    ["COAUTO-19@example..com", `${linked}@example..com`],
    ["COAUTO-19@éxample.com", `${linked}@éxample.com`],
    ["COAUTO-19@example.测试", `${linked}@example.测试`],
    ["COAUTO-19\\@example.com", `${linked}\\@example.com`],
    ["COAUTO-19@example\\.com", `${linked}@example\\.com`],
    ["COAUTO\\-19@example.com", "COAUTO\\-19@example.com"],
  ];
  for (const [markdown, expected] of linkableCases) {
    assert.equal(
      linkTrustedPlaneWorkItemReferences(markdown, [binding()]),
      expected,
      markdown,
    );
  }
});

test("applies CommonMark code, paragraph, and tab-container precedence", () => {
  const markdown = [
    "`<span>` COAUTO-19 `</span>`",
    "\\`COAUTO-19\\`",
    "Paragraph continues",
    "    COAUTO-19 is paragraph text",
    "Paragraph before type 7",
    '<x-tag title="> COAUTO-19">',
    "COAUTO-19 remains paragraph text",
    "",
    "-\t```md",
    "\tCOAUTO-19",
    "\t```",
    "After tab fence COAUTO-19.",
    "",
    "- > -\t~~~",
    "- > -\tCOAUTO-19",
    "- > -\t~~~",
    "After mixed containers COAUTO-19.",
  ].join("\n");
  const linked = "[COAUTO-19](https://plane.example.com/engineering/browse/COAUTO-19)";
  assert.equal(
    linkTrustedPlaneWorkItemReferences(markdown, [binding()]),
    markdown
      .replace("`<span>` COAUTO-19", `\`<span>\` ${linked}`)
      .replace("\\`COAUTO-19\\`", `\\\`${linked}\\\``)
      .replace("    COAUTO-19 is", `    ${linked} is`)
      .replace("COAUTO-19 remains", `${linked} remains`)
      .replace("After tab fence COAUTO-19.", `After tab fence ${linked}.`)
      .replace("After mixed containers COAUTO-19.", `After mixed containers ${linked}.`),
  );
});

test("preserves multiline inline HTML attributes and resets inline block state", () => {
  const markdown = [
    "Before <span",
    ' title="COAUTO-19">COAUTO-19</span> after first COAUTO-19.',
    'and <span title="',
    'COAUTO-19">COAUTO-19</span> after second COAUTO-19.',
    "",
    "`unmatched COAUTO-19",
    "",
    "After unmatched code COAUTO-19.",
    "",
    "<span>unmatched COAUTO-19",
    "",
    "After unmatched HTML COAUTO-19</span>.",
    "",
    "<span><span>COAUTO-19</span> COAUTO-19</span>",
  ].join("\n");
  const linked = "[COAUTO-19](https://plane.example.com/engineering/browse/COAUTO-19)";
  assert.equal(
    linkTrustedPlaneWorkItemReferences(markdown, [binding()]),
    markdown
      .replace("after first COAUTO-19.", `after first ${linked}.`)
      .replace("after second COAUTO-19.", `after second ${linked}.`)
      .replace("`unmatched COAUTO-19", `\`unmatched ${linked}`)
      .replace("After unmatched code COAUTO-19.", `After unmatched code ${linked}.`)
      .replace("<span>unmatched COAUTO-19", `<span>unmatched ${linked}`)
      .replace(
        "After unmatched HTML COAUTO-19</span>.",
        `After unmatched HTML ${linked}</span>.`,
      ),
  );
});

test("applies block precedence after headings and thematic breaks", () => {
  const markdown = [
    "# Heading COAUTO-19",
    "    COAUTO-19 in indented code",
    "After code COAUTO-19.",
    "",
    "## HTML heading",
    '<x-tag title="COAUTO-19">',
    "COAUTO-19 in type-7 HTML",
    "",
    "After HTML COAUTO-19.",
    "",
    "---",
    "    COAUTO-19 after a thematic break",
    "After thematic code COAUTO-19.",
  ].join("\n");
  const linked = "[COAUTO-19](https://plane.example.com/engineering/browse/COAUTO-19)";
  assert.equal(
    linkTrustedPlaneWorkItemReferences(markdown, [binding()]),
    markdown
      .replace("# Heading COAUTO-19", `# Heading ${linked}`)
      .replace("After code COAUTO-19.", `After code ${linked}.`)
      .replace("After HTML COAUTO-19.", `After HTML ${linked}.`)
      .replace("After thematic code COAUTO-19.", `After thematic code ${linked}.`),
  );
});

test("uses CommonMark backslash and code-span delimiter precedence", () => {
  const markdown = [
    "`COAUTO-19\\` outside COAUTO-19.",
    "\\COAUTO-19 remains linkable.",
    "\\`COAUTO-19\\` remains escaped prose.",
  ].join("\n");
  const linked = "[COAUTO-19](https://plane.example.com/engineering/browse/COAUTO-19)";
  assert.equal(
    linkTrustedPlaneWorkItemReferences(markdown, [binding()]),
    [
      `\`COAUTO-19\\\` outside ${linked}.`,
      `\\${linked} remains linkable.`,
      `\\\`${linked}\\\` remains escaped prose.`,
    ].join("\n"),
  );
});

test("resets unmatched brackets at every inline block and container boundary", () => {
  const linked = "[COAUTO-19](https://plane.example.com/engineering/browse/COAUTO-19)";
  const cases = [
    ["Before [\n# COAUTO-19 ]", `Before [\n# ${linked} ]`],
    ["Before [\n> COAUTO-19 ]", `Before [\n> ${linked} ]`],
    ["- Before [\n- COAUTO-19 ]", `- Before [\n- ${linked} ]`],
    ["Before [\n---\nCOAUTO-19 ]", `Before [\n---\n${linked} ]`],
    ["Before [\n```\nprotected COAUTO-19\n```\nCOAUTO-19 ]", `Before [\n\`\`\`\nprotected COAUTO-19\n\`\`\`\n${linked} ]`],
    ["```\nprotected [\n```\nCOAUTO-19 ]", `\`\`\`\nprotected [\n\`\`\`\n${linked} ]`],
  ];
  for (const [markdown, expected] of cases) {
    assert.equal(
      linkTrustedPlaneWorkItemReferences(markdown, [binding()]),
      expected,
      markdown,
    );
  }

  const multiline = "[label\nCOAUTO-19](https://example.com) Outside COAUTO-19.";
  assert.equal(
    linkTrustedPlaneWorkItemReferences(multiline, [binding()]),
    multiline.replace("Outside COAUTO-19.", `Outside ${linked}.`),
  );
});

test("preserves link labels across lazy quote and list paragraph continuations", () => {
  const linked = "[COAUTO-19](https://plane.example.com/engineering/browse/COAUTO-19)";
  for (const markdown of [
    "> [label\nCOAUTO-19](https://example.com) Outside COAUTO-19.",
    "- [label\nCOAUTO-19](https://example.com) Outside COAUTO-19.",
  ]) {
    assert.equal(
      linkTrustedPlaneWorkItemReferences(markdown, [binding()]),
      markdown.replace("Outside COAUTO-19.", `Outside ${linked}.`),
      markdown,
    );
  }
});

test("lets only ordered list start 1 interrupt a CommonMark paragraph", () => {
  const linked = "[COAUTO-19](https://plane.example.com/engineering/browse/COAUTO-19)";
  const existing = "Before [\n2. COAUTO-19](https://example.com)";
  assert.equal(
    linkTrustedPlaneWorkItemReferences(existing, [binding()]),
    existing,
  );
  const cases = [
    ["Before [\n1. COAUTO-19](https://example.com)",
      `Before [\n1. ${linked}](https://example.com)`],
    ["Before [\n- COAUTO-19](https://example.com)",
      `Before [\n- ${linked}](https://example.com)`],
    ["Before [\n\n2. COAUTO-19](https://example.com)",
      `Before [\n\n2. ${linked}](https://example.com)`],
    ["- Before [\n  2. COAUTO-19](https://example.com)",
      "- Before [\n  2. COAUTO-19](https://example.com)"],
    ["- outer\n  2. Before [\n     COAUTO-19](https://example.com)",
      "- outer\n  2. Before [\n     COAUTO-19](https://example.com)"],
    ["[multiline\n2. COAUTO-19](https://example.com) Outside COAUTO-19.",
      `[multiline\n2. COAUTO-19](https://example.com) Outside ${linked}.`],
  ];
  for (const [markdown, expected] of cases) {
    assert.equal(
      linkTrustedPlaneWorkItemReferences(markdown, [binding()]),
      expected,
      markdown,
    );
  }
});

test("requires nonempty CommonMark list items to interrupt paragraphs", () => {
  const linked = "[COAUTO-19](https://plane.example.com/engineering/browse/COAUTO-19)";
  for (const marker of ["+", "+   ", "*", "*   ", "1)", "1)   "]) {
    const markdown = `Before [label\n${marker}\nCOAUTO-19](https://example.com)`;
    assert.equal(
      linkTrustedPlaneWorkItemReferences(markdown, [binding()]),
      markdown,
      JSON.stringify(marker),
    );
  }

  const cases = [
    ["Before [label\n+ COAUTO-19](https://example.com)",
      `Before [label\n+ ${linked}](https://example.com)`],
    ["Before [label\n* COAUTO-19](https://example.com)",
      `Before [label\n* ${linked}](https://example.com)`],
    ["Before [label\n1) COAUTO-19](https://example.com)",
      `Before [label\n1) ${linked}](https://example.com)`],
    ["Before [label\n01. COAUTO-19](https://example.com)",
      `Before [label\n01. ${linked}](https://example.com)`],
    ["Before [label\n01) COAUTO-19](https://example.com)",
      `Before [label\n01) ${linked}](https://example.com)`],
    ["Before [label\n000000001. COAUTO-19](https://example.com)",
      `Before [label\n000000001. ${linked}](https://example.com)`],
    ["Before [label\n2. COAUTO-19](https://example.com)",
      "Before [label\n2. COAUTO-19](https://example.com)"],
    ["Before [label\n02) COAUTO-19](https://example.com)",
      "Before [label\n02) COAUTO-19](https://example.com)"],
    ["Before [label\n   01) COAUTO-19](https://example.com)",
      `Before [label\n   01) ${linked}](https://example.com)`],
    ["Before [label\n    1) COAUTO-19](https://example.com)",
      "Before [label\n    1) COAUTO-19](https://example.com)"],
    ["Before [label\n\n+\n  COAUTO-19](https://example.com)",
      `Before [label\n\n+\n  ${linked}](https://example.com)`],
    ["Before [label\n\n*\n  COAUTO-19](https://example.com)",
      `Before [label\n\n*\n  ${linked}](https://example.com)`],
    ["Before [label\n\n1)\n   COAUTO-19](https://example.com)",
      `Before [label\n\n1)\n   ${linked}](https://example.com)`],
  ];
  for (const [markdown, expected] of cases) {
    assert.equal(
      linkTrustedPlaneWorkItemReferences(markdown, [binding()]),
      expected,
      markdown,
    );
  }
});

test("resets lazy container state at genuine CommonMark block boundaries", () => {
  const linked = "[COAUTO-19](https://plane.example.com/engineering/browse/COAUTO-19)";
  const cases = [
    ["> [label\n>\nCOAUTO-19](https://example.com) Outside COAUTO-19.",
      `> [label\n>\n${linked}](https://example.com) Outside ${linked}.`],
    ["- [label\n\nCOAUTO-19](https://example.com) Outside COAUTO-19.",
      `- [label\n\n${linked}](https://example.com) Outside ${linked}.`],
    ["> [label\n# COAUTO-19 ] Outside COAUTO-19.",
      `> [label\n# ${linked} ] Outside ${linked}.`],
    ["- [label\n# COAUTO-19 ] Outside COAUTO-19.",
      `- [label\n# ${linked} ] Outside ${linked}.`],
    ["> [label\n> > COAUTO-19 ] Outside COAUTO-19.",
      `> [label\n> > ${linked} ] Outside ${linked}.`],
    ["- [label\n  > COAUTO-19 ] Outside COAUTO-19.",
      `- [label\n  > ${linked} ] Outside ${linked}.`],
    ["> [label\n- COAUTO-19 ] Outside COAUTO-19.",
      `> [label\n- ${linked} ] Outside ${linked}.`],
    ["- [label\n- COAUTO-19 ] Outside COAUTO-19.",
      `- [label\n- ${linked} ] Outside ${linked}.`],
    ["> [label\n```\nCOAUTO-19\n```\nOutside COAUTO-19.",
      `> [label\n\`\`\`\nCOAUTO-19\n\`\`\`\nOutside ${linked}.`],
    ["- [label\n```\nCOAUTO-19\n```\nOutside COAUTO-19.",
      `- [label\n\`\`\`\nCOAUTO-19\n\`\`\`\nOutside ${linked}.`],
  ];
  for (const [markdown, expected] of cases) {
    assert.equal(
      linkTrustedPlaneWorkItemReferences(markdown, [binding()]),
      expected,
      markdown,
    );
  }
});

test("protects only complete case-sensitive inline HTML-like forms", () => {
  const linked = "[COAUTO-19](https://plane.example.com/engineering/browse/COAUTO-19)";
  const incomplete = [
    "Before <!-- COAUTO-19",
    "Before <?pi COAUTO-19",
    "Before <![CDATA[ COAUTO-19",
    "Before <!DOCTYPE COAUTO-19",
    "<![cdata[\nCOAUTO-19\n]]>",
  ];
  for (const markdown of incomplete) {
    assert.equal(
      linkTrustedPlaneWorkItemReferences(markdown, [binding()]),
      markdown.replace("COAUTO-19", linked),
      markdown,
    );
  }

  for (const markdown of [
    "Before <!--\nCOAUTO-19\n--> after COAUTO-19.",
    "Before <?pi\nCOAUTO-19\n?> after COAUTO-19.",
    "Before <!DOCTYPE\nCOAUTO-19> after COAUTO-19.",
    "Before <![CDATA[\nCOAUTO-19\n]]> after COAUTO-19.",
  ]) {
    assert.equal(
      linkTrustedPlaneWorkItemReferences(markdown, [binding()]),
      markdown.replace("after COAUTO-19.", `after ${linked}.`),
      markdown,
    );
  }
});

test("scans 10000, 25000, and 50000-character unmatched delimiters", () => {
  const verify = (seed, length) => {
    const markdown = seed.repeat(Math.ceil(length / seed.length)).slice(0, length);
    githubPullRequestCreateInputSchema.parse({
      repository: "example-org/example-repository",
      expectedHeadSha: "a".repeat(40),
      expectedBaseSha: "b".repeat(40),
      headBranch: "codeops/linear-scanner-proof",
      baseBranch: "main",
      title: "Prove bounded Markdown scanning",
      body: markdown,
      draft: true,
    });
    assert.equal(
      linkTrustedPlaneWorkItemReferences(markdown, [binding()]),
      markdown,
    );
  };
  for (const seed of ["[", "<", "<?ticket ", "<!DOCTYPE "]) {
    verify(seed, 2_000);
    for (const length of [10_000, 25_000, 50_000]) {
      verify(seed, length);
    }
  }
});

test("merges ordered range-heavy escapes without sorting", () => {
  const originalSort = Array.prototype.sort;
  let comparisons = 0;
  Array.prototype.sort = function (compare) {
    return originalSort.call(this, compare === undefined
      ? undefined
      : (left, right) => {
          comparisons++;
          return compare(left, right);
        });
  };
  try {
    for (const length of [10_000, 25_000, 50_000]) {
      const markdown = "\\*".repeat(Math.ceil(length / 2)).slice(0, length);
      assert.equal(linkTrustedPlaneWorkItemReferences(markdown, [binding()]), markdown);
    }
  } finally {
    Array.prototype.sort = originalSort;
  }
  assert.equal(comparisons, 0);
});

test("preserves deeply nested same-name HTML at scanner limits", () => {
  for (const length of [10_000, 25_000, 50_000]) {
    const pairs = Math.floor((length - "COAUTO-19".length) / 13);
    const markdown = `${"<span>".repeat(pairs)}COAUTO-19${"</span>".repeat(pairs)}`;
    assert.equal(linkTrustedPlaneWorkItemReferences(markdown, [binding()]), markdown);
  }
});

test("scans repeated unmatched link destinations in deterministic linear passes", () => {
  const verify = (length) => {
    const markdown = "[label](".repeat(Math.ceil(length / 8)).slice(0, length);
    githubPullRequestCreateInputSchema.parse({
      repository: "example-org/example-repository",
      expectedHeadSha: "a".repeat(40),
      expectedBaseSha: "b".repeat(40),
      headBranch: "codeops/linear-destination-proof",
      baseBranch: "main",
      title: "Prove bounded destination scanning",
      body: markdown,
      draft: true,
    });
    assert.equal(linkTrustedPlaneWorkItemReferences(markdown, [binding()]), markdown);
  };
  verify(2_000);
  for (const length of [10_000, 25_000, 50_000]) {
    verify(length);
  }
  assert.equal(
    linkTrustedPlaneWorkItemReferences(
      "[broken](COAUTO-19\n\nOutside COAUTO-19.",
      [binding()],
    ),
    "[broken](COAUTO-19\n\nOutside [COAUTO-19](https://plane.example.com/engineering/browse/COAUTO-19).",
  );
});

test("scans bounded invalid GFM email candidates in linear passes", () => {
  for (const length of [10_000, 25_000, 50_000]) {
    const half = Math.floor(length / 2);
    const noDomainDot = `${"a".repeat(half)}@${"b".repeat(length - half - 1)}`;
    const trailingUnderscore =
      `a@b.${"c".repeat(length - 6)}_`;
    for (const markdown of [noDomainDot, trailingUnderscore]) {
      const startedAt = performance.now();
      assert.equal(
        linkTrustedPlaneWorkItemReferences(markdown, [binding()]),
        markdown,
      );
      assert.ok(performance.now() - startedAt < 1_000, String(length));
    }
  }
});

test("keeps isolated structural performance probes below one second", () => {
  const probes = [
    ["unmatched brackets", "[".repeat(50_000)],
    ["range-heavy escapes", "\\*".repeat(25_000)],
    [
      "nested same-name HTML",
      `${"<span>".repeat(3_800)}COAUTO-19${"</span>".repeat(3_800)}`,
    ],
    ["unmatched destinations", "[label](".repeat(6_250)],
  ];
  for (const [name, markdown] of probes) {
    const startedAt = performance.now();
    const result = linkTrustedPlaneWorkItemReferences(markdown, [binding()]);
    const elapsedMs = performance.now() - startedAt;
    assert.equal(result, markdown, name);
    assert.ok(elapsedMs < 1_000, `${name}: ${elapsedMs.toFixed(3)}ms`);
  }
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
      "[COAUTO-19](https://plane.example.com/engineering/browse/COAUTO-19)",
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
  const token = "COAUTO-19";
  const continuations = [
    ["Latin letter", "é"],
    ["Cyrillic letter", "Ж"],
    ["CJK letter", "中"],
    ["full-width letter", "Ａ"],
    ["full-width number", "１"],
    ["combining mark", "\u0301"],
    ["connector punctuation", "‿"],
    ["full-width connector", "＿"],
    ["zero-width joiner", "\u200d"],
    ["word joiner", "\u2060"],
  ];
  for (const [name, continuation] of continuations) {
    for (const markdown of [
      `${continuation}${token}`,
      `${token}${continuation}`,
    ]) {
      assert.equal(
        linkTrustedPlaneWorkItemReferences(markdown, [binding()]),
        markdown,
        `${name}: ${JSON.stringify(markdown)}`,
      );
    }
  }

  const linked = `[${token}](https://plane.example.com/engineering/browse/${token})`;
  for (const [left, right] of [
    ["(", ")"],
    ["“", "”"],
    ["—", "…"],
    [" ", "\n"],
  ]) {
    assert.equal(
      linkTrustedPlaneWorkItemReferences(`${left}${token}${right}`, [binding()]),
      `${left}${linked}${right}`,
    );
  }
});
