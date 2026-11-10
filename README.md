# CineCut · 视频剪辑工坊

> **截图说明**：本仓库 README 中的界面图均为 **容器实际运行的测试数据截图**，示例内容（任务名、文件名、链接、账号等）全部为本地生成的测试数据，不含任何真实链接、账号信息或视频画面。

一个跑在绿联 DXP4800 Plus（UGOS Pro / Docker）上的**轻量非线编视频剪辑器**：浏览 `/input` 素材、剪辑片段、调整音轨、缩放/旋转画面、叠加图片与字幕，然后加入持久化渲染队列，由服务端 FFmpeg 输出成片。

后端只用 **Python 标准库**（HTTP + SQLite + subprocess），前端原生 HTML/CSS/ES Module，不引 CDN、不需要 npm 构建；外部依赖只有 `ffmpeg` / `ffprobe`。

![CineCut 主界面](docs/screenshots/ui-00-hero.png)

## 功能

### 功能在哪（属性面板速查）
选中时间线片段后，右侧「属性」面板顶部有一排快捷按钮，点一下直接滚到对应设置：**片段/速度、画面裁剪、特效、关键帧、音频、转场**。

每个设置分组的标题右侧有一个 ↺「恢复默认」：片段/速度/画面、马赛克、裁剪/蒙版、混合模式、转场、特效、关键帧、音轨、字幕样式、画面调色都能一键还原；单个特效卡也有自己的 ↺（恢复参数默认值并清空该特效的关键帧）。

| 想做什么 | 入口 |
| --- | --- |
| 画面缩放 / 旋转 / 翻转 / 填充方式 | 选中片段 →「片段 / 速度 / 画面缩放」 |
| 四边裁剪、矩形/椭圆蒙版、羽化 | 选中片段 →「画面裁剪 / 蒙版」 |
| 自定义倍速 25%–400% | 选中片段 →「片段 / 速度 / 画面缩放」→ 速度滑杆（音频自动 atempo 不变调） |
| 单独调音频 | 主轨属性点「分离 / 提取音轨」（或双击原声块）；选中音轨片段调音量/速度/淡入淡出/声像/音频特效；多条音轨用工具栏「混音」 |
| 转场 / 关键帧 / 特效 / 混合模式 | 同一排快捷按钮：转场、关键帧、特效；叠加层另有「混合模式」 |

### 剪辑
- 主轨顺序拼接多个视频片段，拖拽调整顺序。
- **多轨道**：主轨之外可新建任意数量的视频轨、音频轨、字幕轨（每类最多 12 条）。新建视频轨默认置顶；选中轨道后，从素材库添加的素材会优先进入该轨道；也可以在属性面板里把素材换到其它轨道。
- **拖素材直接落到指定轨道**：从素材库或内置素材面板拖到目标轨道即可添加/换轨，落点时间由指针位置决定；轨道高亮、虚线占位块、吸附竖线、时间浮标会同步显示。主轨拖入视频按落点插入。
- **多选与右键菜单**：`Ctrl/Cmd + 点击`增减选择、`Shift + 点击`选择范围；在时间线空白处**按住左键约 0.3 秒**后拖动可框选多个片段（按住 `Ctrl/Shift` 追加），松开后批量操作；右键片段打开批量菜单，可批量复制/剪切/删除、在播放头分割、静音、分离音轨、移动轨道、应用滤镜或马赛克。
- **全选按钮**：时间线工具栏「全选」或 `Ctrl/Cmd + A` 可一次选中主轨、叠加、音轨、字幕全部片段，随后批量复制、删除、静音、换轨。
- **自由换轨**：叠加/音轨/字幕可直接拖到同类轨道；主轨片段拖到视频轨会转为叠加层并保留原声；视频叠加层也可以拖回主视频轨、重新转为顺序片段。右键「移动到指定轨道」、或 `Alt + ↑/↓` 快速切换上/下一条同类轨道。图片、音频、字幕不能作为主轨片段（主轨只接受视频画面）。
- **拖动有明确落点反馈**：拖动片段时所有兼容轨道先弱高亮，指针进入目标轨道（含左侧轨道标签）后强高亮，并显示目标轨道名、落点时间、虚线占位块和吸附竖线；主轨排序显示插入位置和让位动画，落点后高亮闪一下。
- 片段裁剪：拖左右边缘，或把播放头移到片段内后点「播放头设为入点 / 出点」。
- 播放头分割（`S`）、复制、删除、撤销/重做。
- 速度 0.25×–4×（音频用 atempo 联动，不变调）。
- 画面缩放 5%–200%、旋转 0/90/180/270°、水平/垂直翻转、完整显示/铺满裁切。
- 片段淡入/淡出；画面亮度、对比度、饱和度调色。
- 画布支持 16:9 / 9:16 / 1:1 / 4K 等预设，也支持任意自定义尺寸。

