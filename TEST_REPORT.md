# TEST_REPORT

记录 CineCut 的验证过程与证据。开发环境为 Debian 13、Python 3.13.5、FFmpeg 7.1.5；**本环境没有 Docker daemon**，因此镜像构建与 UGOS 真机挂载只能列入上机检查清单，不能写成已验证。

## 1. 后端自动化测试

命令：

```bash
python3 -m py_compile app/*.py tests/*.py
python3 -m unittest discover -s tests -v
```

结果：

```text
Ran 23 tests in 32.284s
OK
```

覆盖内容：

| 用例 | 断言 |
| --- | --- |
| `test_sanitize_and_duration` | 画布/帧率 clamp、出点大于入点、变速后时长 2.5s、非法叠加路径被丢弃、颜色/字号清洗 |
| `test_export_options` | `../../evil` → `evil.mp4`、子目录 `../a/b` → `a/b`、CRF 99 → 40、非法 preset 回退 medium |
| `test_unique_names` | 同名生成 `movie (1).mp4`、`movie (2).mp4` |
| `test_full_render_pipeline` | 640×360 输出、变速 2×、旋转 90°、缩放 80%、调色、图片叠加、双行字幕、额外音轨混音；成片含 H.264 + AAC，时长 3.5s 左右 |
| `test_no_audio_source_gets_silent_track` | 无音轨竖屏视频自动补静音轨，输出 360×640 |
| `test_direct_render_and_naming` | 队列直出、`queue-name.mp4` 与 `queue-name (1).mp4`、完成后清理工作目录 |
| `test_pause_resume_and_stop` | 运行中暂停后进度冻结、继续后 running、终止后 canceled |
| `test_interrupted_task_marked_paused` | `running` 被启动逻辑改为 `paused`，message 含“服务重启” |
| `test_config_files_and_media` | `/api/config`、目录列表、路径穿越 400、素材流 |
| `test_range_request` | `Range: bytes=0-99` → 206、长度 100、Content-Range 正确 |
| `test_render_export_and_output` | `/api/render` 201 → 任务 done → `/api/output` 返回视频 |
| `test_upload_and_traversal` | 原始字节上传 201 并落盘；空 doc 渲染返回 400 |
| `test_finalize_across_devices` | 数据目录与 `/dev/shm` 之间制造 EXDEV，验证复制落盘与覆盖 |
| `test_project_manual_save_export_import` | 带 doc 新建工程、`/data/projects` 快照、导出/导入 `.cinecut.json`、手动保存接口 |
| `test_custom_tracks_and_assignment` | 自定义多视频/音频/字幕轨、素材 trackId 归属、非法轨道回退、视频轨 z-order 排序 |
| `test_default_tracks_exist` | 空文档自动补视频/音频/字幕三条默认轨道 |
| `test_export_formats_and_extensions` | MP4/MKV/AVI/GIF/MP3/FLAC/WAV/OGG/MOV/WebM/M4A 扩展名与非法格式回退 |
| `test_audio_and_gif_export_tasks` | MP3 任务只产出音频、GIF 任务无音轨，任务链路正确落盘 |
| `test_grade_mosaic_and_audio_defaults` | 色温/暗角 clamp、三种 `mosaicMode`、非法模式回退 pixel、音轨 `muted` 默认与清洗 |
| `test_grade_and_mosaic_modes_commands` | `colorbalance`、`vignette`、`gblur`、`drawbox`、`flags=neighbor` 命令生成，并真实编码一段模糊打码成片 |
| `test_manifest_assets_and_ids` | 内置 manifest 五类数量、ID 唯一、贴图/音频文件存在、滤镜字段完整、特效 mode 合法 |
| `test_builtin_media_resolves` | `builtin/stickers/*.png` 与 `builtin/audio/*.wav` 能被 `resolve_source` 解析 |
| `test_version_files_consistent` | `VERSION` 与 config、compose 默认值/镜像 tag、Dockerfile、`.env.example`、前端兜底、check 脚本一致 |

## 2. 服务自检

```bash
$ python3 -m app.server --check
{
  "ok": true,
  "problems": [],
  ...
  "ffmpeg": "/usr/bin/ffmpeg",
  "font": "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc"
}
```

## 3. 真实 FFmpeg 渲染（手工）

一个 6 秒 1920×1080 工程，包含：主轨 + 标题叠加图 + 字幕 + 背景音 + 调色。

