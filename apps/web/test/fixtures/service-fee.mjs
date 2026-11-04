import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { parse } from 'vue/compiler-sfc';

export async function serviceHelpers() {
  const error = await readFile(new URL('../../app/utils/api-error.ts', import.meta.url), 'utf8');
  const helper = await readFile(new URL('../../app/utils/service-fee.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(error + helper.replace(/^import .*;$/m, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  new Function('exports', code)(exports);
  return exports;
}

export async function serviceComponent(file, context, expose) {
  const text = await readFile(new URL('../../app/components/admin/' + file, import.meta.url), 'utf8');
  let script = parse(text).descriptor.scriptSetup.content;
  const parsed = ts.createSourceFile('fee.ts', script, ts.ScriptTarget.Latest, true);
  for (const statement of [...parsed.statements].reverse()) if (ts.isImportDeclaration(statement))
    script = script.slice(0, statement.getStart()) + script.slice(statement.end);
  const code = ts.transpileModule(script, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  return new AsyncFunction(...Object.keys(context), code + '\nreturn { ' + expose + ' };')(...Object.values(context));
}