> 说明：本工具是「片段式时间线」，不是逐帧多轨合成器；主轨用于成片顺序，叠加层/字幕/音轨都以绝对时间挂在成片时间线上。

### 专业剪辑（v1.3 新增）
- **转场**：主轨相邻片段可设 19 种转场（淡化、溶解、左/右/上/下滑动、圆形、径向、像素化、模糊、平滑左右/上下、斜向擦除等），时长可调，时间线总长自动扣除重叠。
- **关键帧动画**：缩放、旋转、不透明度、音量、位置、字号等参数可按播放头打关键帧，支持线性/缓入/缓出/缓入缓出/保持插值；渲染时按关键帧切片固化参数，预览同步插值。
- **特效链**：每个片段可叠加最多 24 个视频/音频特效，含亮度、对比度、饱和度、伽马、色相、色温、曝光、暗角、三向调色、曲线、棕褐、黑白、反相、3D LUT、模糊、锐化、像素化、海报化、描边、颗粒、遮幅、去隔行、防抖、降噪、裁剪、旋转、色度键、不透明度，以及音量、高低切、均衡、低音/高音、压缩、限幅、噪声门、混响、变调、立体声宽度、响度归一、闷音、声像。
- **混合与蒙版**：叠加层支持 15 种混合模式（正常、相乘、滤色、叠加、柔光、强光、差值、变亮/变暗等）、四边裁剪、矩形/椭圆蒙版与羽化、反转蒙版、不透明度。
- **字幕增强**：SRT 导入/导出；字号、颜色、描边、阴影、底框透明度、斜体、不透明度；字幕位置/字号可打关键帧。
- **音频工作流**：音频混音台按轨调节 0–200% 音量与 M/S；音频片段支持声像、速度、淡入淡出、循环与整套音频特效。
- **时间线与监看**：标记点（点击跳转、双击删除）、吸附开关、音频波形、RGB 直方图（示波器）。
- **派生片段**：右键「插入冻结帧」「倒放片段」，服务端用 FFmpeg 生成派生素材并自动入轨；派生文件按 1 秒一个关键帧编码，预览拖动定位更跟手。
- **编辑命令**：分割所有轨道（`Ctrl+K`）、波纹删除（`Shift+Delete`）、复制/剪切/粘贴、多选批量操作。
- **队列清理**：任务队列工具栏「全部删除」可一键清空所有记录（先终止运行中的任务，已导出文件保留）。
- **分屏导出**：导出可指定起始/结束时间，只渲染时间线的一段；31 种容器/编码格式保持不变。

### 音频
- 导入视频到主轨后，音轨轨会自动显示该视频的「原声」联动块，默认可见、可选中。
- 在主轨属性里点「分离 / 提取音轨」或双击原声联动块，即可把原声提取为独立音轨；分离后可独立裁剪、移动、调节音量/速度/淡入淡出/入点/循环，主轨画面自动静音避免重复。
- 每个主轨片段仍有独立音量、静音、淡入淡出（未分离时直接编辑原声）。
- 额外音轨：从任意视频/音频中取音轨，设置开始时间、入点、时长、音量、速度、淡入淡出、循环。
- 最终混音 `amix` + `alimiter` 防削波；没有音轨的素材自动补静音轨，保证拼接一致。

### 素材
- 浏览 `/input` 目录，按视频/图片/音频筛选；缩略图、时长、分辨率、体积。
- 浏览器上传（拖拽或按钮）到 `/input/uploads`，同名自动编号。
- 图片或视频可作为叠加层：位置、缩放、旋转、不透明度、时间范围。
- 字幕：多行文本、字号、颜色、半透明底框、位置、时间范围。

