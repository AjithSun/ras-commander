import { defineConfig } from 'vite';

export default defineConfig({
  assetsInclude: ['**/*.wgsl'],
  server: {
    proxy: {
      '/data': {
        target: 'http://localhost:8081',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/data/, ''),
      },
    },
  },
});
