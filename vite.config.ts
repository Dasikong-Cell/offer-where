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
    emptyOutDir: false
  }
});