### 内置素材（22 滤镜 / 16 字幕模板 / 21 贴图 / 16 音效 / 9 特效）
- **滤镜**：原片、电影感、青橙、冷调、暖阳、黑白、复古、鲜艳、褪色、夜景、高对比、日系、北欧冷灰、棕褐、霓虹、柔光、黑色电影、落日、薄荷、秋日、冰川、80 年代；支持色温、暗角、亮度/对比度/饱和度/色相。
- **字幕模板**：电影标题、开场大标题、纪录片、新闻条、综艺、极简、片尾卡、章节标题、金句、地点时间、人物介绍、双语、警示、倒计时、发言人、日期戳。
- **视频贴图**：NEW/REC/订阅/下三分之一/CUT/箭头/闪光，以及点赞、LIVE、热播、4K HDR、关注、分享、TOP 1、重点圈选、手绘下划线、白色箭头、对话气泡、感叹号、金星、蓝色人物条。
- **音频素材**：氛围铺底、转场 Whoosh、低频 Impact、UI Click，以及 Pop、通知、Swoosh、Riser、Glitch、心跳、键盘、快门、铃声、Bass Drop、掌声、倒计时。
- **马赛克特效**：中央/人像/强/全屏像素化、中央/人像/底部高斯模糊、黑条与黑块遮挡；可调区域、块大小/强度。
- 内置素材点击即应用；也可以直接拖到时间线对应轨道（贴图→视频轨、字幕模板→字幕轨、音效→音频轨、滤镜/特效→主轨片段）。

### 预览
- Canvas 实时预览：变换、旋转、翻转、叠加、字幕、色温/暗角/调色、像素化/模糊/黑块遮挡近似所见即所得。
- 播放/暂停、逐帧、拖动进度、静音预览；点击播放按钮或预览画面都可以暂停/继续。
- 时间线工具栏按钮与键盘 `←` / `→` 都能逐帧前进/倒退；预览器显示 `F 当前帧 / 总帧数`。
- 时间线缩放、播放头跟随滚动。

### 渲染队列
- 任务持久化到 SQLite（`/data/app.db`）：刷新页面、关闭浏览器、重启容器都不丢队列与工程。
- 工程自动保存：编辑后 700ms 落盘，顶部显示「已保存」；关闭页面/切到后台时用 `sendBeacon` 兜底写入。
- **手动保存**：顶栏保存按钮或 `Ctrl/Cmd+S`，立即写入 `/data`。
- **另存为工程**：工程管理里输入新名称 →「另存为当前工程」，会复制当前工程内容为新工程并切换过去。
- **工程文件**：工程管理支持导出/导入 `.cinecut.json`；每次保存还会在 `/data/projects/<工程ID>.cinecut.json` 留一份可读快照。
- 多工程：新建工程不会覆盖旧工程，顶部工程名 → 工程管理可随时重新打开之前任何一个工程继续编辑。
- 导出跨 `/data` 与 `/output` 两个挂载点时自动复制落盘（兼容 NAS 的 `EXDEV: Cross-device link`）。
- 单个任务：暂停、继续、终止、重试、删除、查看日志、打开成片。
- 队列级：暂停队列（不再开始新任务）、启动队列、清除全部已完成、一键重试全部失败。
- 批量：勾选多个任务，批量暂停 / 继续 / 终止。
- 日志从旧到新向下追加，默认自动滚动到底部，可按任务筛选。
- **断点续渲**：主轨按片段编码，完成的分段写入 `/data/work/<task>`；容器重启后任务标为「已中断」，点继续只补未完成片段，最后无损拼接。

### 导出
- 自定义文件名、导出子目录。
- 默认**不覆盖**同名文件，自动追加 ` (1)`、` (2)`；勾选「强制覆盖同名文件」才覆盖。
- **31 种导出格式**：
  - 视频：MP4、MKV、MOV、M4V、AVI、FLV、WebM、TS、M2TS、MTS、WMV、OGV、MPG、VOB、3GP
  - 动图：GIF（无声音，最高 12fps）
  - 音频：MP3、M4A、M4B、AAC、FLAC、WAV、OGG、OGA、OPUS、WMA、AIFF、ALAC、AC3、MKA、CAF
- 视频格式可选画质 CRF 18/21/25 与编码预设；纯音频/GIF 自动忽略视频画质项。
- 扩展名由所选格式自动决定，文件名输入框不需要手写扩展名。
- 有叠加/字幕/音轨时走「分段 → 拼接 → 最终合成」；纯主轨直出时只编码一次并 `-c copy` 拼接。

