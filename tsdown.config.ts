import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: { index: 'src/index.ts' }, outDir: 'dist',
    format: 'esm', platform: 'node', target: 'es2023',
    dts: true, sourcemap: true, clean: true, fixedExtension: false,
    deps: { neverBundle: [/^@deepseek-ai\//], alwaysBundle: ['acorn'], onlyBundle: ['acorn'] },
  },
  {
    entry: { index: 'src/client/index.ts' }, outDir: 'dist/client',
    format: 'cjs', platform: 'browser', target: 'es2023',
    dts: false, sourcemap: true, clean: false, fixedExtension: false,
    inputOptions: { platform: 'browser' },
    deps: { neverBundle: [/^react($|\/)/], alwaysBundle: ['acorn'], onlyBundle: ['acorn'] },
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    // DSH 浏览器插件使用 loader factory，不能直接把 Node 的 ESM 文件交给它。
    outputOptions: {
      entryFileNames: 'index.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-temporary-messages", factory: (require) => {',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])
