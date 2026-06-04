# Aura 发版 / 更新 SOP

> 双通道(OTA + 自分发 APK)更新的标准流程。建立于 2026-06-04,起因是一次
> 「装了 0.1.1 却显示 0.1.0」的事故。所有结论可溯源到 Expo 官方文档 + expo-updates 源码
> (见文末 Sources)。**改 Aura 发版相关的任何东西前,先读这份。**

---

## 0. 三根独立的轴(先建立模型,别再混)

| 轴 | 位置 | 作用 | 何时变 |
|---|---|---|---|
| `version` | app.json `expo.version`(SemVer) | 给人看的产品版本号,也是 **OTA bundle 自报的版本** | **每次 native 发版**手动 bump |
| `versionCode` | app.json `android.versionCode`(int) | 单调递增计数,Android 用它判新旧 | **每次 native build** +1,永不重用 |
| `runtimeVersion` | fingerprint 哈希 | **native 兼容性 key** —— 决定一个 OTA 能不能装到某个 APK 上 | native 运行时变了就变 |

两条交付通道:
- **L1 OTA**(expo-updates):**只能推 JS / 资源改动**。静默,下次冷启动生效,不弹窗。
- **L2 APK**(UpdateGate 弹窗):**native 改动必须走这条**。比对「装机 native 版本 vs `aura:release.version`」(semver)决定弹不弹。

---

## 1. 决策:这次改动走 OTA 还是 APK?

> **一句话判据:动到 JS / 资源之外的任何东西 → 必须重打 APK。**

必须 APK(native)的典型:**权限增删**、native 模块、app.json 的 native 字段(scheme / permissions / plugins)、图标 / splash、Expo SDK 升级。
其余(JS 逻辑、布局、样式、API URL、静态图)→ OTA。

> 权限收紧 = **native 改动 = 必须 APK**,OTA 推不了(改了也不会生效)。

---

## 2. 我们踩的两个坑 + 防止它们的硬规则

### 坑 A —— 版本标签被 OTA 盖住(2026-06-04 事故主因)
- OTA bundle 自报**它自己 app.json 的 version**(`extra.expoClient.version`),不是 native 的 versionName。
- expo-updates 启动时在「内置 bundle + 已下载的 OTA」里**按 `commitTime` 选最新的跑,内置 bundle 不享有优先权**。
- 我们的事故:在 bump 版本**之前**就发了 OTA → 那个 bundle 自报 0.1.0、commitTime 又比内置新 → 盖住了内置的 0.1.1 → 装了 0.1.1 APK 仍显示 0.1.0。

  **规则 A1:核心不变量 —— app.json `version` 永远 = 最近一次 native 发版的版本号。** 只在 native 发版时 bump,且在 build/export **之前** bump;**OTA 不 bump version**(version 是给 native 里程碑用的)。事故真因是 app.json **落后于** native(导出 OTA 时还停在 0.1.0,native 已 0.1.1)→ OTA 自报 0.1.0 盖住 0.1.1。只要 version 不落后于 native baseline,OTA 导出时就自报当前 baseline 版本、与 native 一致,不会回退。
  **规则 A2:native 发版的 `version` 必须严格高于「该 runtime 上任何 OTA 曾自报过的版本」。** 否则已 OTA 到那个标签的设备会判「我已是最新」,永远不弹 APK 更新 → native 改动(如权限收紧)到不了这些设备。

### 坑 B —— 指纹漂移(resolver ≠ 真机)
- 同一棵代码树,`expo-updates runtimeversion:resolve` 给的指纹和**真机 APK 里嵌的指纹可能不一样**(我们见到 resolver=d76e37ea,真机 APK=558bc17)。成因:相对路径 plugin(`./plugins/...`)、autolinking 排序、env/profile 差异等已知非确定性。

  **规则 B1:指纹的唯一可信来源 = 从「已编译的 APK」里读 `assets/fingerprint`。** 注册 `aura:release.runtimeVersion`、发 OTA 的 `--runtime-version`,都用这个值,**绝不用 resolver 的输出**。

---

## 3. SOP-A:Native 发版(如权限收紧)—— 按序执行

