import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as vue from 'vue';
import ts from 'typescript';
import { parse, compileScript } from 'vue/compiler-sfc';
import { productImageAttrs, productImageVariantsEnabled } from '../../app/utils/product-image.ts';

const require = createRequire(import.meta.url);
export async function imageComposable({ enabled = false, asset = value => value } = {}) {
  let source = await readFile(new URL('../../app/composables/useProductImage.ts', import.meta.url), 'utf8');
  const parsed = ts.createSourceFile('image.ts', source, ts.ScriptTarget.Latest, true);
  for (const statement of [...parsed.statements].reverse()) if (ts.isImportDeclaration(statement))
    source = source.slice(0, statement.getStart()) + source.slice(statement.end);
  const code = ts.transpileModule(source.replace(/^export /gm, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const context = { computed: vue.computed, shallowRef: vue.shallowRef, watch: vue.watch,
    productImageAttrs, productImageVariantsEnabled,
    useRuntimeConfig: () => ({ public: { productImageVariants: enabled } }), useAsset: () => asset };
  return new Function(...Object.keys(context), code + '\nreturn useProductImage;')(...Object.values(context));
}

export async function imageComponent(useProductImage) {
  const file = 'components/product/Image.vue';
  const { descriptor } = parse(await readFile(new URL('../../app/' + file, import.meta.url), 'utf8'), { filename: file });
  const compiled = compileScript(descriptor, { id: 'product-image-test', inlineTemplate: true });
  const code = ts.transpileModule(compiled.content, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'useProductImage', code)(require, module, module.exports, useProductImage);
  return module.exports.default;
}
