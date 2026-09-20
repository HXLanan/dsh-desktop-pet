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
| 👆 **悬停变手型** | 鼠标移到宠物身上变指示手型，拖拽时变抓握手型；透明区域不响应，不会挡住下面窗口的点击 |
| 🎭 **9 种表情状态** | `approval` / `question` / `idle` / `thinking` / `working` / `happy` / `error` / `sleep` / `poke` |
| 🔐 **权限请求醒目提示** | DSH 弹出授权请求时，宠物变琥珀色并**脉冲发光**——一眼看出 agent 卡在等你 |
| ❓ **提问提示** | agent 用 `ask_user_question` 提问时变青色并脉冲 |
| 🔄 **跟随 DSH 状态** | 浏览器半边感知 DSH 正在思考/执行/出错，实时切换表情 |
| 👆 **点击播动画** | 单击宠物 → 立刻播放一次「被戳到」的弹性反应，纯玩耍，不干扰 DSH |
| 🖼️ **PNG 序列帧动画** | 丢一组 PNG 进目录就是一套动画 —— **详见下方「更换桌宠」** |
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

## 🎨 更换桌宠（重点章节）

内置的是一只代码画出来的蓝色小圆生物，它只是**占位形象**——给你用来验证整条链路。要换成自己想要的宠物（你的 OC、表情包角色、公司吉祥物……），**只需要往一个目录里丢 PNG，不用改任何代码**。

---

### 一、30 秒快速上手

假设你已经有一只宠物的图片，想先看看效果：

```sh
# 1. 找到素材目录（没有就自己建）
mkdir -p "$DSH_HOME/desktop-pet/assets/idle"

# 2. 丢一张 PNG 进去（文件名随便，但建议 frame_01.png 这种）
cp 我的宠物.png "$DSH_HOME/desktop-pet/assets/idle/frame_01.png"

# 3. 重启桌宠让它重新加载素材
```

> Windows PowerShell 对应：
> ```powershell
> New-Item -ItemType Directory -Force "$env:DSH_HOME\desktop-pet\assets\idle"
> Copy-Item 我的宠物.png "$env:DSH_HOME\desktop-pet\assets\idle\frame_01.png"
> ```

**只丢一张图**的话，宠物就静止显示它——这已经能用了。想看动起来，就往同一个目录多丢几张（见下面「做成动画」）。

**如何确认素材被加载了**：看 `$DSH_HOME/desktop-pet/pet.log`，会有一行：

```
mood 'idle': 6 sprite frame(s)      ← 成功读到 6 帧
```

如果显示的是 `poke reaction: 8 drawn frame(s)` 这类 **drawn** 字样，说明那个状态没找到素材，用的是代码占位图。

---

### 二、目录结构：每个状态一个文件夹

宠物一共有 **9 个状态**，每个状态在自己的文件夹里放一组 PNG：

```
$DSH_HOME/desktop-pet/assets/
├─ idle/        😌 空闲，DSH 没在忙
├─ thinking/    🤔 模型正在思考（已发出请求，还没开始吐工具）
├─ working/     ⚙️ 正在执行工具调用
├─ happy/       🎉 你发了消息之后的短暂庆祝
├─ error/       ❌ 出错了
├─ sleep/       😴 休眠
├─ approval/    🔐 有权限请求在等你批准   ← 最重要
├─ question/    ❓ agent 在向你提问
└─ poke/        👆 你点了它一下的一次性反应
```

| 状态 | 什么时候显示 | 建议 |
|---|---|---|
| `idle` | 大部分时间 | 最常看到，值得多做几帧做呼吸感 |
| `thinking` | 你发消息后、模型出字前 | 可以是「歪头思考」 |
| `working` | 工具在跑（读文件、执行命令） | 可以是「忙碌/打字」 |
| `happy` | 你按下发送键后约 2 秒 | 短促的开心表情 |
| `error` | 出错时 | 沮丧/冒汗 |
| `sleep` | 休眠 | 闭眼、打呼 |
| **`approval`** | **DSH 弹权限框等你授权** | **最重要**——这是桌宠的核心价值，建议做得最醒目 |
| `question` | agent 用 `ask_user_question` 问你 | 疑问/举手的姿态 |
| `poke` | 点击它的瞬间，播一次就恢复 | 一次性反应，建议 6–10 帧 |