1. **bump 版本**:app.json `expo.version`(SemVer,遵守规则 A2,高于任何 OTA 曾报过的标签)+ `android.versionCode` +1;同步 `android/app/build.gradle` 的 versionName / versionCode。
2. **改 native**(如往 `plugins/withBlockedPermissions.js` 的 `BLOCKED` 加权限)。
3. **build 签名 release APK**(gradlew assembleRelease)。
4. **验证产物**(aapt 在 `…/Android/Sdk/build-tools/<v>/aapt.exe`):
   - `aapt dump badging <apk>` → 确认 versionName / versionCode
   - `aapt dump permissions <apk>` → 确认目标权限**已消失**
   - `unzip -p <apk> assets/fingerprint` → **抄下真实 runtimeVersion 哈希**(规则 B1)
   - `unzip -p <apk> assets/app.config` 里的 version → 应 = 新 version
5. **传 R2**:`download.arisfusion.com/aura/releases/<ver>/Nephele-Aura-<ver>.apk`(用 r2 上传脚本)。
6. **原子更新 `aura:release` KV**(先确认 APK 已在 R2,再写 KV):
   `{version, runtimeVersion=<步骤4抄的哈希>, apkUrl, notes, mandatory}`。
7. (可选)只有打算在这个新 APK 上继续迭代 JS 时,才发一个针对**新指纹**的 OTA;否则跳过(APK 已自带全部)。
8. **验证**:`curl /v1/aura/release` 显示新 version;拿旧版本装机覆盖 → UpdateGate 弹窗 → 装 → 版本号 + 权限都对。

## 4. SOP-B:OTA-only 发版(纯 JS 改动)

1. **不要 bump version** —— 保持 app.json `version` = 当前 native baseline(现在 0.1.2)。OTA 静默更新 JS,版本号不变(用 updateId 区分迭代,不靠 version)。仅当你确实想让用户看到版本号跳动时才 bump,但那之后下一个 native 版必须更高(规则 A2)。
2. `python scripts/aura_ota_publish.py --channel production` —— 默认自动从 `aura:release.runtimeVersion` 读已部署 APK 的真实指纹(当前 0.1.2 = `bfd6b59dc68828ec57f210c3a2d9e27a17499fdf`),不用手动传。只有要发到**别的**指纹时才加 `--runtime-version`。(脚本里 `read_deployed_runtime_version()` 接管了原来手动读 `assets/fingerprint` 的步骤。)
4. **不要碰 `aura:release`**(那是 APK 通道)。
5. 验证 manifest endpoint 返回新 updateId + 新 version。

## 5. 阻断 / 回滚

- **停 OTA 推送**:删 KV `aura:ota:<rtv>:production`。注意:只挡**新**拉取;已下载该 bundle 的设备仍会用,直到出现 commitTime 更新的发布或 `rollBackToEmbedded` 指令。
- **停 APK 弹窗**:`aura:release.version` 调到低于所有装机版本(如上一个 good 版)。
- **真·OTA 回滚**(坏 bundle 已在设备上):发一个 commitTime 更新的 good bundle,或实现 `rollBackToEmbedded` 指令(我们后端**目前没实现**,见 backlog)。

## 6. 加固 backlog(治本)

- **稳定指纹**:加 `.fingerprintignore` + `fingerprint.config.js`,plugin 用绝对/仓库相对路径,钉死 `@expo/fingerprint`/SDK 版本,让 resolver == 真机。在那之前一律读 `assets/fingerprint`。
- **mandatory 更新闸**:存 `minSupportedVersion`,启动时用 `expo-application` 的 **native** 版本 + 正经 semver 比较(不要 `split('.').join('')` 那种朴素拼接),低于则非可取消弹窗。安全/权限类强推必须比的是 native 版本。
- 考虑 `ExpoConfigVersions` sourceSkip:让日常 version bump 不再 fork runtimeVersion(把「版本标签」和「指纹」解耦)。

---

## Sources
- Expo Runtime versions and updates — https://docs.expo.dev/eas-update/runtime-versions/
- Expo App versions(OTA 不改 native 版本标签)— https://docs.expo.dev/build-reference/app-versions/
- Expo Updates SDK / deployment — https://docs.expo.dev/versions/latest/sdk/updates/ , https://docs.expo.dev/eas-update/deployment/
- Expo Updates 协议 — https://docs.expo.dev/technical-specs/expo-updates-1/
- @expo/fingerprint(指纹输入 / SourceSkips / 非确定性)— https://docs.expo.dev/versions/latest/sdk/fingerprint/
- expo-updates 源码:`LauncherSelectionPolicyFilterAware.kt`(commitTime 选择)、`UpdatesConfiguration.kt`(`file:fingerprint` → 读 `assets/fingerprint`)
- 同指纹下「新 APK 被旧 OTA 盖住」issue — https://github.com/expo/expo/issues/44091
