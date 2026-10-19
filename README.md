# Git Graph 独立版

把 [Git Graph](https://github.com/mhutchie/vscode-git-graph) 从 VS Code 插件改造成**独立运行的本地应用**：一个 Node 服务 + 浏览器界面。不需要安装 VS Code，也不需要 Electron。

启动后打开 `http://127.0.0.1:7583`，就能看到完整的提交图谱、点开提交查看改动、右键执行 Git 操作。

> 原项目的 `src/`（数据层与业务逻辑）和 `web/`（前端）**没有任何改动**，本仓库通过 `standalone/src/adapter/` 顶替 `vscode` 模块，让同一份业务代码跑在普通 Node 进程里。

## 目录

- [功能](#功能)
- [工作原理](#工作原理)
- [快速开始](#快速开始)
- [仓库管理](#仓库管理)
- [命令行参数](#命令行参数)
- [配置文件](#配置文件)
- [查看文件差异](#查看文件差异)
- [构建与发版](#构建与发版)
- [目录结构](#目录结构)
- [已知限制](#已知限制)
- [常见问题](#常见问题)
- [许可与致谢](#许可与致谢)

## 功能

### 图谱视图

- 显示本地分支、远程分支、Tags、Stashes 与未提交的改动
- 每个提交顶点都带悬停提示：是否在 HEAD 中、被哪些分支 / 标签 / Stash 引用
- 按分支过滤：全部、勾选若干分支、或使用自定义 glob 模式（`git-graph.customBranchGlobPatterns`）
- 查找组件：在提交信息、日期、作者、哈希、分支与标签名中搜索
- 列宽可拖动，Date / Author / Commit 列可显示或隐藏
- 提交信息里的 Emoji 短码（含全部 [gitmoji](https://gitmoji.carloscuesta.me/)）自动替换成对应字符

### Git 操作

在提交、分支、标签、Stash 上右键即可执行：

| 对象 | 支持的操作 |
|---|---|
| 分支 | 创建、检出、删除、抓取、合并、拉取、推送、变基、重命名、重置 |
| 标签 | 添加、删除、推送 |
| 提交 | 检出、拣选、丢弃、合并、还原 |
| Stash | 应用、从 Stash 创建分支、丢弃、弹出 |
| 未提交的改动 | 清理、重置、暂存（Stash） |

### 提交详情与对比

- 点开任意提交查看提交信息、作者、文件改动列表
- 点一个提交后再 `CTRL/CMD` 点另一个，即可对比两次提交
- 文件改动支持树形与列表两种展示方式，可切换是否压缩单层文件夹
- 可以把某次提交涉及的文件恢复到该版本
- 提交信息和标签详情中的 HTTP/HTTPS 链接可直接点开
- 代码评审（Code Review）：记录哪些文件已看过，未看的加粗，看过即取消加粗；30 天无活动自动结束

### 仓库设置组件

- 查看、添加、修改、删除、抓取、清理远程
- Issue 链接：把提交信息里的 issue 编号变成跳转链接
- Pull Request 创建：内置 Bitbucket、GitHub、GitLab，也可用 `git-graph.customPullRequestProviders` 配置自建服务
- 把当前仓库的 Git Graph 配置导出成文件，提交到仓库后其他人可共享同一套设置

### 键盘快捷键

| 快捷键 | 作用 |
|---|---|
| `CTRL/CMD + F` | 打开查找组件 |
| `CTRL/CMD + H` | 视图滚动到 HEAD 对应的提交 |
| `CTRL/CMD + R` | 刷新 |
| `CTRL/CMD + S` | 滚动到第一个（下一个）Stash |
| `CTRL/CMD + SHIFT + S` | 滚动到最后一个（上一个）Stash |
| `Up` / `Down` | 提交详情打开时，在上一个 / 下一个提交上打开详情 |
| `CTRL/CMD + Up` / `Down` | 在同分支的父 / 子提交上打开详情；加 `SHIFT` 时遇到分支或合并会走另一条分支 |
| `Enter` | 提交对话框的主操作 |
| `Escape` | 关闭对话框、右键菜单或提交详情 |

这些快捷键都可以在配置里改。

## 工作原理

```
浏览器 ──HTTP──────▶  本地服务 (127.0.0.1:7583)
   │                    ├─ 托管 media/out.min.js、out.min.css 与静态资源
   └──WebSocket────▶    ├─ 承载原插件的 GG.RequestMessage 协议
                        └─ 调用 src/ 的业务逻辑 ──child_process──▶ git
```

适配层替换了原插件依赖的这些 VS Code 能力：

| VS Code API | 独立版实现 |
|---|---|
| `WebviewPanel` | 浏览器标签页（HTTP + WebSocket） |
| `workspace.getConfiguration` | `package.json` 里的默认值 + `settings.json` 用户配置 |
| `Memento`（globalState / workspaceState） | 数据目录下的 `<name>.json` |
| `FileSystemWatcher` | `fs.watch`（递归），忽略 `node_modules`、`.git/objects` 等 |
| `env.clipboard` | `clip` / `pbcopy` / `xclip` |
| `vscode.open` | 系统默认程序打开文件 |
| `vscode.diff` | 服务生成的差异页（`/diff/<id>`） |
| `window.createTerminal` | 系统终端，工作目录为当前仓库 |

前端只做两处运行时注入，不改源码：

- `standalone/assets/bridge.js`：实现 `acquireVsCodeApi()`，把 `postMessage` 转成 WebSocket
- `standalone/assets/theme.css`：补齐 `--vscode-*` 主题变量

## 快速开始

### 前置条件

- Node.js **≥ 18**
- Git 在 `PATH` 中（或设置 `git.path`）

### 方式一：用发布包

从 [Releases](../../releases) 下载 `git-graph-standalone-v*.zip`，解压后：

```bash
./start.sh          # macOS / Linux
start.bat           # Windows
```

发布包内已经带了运行所需的依赖，不需要 `npm install`。

### 方式二：从源码运行

```bash
cd standalone
npm install         # 只装 typescript / uglify-js / @types，不含 Electron
npm run build       # 编译 src + web，产出 standalone/out 与 media/out.min.js
npm start           # 启动并自动打开浏览器
```

`npm run dev` 等于「构建 + 启动」，改完代码直接用它。

启动成功后控制台输出：

```
  Git Graph is running at http://127.0.0.1:7583
  Press Ctrl+C to stop.
```

## 仓库管理

**启动时不需要带任何参数。** 如果没有可显示的仓库，访问 `http://127.0.0.1:7583` 会自动跳到选择页 `/repos`：

- **已添加的仓库**：点「打开」进入图形界面，点「移除」把它从列表里删掉
- **浏览目录**：从扫描目录或磁盘根开始逐级浏览，带 `git` 徽章的目录可一键添加
- **直接输入路径**：粘贴 `D:/work/project` 这类路径
- **扫描目录**：添加一个要扫描的目录，点「立即扫描」自动发现其下（默认一层）的仓库

改动会写回 `settings.json` 的 `repos`，下次启动无需再选；已经打开的图形界面标签页会自动刷新。

「移除」只是从列表中摘掉，**不会删除磁盘上的任何文件**。被移除的仓库会记进 `workspaceState.json` 的 `ignoredRepos`，所以随后的目录扫描不会把它自动加回来；手动添加同一目录即可恢复。

图形界面右下角有个固定的 **「＋ 仓库」** 按钮，随时可以回到选择页。

## 命令行参数

| 参数 | 说明 |
|---|---|
| `-r, --repo <path>` | 预先添加仓库，可重复 |
| `--root <path>` | 添加扫描目录，可重复 |
| `-p, --port <port>` | 首选端口，默认 `7583`；被占用时自动顺延 |
| `--data-dir <path>` | 数据目录，默认 `standalone/data` |
| `--no-open` | 不自动打开浏览器，只打印地址 |
| `-h, --help` | 显示帮助 |

```bash
node out/standalone/src/main.js --port 8080 --no-open --repo D:/work/my-project
```

环境变量 `GG_EXTENSION_PATH` 可以显式指定「包含 `package.json`、`media`、`resources` 的目录」。

## 配置文件

数据目录默认是 `standalone/data/`，可用 `--data-dir` 改：

| 文件 | 内容 |
|---|---|
| `settings.json` | 仓库列表、扫描目录、`git-graph.*` 配置 |
| `workspaceState.json` | 各仓库的界面状态、被忽略的仓库 |
| `globalState.json` | 全局状态（如缓存的 Git 版本信息） |
| `logs/` | 运行日志 |

`settings.json` 的结构：

```json
{
	"workspaceRoots": ["D:/work"],
	"repos": ["D:/work/my-project"],
	"config": {
		"git-graph.date.format": "Date & Time",
		"git-graph.repository.commits.initialLoad": 300,
		"git-graph.graph.style": "rounded"
	}
}
```

`config` 里的键就是界面上的全部设置项，**默认值来自根 `package.json` 的 `contributes.configuration`**（这也是该字段被保留下来的原因）。常用几项：

| 键 | 默认值 | 说明 |
|---|---|---|
| `git-graph.repository.commits.initialLoad` | `300` | 首次加载的提交数 |
| `git-graph.repository.commits.loadMore` | `100` | 每次「加载更多」的条数 |
| `git-graph.repository.commits.order` | `date` | 提交排序：`date` / `author-date` / `topo` |
| `git-graph.date.format` | `Date & Time` | 日期格式，另有 `Date Only`、`ISO Date & Time`、`ISO Date Only`、`Relative` |
| `git-graph.graph.style` | `rounded` | 连线风格：`rounded` / `angular` |
| `git-graph.graph.colours` | 12 色数组 | 分支配色 |
| `git-graph.fileEncoding` | `utf8` | 读取历史文件时的编码 |
| `git-graph.maxDepthOfRepoSearch` | `0` | 扫描仓库时的子目录深度 |
| `git-graph.repository.fetchAvatars` | `false` | 是否拉取作者头像（会把邮箱发给 GitHub / GitLab / Gravatar） |
| `git-graph.integratedTerminalShell` | 空 | 打开终端时使用的 Shell 路径 |

完整清单见根目录 `package.json` 的 `contributes.configuration`。想重置所有状态，直接删掉数据目录即可。

## 查看文件差异

在提交详情或对比视图里点击文件，会在新标签页打开差异页：

- 支持**并排**与**统一**两种视图，纯 CSS 切换，不依赖脚本
- 行对齐由 `git diff --no-index` 计算，与 `git diff` 结果一致
- 文件内容通过 `DataSource` 读取，遵循 `git-graph.fileEncoding` 配置的编码
- 只发生换行符（CRLF / LF）差异时会提示「未检测到差异」，而不是显示一张空表

## 构建与发版

```bash
cd standalone
npm run build       # 编译后端 + 打包前端，产出 out/ 与 ../media/out.min.js
```

打 tag 即触发 GitHub Actions（`.github/workflows/standalone-release.yml`）：

```bash
git tag v1.0.0
git push origin v1.0.0
```

CI 会构建、组装发布包（含运行时依赖）、打成 zip 并挂到 Release 上。也可以在 Actions 页面手动 `workflow_dispatch`。

## 目录结构

```
.
├── src/                    # 原插件后端（未改动）
├── web/                    # 原插件前端（未改动）
├── media/                  # 前端构建产物（out.min.js / out.min.css，不提交）
├── resources/              # 图标等静态资源
├── standalone/             # 独立版全部新增代码
│   ├── src/
│   │   ├── adapter/        # vscode API 适配层（核心）
│   │   ├── server.ts       # HTTP + WebSocket 服务
│   │   ├── main.ts         # 启动、参数、配置持久化
│   │   ├── diff.ts         # 差异页渲染
│   │   ├── repoApi.ts      # 仓库管理 API
│   │   └── repoPicker.ts   # /repos 选择页
│   ├── assets/             # 浏览器端桥接脚本与主题变量
│   ├── packaging/          # start.bat / start.sh
│   ├── build.js            # 构建脚本
│   └── data/               # 运行时数据（不提交）
├── tests/                  # 原插件单元测试
└── .github/workflows/      # 发版流程
```

## 已知限制

| 项目 | 现状 |
|---|---|
| 打开文件 | 调用系统默认程序，而不是编辑器内打开 |
| 差异高亮 | 只有增删配色，没有语法高亮 |
| 删除仓库 | 只能在 `/repos` 选择页操作 |
| Git 凭据输入（askpass） | 未接入，私有仓库操作依赖系统凭据管理器 |
| 归档导出（Create Archive） | 不支持，原实现依赖 VS Code 的保存对话框 |
| 终端 | 打开系统终端，不是编辑器内嵌终端 |
| 多仓库 | 仓库下拉排序中的 `Workspace Full Path` 退化为按路径排序 |

## 常见问题

**端口被占用？** 服务会自动尝试 `7583` 之后的端口，控制台日志里有实际地址；也可以用 `--port` 指定。

**页面白屏？** 说明 `media/out.min.js` 没被正确提供。确认 `media/` 目录存在（从源码跑时先执行 `npm run build`），以及启动日志里 `Extension path:` 指向的是仓库根。

**提示找不到 Git？** 把 Git 加到 `PATH`，或在 `settings.json` 的 `config` 里设置 `git.path`。

**macOS / Linux 上 `start.sh` 不能执行？** `chmod +x start.sh`。

**数据存到哪了？** 默认 `standalone/data/`，日志在同名子目录 `logs/`。删掉整个目录即可重置。

## 许可与致谢

本项目基于 [mhutchie/vscode-git-graph](https://github.com/mhutchie/vscode-git-graph)（MIT），保留原仓库的 `LICENSE` 与署名。原项目的 `src/` 与 `web/` 未做修改，新增部分集中在 `standalone/`。

图标来源：

- [GitHub Octicons](https://octicons.github.com/)（[License](https://github.com/primer/octicons/blob/master/LICENSE)）
- [Icons8](https://icons8.com/icon/pack/free-icons/ios11)（[License](https://icons8.com/license)）
