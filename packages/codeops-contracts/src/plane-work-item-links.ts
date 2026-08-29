import {
  trustedPlaneWorkItemReferenceSchema,
  type TrustedPlaneWorkItemReference,
} from "./session-broker.js";

type Range = readonly [start: number, end: number];
type Container =
  | { type: "quote" }
  | { type: "list"; continuationColumns: number };

type ContainerContent = {
  content: string;
  containers: Container[];
  continued: boolean;
  startsNewBlock: boolean;
};

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

function expandTabs(line: string): string {
  let result = "";
  let column = 0;
  for (const character of line) {
    if (character === "\t") {
      const width = 4 - column % 4;
      result += " ".repeat(width);
      column += width;
    } else {
      result += character;
      column++;
    }
  }
  return result;
}

function listMarker(content: string): {
  content: string;
  continuationColumns: number;
  interruptsParagraph: boolean;
} | null {
  const marker = content.match(/^ {0,3}(?:[-+*]|([0-9]{1,9})[.)])/);
  if (marker === null) return null;
  const markerColumns = marker[0].length;
  let whitespace = 0;
  while (content[markerColumns + whitespace] === " ") whitespace++;
  if (whitespace === 0 && markerColumns < content.length) return null;
  // CommonMark treats five or more following columns as one column of list
  // padding. The remaining columns belong to the item content.
  const padding = whitespace === 0 || whitespace > 4 ? 1 : whitespace;
  const continuationColumns = markerColumns + padding;
  const itemContent = content.slice(continuationColumns);
  return {
    content: itemContent,
    continuationColumns,
    interruptsParagraph: itemContent.trim() !== "" &&
      (marker[1] === undefined || Number(marker[1]) === 1),
  };
}

function contentAfterContainers(
  rawLine: string,
  continuationContainers: readonly Container[] = [],
  paragraphContinuation = false,
): ContainerContent {
  let content = expandTabs(rawLine);
  const containers: Container[] = [];
  let startsNewBlock = false;
  for (const container of continuationContainers) {
    if (container.type === "quote") {
      const quote = content.match(/^ {0,3}> ?/);
      if (quote === null) {
        return { content, containers, continued: false, startsNewBlock };
      }
      content = content.slice(quote[0].length);
    } else {
      const indentation = content.match(/^ */)![0].length;
      if (indentation < container.continuationColumns) {
        const replacementMarker = listMarker(content);
        if (
          replacementMarker === null ||
          (paragraphContinuation && !replacementMarker.interruptsParagraph)
        ) {
          return { content, containers, continued: false, startsNewBlock };
        }
        content = replacementMarker.content;
        startsNewBlock = true;
      } else {
        content = content.slice(container.continuationColumns);
      }
    }
    containers.push(container);
  }
  for (;;) {
    const quote = content.match(/^ {0,3}> ?/);
    if (quote !== null) {
      containers.push({ type: "quote" });
      content = content.slice(quote[0].length);
      startsNewBlock = true;
      continue;
    }
    const list = listMarker(content);
    if (list !== null) {
      if (paragraphContinuation && !list.interruptsParagraph) break;
      containers.push({
        type: "list",
        continuationColumns: list.continuationColumns,
      });
      content = list.content;
      startsNewBlock = true;
      continue;
    }
    break;
  }
  return { content, containers, continued: true, startsNewBlock };
}

function sameContainers(
  left: readonly Container[],
  right: readonly Container[],
): boolean {
  return left.length === right.length && left.every((container, index) => {
    const other = right[index];
    return other !== undefined && container.type === other.type &&
      (container.type === "quote" ||
        (other.type === "list" &&
          container.continuationColumns === other.continuationColumns));
  });
}

function parseContainerLine(
  line: string,
  previous: readonly Container[],
): ContainerContent {
  const continued = contentAfterContainers(line, previous);
  return continued.continued ? continued : contentAfterContainers(line);
}

function definitionTitle(text: string): boolean {
  const value = text.trim();
  if (value.length < 2) return false;
  const close = value[0] === "(" ? ")" : value[0];
  if (close !== "\"" && close !== "'" && close !== ")") return false;
  if (value.at(-1) !== close) return false;
  for (let cursor = 1; cursor < value.length - 1; cursor++) {
    if (value[cursor] === "\\") {
      cursor++;
    } else if (value[cursor] === close) {
      return false;
    }
  }
  return true;
}