### 界面
- 深色玻璃拟态工作台，7 套配色：午夜青、深海蓝、暮光紫、琥珀金、苔原绿、玫瑰红、日光白。
- 主题选择保存在浏览器 localStorage；1440×900 与窄屏自适应。
- 全部图标为内联 SVG，字体使用系统中文字体栈。

## 截图

| 剪辑台 | 叠加层属性 |
| --- | --- |
| ![主界面](docs/screenshots/ui-00-hero.png) | ![叠加层](docs/screenshots/ui-07-overlay.png) |

| 自定义多轨道 | 拖动落点反馈 |
| --- | --- |
| ![多轨道](docs/screenshots/ui-10-custom-tracks.png) | ![拖动](docs/screenshots/ui-11-drag.png) |

| 任务队列 | 运行日志 |
| --- | --- |
| ![队列](docs/screenshots/ui-02-queue.png) | ![日志](docs/screenshots/ui-03-logs.png) |

| 导出设置 | 配色主题 |
| --- | --- |
| ![导出](docs/screenshots/ui-04-export.png) | ![主题](docs/screenshots/ui-05-themes.png) |

| 内置素材库 | 多选批量操作 |
| --- | --- |
| ![内置素材](docs/screenshots/ui-17-builtin-expanded.png) | ![多选](docs/screenshots/ui-18-multi-select.png) |

| 右键菜单 | 拖到指定轨道 |
| --- | --- |
| ![右键菜单](docs/screenshots/ui-19-context-menu.png) | ![拖拽轨道](docs/screenshots/ui-21-drag-track.png) |

| 全选所有片段 | 主轨转为叠加层 |
| --- | --- |
| ![全选](docs/screenshots/ui-22-select-all.png) | ![主轨换轨](docs/screenshots/ui-23-move-main.png) |

| 拖到轨道标签 | 兼容轨道提示 |
| --- | --- |
| ![拖到标签](docs/screenshots/ui-24-drag-label.png) | ![兼容轨道](docs/screenshots/ui-25-drag-hint.png) |

| 视频叠加层移回主轨 | 主轨换轨菜单 |
| --- | --- |
| ![移回主轨](docs/screenshots/ui-26-overlay-to-main.png) | ![主轨换轨](docs/screenshots/ui-23-move-main.png) |

| 长按左键框选 | 框选后批量操作 |
| --- | --- |
| ![框选](docs/screenshots/ui-27-marquee.png) | ![框选结果](docs/screenshots/ui-28-marquee-selected.png) |

日光白主题：

![日光白](docs/screenshots/ui-06-daylight.png)

## 部署（Docker / 绿联 DXP4800 Plus）

把整个 `dxp-video-editor/` 目录放到 NAS（例如 `/volume1/docker/cinecut`），复制 `.env.example` 为 `.env`，把 `HOST_INPUT_DIR` / `HOST_OUTPUT_DIR` 指向你的素材与成片目录，然后：

```bash
cd /volume1/docker/cinecut
docker compose up -d --build
```

打开 `http://NAS_IP:3873`。

构建层顺序做了优化：`runtime` 阶段只安装 FFmpeg/字体，`app` 阶段先 `COPY` 代码并自检，最后才写版本号 `ENV/LABEL`。因此改代码或发版都不会重装 FFmpeg；只有改 Dockerfile 依赖层、基础镜像或 `APK_MIRROR` 时才会重新下载 apk。不编译任何源码，也不需要 npm/pip。

### 快速重建（日常改代码用这个）

```bash
cd /volume1/docker/cinecut
bash scripts/rebuild.sh
```

脚本会强制启用 BuildKit、执行 `docker compose build`，然后 `up -d --no-build`。依赖层命中缓存时通常几秒完成。只看构建、不启动容器：

```bash
bash scripts/rebuild.sh --build-only
```

> 从旧版 Dockerfile 升级到这个分层结构的**第一次构建**仍可能重建 ffmpeg/字体层；这次之后，日常改代码或发版只会重建 app 层。

排错：

