# 色块暴走派对 · Color Block Party

> 一张「会随音乐律动」的实时生成海报。插入任意一段音频,屏幕上的蒙德里安色块云就会被节拍、底鼓、副歌和和弦驱动起来——缩放、漂浮、自转、引爆、撒出碎片与烟花,再用泛光把整个舞台点亮。
>
> A music-driven generative VJ poster. Drop in any audio file and a cloud of Mondrian-style colour blocks comes alive — driven by beat, kick, chorus and chord into scaling, floating, spinning, detonation, shards and fireworks, all lit by bloom.

唯一的「乐器」就是音乐本身:**插入音频即驱动全场**。音乐安静或停止时,画面自动收敛成一张干净的静态海报,方便直接当壁纸 / 静帧截图导出。

---

## ✨ 特性 Features

- **实时音频 → 三维视觉管线**:`AnalyserNode` 把声音拆成一组特征量(响度、底鼓、8 频段能量、副歌、音高、和弦),逐帧驱动 Three.js 场景。
- **频谱「画」在方块阵上**:585 个色块按高度分到 8 个频段(底部=低频、顶部=高频),频谱直接体现为方块阵的起伏。
- **底鼓引爆**:强底鼓给所有方块一个径向冲量,弹簧物理再把它们吸回——「炸开又聚拢」的呼吸感。
- **和声决定主色**:当前和弦根音映射到红 / 黄 / 蓝三种辉光色,听觉的调性 ↔ 视觉的色彩。
- **碎片 / 烟花 / 泛光 / 相机呼吸**:副歌持续撒碎片,底鼓让镜头「吸气」、Bloom 过曝一下。
- **零安装、零构建**:纯静态网页,Three.js 通过 CDN importmap 加载,本地起个静态服务器即可运行。

> 想了解每一个特征是怎么算、怎么映射到画面的,见 [`算法映射.md`](./算法映射.md)。

---

## 🚀 快速开始 Quick start

因为用到 ES module 和音频文件,需要通过一个本地 HTTP 服务器打开(直接双击 `index.html` 用 `file://` 协议会被浏览器拦截)。

**macOS / Linux**

```bash
./start.sh
```

**Windows**

```bat
start.bat
```

脚本会在 `http://localhost:8091` 启动一个静态服务器并自动打开浏览器。它优先用 `python3`,没有则退回 `python` 或 `npx serve`。

**手动启动**(任选其一):

```bash
python3 -m http.server 8091
# 或
npx serve -l 8091
```

然后浏览器打开 `http://localhost:8091`。

### 使用 Usage

1. 点击左上角 **「♪ 插入音乐」**,选择一段音频(或直接把音频文件拖到页面上)。仓库自带 `色块暴走派对.mp3` 作为示例曲目。
2. 画面随音乐律动起来;**用 ⏸ 暂停会冻结当前帧**,方便当作静帧海报截图 / 导出。
3. 鼠标点画布可手动触发一次「引爆 + 烟花」。

---

## 🧱 技术栈 Tech stack

- **[Three.js](https://threejs.org/)** `0.160`(经 CDN importmap 加载)+ `EffectComposer` / `UnrealBloomPass` 后期。
- **Web Audio API**(`AnalyserNode`,FFT 4096)做实时频谱 / 特征提取;音高用 YIN,和弦用 12 维 chroma 模板匹配。
- 纯原生 HTML / CSS / JavaScript,**无构建步骤、无打包工具**。

### 浏览器支持 Browser support

需要支持 ES modules、importmap 和 Web Audio 的现代浏览器(Chrome / Edge / Firefox / Safari 新版)。Safari 的音频加载已做专门兼容处理。

---

## 📁 项目结构 Structure

```
index.html        # 入口:舞台 canvas + 「插入音乐」交互 + importmap
music.js          # 分析层:Web Audio → 特征量(window.MUSIC.state)
色块暴走派对.js     # 映射层:特征 → Three.js 场景(方块/碎片/烟花/相机/泛光)
styles.css        # VJ 舞台皮肤
色块暴走派对.mp3    # 内置示例曲目
算法映射.md         # 「音乐 → 视觉」完整算法文档
start.sh / start.bat  # 一键本地服务器启动脚本
```

---

## 📄 许可证 License

代码以 **[Apache License 2.0](./LICENSE)** 发布。详见 `LICENSE`。

内置示例曲目 `色块暴走派对.mp3` 为作者自有 / 免版税音乐,随项目一并以同一许可证提供。若你 fork 后替换为第三方曲目,请自行确认相应音频的版权与授权。

Copyright 2026 Leido.