function definitionDestination(
  text: string,
): { valid: boolean; acceptsTitle: boolean } {
  let cursor = 0;
  while (text[cursor] === " " || text[cursor] === "\t") cursor++;
  if (cursor === text.length) return { valid: false, acceptsTitle: false };
  if (text[cursor] === "<") {
    cursor++;
    let closed = false;
    for (; cursor < text.length; cursor++) {
      if (text[cursor] === "\\") {
        cursor++;
      } else if (text[cursor] === ">") {
        cursor++;
        closed = true;
        break;
      } else if (text[cursor] === "<") {
        return { valid: false, acceptsTitle: false };
      }
    }
    if (!closed) return { valid: false, acceptsTitle: false };
  } else {
    let depth = 0;
    const start = cursor;
    for (; cursor < text.length; cursor++) {
      const character = text[cursor];
      if (character === "\\") {
        cursor++;
      } else if ((character === " " || character === "\t") && depth === 0) {
        break;
      } else if (character === "(") {
        depth++;
      } else if (character === ")") {
        if (depth === 0) return { valid: false, acceptsTitle: false };
        depth--;
      }
    }
    if (cursor === start || depth !== 0) {
      return { valid: false, acceptsTitle: false };
    }
  }
  const remainder = text.slice(cursor).trim();
  return remainder === ""
    ? { valid: true, acceptsTitle: true }
    : { valid: definitionTitle(remainder), acceptsTitle: false };
}

function definitionContinuation(line: string): string | null {
  const match = line.match(/^(?: {1,3}|\t)(.*)$/);
  return match?.[1] ?? null;
}

function definitionEnd(lines: readonly string[], start: number): number | null {
  const content = contentAfterContainers(lines[start]!).content;
  const opening = content.match(/^ {0,3}\[(?:\\.|[^\]\\\r\n])+\]:(.*)$/);
  if (opening === null) return null;
  let destination = definitionDestination(opening[1]!);
  let end = start;
  if (!destination.valid) {
    if (opening[1]!.trim() !== "" || start + 1 >= lines.length) return null;
    const continuation = definitionContinuation(
      contentAfterContainers(lines[start + 1]!).content,
    );
    if (continuation === null) return null;
    destination = definitionDestination(continuation);
    if (!destination.valid) return null;
    end++;
  }
  if (destination.acceptsTitle && end + 1 < lines.length) {
    const possibleTitle = definitionContinuation(
      contentAfterContainers(lines[end + 1]!).content,
    );
    if (possibleTitle !== null && definitionTitle(possibleTitle)) end++;
  }
  return end;
}

