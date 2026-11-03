import { defineConfig } from "vite";

// 为什么 build 用 iife：验收要在 host/tool/shot.mjs 下截图，而它只接受文件路径（自己拼 file:///）。
// file:// 页面里 <script type="module"> 会被 CORS 拦掉，只有经典脚本能跑，
// 所以产出必须是 iife + 相对资源路径（base './'）。dev server 不受影响，仍是原生 ESM。
/** 把构建产物里的 <script type="module"> 改回经典 <script>：
 *  iife 产物本来就是经典脚本，但 Vite 仍会标 module —— 而 file:// 页面加载 module 脚本
 *  会被 CORS 拦掉（origin null），shot.mjs 传 <in.html> 文件路径那条用法就走不通了。 */
function classicScriptPlugin() {
  return {
    name: "retina-classic-script",
    apply: "build" as const,
    transformIndexHtml(html: string): string {
      return html.replace(/<script type="module" crossorigin src=/g, "<script defer src=");
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [classicScriptPlugin()],
  build: {
    target: "es2022",
    rollupOptions: {
      output: {
        format: "iife",
        inlineDynamicImports: true,
        entryFileNames: "assets/app.js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
  server: { port: 5173, host: "127.0.0.1" },
});