- **不要**每次加 `--no-cache`，否则一定会重装 FFmpeg/字体；只有怀疑缓存损坏时才用 `docker compose build --no-cache`。
- 首次构建或改 `APK_MIRROR` 后需要重新下载 apk，可在 `.env` 设置 `APK_MIRROR=mirrors.aliyun.com`，并先手动 `docker pull python:3.12-alpine3.21`。
- 想确认是否命中缓存，可运行 `docker compose build --progress=plain`，看 `RUN apk add` 是否显示 `CACHED`。

### 端口与挂载

| 项目 | 值 |
| --- | --- |
| 网络 | `network_mode: bridge` |
| 端口 | `3873:3873` |
| 素材输入 | `${HOST_INPUT_DIR:-./input}:/input` |
| 成片输出 | `${HOST_OUTPUT_DIR:-./output}:/output` |
| 持久化数据 | `./data:/data`（SQLite、缩略图、分段缓存、日志） |

> `./data` 是相对 compose 文件所在目录。它必须持久化：删除 `/data` 等于删除工程、队列和断点缓存。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `TZ` | `Asia/Shanghai` | 容器时区 |
| `INPUT_ROOT` | `/input` | 素材根目录 |
| `OUTPUT_ROOT` | `/output` | 导出根目录 |
| `HOST_INPUT_DIR` | `./input` | 宿主机素材目录（挂载到 `/input`） |
| `HOST_OUTPUT_DIR` | `./output` | 宿主集成片目录（挂载到 `/output`） |
| `DATA_DIR` | `/data` | 数据库与工作目录 |
| `PORT` | `3873` | 监听端口 |
| `MAX_UPLOAD_MB` | `8192` | 单文件上传上限 |
| `MAX_CONCURRENT_RENDERS` | `1` | 渲染线程数；NAS 建议保持 1 |
| `ACCESS_PASSWORD` | 空 | 设置后启用 HTTP Basic 认证，用户名固定 `cinecut` |
| `FONT_FILE` | 自动查找 | 字幕字体路径；镜像内已装文泉驿正黑 |

镜像使用 **Alpine 3.21 + apk** 安装 FFmpeg 与字体，首次构建通常比 Debian 方案快很多、体积也更小。国内网络可复制 `.env.example` 为 `.env`，设置：

```dotenv
BASE_IMAGE=docker.m.daocloud.io/library/python:3.12-alpine3.21
APK_MIRROR=mirrors.aliyun.com
```

### 数据目录结构

```text
data/
├── app.db                 # 工程、任务、日志（SQLite WAL）
├── projects/              # 每个工程的 .cinecut.json 可读快照（可导入迁移）
├── thumbs/                # 素材缩略图缓存
└── work/<task_id>/        # 分段视频、字幕文本、拼接清单（完成后清理）
```

## 使用流程

1. 左侧浏览 `/input`；双击视频加入主轨，或点行内「叠加」「音轨」。
2. 在时间线上拖片段边缘裁剪，拖动叠加/字幕/音轨块调整开始时间。
3. 选中片段，在右侧「属性」调节速度、音量、缩放、旋转、填充、淡入淡出。
4. 点「字幕」在播放头处新建字幕；点「分割」在播放头切分主轨。
5. 需要额外素材时点素材库右上角上传按钮，或直接把文件拖进素材库。
6. 点右上角「导出影片」设置文件名、画质，加入渲染队列。
7. 在右侧「队列」查看进度；「日志」看 FFmpeg 实时输出。

### 快捷键

| 操作 | 快捷键 |
| --- | --- |
| 播放 / 暂停 | `Space` |
| 倒放 / 暂停 / 播放 | `J` / `K` / `L` |
| 在播放头分割 | `S` |
| 删除选中 | `Delete` / `Backspace` |
| 复制 / 剪切 / 粘贴 | `Ctrl/Cmd + C` / `X` / `V` |
| 复制一份 | `Ctrl/Cmd + D` |
| 撤销 / 重做 | `Ctrl/Cmd + Z` / `Ctrl/Cmd + Shift + Z` |
| 逐帧前后 | `←` / `→` |
| 前后 1 秒 | `Shift + ←` / `→` |
| 跳到上/下剪切点 | `↑` / `↓` |
| 入点 / 出点 | `I` / `O` |
| 静音选中 | `M` |
| 时间线缩放 | `+` / `-` |
| 全屏预览 | `F` |
| 保存 | `Ctrl/Cmd + S` |
| 关闭弹窗 / 菜单 | `Esc` |
| 全选所有片段 | `Ctrl/Cmd + A` 或时间线「全选」 |
| 上/下一条同类轨道 | `Alt + ↑ / ↓` |
| 多选 / 范围选择 | `Ctrl/Cmd + 点击` / `Shift + 点击` |
| 批量菜单 | 右键片段 / 素材 / 内置素材 |

