# dsh-desktop-pet 🐾

**给你的 DeepSeek Harness 养一只桌宠。**

一只真正浮在 Windows 桌面上的宠物——透明、置顶、可拖拽。它会跟着 DSH 的状态变表情，点一下就能找它说话。

> 不是 Web 页面里的吉祥物，是**一个独立的操作系统窗口**。

---

## ✨ 能力

| 能力 | 说明 |
|------|------|
| 🪟 **真·桌面悬浮** | 独立透明窗口，逐像素 alpha，浮在所有窗口之上，不进任务栏、不抢焦点 |
| 🖱️ **拖拽 + 位置记忆** | 拖到哪儿就待在哪儿，重启后回到原位 |
| 🎭 **6 种表情状态** | `idle` / `thinking` / `working` / `happy` / `error` / `sleep` |
| 🔄 **跟随 DSH 状态** | 浏览器半边感知 DSH 正在思考/执行/出错，实时切换表情 |
| 💬 **点击对话** | 单击宠物 → 桌宠做庆祝动作 + DSH 输入框自动获得焦点，直接开聊 |
| 🖼️ **PNG 序列帧动画** | 丢一组 PNG 进目录就是一套动画 |
| 🎛️ **右键菜单** | 切换表情、退出桌宠 |

---

## 🏗️ 架构

```
┌──────────────────────── dsh-desktop-pet（双面插件）────────────────────────┐
│                                                                            │
│  host 半边 (lib/index.js)              client 半边 (lib/client.js)          │
│  ├─ ctx.subprocess 启动/管理宠物        ├─ 观察 DSH 会话状态                 │
│  ├─ /desktop-pet/api 状态接口          ├─ 推断 mood（思考/执行/出错）        │
│  └─ 生死跟随 DSH 生命周期              └─ 推给 host                          │
│                          │                          │                      │
└──────────────────────────┼──────────────────────────┘                      │
                           │  state.json (轮询)                              │
                           ▼                                                 │
              ┌────────────────────────────────┐                             │
              │  pet/pet.py  (PyQt5 独立进程)   │                             │
              │  透明置顶窗 · 动画 · 拖拽        │                             │
              │  回报 pet.json / pos.json       │                             │
              └────────────────────────────────┘                             │
```

**为什么用文件通信**：宠物是独立 OS 进程，而 DSH 的 Web 端口每次启动都变（OS 随机分配）。落在磁盘上的 JSON 是一个稳定的会合点，两边任一重启都不丢。

**为什么宠物进程由 DSH 托管**：host 半边通过 `ctx.subprocess` 启动，而该 seam 在自身 dispose 时会终止所有托管进程——宠物不可能在 DSH 退出后变成孤儿进程。

---

## 📦 安装

### 1. 准备 Python 环境（需要 PyQt5）

宠物窗口用 PyQt5 实现（逐像素透明需要它，WinForms 的色键透明做不出柔边效果）。

```sh
conda create -n dsh-pet python=3.13 -y
conda activate dsh-pet
pip install PyQt5
```

> 若你的网络不便，也可克隆一个已有的含 PyQt5 的环境：`conda create -n dsh-pet --clone base`。

插件会按以下顺序自动探测解释器，都不命中则回退到 PATH 上的 `python`：

1. 环境变量 `DSH_PET_PYTHON`
2. `D:\anaconda3\envs\dsh-pet\python.exe`
3. `~/anaconda3/envs/dsh-pet/python.exe`
4. `~/miniconda3/envs/dsh-pet/python.exe`
5. `C:\ProgramData\anaconda3\envs\dsh-pet\python.exe`

### 2. 装入 DSH

```sh
dsh plugin --profile web add -w <本目录绝对路径>
dsh web   # 重启生效
```

---

## ⚙️ 配置

插件配置写在 profile 的 cordis 行里，全部可选：

```yaml
- id: desktop-pet
  name: dsh-desktop-pet
  config:
    pythonPath: D:\anaconda3\envs\dsh-pet\python.exe  # 解释器
    petDir: ''            # 状态文件目录，默认 $DSH_HOME/desktop-pet
    scale: 1.0            # 缩放倍率
    pollMs: 250           # 状态轮询间隔
    autoStart: true       # 随 DSH 自动启动
    image: ''             # 指定单张图片（覆盖 idle 动画）
```

### 自动启动

桌宠默认随 DSH 启动。判定顺序（先命中者生效）：

1. 环境变量 `DSH_PET_AUTOSTART=0` / `=1` —— 最强开关，可在 loader 注入默认值时依然生效
2. 插件配置里的 `autoStart` 显式布尔值
3. 默认开启

