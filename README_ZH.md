<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/CreatorAris/CreatorAris/dist/github-snake-dark.svg" />
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/CreatorAris/CreatorAris/dist/github-snake.svg" />
  <img alt="github contribution snake animation" src="https://raw.githubusercontent.com/CreatorAris/CreatorAris/dist/github-snake.svg" />
</picture>

# Nephele Aura

[Nephele Workshop](https://nephele.arisfusion.com) 的移动伴侣端 —— 用 Expo / React Native 写的 App，连接到正在运行的桌面端会话，让画师在桌面端画画的同时，用手机浏览素材库，不打断创作节奏。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Expo](https://img.shields.io/badge/Expo-SDK%2054-000020.svg)](https://expo.dev)
[![React Native](https://img.shields.io/badge/React%20Native-0.81-61DAFB.svg)](https://reactnative.dev)
[![Status](https://img.shields.io/badge/status-alpha-orange.svg)](#状态)
[![GitHub stars](https://img.shields.io/github/stars/CreatorAris/nephele-aura.svg)](https://github.com/CreatorAris/nephele-aura/stargazers)
[![GitHub last commit](https://img.shields.io/github/last-commit/CreatorAris/nephele-aura.svg)](https://github.com/CreatorAris/nephele-aura/commits)

[English](README.md) · [Nephele Workshop](https://nephele.arisfusion.com)

</div>

## 这是什么

Nephele Aura 是 Nephele Workshop 生态的移动端。它通过部署在 Cloudflare Durable Object 上的 WebSocket 中继，连接到正在运行的桌面端 (PySide6)，让画师能在画画时用手机翻看素材库，而不打断主创作节奏。

桌面端代码闭源；公开的可审计子集见 [nephele-core-audit](https://github.com/CreatorAris/nephele-core-audit)。

## 状态

Alpha。Mobile 包暂未上架 App Store / Play Store。当前阶段专注图片浏览，agent 对话、pipeline 等桌面端工具入口暂时砍掉，等浏览体验打磨好之后再回来。

## 架构

```
Mobile (Expo + React Native + Tamagui)
    <-- WebSocket -->
Cloudflare Durable Object (RemoteRelay, 支持 Hibernation)
    <-- WebSocket -->
Desktop (PySide6 + Python, core/remote_bridge.py)
    <--> 素材库 (Eagle .library 格式), file server
```

图像传输：

- **LAN** —— 桌面端 `core/file_server.py` 直连 HTTP，Tailscale 感知（自动识别 `100.x` 地址）
- **WAN** —— 缩略图通过 WebSocket 中继（Pillow 200px JPEG q70），原图通过 Cloudflare R2 CDN URL

认证：邮箱 OTP。Mobile 客户端通过 `X-Client-Type: nephele-mobile-v1` 声明客户端类型来旁路 CAPTCHA —— 这是公开的客户端标识，不是 secret。真正的防御依赖服务端限流（IP RPM/RPH/RPD、每邮箱 cooldown 与日发送上限）。

## 屏幕

| 屏幕 | 内容 |
|:---|:---|
| Gallery | 素材库文件夹树 + 标签/评分筛选 + 瀑布流缩略图 + 双指缩放灯箱；多选批量操作、相册导入、姿势搜索 |
| Profile | 邮箱 OTP 登录、注销 |

## 仓库结构

| 路径 | 内容 |
|:---|:---|
| `app/` | expo-router 文件式路由（tabs / auth） |
| `components/` | 共享 UI 原语（Tamagui） |
| `utils/` | 认证、WebSocket 客户端、主题 token |
| `assets/` | App 图标、启动图 |

## 开发

```bash
npm install
npx expo start
```

需要本地运行的 Nephele Workshop 桌面端（登录同一账号）才能拿到真实数据。

## 反馈

移动端 bug —— 在本仓库提 issue。欢迎 PR：本仓库就是发布版 Mobile 包的代码源头，合并即上线。

Nephele Workshop 桌面端本身的功能需求 —— 桌面端代码是闭源的，请通过 [官网](https://nephele.arisfusion.com) 上的联系方式提交，不要发到本仓库。

## License

MIT，见 [LICENSE](LICENSE)。可自由 fork、审计、重新打包。

## 相关仓库

- [nephele-wisp](https://github.com/CreatorAris/nephele-wisp) —— 浏览器扩展伴侣（Chrome / Edge MV3 + Native Messaging Host）
- [nephele-core-audit](https://github.com/CreatorAris/nephele-core-audit) —— Nephele Workshop 客户端的可审计代码子集（rights / packer / validator）
- [nephele-verify](https://github.com/CreatorAris/nephele-verify) —— `.nep` 存证文件的独立验证页