## 队列语义

- **暂停队列**：不再领取新的排队任务，当前正在编码的任务继续。状态持久化，重启后保持。
- **暂停任务**：运行中任务对 FFmpeg 进程组发 `SIGSTOP`，进度和进程都冻结；继续发 `SIGCONT`。
- **终止任务**：结束进程组并标记「已终止」，可重试。
- **重试**：失败 / 已终止任务重新排队；已完成片段默认复用（除非整个工作目录已被清理）。
- **清除已完成**：只删任务记录与日志，不删 `/output` 里的视频。
- **重启恢复**：服务启动时把上次的 `running` 任务改为 `paused`，保留分段；点继续会从断点补编码。

## 导出命名

- 输入 `旅行` 并选 MP4 → `旅行.mp4`；选 MP3 → `旅行.mp3`（扩展名跟随所选格式）。
- 已存在且未勾选覆盖 → `旅行 (1).mp4`、`旅行 (2).mp4`（各格式同理）……
- 勾选覆盖 → 直接原子替换同名文件。
- 子目录会做路径清洗，不允许 `..` 或跳出 `/output`。

## 目录结构

```text
dxp-video-editor/
├── app/
│   ├── server.py          # HTTP API / SSE / 静态资源 / Range 流媒体
│   ├── tasks.py           # 持久队列、暂停/继续/终止、FFmpeg 执行
│   ├── render.py          # 分段、拼接、叠加、字幕、混音命令构建
│   ├── project.py         # 工程文档白名单校验与导出参数
│   ├── media.py           # 目录浏览、ffprobe、缩略图、路径安全
│   ├── db.py              # SQLite 持久化
│   ├── config.py          # 环境变量与路径
│   └── static/            # 原生前端（index.html / style.css / js/*）
│       └── builtin/       # 内置滤镜/字幕/贴图/音效 manifest 与素材
├── scripts/
│   ├── rebuild.sh          # 快速重建（复用 ffmpeg/字体层）
│   ├── gen_builtin_assets.py  # 开发期生成内置 PNG/WAV 与 manifest
│   ├── bump_version.py
│   └── check_version.py
├── tests/test_backend.py  # 单元 + FFmpeg 集成测试
├── Dockerfile
├── docker-compose.yml
├── VERSION                 # 唯一版本源
└── docs/screenshots/
```

## HTTP API（摘要）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/healthz` | 健康检查（免认证） |
| GET | `/api/config` | 版本、路径、FFmpeg 状态 |
| GET | `/api/files?path=` | 目录浏览 + ffprobe 元数据 |
| GET | `/api/thumb?path=` | 缩略图 |
| GET | `/api/media?path=` | 素材流（支持 Range） |
| GET | `/api/output?path=` | 成片流（`download=1` 强制下载） |
| GET/POST | `/api/projects` | 工程列表 / 新建（可带 `doc`） |
| GET/PUT/DELETE | `/api/projects/{id}` | 读取 / 保存 / 删除 |
| POST | `/api/projects/{id}/save` | 手动保存（sendBeacon 兼容） |
| GET | `/api/projects/{id}/export` | 导出 `.cinecut.json` 工程文件 |
| POST | `/api/projects/import` | 导入工程文件 |
| POST | `/api/render` | 提交渲染任务 |
| GET | `/api/tasks` | 任务列表 + 队列状态 |
| POST | `/api/tasks/{id}/action` | `pause` / `resume` / `stop` / `retry` |
| POST | `/api/tasks/batch` | 批量任务操作 |
| POST | `/api/tasks/clear-completed` | 清除已完成 |
| POST | `/api/tasks/retry-failed` | 重试全部失败 |
| POST | `/api/queue` | `pause` / `start` 队列 |
| GET | `/api/events` | SSE：任务更新、日志、队列状态 |
| POST | `/api/upload` | 原始字节上传（query: `dir`、`name`） |

## 限制与说明