**任何一个状态都可以缺席**。缺席的状态会自动回退到代码画的占位形象，所以你可以先只做 `idle` 和 `approval`，其余慢慢补。

---

### 三、做成动画：序列帧

同一个文件夹里放**多张** PNG，就是一段动画：

```
assets/idle/
├─ frame_01.png
├─ frame_02.png
├─ frame_03.png
└─ frame_04.png
```

播放规则：

- **顺序按文件名自然排序**——`frame_2.png` 会排在 `frame_10.png` 前面（这是数字感知排序，不是字典排序，所以 `2 < 10` 符合直觉）
- **循环播放**，从最后一帧回到第一帧（`poke` 例外，它只播一次）
- **速度固定为每帧 120ms**（约 8fps）。想要更顺滑就多放几帧，想要更利落就减少帧数

> 想让动画更细腻，可以给 `approval` 放 8–12 帧做脉冲呼吸效果；`idle` 放 4–6 帧做个轻微的上下浮动就很自然。

---

### 四、图片要求

| 项目 | 要求 |
|---|---|
| **格式** | PNG（必须是 PNG，其它格式不会被读取） |
| **透明** | 需要**透明背景**！宠物窗口是逐像素透明的，白底会在桌面上显示成一个白方块 |
| **尺寸** | 一个文件夹内**所有帧必须同尺寸**（否则会跳来跳去）。不同状态之间可以不同尺寸 |
| **推荐大小** | 128×128 到 256×256 之间。太小会糊，太大会占半个屏幕 |
| **缩放** | 想整体放大缩小，改插件配置里的 `scale`（见「配置」一节），不用改图 |

**关于透明背景**：如果你的素材是白底或其它纯色底，需要先抠掉。用 Photoshop、GIMP、或在线工具都行。这一步没做的话，宠物会带着一个方块底显示，很难看。

---

### 五、完整示例：装一只三状态的宠物

假设你手上有一组猫咪图，做好后目录长这样：

```
$DSH_HOME/desktop-pet/assets/
├─ idle/
│   ├─ cat_idle_01.png
│   ├─ cat_idle_02.png
│   └─ cat_idle_03.png
├─ thinking/
│   ├─ cat_think_01.png
│   └─ cat_think_02.png
└─ approval/
    ├─ cat_alert_01.png
    ├─ cat_alert_02.png
    ├─ cat_alert_03.png
    ├─ cat_alert_04.png
    └─ cat_alert_05.png
```

效果：
- `working` / `happy` / `error` / `sleep` / `question` / `poke` 继续用代码占位图（因为你没放）
- `idle` 播 3 帧猫咪呼吸
- `thinking` 播 2 帧思考
- `approval` 播 5 帧「猫咪警觉」，权限请求时循环播放

**混搭是完全可以的**——逐步替换，不用一次做齐。

---

### 六、让新素材生效

素材是在**桌宠进程启动时**读入内存的，所以放好文件后需要让它重新加载。三种方式任选：

**方式一：重启桌宠（最简单）**

浏览器控制台：

```js
dshDesktopPet.stop().then(() => dshDesktopPet.start())
```

或者直接右键单击宠物 → 「Quit pet」，然后重启 DSH。

**方式二：重启 DSH**

重启后插件会自动拉起桌宠（前提是 `autoStart` 开着），新素材随之加载。

**方式三：直接杀掉桌宠进程**

```powershell
Get-Process python | Where-Object { $_.MainWindowTitle -eq 'DSH Desktop Pet' } | Stop-Process
```

下次 DSH 启动或你调用 `start` 时会重新读素材。

**验证是否生效**：`pet.log` 里的帧数会变。比如从 `mood 'idle': 6 sprite frame(s)` 变成 `mood 'idle': 3 sprite frame(s)`，说明读到你的新素材了。

---

### 七、进阶：按状态调参数

有几个动画参数在 `pet/pet.py` 顶上，改完重启桌宠即可：

```python
#: 占位形象的每帧时长（毫秒）。数值越大越慢。
PLACEHOLDER_FRAME_MS = 120

#: 权限/提问状态光晕的呼吸周期帧数
ATTENTION_PULSE_FRAMES = 8

#: 点击反应的总帧数与每帧时长
POKE_FRAMES = 8
POKE_FRAME_MS = 60
```

> **注意**：这些参数只影响**代码画的占位形象**。你自己放的 PNG 序列帧用的是固定的 120ms/帧；想调节素材动画速度就增删帧数。

---