```bash
ffprobe -v error -show_entries format=duration,size:stream=codec_type,width,height \
  -of json '<导出目录>/position-test.mp4'
```

结果：

```json
{"streams":[{"codec_type":"video","width":1920,"height":1080},
            {"codec_type":"audio"}],
 "format":{"duration":"6.000000","size":"..."}}
```

抽取第 2 秒画面核对：标题卡中心位于画布 70% 处（与前端预览坐标一致），字幕在底部，调色与音频均生效。

## 4. 导出命名与覆盖

通过 HTTP 连续提交三次同名 `same.mp4`：

```text
first      done  same.mp4
second     done  same (1).mp4
overwrite  done  same.mp4
outputs    ['same (1).mp4', 'same.mp4', ...]
```

结论：默认不覆盖并追加编号；强制覆盖时原子替换。

## 5. 队列暂停 / 单任务暂停 / 批量

```text
队列暂停后提交任务 → status=queued（未开始）
队列启动          → running → done
单任务暂停        → paused, progress=10.59，2 秒后仍 10.59
继续              → running
终止              → canceled
批量暂停 2 个      → 2/2 ok
批量继续 2 个      → 2/2 queued
```

## 6. 重启断点续渲

1. 8 段、每段 6 秒、1080p、preset medium 的任务开始渲染。
2. 进度 16.93%（片段 2/8）时对服务发 `SIGTERM`。
3. 重启服务：

```text
after restart paused 19.28 已中断
message: 服务停止导致渲染中断，已完成的分段会保留，可继续渲染
segments: ['seg_0000.mp4', 'seg_0001.part.mp4']
```

4. 点继续：

```text
任务重新排队，继续时会复用已完成分段。
发现已完成分段 6.00s，继续时将跳过。
✅ 导出完成：/output/resume-verify.mp4（21.2s，31.8 MB）
```

5. 成片复核：`duration=48.021333`，与 8×6 秒工程一致。

## 7. 前端 UI 检查

- 通过 Chrome DevTools Protocol 固定 **1440×900** 视口截图。
- 检查项：素材库不溢出、预览画布保持比例、时间线四轨对齐、右侧属性/队列/日志可滚动、导出弹窗不遮挡按钮、7 套主题切换正常。
- 控制台：无 `Runtime.exceptionThrown`、无模块导入错误。
- 手工交互：双击素材入轨、拖叠加块改开始时间、在 2s 处分割、撤销恢复、字幕属性改字号/颜色、工程新建与切换、上传后自动跳到 `/uploads`、队列暂停后任务保持排队。

### 逐帧前进/倒退

- 时间线工具栏新增 `上一帧 / 下一帧` 图标按钮；`←` / `→` 调用同一 `stepFrame()`。
- 帧位置按 `round(playhead * fps) + ±1` 计算后再落到 `frame / fps`，连续步进不会累计浮点误差；步进前先暂停播放。
- 预览器显示 `F 当前帧 / 总帧数`。
- 浏览器实测 30fps、2 秒素材：点 3 次下一帧 → `F 3 / 60`；点 2 次上一帧 → `F 1 / 60`。

### 播放后无法暂停修复

- 原因：播放期间 `updateTransport()` 每帧执行 `playBtn.innerHTML = ...`，真实鼠标的 `mousedown`/`mouseup` 落在被替换的不同 SVG 节点上，浏览器不合成 `click`；自动化 `.click()` 不走命中测试，所以之前未暴露。
- 修复：只在播放/静音状态变化时替换图标 DOM；同时支持点击预览画面暂停/继续。
- Chrome DevTools 真实鼠标事件验证：播放 1.2 秒后点击播放按钮，时间停在 `00:01.2`，图标回到 `#i-play`；点击预览画面同样停在 `00:00.8`。

截图见 `docs/screenshots/`。

## 8. 跨设备导出与音轨分离

### EXDEV 修复

NAS 上 `/data` 与 `/output` 是两个 bind mount，`os.replace('/data/work/.../final.mp4', '/output/...')` 会抛 `OSError: [Errno 18] Cross-device link`。修复方式：

1. 先尝试同设备 `os.replace`。
2. 捕获 `EXDEV` 后，把成品复制到 `/output` 目录内的隐藏临时文件，再在输出目录内 `os.replace`（原子改名），最后删除 `/data` 临时文件。
3. 覆盖/自动编号逻辑保持不变。