- 视频编码为软件 `libx264`，默认单 worker；不启用 QSV/NVENC，避免 NAS 驱动与设备映射问题。
- 单个工程最多 300 个主轨片段、100 个叠加层、50 条音轨、100 条字幕；工程时长上限 12 小时；时间线轨道超出可视高度时可纵向滚动。
- 预览音频为浏览器侧近似同步；最终以服务端 FFmpeg 混音为准。
- 默认无认证，只适合内网；暴露到公网请设置 `ACCESS_PASSWORD` 并放在反向代理之后。
- 素材目录同时用于上传，因此容器对 `/input` 需要写权限（仅写 `/input/uploads`）。
- Docker 镜像没有内置硬件编码和 GPU 支持；DXP4800 Plus 的 CPU 软编 1080p 足够，4K 长片会慢。

## 上机检查清单（无法在本开发环境验证的部分）

- [ ] `docker compose up -d --build` 能成功构建（本开发环境无 Docker daemon，仅验证了 compose YAML 与宿主机运行）。
- [ ] 两个中文长路径在 UGOS Pro 上可正常挂载，容器内 `/input`、`/output` 可读写。
- [ ] 打开 `http://NAS_IP:3873` 显示剪辑台，`/healthz` 返回 `{"ok":true}`。
- [ ] 上传一个带中文名的视频，能出现在 `/input/uploads`。
- [ ] 导出一个带字幕/叠加/音轨的成片，中文不出豆腐块。
- [ ] 导出同名文件两次，第二次生成 ` (1)`。
- [ ] 渲染 30 秒以上视频时点暂停，进度停止；继续后完成。
- [ ] 渲染中重启容器，任务变「已中断」；继续后复用已完成分段并完成。
- [ ] 暂停队列后新任务保持排队；启动队列后自动开始。

## 版本管理

当前版本：**1.3.2**。

- `VERSION` 是唯一版本源；后端 `config.APP_VERSION`、顶栏版本号、`/healthz`、工程快照都从它读取。
- Docker 镜像 tag 由 Compose 的 `APP_VERSION` 变量决定，默认值与 `VERSION` 同步；Dockerfile 也会写入 OCI version 标签。
- 每次更新必须执行：

```bash
python3 scripts/bump_version.py patch   # 或 minor / major / 1.2.3
# 补充 CHANGELOG.md
python3 scripts/check_version.py
```

`bump_version.py` 会同步 `VERSION`、`docker-compose.yml`、`.env`（如存在）、`.env.example`、`Dockerfile` 和前端兜底版本；`check_version.py` 不一致时返回非零退出码。后端测试也包含版本一致性检查。

## 开发与测试

本机安装 `ffmpeg`、`ffprobe` 后：

```bash
cd dxp-video-editor
python3 -m app.server --check
python3 -m unittest discover -s tests -v
PORT=3873 INPUT_ROOT=./input OUTPUT_ROOT=./output DATA_DIR=./data \
  python3 -m app.server
```

测试会在 `tests/.testdata` 现场生成 640×360 视频、无音轨竖屏视频、PNG、MP3，覆盖：

- 工程文档裁剪/时长计算、导出参数清洗、重名编号；
- 完整 FFmpeg 渲染链（裁剪、变速、旋转、缩放、叠加、字幕、混音、调色）；
- 无音轨素材自动补静音；
- 队列直出、命名 ` (1)`、工作目录清理；
- 暂停/继续/终止、重启中断标记；
- HTTP 文件列表、Range、上传、路径穿越、导出接口；
- 内置素材 manifest 完整性（文件存在、ID 唯一、滤镜/特效字段）；
- 色温/暗角滤镜与像素/模糊/黑块三种遮挡的命令构建和真实 FFmpeg 编码。

最近一次测试结果见 [TEST_REPORT.md](TEST_REPORT.md)。

## 安全

- 所有素材路径在服务端 `realpath` 后校验必须位于 `/input`，导出路径必须位于 `/output`，禁止 `..` 与符号链接逃逸。
- 任务提交时只接受白名单字段，数值全部 clamp；字幕通过 `textfile` 传给 FFmpeg，不拼接 shell。
- 不使用 `shell=True`；FFmpeg 进程组单独管理，支持暂停与终止。
- 容器不挂载 `docker.sock`、不使用 `privileged`。
- 可选 HTTP Basic 认证；默认面向局域网。