### 八、常见问题

**Q：放好了图片但宠物没变化？**
A：先看 `pet.log` 有没有对应的 `N sprite frame(s)` 行。如果没有，检查：① 目录名拼写（必须是 `idle` 这种小写，放在 `assets/` 下）；② 文件是不是 `.png` 结尾；③ 桌宠是不是没重启。

**Q：宠物变成一个方块了？**
A：素材没有透明背景。用图像工具抠掉背景再存成带 alpha 的 PNG。

**Q：动画抖得厉害/位置乱跳？**
A：同一个文件夹里的帧尺寸不一致。把所有帧统一成相同尺寸。

**Q：宠物太大/太小？**
A：改插件配置的 `scale`：

```yaml
- id: desktop-pet
  name: dsh-desktop-pet
  config:
    scale: 0.6      # 缩小到 60%
```

**Q：我只想让权限提醒用我的图，其它都无所谓？**
A：完全可以，只做 `assets/approval/` 一个目录就行——其它状态自动用占位图。

**Q：能用 GIF 吗？**
A：不能。只认 PNG 序列帧。GIF 需要先拆成 PNG 帧（很多工具能批量导帧）。

**Q：素材会随插件一起分发吗？**
A：不会。`assets/` 在你自己的 `$DSH_HOME` 下，属于本地数据，不进插件包。这既是隐私保护，也意味着**重装插件不会覆盖你的素材**。

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
| `poke` | 让宠物播放一次「被戳」动画（递增 `state.json` 里的 `pokes` 计数） |

### 点击宠物 → 播动画

**点击是一次纯玩耍的互动**，不触发任何 DSH 动作。桌宠当场播放 `poke` 反应动画（8 帧弹性形变，约 0.5 秒），同时把 `pet.json` 的 `clicks` 计数 +1 供 shell 观察。

**为什么完全在桌宠本地处理**：桌宠通过轮询 `state.json` 与 host 通信。若把点击绕一圈交给浏览器半边再回来，就要多等一个轮询周期——点击反馈必须即时，迟到的反应不像反应。所以点击由 `pet.py` 当场处理，`client.js` 不参与。

`poke` API 仍保留，可用于从控制台远程戳它，或将来接设置面板：

```js
dshDesktopPet.poke()      // 让它弹一下
```

### DSH 状态 → 表情的判定方式

浏览器半边每 600ms 采一次样，按**优先级从高到低**判定：

| 优先级 | 状态 | 判定依据 |
|---|---|---|
| 1 | `approval` | 存在 `[data-approval-key]` —— 权限请求等待你批准 |
| 2 | `question` | 存在 `[data-question-key]` —— agent 提问等待你回答 |
| 3 | `error` | 存在明确以 error 命名的错误面 |
| 4 | `working` / `thinking` | 会话区域文本长度在最近 2.5s 内增长过（有工具行则 `working`） |
| 5 | `idle` | 其余情况 |

**为什么权限排在最高优先级**：agent 在等你授权时，整个运行是**停住的**。这时候宠物若还显示"工作中"，就是在骗你——而桌宠存在的意义恰恰是告诉你"该看我了"。所以只要有待处理的授权/提问，其他一切状态都让位。

两个注意力状态的 DOM 标记**来自官方 bundle 的源码，不是猜的**：
- `data-approval-key` 由 `@deepseek-ai/dsh-client-ui-conversation` 的 `ApprovalFlow` 组件渲染
- `data-question-key` 由 `@deepseek-ai/dsh-client-ui-user-questions` 的 `QuestionComposer` 组件渲染

两者都**只在有待处理请求时挂载**，所以"属性存在"就等价于"agent 被阻塞了"。提问面板即使被最小化也仍持有 key——被收起来的问题依然是阻塞的问题。

**动画与视觉**：注意力状态用 8 帧的脉冲光晕（普通状态只用 2 帧呼吸），因为两帧的环状脉冲看起来像闪烁而非呼吸。同时琥珀色（授权）与青色（提问）刻意选得与 idle 蓝、working 青绿区分明显。

**庆祝会被打断**：如果点宠物触发的庆祝动作还没结束就出现了授权请求，庆祝立即中止并切到 `approval`——不能让"开心"盖住"需要你"。

