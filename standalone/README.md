# Git Graph Standalone

把 [Git Graph](https://marketplace.visualstudio.com/items?itemName=mhutchie.git-graph) 从 VS Code 插件改造成**不依赖 VS Code 的独立程序**：一个本地 Node 服务 + 浏览器界面。

原有 `src/`（后端）、`web/`（前端）**完全没有改动**，本项目通过适配层（`src/adapter/vscode.ts`）顶替 `vscode` 模块，让同一份业务代码跑在普通 Node 进程里。

## 工作原理

```
浏览器  ──HTTP──▶  本地服务 (127.0.0.1:7583)
   │                 ├─ 托管 media/out.min.js 与 out.min.css
   └──WebSocket──▶   ├─ 承载 GG.RequestMessage 协议
                     └─ 调用 src/ 的原始逻辑 ──child_process──▶ git
```

关键替换关系：

| VS Code API | 独立版实现 |
|---|---|
| `WebviewPanel` | 浏览器标签页（HTTP + WebSocket） |
| `workspace.getConfiguration` | `package.json` 里的默认值 + `settings.json` 用户配置 |
| `Memento`（globalState / workspaceState） | `<data-dir>/*.json` |
| `FileSystemWatcher` | `fs.watch`（递归），忽略 `node_modules`、`.git/objects` 等 |
| `env.clipboard` | `clip` / `pbcopy` / `xclip` |
| `vscode.open` | 系统默认程序打开文件 |
| `vscode.diff` | 本地服务生成的差异页面（`/diff/<id>`） |
| `window.createTerminal` | 系统终端，工作目录为当前仓库 |

前端只做了两处运行时注入，不改源码：
- `assets/bridge.js`：实现 `acquireVsCodeApi()`，把 `postMessage` 转成 WebSocket
- `assets/theme.css`：补齐 `--vscode-*` 主题变量（Light+ 配色）

## 构建与运行

```bash
cd standalone
npm install          # 只装 typescript / uglify-js / @types，不含 Electron
npm run build        # 编译 src + web，产出 out/ 与 ../media/out.min.js
npm start            # 或 npm run dev（构建 + 启动）
```

启动后自动打开 `http://127.0.0.1:7583`。

## 选择仓库（不需要命令行参数）

启动时**什么都不用带**。如果当前没有可显示的仓库，打开 `http://127.0.0.1:7583` 会自动跳到仓库选择页 `/repos`：

- **已添加的仓库**：点「打开」即可进入图形界面；点「移除」把它从列表中删掉（磁盘上的文件不动，重新添加同一目录即可恢复）
- **浏览目录**：从扫描目录（或磁盘根）开始逐级浏览，标了 `git` 徽章的目录可一键添加；也可以先「进入」再「添加此仓库」
- **直接输入路径**：粘贴 `D:/work/project` 之类的路径
- **扫描目录**：添加一个要扫描的目录，点「立即扫描」自动发现其下（默认一层）的仓库

选中的仓库会写回 `settings.json` 的 `repos`，下次启动无需再选。已经打开着图形界面的标签页会被自动刷新。

被「移除」的仓库同时会记到 `workspaceState.json` 的 `ignoredRepos`，所以随后的目录扫描不会把它自动加回来；只有手动添加它才会重新出现。

图形界面右下角有个 **「＋ 仓库」** 浮动按钮，随时可以打开同一个选择页来添加或切换仓库。

### 命令行参数（可选，用于跳过选择）

| 参数 | 说明 |
|---|---|
| `-r, --repo <path>` | 预先添加仓库（可重复） |
| `--root <path>` | 预先指定扫描目录（可重复） |
| `-p, --port <port>` | 首选端口，被占用时自动向后顺延（默认 7583） |
| `--data-dir <path>` | 状态/配置/日志目录（默认 `standalone/data`） |
| `--no-open` | 不自动打开浏览器 |

```bash
node out/standalone/src/main.js --repo "D:/work/project" --root "D:/work"
```

## 配置文件

`<data-dir>/settings.json`，首次启动自动生成：

```json
{
	"workspaceRoots": ["D:/work"],
	"repos": ["D:/work/project"],
	"config": {
		"git-graph.dateFormat": "Date & Time",
		"git-graph.graph.colours": ["#0085d9", "#d9008f"]
	}
}
```

`config` 的键就是原插件的设置名（与 VS Code `settings.json` 中的 `git-graph.*` 一致），默认值直接读取根目录 `package.json` 的 `contributes.configuration`，因此**所有原有设置项都能用**。

## 目录结构

```
standalone/
├── build.js              # 构建脚本（编译 + 打包前端 + 改写 require）
├── assets/
│   ├── bridge.js         # 浏览器端 acquireVsCodeApi 桥接
│   └── theme.css         # VS Code 主题变量
├── src/
│   ├── adapter/
│   │   ├── vscode.ts     # vscode API 适配层
│   │   ├── state.ts      # Memento（JSON 持久化）
│   │   └── watcher.ts    # 递归文件监听
│   ├── diff.ts           # 差异页生成（git diff --no-index + 并排/统一渲染）
│   ├── repoApi.ts        # 仓库管理 API（选择页调用）
│   ├── repoPicker.ts     # 仓库选择页 /repos
│   ├── server.ts         # HTTP + WebSocket 服务
│   └── main.ts           # 启动接线
├── tsconfig.json         # 后端（含 ../src）
└── tsconfig.web.json     # 前端
```

构建产物：`standalone/out/`（后端）、`media/out.min.js` 与 `media/out.min.css`（前端）。

## 文件差异查看

VS Code 自带 diff 编辑器，独立版用的是自己实现的只读差异页面：

- 点击提交详情里的文件，或对比两个提交，会在浏览器新标签页打开 `/diff/<id>`
- 页面支持**并排**与**统一**两种视图（右上角切换），带行号、`+N/-N` 统计、浅色/深色随系统
- 双击文件查看某个版本的内容，打开的是 `/file/<id>` 只读页
- 行对齐交给 `git diff --no-index` 计算，结果与 `git diff` 一致；内容通过 `DataSource.getCommitFile` 读取，遵循仓库配置的文件编码
- 超过 4 MB 的文件、二进制文件、超过 20000 行的差异会给出提示而不是硬渲染
- 新增/删除文件、重命名、工作区未提交改动都支持

生成页面的链接只保留最近 100 个，浏览器标签页关掉后刷新会提示"页面已失效"，回到 Git Graph 重新点一次即可。

## 安全说明

服务**只监听 `127.0.0.1`**，并且校验 WebSocket 的 `Origin`。切勿改成 `0.0.0.0` —— 该服务可以在本机执行任意 git 命令。

## 已知限制

| 功能 | 当前状态 |
|---|---|
| 打开文件 | 调用系统默认程序，而不是编辑器内打开 |
| 代码语法高亮 | 差异页只有增删配色，没有语法高亮 |
| 删除仓库 | 只能在 `/repos` 选择页操作（图形界面内的仓库下拉菜单里没有） |
| git 凭据输入（askpass） | 未接入，私有仓库推送请依赖系统凭据管理器 |
| 归档导出（Create Archive） | 暂不支持（原实现依赖 VS Code 保存对话框） |

使用 `--no-open` 启动时，差异页面也不会自动打开浏览器，只会记到日志里（便于在 CI/无头环境检查）：

```
Opened diff view: http://127.0.0.1:7583/diff/0dd5c885e8c0996a (git_core.py (6a07248d^ ↔ 6a07248d))
```

## 授权

基于 mhutchie/vscode-git-graph（MIT）。保留原仓库的 `LICENSE` 与署名。