function htmlTag(
  text: string,
  start: number,
  limit = text.length,
): { end: number; name: string; closing: boolean; selfClosing: boolean } | null {
  if (text[start] !== "<") return null;
  let cursor = start + 1;
  let closing = false;
  if (text[cursor] === "/") {
    closing = true;
    cursor++;
  }
  const nameStart = cursor;
  while (/[A-Za-z0-9-]/.test(text[cursor] ?? "")) cursor++;
  if (
    cursor === nameStart ||
    !/[A-Za-z]/.test(text[nameStart]!) ||
    !/[\s/>]/.test(text[cursor] ?? "")
  ) return null;
  const name = text.slice(nameStart, cursor).toLowerCase();
  const whitespace = /[\t\n\f\r ]/;
  const skipWhitespace = (): void => {
    while (cursor < limit && whitespace.test(text[cursor]!)) cursor++;
  };
  if (closing) {
    skipWhitespace();
    return text[cursor] === ">"
      ? { end: cursor + 1, name, closing: true, selfClosing: false }
      : null;
  }
  for (;;) {
    const beforeWhitespace = cursor;
    skipWhitespace();
    if (text[cursor] === ">") {
      return { end: cursor + 1, name, closing: false, selfClosing: false };
    }
    if (text[cursor] === "/" && text[cursor + 1] === ">") {
      return { end: cursor + 2, name, closing: false, selfClosing: true };
    }
    // Attributes must be separated from the tag name or previous attribute.
    if (cursor === beforeWhitespace || cursor >= limit) return null;
    if (!/[A-Za-z_:]/.test(text[cursor]!)) return null;
    cursor++;
    while (cursor < limit && /[A-Za-z0-9_.:-]/.test(text[cursor]!)) cursor++;
    skipWhitespace();
    if (text[cursor] !== "=") continue;
    cursor++;
    skipWhitespace();
    const quote = text[cursor];
    if (quote === "\"" || quote === "'") {
      cursor++;
      while (cursor < limit && text[cursor] !== quote) cursor++;
      if (cursor >= limit) return null;
      cursor++;
      continue;
    }
    const valueStart = cursor;
    while (
      cursor < limit &&
      !whitespace.test(text[cursor]!) &&
      !/[\"'=<>`]/.test(text[cursor]!)
    ) cursor++;
    if (cursor === valueStart) return null;
  }
}

function isNonParagraphLine(content: string): boolean {
  return content.trim() === "" ||
    /^ {0,3}#{1,6}(?:[ \t]+|$)/.test(content) ||
    /^ {0,3}(?:=+[ \t]*|-+[ \t]*)$/.test(content) ||
    /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/.test(
      content,
    );
}

function completeHtmlTagLine(content: string): boolean {
  const indentation = content.match(/^ {0,3}/)![0].length;
  const tag = htmlTag(content, indentation);
  return tag !== null && content.slice(tag.end).trim() === "";
}

function protectedBlockRanges(markdown: string): Range[] {
  const ranges: Range[] = [];
  let offset = 0;
  let fence: {
    character: string;
    length: number;
    containers: readonly Container[];
  } | null = null;
  let html: {
    close: RegExp | null;
    untilBlank: boolean;
    containers: readonly Container[];
  } | null = null;
  let paragraph = false;
  let previousContainers: readonly Container[] = [];
  const lineEndings = markdown.match(/.*(?:\r?\n|$)/g)?.filter(Boolean) ?? [];
  const lines = lineEndings.map((line) => line.replace(/\r?\n$/, ""));
  for (let index = 0; index < lineEndings.length; index++) {
    const lineWithEnding = lineEndings[index]!;
    const line = lineWithEnding.replace(/\r?\n$/, "");
    const stateContainers = fence?.containers ?? html?.containers;
    let parsed = contentAfterContainers(
      line,
      stateContainers ?? previousContainers,
      stateContainers === undefined && paragraph,
    );
    if (
      stateContainers !== undefined &&
      (!parsed.continued || (html !== null && parsed.startsNewBlock) ||
        !sameContainers(parsed.containers, stateContainers))
    ) {
      fence = null;
      html = null;
      parsed = parseContainerLine(line, previousContainers);
    } else if (!parsed.continued) {
      parsed = contentAfterContainers(line, [], paragraph);
    }
    const containerTransition = parsed.startsNewBlock ||
      !sameContainers(previousContainers, parsed.containers);
    if (containerTransition) paragraph = false;
    const content = parsed.content;
    let protect = fence !== null || html !== null;
    if (fence !== null) {
      const close = content.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (
        close !== null &&
        close[1]![0] === fence.character &&
        close[1]!.length >= fence.length
      ) {
        fence = null;
      }
    } else if (html !== null) {
      if (html.untilBlank && content.trim() === "") {
        html = null;
        protect = false;
      } else if (html.close?.test(content)) {
        html = null;
      }
    } else {
      const openingFence = content.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (
        openingFence !== null &&
        (openingFence[1]![0] !== "`" || !openingFence[2]!.includes("`"))
      ) {
        fence = {
          character: openingFence[1]![0]!,
          length: openingFence[1]!.length,
          containers: parsed.containers,
        };
        protect = true;
        paragraph = false;
      } else if (/^ {4}/.test(content) && !paragraph) {
        protect = true;
      } else {
        // Link reference definitions have lower precedence than paragraphs.
        const definitionLastLine = paragraph ? null : definitionEnd(lines, index);
        if (definitionLastLine !== null) {
          let consumedContainers = parsed.containers;
          for (; index <= definitionLastLine; index++) {
            const length = lineEndings[index]!.length;
            ranges.push([offset, offset + length]);
            offset += length;
            if (index < definitionLastLine) {
              consumedContainers = parseContainerLine(
                lines[index + 1]!,
                consumedContainers,
              ).containers;
            }
          }
          index--;
          paragraph = false;
          previousContainers = consumedContainers;
          continue;
        }
        const htmlOpening = content.match(
          /^ {0,3}(?:(<!--)|(<\?)|(<!\[CDATA\[)|(<![A-Z])|<(script|pre|style|textarea)(?:\s|>|$)|<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|\/?>|$))/i,
        );
        const validHtmlOpening = htmlOpening !== null &&
          (htmlOpening[3] === undefined || htmlOpening[3] === "<![CDATA[");
        if (validHtmlOpening && htmlOpening !== null) {
          protect = true;
          let close: RegExp | null = null;
          let untilBlank = false;
          if (htmlOpening[1] !== undefined) {
            close = content.includes("-->") ? null : /-->/;
          } else if (htmlOpening[2] !== undefined) {
            close = content.includes("?>") ? null : /\?>/;
          } else if (htmlOpening[3] !== undefined) {
            close = content.includes("]]>") ? null : /\]\]>/;
          } else if (htmlOpening[4] !== undefined) {
            close = content.includes(">") ? null : />/;
          } else if (htmlOpening[5] !== undefined) {
            const tag = htmlOpening[5];
            if (!new RegExp(`</${tag}>`, "i").test(content)) {
              close = new RegExp(`</${tag}>`, "i");
            }
          } else {
            untilBlank = true;
          }
          html = close === null && !untilBlank
            ? null
            : { close, untilBlank, containers: parsed.containers };
          paragraph = false;
        } else if (!paragraph && completeHtmlTagLine(content)) {
          // CommonMark type-7 HTML blocks cannot interrupt a paragraph.
          protect = true;
          html = {
            close: null,
            untilBlank: true,
            containers: parsed.containers,
          };
          paragraph = false;
        }
      }
    }
    if (protect) ranges.push([offset, offset + lineWithEnding.length]);
    if (!protect) paragraph = !isNonParagraphLine(content);
    previousContainers = parsed.containers;
    offset += lineWithEnding.length;
  }
  return ranges;
}

