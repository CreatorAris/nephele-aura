# Nephele Remote

Nephele Workshop 的移动伴侣端 — 在画画的间隙用手机浏览 Eagle 素材库、查看桌面端 Agent 的进度、远程触发 Pipeline。

> **这是配套 App,不能独立使用。** 它通过 WebSocket 连接到正在运行的 Nephele Workshop 桌面端,所有功能依赖桌面端会话。

## Stack

- Expo (React Native) + TypeScript
- expo-router file-based routing
- Tamagui design system
- @react-native-async-storage/async-storage 存 JWT
- WebSocket 走 Cloudflare Durable Object 中继到桌面端

## Screens

- **Workshop** — 连接状态 + 积分 + 快捷动作
- **Gallery (Eagle)** — 文件夹浏览 + 瀑布流缩略图 + 全屏预览(支持双指缩放)
- **Agent** — 流式对话 + 工具调用展示 + 中断
- **Pipeline** — 实时步骤进度 + 启动控制
- **Profile** — 邮箱登录(OTP)+ 注销

## Dev

```bash
npm install
npx expo start
```

需要本地运行的桌面端来测真实数据流。

## License

MIT
