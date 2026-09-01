import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { visualizer } from "rollup-plugin-visualizer";
import importToCDN from 'vite-plugin-cdn-import'
import cssInjectedByJsPlugin from 'vite-plugin-css-injected-by-js'
import legacyPlugin from '@vitejs/plugin-legacy'

export default defineConfig({
  plugins: [
    vue(),
    // importToCDN({
    //   // prodUrl: 'https://cdn.staticfile.org/{name}/{version}/{path}',
    //   prodUrl: 'https://cdn.bootcdn.net/ajax/libs/{name}/{version}/{path}',
    //   // prodUrl: 'https://cdn.iocdn.cc/npm/{name}@{version}/dist/{path}',
    //   modules: [
    //     {
    //       name: "echarts",
    //       var: "echarts",
    //       path: "echarts.min.js",
    //     },
    //     {
    //       name: 'vue',
    //       var: 'Vue',
    //       path: `vue.runtime.global.prod.min.js`,
    //     },
    //     {
    //       name: 'element-plus',
    //       var: 'ElementPlus',
    //       path: `index.full.min.js`,
    //       css: 'index.min.css'
    //     },
    //   ],
    // }),
    // cssInjectedByJsPlugin(), // css注入插件 会导致字体路径异常
    legacyPlugin({
      targets:['chrome 52'],  // 需要兼容的目标列表，可以设置多个
      additionalLegacyPolyfills:['regenerator-runtime/runtime'] // 面向IE11时需要此插件
    }),
    visualizer({
      gzipSize: true,
      brotliSize: true,
      emitFile: false,
      filename: "visualizer.html",
      template :"sunburst",
      open:false
    })
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  build:{
    assetsDir: 'assets',
    assetsInlineLimit: 8 * 1024,
    rollupOptions:{
      manualChunks(id){
        if(id.includes('node_modules')){
          return "vendor"
        }
      }
    }
  },
  server: {
    open: true,
    port: 3005,
    host: '0.0.0.0',
    proxy: {
      '/proxy': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/health': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      // 腾讯CDN测速文件代理（解决CORS）
      '/cdn-proxy/tencent': {
        target: 'http://webcdn.m.qq.com',
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/cdn-proxy\/tencent/, ''),
        configure: (proxy: any) => {
          proxy.on('proxyRes', (proxyRes: any) => {
            proxyRes.headers['access-control-allow-origin'] = '*';
          });
        },
      },
      // 腾讯测速上传接口代理
      '/cdn-proxy/netsp': {
        target: 'http://netsp.master.qq.com',
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/cdn-proxy\/netsp/, ''),
        configure: (proxy: any) => {
          proxy.on('proxyRes', (proxyRes: any) => {
            proxyRes.headers['access-control-allow-origin'] = '*';
          });
        },
      },
    },
  },
  base: './'
})