验证：

```text
/data st_dev 1048811
/output(/dev/shm) st_dev 4194398
out /dev/shm/.../跨设备测试.mp4 True fake-video-bytes src_exists False
overwrite second src_exists False
```

新增 `CrossDeviceTests.test_finalize_across_devices`，在 `/dev/shm` 与工程数据目录之间实际制造 EXDEV，测试通过。

### 音轨分离

- 主轨导入视频后，音轨轨自动显示「原声 · 文件名」联动块（`hasAudio` 来自 ffprobe）。
- 主轨属性「分离 / 提取音轨」或双击联动块：主轨标记 `audioDetached/muted`，生成独立 audio item（继承入点、时长、速度、音量、淡入淡出）。
- 独立音轨支持音量、速度（atempo）、淡入淡出、入点、开始、时长、循环；FFmpeg 音频链增加 `source_span = duration × speed` 与 atempo。
- 浏览器实测：添加 4 秒带音轨视频 → 音轨轨出现联动块 → 分离后联动块消失、独立音轨出现 → 修改速度 2.0 并落库 → 渲染输出 4 秒成片，音轨正常编码。

## 9. 手动保存 / 另存为 / 工程文件

- 顶栏新增保存按钮（`Ctrl/Cmd+S` 同样生效），点击后立即 PUT 当前工程并提示「工程已保存到 /data」。
- 工程管理新增「另存为当前工程」：用输入框名称把当前 doc 复制为新工程并切换；旧工程保留。
- 工程管理新增「导出工程文件 / 导入工程文件」，格式 `.cinecut.json`（`format: cinecut-project`）。
- 每次保存/新建都会写 `/data/projects/<project_id>.cinecut.json` 快照；删除工程时同步删除快照。
- 导入时若同名工程已存在，自动追加 ` (1)`，避免覆盖混淆。

浏览器实测：

```text
手动保存按钮 → toast 工程已保存到 /data，快照文件存在
另存为「手动另存为测试」→ 顶部工程名切换，projects/ 下出现第二个快照
导入导出的 .cinecut.json → 新工程创建并打开
```

## 10. 多轨道与拖动落点

- 主轨之外新增可持久化 `tracks` 列表，支持创建多个视频轨/音频轨/字幕轨（每类最多 12 条）。
- 视频轨/字幕轨按数组顺序定义层级：靠前的轨道在上层；预览与最终 FFmpeg 都按“低层先画、高层后画”排序。
- 素材添加时优先进入当前选中轨道；右侧属性可切换所在轨道；轨道标签可删除，轨道上素材会回退到同类型第一条轨道。
- 时间线 8 条轨道时实际滚动验证：`scrollHeight=426`、`clientHeight=282`，标签列通过 `translateY(-scrollTop)` 同步，刻度尺 sticky 保持可见。
- 拖动动画反馈：
  - 素材块跟随指针；目标位置显示脉冲虚线占位块、吸附竖线、时间浮标；
  - 主轨排序显示插入位置和后续片段让位动画；
  - 落点后新块播放 0.42s 高亮闪烁。
- 浏览器实测：新增「画中画轨」「对白轨」「音乐轨」；新视频轨自动置顶；拖 overlay 至 1.00s 时显示 `drop-ghost=1`、`snap-label=00:01.00`、`drag-tip=00:01.00`；松开后 API 中 `start=1`。

## 11. 多格式导出

支持 31 种格式，格式注册表在 `app/formats.py`，由 `/api/config` 下发给前端：

| 类型 | 格式 |
| --- | --- |
| 视频 | MP4、MKV、MOV、M4V、AVI、FLV、WebM、TS、M2TS、MTS、WMV、OGV、MPG、VOB、3GP |
| 动图 | GIF |
| 音频 | MP3、M4A、M4B、AAC、FLAC、WAV、OGG、OGA、OPUS、WMA、AIFF、ALAC、AC3、MKA、CAF |

- 非 MP4 格式强制走最终编码（不能直接 concat 复制）；纯音频格式不映射视频、加 `-vn`；GIF 不映射音频、加 `-an`。
- 扩展名由格式决定，用户填 `foo.mp4` 选 MP3 会自动得到 `foo.mp3`。
- 所有格式在本机 FFmpeg 7.1.5 上逐个实际编码通过（2 秒 320×180 测试片）：