> **排障**：若重启后桌宠没自动出现，看 `$DSH_HOME/desktop-pet/host.log`——每次 `apply` 都会记录收到的原始配置与最终判定，例如
> `apply rawConfig={"autoStart":false} autoStart=false`。
> 需要临时关掉自动启动时，设 `DSH_PET_AUTOSTART=0` 即可。

---

## 🎨 换成你自己的宠物形象

在 `petDir`（默认 `$DSH_HOME/desktop-pet`）下建 `assets/<mood>/`，把 PNG 序列帧丢进去即可：

```
$DSH_HOME/desktop-pet/assets/
├─ idle/       idle_01.png  idle_02.png  ...
├─ thinking/   think_01.png ...
├─ working/    work_01.png  ...
├─ happy/      happy_01.png ...
├─ error/      err_01.png   ...
└─ sleep/      sleep_01.png ...
```

规则：
- 文件名按**自然序**排列（`frame_2.png` 在 `frame_10.png` 之前）
- 某目录不存在或没有可加载的 PNG → 该状态自动回退到**代码绘制的占位形象**
- 帧率由 `PLACEHOLDER_FRAME_MS`（占位）与帧数（素材）决定

---

## 🔌 运行时控制

浏览器控制台里：

```js
dshDesktopPet.status()      // 查看宠物运行状态
dshDesktopPet.setMood('happy')
dshDesktopPet.toggle()      // 开关桌宠
dshDesktopPet.enable()
dshDesktopPet.disable()
```

host API（`POST /desktop-pet/api`，仅回环可达）：

| method | 作用 |
|---|---|
| `status` | 运行状态、宠物回报的位置/心情、未领取的点击数 |
| `start` / `stop` | 启动 / 停止宠物进程 |
| `mood` | 推送 `{ mood, visible? }` |
| `clicks` | 领取宠物被点击的次数（读后即清，两个标签页不会重复响应） |

### 点击宠物 → 对话

链路是：

```
用户点宠物 → pet.py 累加 pet.json 里的 clicks
           → client 半边轮询 POST {method:"clicks"} 领取
           → 桌宠做一次 happy 动作
           → client 聚焦 DSH 输入框（同时让 DSH 窗口变为活动窗口）
```

点击数用**单调递增计数器 + 读后即清**，所以多个浏览器标签页同时轮询也不会对一次点击重复响应。

> 浏览器无法直接唤起操作系统窗口，因此"聚焦输入框"是 Web 层能做到的最接近"打开对话"的效果——在 Windows 上，聚焦页面元素同时会让该窗口成为前台窗口。

---

## 🧪 测试

```sh
node tools/harness.mjs     # 单元级：配置解析 + API 路由 + 点击领取 + 错误处理
node tools/e2e.mjs         # 端到端：真实启动宠物 → 状态联动 → 点击 → 优雅停止
conda run -n dsh-pet python pet/pet.py --pet-dir <dir>   # 脱离 DSH 单跑宠物窗
conda run -n dsh-pet python tools/make_test_assets.py    # 生成测试用序列帧素材
```

实测结果（写此文档时）：

```
ALL CHECKS PASSED     # 20 项单元检查
E2E PASSED            # 8 项端到端检查
```

素材管道实测日志：

```
mood 'idle': 6 sprite frame(s)      # 有素材 → 用素材
mood 'thinking': 6 sprite frame(s)
animations ready
shown at 2391,1359 size 128x128     # 窗口自适应素材尺寸
mood -> working                     # 无素材 → 自动回退占位形象
```

---

## 📁 结构

```
dsh-desktop-pet/
├─ package.json          # dsh.bundle + dsh.client 清单
├─ cordis.patch.yml      # host loader 入口
├─ lib/
│  ├─ index.js           # host 半边：进程托管 + API + 点击队列
│  └─ client.js          # 浏览器半边：状态感知 + 上报 + 点击响应
├─ pet/
│  ├─ pet.py             # PyQt5 透明置顶宠物窗（主实现）
│  └─ pet.ps1            # PowerShell 备选实现（色键透明，保留作对照）
└─ tools/
   ├─ harness.mjs        # 单元测试
   ├─ e2e.mjs            # 端到端测试
   └─ make_test_assets.py # 生成测试用 PNG 序列帧
```

---

## ⚠️ 已知限制

- **仅 Windows**：透明窗口与 `taskkill` 生命周期管理目前按 Windows 实现。
- **需要 PyQt5**：DSH 自带的嵌入式 Python 不含 Qt，必须用自建环境。
- **状态感知是启发式的**：client 半边通过 DOM 结构推断 DSH 状态，不依赖内部 API；DSH 大改版时可能需要更新选择器。
- **点击对话尚未接线**（阶段二）：当前点击只记录事件到 `pet.json`。

---

## 📄 许可

MIT
