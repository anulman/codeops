import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";

// Execute the emitted entrypoint's complete runtime HTTP try/catch, including
// its actual callback wiring and error mapping. Do not boot unrelated cluster
// controllers or substitute a second hand-written route in this regression.
export async function entrypointRuntimeRoute(name, { database, token, workerId }) {
  const url = new URL(`../dist/${name}.js`, import.meta.url);
  const source = ts.createSourceFile(url.pathname, await readFile(url, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const routes = [];
  const visit = (node) => {
    if (ts.isTryStatement(node) && node.tryBlock.statements.some((statement) =>
      ts.isVariableStatement(statement) && statement.declarationList.declarations.some((declaration) =>
        declaration.initializer && ts.isAwaitExpression(declaration.initializer) &&
        ts.isCallExpression(declaration.initializer.expression) &&
        declaration.initializer.expression.expression.getText(source) === "serveSessionRuntime"))) routes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.equal(routes.length, 1, `${name} must mount exactly one runtime route`);
  const route = routes[0].getText(source);
  const scope = { Buffer, database, secrets: { workerToken: token }, workerId,
    sessionRuntimeWorkerToken: token, sessionRuntimeWorkerId: workerId,
    configuredWorkItemProvider: undefined, configuredGitHubReadProvider: undefined,
    configuredGitHubMutationProvider: undefined };
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const used = bindings.elements.filter((binding) => new RegExp(`\\b${binding.name.text}\\b`).test(route));
    if (!used.length) continue;
    const specifier = statement.moduleSpecifier.text;
    const module = await import(specifier.startsWith(".") ? new URL(specifier, url).href : specifier);
    for (const binding of used) scope[binding.name.text] = module[(binding.propertyName ?? binding.name).text];
  }
  const helpers = ["readJson", "json"].map((name) => {
    const declaration = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(declaration, name);
    return declaration.getText(source);
  }).join("\n");
  return vm.runInNewContext(`(function () { const MAX_BODY_BYTES = 1024 * 1024; ${helpers}; return async (request, response) => { ${route} }; })()`, scope, { filename: url.pathname });
}