```text
mp4 mkv mov m4v avi flv webm ts m2ts mts wmv ogv gif mpg vob 3gp
mp3 m4a m4b aac flac wav ogg oga opus wma aiff alac ac3 mka caf
```

- 任务链路实测：MP3 输出只有 audio 流；GIF 无音轨；均落在 `/output`。

## 12. 镜像构建策略

为满足“构建快”：

- 基础镜像改为 `python:3.12-alpine3.21`，用 `apk add --no-cache` 安装 `ffmpeg`、`font-wqy-zenhei`、`font-dejavu`、`tzdata`，不编译源码、不装 pip/npm。
- `ffmpeg` 与 `font-wqy-zenhei` 位于 Alpine `community` 仓库，Dockerfile 显式追加 `--repository`，避免基础镜像仓库配置差异导致构建失败。
- 依赖层位于 `COPY app` 之前；改代码后重复构建只重建 COPY/check 层，依赖层命中缓存。
- `font-wqy-zenhei` 的安装路径 `/usr/share/fonts/wqy-zenhei/wqy-zenhei.ttc` 已加入 `find_font()` 候选，并有字体目录扫描兜底。

本环境没有 Docker daemon，Alpine 包名、仓库与字体路径通过 Alpine APKINDEX/文件列表核对，**未实际执行镜像构建**。

## 13. 版本管理

- 当前版本 `1.2.1`，唯一源为 `VERSION`。
- `scripts/bump_version.py` 同步 `VERSION`、`docker-compose.yml`（默认值与 `cinecut:${APP_VERSION:-...}` tag）、`.env`（存在时）、`.env.example`、`Dockerfile`、前端兜底版本，并插入 CHANGELOG 草稿。
- `scripts/check_version.py` 检查上述文件一致性，返回非零即失败。
- 后端 `VersionTests.test_version_files_consistent` 调用 check 脚本，确保每次更新不会只改一处版本。

## 14. 未在本环境验证（上机检查）

- `docker compose build` 与镜像内 Alpine 3.21 / FFmpeg 6.1.2 的实际行为（本机测试用 Debian 13 / FFmpeg 7.1.5）。
- UGOS Pro 对两个中文长路径的挂载与写权限。
- 容器重启（docker restart）后 SQLite 与 `/data` 分段缓存的真实行为（本机用 SIGTERM + 重启进程等价验证）。
- 浏览器对超大 4K 文件的预览拖动性能。

以上均写入 README 的「上机检查清单」。

## 15. 1.2.0 内置素材 / 多选 / 右键 / 拖轨

### 自动化

```bash
python3 -m py_compile app/*.py tests/*.py
python3 -m unittest discover -s tests -v
python3 scripts/check_version.py
```

结果：

```text
Ran 23 tests in 32.284s
OK
CineCut 1.2.0 版本一致
```

新增测试见第 1 节表格。真实 FFmpeg 用例 `test_grade_and_mosaic_modes_commands` 生成并编码了带
`colorbalance` + `vignette` + `gblur` 的 1 秒 640×360 片段，文件大于 1 KB，证明滤镜/模糊遮挡链可执行。

端到端渲染（API `POST /api/render`，640×360、2 秒、色温 0.25 + 暗角 0.4 + 人像模糊 + 内置贴图/音效/字幕）：

```text
task tsk_ae46e1de2296 status done output 1.2-feature-test.mp4
ffprobe: video 640×360 + audio, duration 2.000000, size 246180
抽帧 /tmp/feature-frame.png：中央模糊区域、底部人物条贴图、白色字幕、暗角均可见
```

### 内置素材

`app/static/builtin/manifest.json` 实测：

```text
filters=22 subtitles=16 stickers=21 audio=16 effects=9
```

- 贴图 21 张 PNG 与音频 16 个文件全部存在；`test_manifest_assets_and_ids` 逐项检查。
- 滤镜覆盖电影感/青橙/冷调/暖阳/黑白/复古/日系/北欧/棕褐/霓虹/柔光/黑色电影/落日/薄荷/秋日/冰川/80 年代等；
  新增 `temperature`、`vignette` 字段，旧工程缺省补 0。
