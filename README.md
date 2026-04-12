# xPhoto - 极简纯粹的大模型修图引擎

xPhoto 是一款专为摄影师与爱好者打造的纯前端（Serverless）图像处理 Web 应用程序。核心特点是：支持 RAW 格式解码，通过前端直连云端大模型 API 实现智能提亮与美颜，最终一键导出 JPG 格式，全过程在浏览器完成，无后端存储，保护隐私且零运维成本。

## 核心功能与架构方案

### 1. RAW 格式解码层 (纯前端解析)
- **技术栈**: React + WebAssembly (例如 `magick.wasm` 或轻量级解码器 `utif.js` / 纯 JS 解码库)。
- **实现机制**: 用户在浏览器选择 RAW 文件（如 `.dng`, `.cr2`, `.nef`），系统通过 FileReader 获取文件二进制数据流，由前端 WebAssembly 模块将 RAW 的宽容度与色彩数据无损解算为 Canvas 像素，并提取中间态高质量图片。

### 2. 云端大模型处理层 (API 驱动)
由于项目将部署为完全静态的 GitHub Pages 站点，不带有后端服务器，因此 AI 处理采用以下策略：
- **API 密钥配置**: 系统提供一个安全的本地设置项，用户可自行填入云端视觉大模型服务商的 API Key（如 OpenAI GPT-4o Vision，阿里云视觉开放平台，或 Photoroom 等，这能完全避免 API Key 泄露风险和后端代理成本）。
- **亮度增强与智能美颜**: 前端将解码后的 RAW 图像转为 Base64 或 Blob，通过标准的 HTTPS POST 请求直接发送至提供商的 API。利用大语言模型（如 GPT-4V 或专用图像 API）进行参数指令控制（如“Enhance lighting and smooth skin while maintaining natural texture”）。

### 3. 本地合成与导出层 (JPG 渲染)
- **效果预览**: AI 模型返回处理结果后，前端应用 `react-compare-slider` 等组件提供原图与成品的滑动对比视图。
- **客户端渲染与导出**: 利用 HTML5 `<canvas>` API，确保在导出时色彩空间被正确渲染。最后利用 `toDataURL('image/jpeg', 0.95)` 在客户端生成高质量 JPG 图片并触发本地下载，即用即走。

## 开发与部署指南

本项目采用 Vite + React 构建，专门优化了 GitHub Pages 的静态托管。

### 本地开发
```bash
# 1. 安装依赖
npm install

# 2. 启动本地开发服务器
npm run dev
```

### 部署到 GitHub Pages
项目内置了部署脚本。只需要在 GitHub 设置页面开启 GitHub Pages (指向 `gh-pages` 分支)，并运行部署命令：
```bash
npm run deploy
```

## 为什么选择纯前端架构？
- **零成本运维**: GitHub Pages 免费提供静态文件托管。
- **高可用与低延迟**: 无需自建后端代理大流量的图片传输，由浏览器直连 CDN 或云厂商 API，速度达到物理极限。
- **绝对隐私**: 所有解码与文件流转皆在浏览器沙箱内完成，无需上传第三方未知后端服务器。