function mergeRanges(ranges: readonly Range[]): Range[] {
  let ordered = true;
  for (let index = 1; index < ranges.length; index++) {
    const previous = ranges[index - 1]!;
    const current = ranges[index]!;
    if (
      current[0] < previous[0] ||
      (current[0] === previous[0] && current[1] < previous[1])
    ) {
      ordered = false;
      break;
    }
  }
  const sorted = ordered
    ? ranges
    : [...ranges].sort(
        (left, right) => left[0] - right[0] || left[1] - right[1],
      );
  const merged: Range[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous === undefined || range[0] > previous[1]) {
      merged.push(range);
    } else if (range[1] > previous[1]) {
      merged[merged.length - 1] = [previous[0], range[1]];
    }
  }
  return merged;
}

function inlineBlockRanges(markdown: string, blocks: readonly Range[]): Range[] {
  const ranges: Range[] = [];
  const mergedBlocks = mergeRanges(blocks);
  const lineEndings = markdown.match(/.*(?:\r?\n|$)/g)?.filter(Boolean) ?? [];
  let offset = 0;
  let start: number | null = null;
  let blockIndex = 0;
  let previousContainers: readonly Container[] = [];
  const close = (end: number): void => {
    if (start !== null && start < end) ranges.push([start, end]);
    start = null;
  };
  for (const lineWithEnding of lineEndings) {
    const end = offset + lineWithEnding.length;
    const line = lineWithEnding.replace(/\r?\n$/, "");
    while (
      blockIndex < mergedBlocks.length &&
      mergedBlocks[blockIndex]![1] <= offset
    ) blockIndex++;
    const block = mergedBlocks[blockIndex];
    const continued = contentAfterContainers(
      line,
      previousContainers,
      start !== null,
    );
    const contentStartsContainer = contentAfterContainers(
      continued.content,
      [],
      start !== null,
    )
      .startsNewBlock;
    const lazyContinuation = start !== null &&
      !continued.continued &&
      (block === undefined || block[0] > offset) &&
      continued.content.trim() !== "" &&
      !isNonParagraphLine(continued.content) &&
      !contentStartsContainer;
    const parsed = continued.continued
      ? continued
      : lazyContinuation
        ? {
            ...continued,
            containers: [...previousContainers],
            continued: true,
          }
        : contentAfterContainers(line);
    if (
      parsed.startsNewBlock ||
      !sameContainers(previousContainers, parsed.containers)
    ) close(offset);
    if (block !== undefined && block[0] <= offset) {
      close(offset);
      previousContainers = parsed.containers;
      offset = end;
      continue;
    }
    const content = parsed.content;
    if (content.trim() === "") {
      close(offset);
    } else if (isNonParagraphLine(content)) {
      close(offset);
      ranges.push([offset, end]);
    } else {
      start ??= offset;
    }
    previousContainers = parsed.containers;
    offset = end;
  }
  close(markdown.length);
  return ranges;
}