- 字幕模板 16 种；贴图含点赞/LIVE/热播/4K/关注/分享/TOP1/圈选/下划线/气泡/感叹号等；音频含 Pop/通知/Swoosh/Riser/Glitch/心跳/键盘/快门/铃声/Bass Drop/掌声/倒计时；特效 9 种含像素、模糊、黑块。
- 生成脚本 `scripts/gen_builtin_assets.py` 可重复生成上述 PNG/WAV 与 manifest（开发期依赖 Pillow，运行容器不依赖）。

### 浏览器实测（Chrome DevTools Protocol，1440×900）

控制台：无 `Runtime.exceptionThrown`、无 ES Module 导入错误。

```text
CATS 滤镜 22 | 字幕模板 16 | 视频贴图 21 | 音频素材 16 | 马赛克特效 9
多选（Ctrl 点击）→ 属性面板：已选 3 项 · 主轨 1 · 叠加 1 · 音轨 1
右键菜单 → 已选 3 个片段，含复制/剪切/粘贴/删除/分割/静音/分离音轨/应用滤镜/马赛克/移动到轨道子菜单
内置贴图拖到「贴图轨」→ overlays 1 → 2，落点 2.5s，轨道高亮 + 虚线占位 + 时间浮标
文件 main.mp4 拖到主轨 → main 1 → 2
字幕模板拖到字幕轨 → 新增 1 条 text（章节标题，trackId=trk_t1）
音频素材拖到音轨 → 新增 1 条 audio
应用「电影感」→ API doc.grade = {brightness:0.02, contrast:1.18, saturation:0.88, hue:-3, temperature:-0.08, vignette:0.22}
应用「人像模糊」→ API main[0] = {mosaic:true, mosaicMode:"blur", mosaicBlock:32, x:0.3, y:0.14}
添加「章节标题」字幕模板 → texts 新增 {text:"第一章 · 出发", trackId:"trk_t1", y:0.16, size:46}
```

截图（均为 1.2.0）：

- `docs/screenshots/ui-17-builtin-expanded.png`：内置素材库 22 滤镜与多轨时间线。
- `docs/screenshots/ui-18-multi-select.png`：Ctrl 多选后属性面板批量摘要。
- `docs/screenshots/ui-19-context-menu.png`：多选右键菜单。
- `docs/screenshots/ui-20-mosaic.png`：人像高斯模糊应用到主轨。
- `docs/screenshots/ui-21-drag-track.png`：内置贴图拖到指定轨道时的轨道高亮/占位/浮标。

### 快捷键实测

- `Ctrl+C/V` 复制粘贴 6 个选中片段：时间线块 8 → 16（含联动原声块）。
- `Ctrl+A` 全选 6 个工程项，属性面板显示「已选 6 项」。
- `Ctrl+Z` 撤销换轨操作后 overlay 回到原轨道。
- `S` 在 2s 处分割 1 段主轨 → main 变 2 段；`I` 把第一段入点裁到 1s（in=1, out=2）。
- 选中音轨按 `M` → API `audios[0].muted=true`；再按 `M` 恢复。
- `J` 从 3s 倒放 0.5s 后时间显示 2.5s、播放按钮切到暂停图标；`K` 暂停后回到播放图标。
- `+` 让时间线从 48 px/s 变为 58 px/s；`↑/↓`、`Home/End`、`F` 均已绑定。
- 已有时间线 overlay 直接拖到另一条视频轨：`o_cc...` 从 `trk_3f...` 变为 `trk_85...`，属性面板轨道同步。
- 7 条轨道时 `#tlScroll` 的 `scrollHeight=426`、`clientHeight=282`；滚到 120px 后标签列 `transform=translateY(-120px)`，内容与标签对齐。


## 16. 1.2.1 换轨修复 / 全选按钮

### 修复内容

- 主轨片段右键「移动到指定轨道」不再禁用：子菜单列出视频轨并标注「转叠加层」，点击后主轨片段转为叠加层，原声自动生成独立音轨。
- 拖主轨片段到视频轨（轨道空白或左侧轨道标签均可）会显示目标轨道提示与虚线占位，松开即转为叠加层。
- 拖动任意片段时，所有兼容轨道先弱高亮，指针进入目标轨道后轨道/标签强高亮，浮标显示 `移到「轨道名」· 时间`；移出后高亮自动清除。
- 新增时间线「全选」按钮与 `Ctrl/Cmd + A` 全选所有工程片段。
- 右键新增「移到上一条 / 下一条同类轨道」，快捷键 `Alt + ↑ / ↓`。

### 浏览器实测（1440×900，v1.2.1）

