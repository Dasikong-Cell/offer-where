import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true
      },
      '/data': {
        target: 'http://localhost:3000',
        changeOrigin: true
      }
    }
  },
  css: {
    preprocessorOptions: {
      less: {
        javascriptEnabled: true
      }
    }
  },
  build: {
    // 关闭自动清空输出目录：本环境下回收站拦截会导致 emptyDir 失败；
    // 改为由启动脚本在构建前手动 rm -rf dist（见 npm run build 前置步骤）。
    emptyOutDir: false,
    // 依赖安全升级后单个 chunk 涨到 3.9MB（gzip 1.07MB），已触发 Vite 的 500KB 告警。
    // 按「运行时/UI 库/文档渲染」拆包：既消除告警，也让浏览器能并行下载 + 长期缓存
    // 互不影响的依赖（改业务代码不会让 tdesign/mermaid 的缓存失效）。
    // 阈值定 1900：拆包后最大的两个是 vendor(1.7MB) 与 vendor-markdown(1.5MB)，
    // 均为「第三方库总量」而非单库（无进一步可拆的语义边界），保留告警但避免噪音刷屏。
    chunkSizeWarningLimit: 1900,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          // 注：@tencent-ai/agent-sdk 只在服务端使用，不在前端 bundle 里，无需单独拆包
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) return 'vendor-react';
          if (/[\\/]node_modules[\\/](tdesign-react|tdesign-icons-react|@tdesign-react)[\\/]/.test(id)) return 'vendor-tdesign';
          // 这一坨是 dev UI 里最重的：mermaid（图表）+ cherry-markdown（编辑器）+ dompurify
          if (/[\\/]node_modules[\\/](mermaid|cherry-markdown|dompurify|katex|highlight\.js|mdast|micromark|unified)[\\/]/.test(id)) return 'vendor-markdown';
          if (/[\\/]node_modules[\\/]lucide-react[\\/]/.test(id)) return 'vendor-icons';
          return 'vendor';
        },
      },
    },
  }
});
