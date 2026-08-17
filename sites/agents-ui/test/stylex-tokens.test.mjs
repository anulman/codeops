import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { parseAsync } from "@babel/core";

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const url = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    if (entry.isDirectory()) return sourceFiles(url);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [url] : [];
  }));
  return nested.flat();
}

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (["loc", "start", "end", "extra"].includes(key)) continue;
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit));
    else walk(value, visit);
  }
}

function keyName(property) {
  if (property?.key?.type === "StringLiteral" || property?.key?.type === "Identifier") {
    return property.key.name ?? property.key.value;
  }
  return null;
}

test("every literal sx token resolves before a route renders", async () => {
  const sourceDirectory = new URL("../src/", import.meta.url);
  const styleSource = await readFile(new URL("styles/sx.ts", sourceDirectory), "utf8");
  const styleAst = await parseAsync(styleSource, {
    filename: "sx.ts",
    parserOpts: { plugins: ["typescript", "jsx"] },
  });
  const known = new Set();
  walk(styleAst, (node) => {
    if (node.type !== "VariableDeclarator" || node.id?.type !== "Identifier") return;
    if (node.id.name === "utilityStyles" && node.init?.type === "CallExpression") {
      for (const property of node.init.arguments[0]?.properties ?? []) {
        const name = keyName(property);
        if (name) known.add(name);
      }
    }
    if (node.id.name === "structuralTokens" && node.init?.type === "NewExpression") {
      for (const element of node.init.arguments[0]?.elements ?? []) {
        if (element?.type === "StringLiteral") known.add(element.value);
      }
    }
  });

  const unresolved = new Set();
  for (const file of await sourceFiles(sourceDirectory)) {
    const source = await readFile(file, "utf8");
    const ast = await parseAsync(source, {
      filename: file.pathname,
      parserOpts: { plugins: ["typescript", "jsx"] },
    });
    walk(ast, (node) => {
      if (node.type !== "CallExpression" || node.callee?.type !== "Identifier" || node.callee.name !== "sx") return;
      for (const argument of node.arguments) {
        walk(argument, (literal) => {
          const value = literal.type === "StringLiteral"
            ? literal.value
            : literal.type === "TemplateElement"
              ? literal.value.cooked
              : null;
          for (const token of value?.split(/\s+/).filter(Boolean) ?? []) {
            if (!known.has(token) && /[-:[\]/]/.test(token)) unresolved.add(token);
          }
        });
      }
    });
  }
  assert.deepEqual([...unresolved].sort(), []);
});

test("dense typography keeps explicit leading proportional to its font size", async () => {
  const sourceDirectory = new URL("../src/", import.meta.url);
  const fontSizes = new Map([
    ["text-[8px]", 8],
    ["text-[9px]", 9],
    ["text-[10px]", 10],
    ["text-[11px]", 11],
  ]);
  const lineHeights = new Map([
    ["leading-3", 12],
    ["leading-4", 16],
    ["leading-5", 20],
    ["leading-6", 24],
  ]);
  const maximumLineHeight = new Map([
    [8, 12],
    [9, 12],
    [10, 16],
    [11, 16],
  ]);
  const violations = [];

  for (const file of await sourceFiles(sourceDirectory)) {
    const source = await readFile(file, "utf8");
    const ast = await parseAsync(source, {
      filename: file.pathname,
      parserOpts: { plugins: ["typescript", "jsx"] },
    });
    walk(ast, (node) => {
      if (node.type !== "CallExpression" || node.callee?.type !== "Identifier" || node.callee.name !== "sx") return;
      for (const argument of node.arguments) {
        walk(argument, (literal) => {
          const value = literal.type === "StringLiteral"
            ? literal.value
            : literal.type === "TemplateElement"
              ? literal.value.cooked
              : null;
          const tokens = value?.split(/\s+/).filter(Boolean) ?? [];
          const fontToken = tokens.find((token) => fontSizes.has(token));
          const leadingToken = tokens.find((token) => lineHeights.has(token));
          if (!fontToken || !leadingToken) return;
          const fontSize = fontSizes.get(fontToken);
          const lineHeight = lineHeights.get(leadingToken);
          if (lineHeight > maximumLineHeight.get(fontSize)) {
            violations.push(`${file.pathname}:${literal.loc?.start.line ?? "?"} ${fontToken} ${leadingToken}`);
          }
        });
      }
    });
  }

  assert.deepEqual(violations, []);
});

test("leading utilities use absolute pixel lengths instead of unitless multipliers", async () => {
  const styleSource = await readFile(new URL("../src/styles/sx.ts", import.meta.url), "utf8");
  for (const [token, lineHeight] of [
    ["leading-3", 12],
    ["leading-4", 16],
    ["leading-5", 20],
    ["leading-6", 24],
  ]) {
    assert.match(
      styleSource,
      new RegExp(`"${token}": \\{\\s*"lineHeight": "${lineHeight}px"\\s*\\}`),
      `${token} must compile to an absolute ${lineHeight}px line height`,
    );
  }
});