function inlineProtectedRanges(markdown: string, blocks: readonly Range[]): Range[] {
  const ranges: Range[] = [...blocks];
  const escaped = new Uint8Array(markdown.length);
  const escapablePunctuation = /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]$/;
  for (let cursor = 0; cursor + 1 < markdown.length;) {
    if (
      markdown[cursor] === "\\" &&
      escapablePunctuation.test(markdown[cursor + 1]!)
    ) {
      escaped[cursor + 1] = 1;
      ranges.push([cursor, cursor + 2]);
      cursor += 2;
    } else {
      cursor++;
    }
  }

  // Resolve code spans before looking for HTML. A delimiter run closes only a
  // run of exactly the same length. Backslashes can escape an opener in prose,
  // but they are literal characters once a code span has opened.
  const inlineBlocks = inlineBlockRanges(markdown, blocks);
  for (const inlineBlock of inlineBlocks) {
    const ticks: { start: number; end: number; length: number }[] = [];
    for (let cursor = inlineBlock[0]; cursor < inlineBlock[1];) {
      if (markdown[cursor] !== "`") {
        cursor++;
        continue;
      }
      const start = cursor;
      while (cursor < inlineBlock[1] && markdown[cursor] === "`") cursor++;
      ticks.push({ start, end: cursor, length: cursor - start });
    }
    const nextTick = new Map<number, number>();
    const nextByLength = new Map<number, number>();
    for (let index = ticks.length - 1; index >= 0; index--) {
      const tick = ticks[index]!;
      const next = nextByLength.get(tick.length);
      if (next !== undefined) nextTick.set(index, next);
      nextByLength.set(tick.length, index);
    }
    for (let index = 0; index < ticks.length;) {
      if (escaped[ticks[index]!.start] === 1) {
        index++;
        continue;
      }
      const close = nextTick.get(index);
      if (close === undefined) {
        index++;
      } else {
        ranges.push([ticks[index]!.start, ticks[close]!.end]);
        index = close + 1;
      }
    }
  }

  const codeAndBlocks = mergeRanges(ranges);
  let protectedIndex = 0;
  const inCodeOrBlock = (index: number): boolean => {
    while (
      protectedIndex < codeAndBlocks.length &&
      codeAndBlocks[protectedIndex]![1] <= index
    ) protectedIndex++;
    const range = codeAndBlocks[protectedIndex];
    return range !== undefined && range[0] <= index;
  };

  const autolinkPattern =
    /<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^ <>\u0000-\u0020]*|[A-Za-z0-9.!#$%&'*+/=?^_\`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/y;
  for (const inlineBlock of inlineBlocks) {
    const htmlOpenings = new Map<string, number[]>();
    for (let cursor = inlineBlock[0]; cursor < inlineBlock[1];) {
      if (
        markdown[cursor] !== "<" ||
        escaped[cursor] === 1 ||
        inCodeOrBlock(cursor)
      ) {
        cursor++;
        continue;
      }
    if (markdown.startsWith("<!--", cursor)) {
      const close = markdown.indexOf("-->", cursor + 4);
      if (close >= 0 && close + 3 <= inlineBlock[1]) {
        const end = close + 3;
        ranges.push([cursor, end]);
        cursor = end;
        continue;
      }
    }
    autolinkPattern.lastIndex = cursor;
    const autolink = autolinkPattern.exec(markdown);
    if (autolink !== null && cursor + autolink[0].length <= inlineBlock[1]) {
      ranges.push([cursor, cursor + autolink[0].length]);
      cursor += autolink[0].length;
      continue;
    }
    const inlineHtmlClose = markdown.startsWith("<?", cursor)
      ? "?>"
      : markdown.startsWith("<![CDATA[", cursor)
        ? "]]>"
        : markdown[cursor + 1] === "!" &&
            /[A-Z]/.test(markdown[cursor + 2] ?? "")
          ? ">"
          : null;
    if (inlineHtmlClose !== null) {
      const close = markdown.indexOf(inlineHtmlClose, cursor + 2);
      if (close >= 0 && close + inlineHtmlClose.length <= inlineBlock[1]) {
        const end = close + inlineHtmlClose.length;
        ranges.push([cursor, end]);
        cursor = end;
        continue;
      }
    }
    const tag = htmlTag(markdown, cursor, inlineBlock[1]);
    if (tag === null) {
      cursor++;
      continue;
    }
    ranges.push([cursor, tag.end]);
    if (tag.closing) {
      const openings = htmlOpenings.get(tag.name);
      const start = openings?.pop();
      if (start !== undefined) ranges.push([start, tag.end]);
    } else if (!tag.selfClosing) {
      const openings = htmlOpenings.get(tag.name) ?? [];
      openings.push(cursor);
      htmlOpenings.set(tag.name, openings);
    }
    cursor = tag.end;
    }
  }

  for (const match of markdown.matchAll(/(?:https?:\/\/|www\.)[^\s<>]+/gi)) {
    ranges.push([match.index, match.index + match[0].length]);
  }

  // GFM extended email autolinks use a narrower grammar than CommonMark
  // angle-bracket email autolinks. Protect only the complete ASCII address:
  // a .-_+ local part, a . separated -_ domain, at least one domain dot, and
  // an alphanumeric final domain character. Scan around each @ once so a
  // maximum-length invalid address cannot cause regular-expression backtracking.
  const emailExclusions = mergeRanges(ranges);
  let emailExclusionIndex = 0;
  const asciiAlphanumeric = (character: string): boolean =>
    character >= "0" && character <= "9" ||
    character >= "A" && character <= "Z" ||
    character >= "a" && character <= "z";
  const emailLocalCharacter = (character: string): boolean =>
    asciiAlphanumeric(character) || ".-_+".includes(character);
  const emailDomainCharacter = (character: string): boolean =>
    asciiAlphanumeric(character) || ".-_".includes(character);
  for (const inlineBlock of inlineBlocks) {
    for (let cursor = inlineBlock[0]; cursor < inlineBlock[1];) {
      const at = markdown.indexOf("@", cursor);
      if (at < 0 || at >= inlineBlock[1]) break;
      let start = at;
      while (
        start > inlineBlock[0] && emailLocalCharacter(markdown[start - 1]!)
      ) start--;
      let domainEnd = at + 1;
      while (
        domainEnd < inlineBlock[1] &&
        emailDomainCharacter(markdown[domainEnd]!)
      ) domainEnd++;
      cursor = Math.max(at + 1, domainEnd);
      let end = domainEnd;
      while (end > at + 1 && markdown[end - 1] === ".") end--;
      let hasDot = false;
      let emptySegment = true;
      for (let domainCursor = at + 1; domainCursor < end; domainCursor++) {
        if (markdown[domainCursor] === ".") {
          if (emptySegment) break;
          hasDot = true;
          emptySegment = true;
        } else {
          emptySegment = false;
        }
      }
      if (
        start === at || !hasDot || emptySegment ||
        !asciiAlphanumeric(markdown[end - 1] ?? "")
      ) continue;
      while (
        emailExclusionIndex < emailExclusions.length &&
        emailExclusions[emailExclusionIndex]![1] <= start
      ) emailExclusionIndex++;
      const exclusion = emailExclusions[emailExclusionIndex];
      if (exclusion === undefined || exclusion[0] >= end) {
        ranges.push([start, end]);
      }
    }
  }

  const preliminary = mergeRanges(ranges);
  let preliminaryIndex = 0;
  const inPreliminary = (index: number): boolean => {
    while (
      preliminaryIndex < preliminary.length && preliminary[preliminaryIndex]![1] <= index
    ) preliminaryIndex++;
    const range = preliminary[preliminaryIndex];
    return range !== undefined && range[0] <= index;
  };

  const bracketCloses = new Map<number, number>();
  for (const inlineBlock of inlineBlocks) {
    const bracketStack: number[] = [];
    for (let cursor = inlineBlock[0]; cursor < inlineBlock[1]; cursor++) {
      if (inPreliminary(cursor) || escaped[cursor] === 1) continue;
      const possibleCdata = markdown.slice(cursor, cursor + 9);
      if (
        possibleCdata !== "<![CDATA[" &&
        possibleCdata.toLowerCase() === "<![cdata["
      ) {
        cursor += possibleCdata.length - 1;
        continue;
      }
      if (markdown[cursor] === "[") bracketStack.push(cursor);
      if (markdown[cursor] === "]") {
        const opening = bracketStack.pop();
        if (opening !== undefined) bracketCloses.set(opening, cursor);
      }
    }
  }

  const closingDestination = (
    opening: number,
    boundary: number,
  ): { close: number | null; boundary: number } => {
    let depth = 1;
    let quote: "\"" | "'" | null = null;
    for (let cursor = opening + 1; cursor < boundary; cursor++) {
      const character = markdown[cursor];
      if (escaped[cursor] === 1) continue;
      if (quote !== null) {
        if (character === quote) quote = null;
        continue;
      }
      if (character === "\"" || character === "'") {
        quote = character;
      } else if (character === "(") {
        depth++;
      } else if (character === ")" && --depth === 0) {
        return { close: cursor, boundary: cursor + 1 };
      }
    }
    return { close: null, boundary };
  };
  for (const inlineBlock of inlineBlocks) {
    for (let cursor = inlineBlock[0]; cursor < inlineBlock[1]; cursor++) {
      if (markdown[cursor] !== "[" || escaped[cursor] === 1) continue;
      const close = bracketCloses.get(cursor);
      if (close === undefined) continue;
      const start = cursor > inlineBlock[0] && markdown[cursor - 1] === "!" &&
          escaped[cursor - 1] !== 1
        ? cursor - 1
        : cursor;
      let end = close + 1;
      if (markdown[end] === "(") {
        const destination = closingDestination(end, inlineBlock[1]);
        end = destination.close === null
          ? destination.boundary
          : destination.close + 1;
      } else if (markdown[end] === "[") {
        const referenceClose = bracketCloses.get(end);
        if (referenceClose !== undefined) end = referenceClose + 1;
      }
      ranges.push([start, end]);
      cursor = end - 1;
    }
  }
  return mergeRanges(ranges);
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

  const ranges = inlineProtectedRanges(markdown, protectedBlockRanges(markdown));
  const references = [...unambiguous.keys()]
    .sort((left, right) => right.length - left.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const matcher = new RegExp(
    `(?:${references.join("|")})`,
    "g",
  );
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
  let result = "";
  let cursor = 0;
  let rangeIndex = 0;
  for (const match of markdown.matchAll(matcher)) {
    const start = match.index!;
    const end = start + match[0].length;
    if (
      continuation.test(characterBefore(start)) ||
      continuation.test(characterAfter(end))
    ) continue;
    while (rangeIndex < ranges.length && ranges[rangeIndex]![1] <= start) {
      rangeIndex++;
    }
    const range = ranges[rangeIndex];
    if (range !== undefined && range[0] <= start) continue;
    const binding = unambiguous.get(match[0])!;
    result += markdown.slice(cursor, start);
    result += `[${match[0]}](${canonicalUrl(binding)})`;
    cursor = end;
  }
  return cursor === 0 ? markdown : result + markdown.slice(cursor);
}
