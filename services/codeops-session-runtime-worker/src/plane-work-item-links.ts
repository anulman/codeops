import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";

import {
  trustedPlaneWorkItemReferenceSchema,
  type TrustedPlaneWorkItemReference,
} from "@codeops/codeops-contracts/session-broker";

type PositionedNode = {
  type: string;
  position?: {
    start: { offset?: number };
    end: { offset?: number };
  };
  children?: PositionedNode[];
  value?: string;
};

type Replacement = {
  start: number;
  end: number;
  value: string;
};

type Range = readonly [start: number, end: number];

const protectedAncestors = new Set([
  "code",
  "definition",
  "footnoteDefinition",
  "html",
  "inlineCode",
  "link",
  "linkReference",
]);

function canonicalUrl(binding: TrustedPlaneWorkItemReference): string {
  const path = `/${encodeURIComponent(binding.workspaceSlug)}/browse/${encodeURIComponent(binding.reference)}`;
  return new URL(path, binding.apiOrigin).href;
}

function canonicalIdentity(binding: TrustedPlaneWorkItemReference): string {
  return [
    binding.apiOrigin,
    binding.workspaceSlug,
    binding.workspaceId,
    binding.projectId,
    binding.projectIdentifier,
    binding.workItemId,
    String(binding.sequenceId),
  ].join("\0");
}

function offsets(node: PositionedNode): Range | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined ? null : [start, end];
}

function rawHtmlSyntaxRanges(root: PositionedNode): Range[] {
  const ranges: Range[] = [];
  const visit = (node: PositionedNode): void => {
    if (node.type === "html") {
      const range = offsets(node);
      if (range !== null) ranges.push(range);
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  return ranges.sort((left, right) => left[0] - right[0]);
}

function htmlElementTextRanges(
  markdown: string,
  root: PositionedNode,
): Range[] {
  const ranges: Range[] = [];
  const htmlSyntax = rawHtmlSyntaxRanges(root);
  const parserInput = markdown.split("");
  for (let index = 0; index < parserInput.length; index++) {
    if (parserInput[index] === "<" && !isInsideRange(index, htmlSyntax)) {
      parserInput[index] = " ";
    }
  }
  const fragment = parseFragment(parserInput.join(""), {
    sourceCodeLocationInfo: true,
  });
  const visit = (
    node: DefaultTreeAdapterTypes.Node,
    insideElement: boolean,
  ): void => {
    if (node.nodeName === "#text") {
      const location = node.sourceCodeLocation;
      if (insideElement && location !== undefined && location !== null) {
        ranges.push([location.startOffset, location.endOffset]);
      }
      return;
    }
    const nextInsideElement = insideElement || "tagName" in node;
    if ("childNodes" in node) {
      for (const child of node.childNodes) visit(child, nextInsideElement);
    }
    if ("content" in node) {
      visit(node.content, true);
    }
  };
  visit(fragment, false);
  ranges.sort((left, right) => left[0] - right[0] || right[1] - left[1]);
  return ranges;
}

function eligibleTextRanges(root: PositionedNode): Range[] {
  const ranges: Range[] = [];
  const walk = (node: PositionedNode, protectedSyntax: boolean): void => {
    const protectedNode = protectedSyntax || protectedAncestors.has(node.type);
    if (node.type === "text" && !protectedNode) {
      const range = offsets(node);
      if (range !== null) ranges.push(range);
      return;
    }
    for (const child of node.children ?? []) walk(child, protectedNode);
  };
  walk(root, false);
  return ranges;
}

function isInsideRange(start: number, ranges: readonly Range[]): boolean {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (ranges[middle]![1] <= start) low = middle + 1;
    else high = middle;
  }
  return ranges[low] !== undefined && ranges[low]![0] <= start;
}

/** Link only exact references backed by one canonical, trusted Plane identity. */
export function linkTrustedPlaneWorkItemReferences(
  markdown: string,
  rawBindings: readonly TrustedPlaneWorkItemReference[],
): string {
  if (rawBindings.length === 0 || markdown.length === 0) return markdown;
  const byReference = new Map<string, Map<string, TrustedPlaneWorkItemReference>>();
  for (const raw of rawBindings) {
    const binding = trustedPlaneWorkItemReferenceSchema.parse(raw);
    const identities = byReference.get(binding.reference) ?? new Map();
    identities.set(canonicalIdentity(binding), binding);
    byReference.set(binding.reference, identities);
  }
  const unambiguous = new Map<string, TrustedPlaneWorkItemReference>();
  for (const [reference, identities] of byReference) {
    if (identities.size === 1) {
      unambiguous.set(reference, identities.values().next().value!);
    }
  }
  if (unambiguous.size === 0) return markdown;

  const tree = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }) as PositionedNode;
  const htmlRanges = htmlElementTextRanges(markdown, tree);
  const references = [...unambiguous.keys()]
    .sort((left, right) => right.length - left.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const matcher = new RegExp(`(?:${references.join("|")})`, "g");
  const continuation = /[\p{L}\p{M}\p{N}\p{Pc}\p{Cf}-]/u;
  const characterBefore = (index: number): string => {
    if (index === 0) return "";
    const last = markdown.charCodeAt(index - 1);
    return last >= 0xdc00 && last <= 0xdfff && index >= 2 &&
        markdown.charCodeAt(index - 2) >= 0xd800 &&
        markdown.charCodeAt(index - 2) <= 0xdbff
      ? markdown.slice(index - 2, index)
      : markdown[index - 1]!;
  };
  const characterAfter = (index: number): string =>
    index >= markdown.length
      ? ""
      : String.fromCodePoint(markdown.codePointAt(index)!);

  const replacements: Replacement[] = [];
  for (const [rangeStart, rangeEnd] of eligibleTextRanges(tree)) {
    matcher.lastIndex = rangeStart;
    for (;;) {
      const match = matcher.exec(markdown);
      if (match === null || match.index >= rangeEnd) break;
      const start = match.index;
      const end = start + match[0].length;
      if (
        end <= rangeEnd &&
        !isInsideRange(start, htmlRanges) &&
        !continuation.test(characterBefore(start)) &&
        !continuation.test(characterAfter(end))
      ) {
        const binding = unambiguous.get(match[0])!;
        replacements.push({
          start,
          end,
          value: `[${match[0]}](${canonicalUrl(binding)})`,
        });
      }
      if (matcher.lastIndex >= rangeEnd) break;
    }
  }
  let result = markdown;
  for (let index = replacements.length - 1; index >= 0; index--) {
    const replacement = replacements[index]!;
    result = result.slice(0, replacement.start) + replacement.value +
      result.slice(replacement.end);
  }
  return result;
}
