import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const reportErrorsPlugin = {
  name: 'report-errors',
  setup(build) {
    build.onEnd((result) => {
      for (const { text, location } of result.errors) {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}:`);
        }
      }
    });
  },
};

/** VS Code の problemMatcher がビルドの開始と完了を検知するための出力 */
const watchStatusPlugin = {
  name: 'watch-status',
  setup(build) {
    build.onStart(() => {
      console.log('[watch] build started');
    });
    build.onEnd(() => {
      console.log('[watch] build finished');
    });
  },
};

const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  logLevel: 'silent',
};

const webview = await esbuild.context({
  ...common,
  entryPoints: ['webview/main.js'],
  format: 'iife',
  platform: 'browser',
  outdir: 'dist/webview',
  plugins: [reportErrorsPlugin],
});

const extension = await esbuild.context({
  ...common,
  // ワーカーは別スレッドで読み込むので、別のファイルとして出力する
  entryPoints: ['src/extension.ts', 'src/scanWorker.ts'],
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  outdir: 'dist',
  external: ['vscode'],
  plugins: [reportErrorsPlugin, watchStatusPlugin],
});

if (watch) {
  await Promise.all([webview.watch(), extension.watch()]);
} else {
  try {
    await Promise.all([webview.rebuild(), extension.rebuild()]);
  } catch {
    process.exit(1);
  }
  await Promise.all([webview.dispose(), extension.dispose()]);
}