```text
主轨右键菜单：移动到指定轨道 disabled=false
子菜单：贴图轨 / 视频轨 1（hint=转叠加层）/ 新建轨道…
点击「视频轨 1」→ main 1→0，overlays 2→3，audios 1→2（原声保留）
Ctrl+Z（等待 1.4s 自动保存）→ main 0→1，overlays 3→2，audios 2→1

主轨拖到视频轨：
  compatible=3, drag-target=1, drop-ghost=1
  tip=松开转为叠加层「贴图轨」· 00:00.00
  松开 → main 1→0，overlays 2→3，audios 1→2

叠加层拖到「视频轨 1」左侧标签：
  compatible=2, drag-target(lane)=1, drag-target(label)=1, drop-ghost=1
  tip=移到「视频轨 1」· 00:00.00
  松开 → 两条叠加层均落到 trk_v1

内置贴图拖到「视频轨 1」左侧标签：
  targetLane=1, targetLabel=1, tip=视频轨 1 · 00:00.00
  松开 → overlays 2→3

视频叠加层移回主视频轨：
  右键菜单「移回主视频轨」disabled=false
  点击后 main 0→1，overlays 3→2，audios 2→1（linkedOverlayId 关联音轨同步移除）
  视频叠加层拖回主轨：tip=移回主视频轨 · 00:02.95，松开后 main 1→2

时间线空白处长按左键框选：
  pointerdown 后等待 380ms → 出现 .marquee-box（410×232），body.marquee-mode
  拖动框覆盖主轨/叠加/音轨/字幕（从刻度尺拖到字幕行）后松开
  → 属性面板「已选 6 项」（主轨 1 / 叠加 2 / 音轨 1 / 字幕 2），框选层移除
  快速拖动（未到 280ms）仍只移动播放头，不出现框选框

Ctrl+A 与工具栏「全选」→ 属性面板「已选 6 项」（音轨 1 / 主轨 1 / 字幕 2 / 叠加 2）
Alt+↓ → overlay 轨道 ['trk_v2','trk_v1'] → ['trk_v1','trk_v1']
版本显示 v1.2.1
```

后端回归：`Ran 23 tests in 19.201s / OK`，`check_version` 1.2.1 一致。

### 构建加速

- Dockerfile 改为 `runtime`（只装 ffmpeg/字体）+ `app` 两阶段；`ARG APP_VERSION`、`ENV APP_VERSION`、`LABEL` 移到 `COPY app` 和自检之后，版本号变化不再击穿 apk 依赖层。
- 新增 `scripts/rebuild.sh`，强制 BuildKit 并执行 `docker compose build` + `up -d --no-build`；`bash -n` 通过。
- README 增加缓存排错：日常不要 `--no-cache`，首次构建可设置 `APK_MIRROR` 并预拉基础镜像。
- 本开发环境没有 docker 命令，Dockerfile 分层缓存与真实重建耗时**未实测**，已列入 README 上机检查清单。

截图：

- `docs/screenshots/ui-22-select-all.png`：工具栏「全选」与批量属性面板。
- `docs/screenshots/ui-23-move-main.png`：主轨片段右键「移动到指定轨道」子菜单。
- `docs/screenshots/ui-24-drag-label.png`：拖到左侧轨道标签时的目标提示。
- `docs/screenshots/ui-25-drag-hint.png`：拖到目标轨道时的兼容轨道高亮、占位与轨道名浮标。
- `docs/screenshots/ui-26-overlay-to-main.png`：视频叠加层右键「移回主视频轨」。
- `docs/screenshots/ui-27-marquee.png`：长按左键后的框选矩形与提示。
- `docs/screenshots/ui-28-marquee-selected.png`：框选松开后的批量选择结果。

## 1.3.0 — Shotcut / OpenShot 功能对齐（2026-11-10）

### 做了什么
- 新增转场（19 种 xfade）、关键帧动画（5 种插值、按帧切片渲染）、43 个视频/音频特效、15 种混合模式、四边裁剪、矩形/椭圆蒙版与羽化。
- 新增 SRT 导入/导出、混音台（轨道音量/M/S）、标记、吸附开关、波形、RGB 直方图、冻结帧/倒放派生、分割所有轨道、波纹删除、导出起止时间。
- 升级工程模型到 v2（`app/project.py` VERSION=2），渲染管线重写（`app/render.py`），新增 `app/effects.py` / `app/luts.py` / `app/derive.py`。
- 修复 FFmpeg 7.1 最终合成在片段边界的死锁（色彩元数据不一致 + `atrim` + base `setpts`）。
- 版本号统一升到 1.3.0（VERSION / Dockerfile / docker-compose / index.html / README）。

