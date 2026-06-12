const resolve = require('@rollup/plugin-node-resolve');
const commonjs = require('@rollup/plugin-commonjs');
const typescript = require('@rollup/plugin-typescript');

module.exports = {
  input: 'src/main.ts',
  output: {
    file: 'main.js',
    format: 'cjs',
    sourcemap: true,
    exports: 'default'
  },
  external: ['obsidian'],
  plugins: [
    typescript({
      tsconfig: './tsconfig.json'
    }),
    resolve({
      preferBuiltins: false,
      browser: true
    }),
    commonjs({
      include: 'node_modules/**'
    })
  ]
};
