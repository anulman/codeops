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