### 怎么验证
```bash
python3 -m py_compile app/*.py
python3 -m unittest tests.test_backend
node --experimental-vm-modules -e "…vm.SourceTextModule 解析全部 app/static/js/*.js…"
# 端到端：浏览器操作 + POST /api/render，轮询 /api/tasks/<id>
ffprobe -v error -show_entries format=duration:stream=codec_name,codec_type -of json output/final-flow6.mp4
ffmpeg -ss 1.5 -i output/final-flow6.mp4 -frames:v 1 /tmp/f.png
```

### 结果 / 证据
- `python3 -m unittest tests.test_backend` → `Ran 23 tests in 8.883s / OK`。
- 完整流程工程（a.mp4 4s + 冻结帧 3s + 倒放 3s + logo 叠加 + 3 条字幕 + bgm，10s）渲染任务 `tsk_3e54121fb9a5` **6.1s 完成**，输出 `output/final-flow6.mp4`：h264 1280x720@30 + aac，容器时长 10.000000s；章节 2 条（0–4.5、4.5–10）；抽帧 1.5s 可见叠加层与字幕，4.6s 叠加层按时消失。
- 转场/关键帧/调色/蒙版/混音/字幕/标记/波形/示波器/派生片段均通过浏览器实测并保存工程。
- 页面启动 `boot done`，无 Runtime 错误；1440×900 截图见 `docs/screenshots/v2-*.png`。
- 构建：Dockerfile 维持两阶段缓存（ffmpeg/字体层不随代码变更重建，`COPY app` 之后才写版本）；本机无 docker，真实构建耗时未实测，已列 README 上机清单。

### 结论
pass（代码/接口/端到端渲染/前端交互均已验证；镜像构建速度仅做静态分层核查）。


## 1.3.0 — 队列「全部删除」（2026-11-10）

### 做了什么
- 新增 `POST /api/tasks/clear-all` 与 `TaskManager.clear_all()`：终止 running/queued/paused 任务，删除全部任务记录与日志，清理 `data/work/<taskId>`；不删除 `/output` 成品。
- 任务队列工具栏新增「全部删除」按钮，带二次确认（显示任务数与未完成数）。

### 怎么验证
- `python3 -m unittest tests.test_backend`（新增 `test_clear_all_tasks`）。
- 浏览器实测：队列页点「全部删除」→ 确认框文案「将删除 4 条任务记录与日志…」→ 确认后 `GET /api/tasks` 返回 0 条，`data/work` 为空。

### 结果 / 证据
- `Ran 24 tests in 23.205s / OK`。
- 删除前 4 条 canceled 任务，删除后 `tasks 0`、`work count: 0`；截图 `docs/screenshots/v2-queue-clearall.png`。
- 运行中任务路径由 `clear_all()` 先调用 `stop()`（SIGTERM 进程组）再删除，避免遗留 ffmpeg。

### 结论
pass


## 1.3.1 — 右键菜单滚动关闭（2026-11-10）

### 做了什么
- `app/static/js/contextmenu.js` 的捕获阶段 `scroll` 监听改为：`event.target` 在 `.ctx-menu` 内时直接返回，不再关闭菜单；其它滚动仍关闭。

### 怎么验证
- 浏览器（CDP 9222）右键主轨片段，菜单 `scrollHeight > clientHeight`（501px 可视），执行 `menu.scrollTop=60` 并派发 wheel，等待后菜单仍存在、`scrollTop=60`。
- 再在 `#tlContent` 上派发 `scroll`，菜单正常关闭。

### 结果 / 证据
- `{"open":true,"top":60}`；外部滚动后 `{"was":true,"closed":true}`；截图 `docs/screenshots/v2-contextmenu-scroll.png`。
- 菜单滚动条可见，滚动后仍停留在「复制/剪切/粘贴…」。

### 结论
pass


## 1.3.1 — 倒放片段预览闪烁（2026-11-10）

