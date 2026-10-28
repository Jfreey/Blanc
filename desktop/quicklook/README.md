# QuickLook 扩展 —— **封存中（2026-10-16）**

代码保留，但**当前不参与打包分发**，也没在主流程里启用。恢复之前需要先解决两件事：

## 1. 代码签名

QuickLook 扩展要以 `.appex` 形式随 `.app` 分发，必须**开发者签名 + 公证**。
目前没有签名配置，所以 `npm run tauri:build` 里的 `ql:build` / `ql:inject`
两步对**本机开发**有用，对**分发**是不够的。

## 2. 命名已统一（2026-10-16）

| | 值 |
|---|---|
| 主 app bundle id | `org.blanc.notes` |
| QuickLook bundle id | `org.blanc.notes.quicklook` |
| 产物名 | `BlancQuickLook.appex` |

`Info.plist` / `build-ql.sh` / `inject-ql.sh` / `Preview.swift` 里的 `Talkbai`
都已改掉。因为本扩展处于封存状态，改名没有运行时风险。

> 注意：`src/api.js` 里的 `talkbai-ui` 是**故意保留**的 ——
> 那是老用户 localStorage 的迁移源键，不能跟着改名。

## 构建（仅本机调试用）

```bash
npm run ql:build     # 编译 Preview.swift → build/BlancQuickLook.appex
npm run ql:inject    # 注入进已构建的 Blanc.app
```

`build/` 已在 `.gitignore` 里。