**历史教训**：早期版本用 `[data-ds-tool]`、`[class*="toolCall"]`、`[role="alert"]` 等**猜出来的**选择器判状态，而这个 shell 根本不渲染这些属性，结果宠物被永久钉在 `working` 上——历史消息里只要出现过一次工具调用，那个节点就一直留在 DOM 里。现在改用"内容是否在增长"，不再依赖类名。

另外首次采样只建立基线，不判定为"增长"，否则页面一加载宠物就会误报一次忙碌。

> **已知局限**：`thinking` 与 `working` 的区分仍依赖工具行检测，命中不了就降级为 `thinking`——宁可报"模型在忙"，也不谎报"工具在跑"。

### 鼠标悬停 → 手型指针

窗口是一个包裹着不规则轮廓的**透明方块**，所以不能把整个矩形都当作宠物——否则鼠标飘在空白处也会变手型，还会挡住下层窗口的点击。

实现要点：

- **按像素判定**：对当前帧做 alpha 采样，只有落在宠物实际图形上的点才算命中（阈值 `alpha > 8`，让抗锯齿边缘也可点）。采样结果按 `(mood, 帧号)` 缓存，所以每显示一帧才查一次，而不是每次鼠标移动都查。
- **三种光标**：悬停宠物 → 指示手型 `PointingHandCursor`；按住未拖动 → 张开手 `OpenHandCursor`；拖拽中 → 握拳手 `ClosedHandCursor`；其余 → 普通箭头。
- **开启鼠标跟踪**：`setMouseTracking(True)` 是必需的，否则 Qt 不投递无按键的移动事件，光标根本无法跟随指针。
- **动画帧切换时重判**：轮廓逐帧变化，所以每换一帧都会重新判定当前指针位置（仅当鼠标确实在窗口内）。

---

## 🧪 测试

```sh
node tools/harness.mjs     # 单元级：配置解析 + API 路由 + 点击领取 + 错误处理
node tools/e2e.mjs         # 端到端：真实启动宠物 → 状态联动 → 点击 → 优雅停止
node tools/test_mood.mjs   # 状态分类器：9 种状态的判定与优先级
conda run -n dsh-pet python tools/test_poke.py              # 点击反应动画
conda run -n dsh-pet python tools/test_cursor.py            # 悬停光标与 alpha 命中判定
conda run -n dsh-pet python tools/test_attention_moods.py   # 权限/提问状态的渲染
conda run -n dsh-pet python pet/pet.py --pet-dir <dir>      # 脱离 DSH 单跑宠物窗
conda run -n dsh-pet python tools/make_test_assets.py       # 生成测试用序列帧素材
node tools/probe_dom.mjs   # 用无头 Chrome 抓 DSH 真实 DOM（排查选择器失效时用）
```

实测结果（写此文档时）：

```
ALL CHECKS PASSED                # 单元检查
E2E PASSED                       # 端到端检查
ALL MOOD CHECKS PASSED           # 20 项状态分类检查
ALL POKE CHECKS PASSED           # 13 项点击反应检查
ALL ATTENTION MOOD CHECKS PASSED # 9 项注意力状态渲染检查
ALL CURSOR CHECKS PASSED         # 8 项光标检查
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
   ├─ harness.mjs             # 单元测试
   ├─ e2e.mjs                 # 端到端测试
   ├─ test_mood.mjs           # 状态分类与优先级测试
   ├─ test_poke.py            # 点击反应动画测试
   ├─ test_cursor.py          # 光标悬停与 alpha 命中测试
   ├─ test_attention_moods.py # 权限/提问状态渲染测试
   ├─ probe_dom.mjs           # 无头 Chrome DOM 探测（排查用）
   └─ make_test_assets.py     # 生成测试用 PNG 序列帧
```

---

## ⚠️ 已知限制

- **仅 Windows**：透明窗口与 `taskkill` 生命周期管理目前按 Windows 实现。
- **需要 PyQt5**：DSH 自带的嵌入式 Python 不含 Qt，必须用自建环境。
- **状态感知是启发式的**：`approval` / `question` 两个状态读的是官方 bundle 渲染的真实属性（可靠），但 `working` 与 `thinking` 的区分仍靠工具行检测，命中不了就降级为 `thinking`。
- **素材需重启桌宠才生效**：图片在进程启动时读入内存，换素材后要让桌宠重启一次（见「更换桌宠」第六节）。
- **素材动画速度固定**：序列帧按 120ms/帧播放，想调速只能增删帧数（代码占位形象的参数可调）。

---

## 📄 许可

MIT