### 做了什么
- `app/static/js/preview.js`：主轨视频 `readyState < 2`（seek 解码中）时不再只画黑底，而是把最近一帧缓存到离屏 canvas 并继续显示；切换片段时也先保留上一段最后一帧。
- `app/derive.py`：freeze/reverse 编码加 `-g 30 -keyint_min 30 -sc_threshold 0`（1 秒一个关键帧），缓存 key 升到 `v3|`；倒放文件 seek 不再依赖 8 秒一次的关键帧。

### 怎么验证
- 生成倒放文件 `input/.derived/reverse_f742158695a71207de98.mp4`，`ffprobe -show_frames` 统计关键帧 6 个 / 180 帧（6 秒）。
- 浏览器（CDP）在 3.6s–7.35s 之间每 90ms 连续定位（跨越普通片段→倒放片段边界），采样预览 canvas 平均亮度：16 次全部 `127`，无 `0`（黑帧）。
- 倒放播放（J 键）18 次采样同样全部 `127`。
- `python3 -m unittest tests.test_backend` → `Ran 24 tests in 7.594s / OK`；`python3 -m py_compile app/*.py` 通过。

### 结论
pass


## 1.3.1 — 时间线跳转预览卡顿（2026-11-10）

### 做了什么
- `app/static/js/preview.js`：新增 `scheduleSeek/pumpSeek`，每个 `<video>` 维护 `__seek={target,busy}`；拖动播放头时若已有 seek 在飞，只更新目标，`seeked` 后再补最后一跳；`pause()` 等跳转仍走 `force`。
- 拖动时不再每帧从 canvas 拷贝 hold 帧（播放中跳过 `rememberFrame`）。

### 怎么验证
- 浏览器 CDP：60 次 `#scrub` input（8ms 间隔）后统计主轨视频 `seeking` 次数、最终 `currentTime`、画面中心亮度。
- 播放回归：seek 到 1s 后播放 0.7s，检查 `#timeNow` 与 `video.currentTime`。

### 结果 / 证据
- 60 次连续跳转只触发 **14 次 seek**（合并生效），最终 `currentTime=3.74` 与输入 3.74 一致，画面亮度 127（非黑帧）。
- 音轨同一套合并逻辑：50 次连续跳转只触发 13 次 seek，主轨 `currentTime=3.73`、音轨 `currentTime=3.73`，与输入一致。
- 播放回归：`#timeNow 00:01.7`、`currentTime 1.65`、`paused=false`，播放正常。
- 倒放/冻结关键帧：180 帧文件 6 个关键帧，跨片段 16 次定位亮度全 127。

### 结论
pass


## 1.3.2 — 编辑选项恢复默认（2026-11-10）

### 做了什么
- `app/static/js/inspector.js`：`resetBtn(scope)` + `applyReset(kind,item,scope)` + `#inspectorContent` 点击委托；覆盖片段/速度/画面、马赛克、叠加位置/缩放、裁剪/蒙版、混合、转场、特效、关键帧、音轨、字幕样式、画面调色（+总音量）。
- `app/static/js/effects-ui.js`：各区块标题加 ↺；单个特效卡新增 ↺（恢复参数默认值并清空该特效关键帧）。

### 怎么验证
- 浏览器 CDP：选中主轨片段 → 速度改 200%、裁剪 left 改 30% → 点「片段/速度」与「裁剪/蒙版」的 ↺；再改亮度 40% 后点「画面调色」↺。
- 特效：添加 brightness 特效、参数改 0.5 → 点特效卡 ↺；再点「特效」区 ↺ 清空。关键帧：打 1 帧后点「关键帧」↺。
- 音轨：音量改 50% 后点「音轨」↺，等待自动保存后查工程 JSON。

### 结果 / 证据
- 片段：`#ipSpeed` 200→100、`crop.left` 0.3→0，toast「画面/速度已恢复默认」「裁剪/蒙版已恢复默认」；工程 JSON `speed=1.0, crop=0, scale=1.0`。
- 特效：参数 0.5→0；清空后 `[data-fx-card]` 数量 0。关键帧：`1 帧`→`0 帧`。
- 调色：亮度 40%→0，toast「画面调色已恢复默认」，doc `grade.brightness=0`、`masterVolume=1`。
- 音轨：`audios[0].volume=1.0, pan=0, speed=1`。
- 截图 `docs/screenshots/v2-reset-defaults.png`（1440×900；片段标题右侧 ↺）。
- `node vm.SourceTextModule` 解析 inspector.js / effects-ui.js 通过。

### 结论
pass
