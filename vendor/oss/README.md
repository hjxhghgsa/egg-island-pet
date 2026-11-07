# vendor/oss — 已集成的开源资源

全部为**源码文件**，不含任何可执行二进制、字体或模型；运行时不联网、不新增 npm 依赖。
每个目录里都带原始许可证文件。查询来源：`https://api.github.com/repos/<repo>`（star / license / 最后推送时间）。

| 资源 | 仓库 | Star | 许可 | 版本 / 最后维护 | 用在哪 |
| --- | --- | --- | --- | --- | --- |
| jsfxr | `chr15m/jsfxr` | 463 | Unlicense（公有领域） | master，2026-05 | `jsfxr/`：`riffwave.js` + `sfxr.js`。程序化合成点击 / 连击 / 贴边 / 获救音效，全部正弦波短音，零音频文件 |
| bezier-easing | `gre/bezier-easing` | 1,781 | MIT | 2.1.0，2026-11 | `bezier-easing/bezier-easing.js`（UMD）。主进程吸附滑行、渲染层探头镜头 / 开花错峰的贝塞尔缓动 |
| Fuse.js | `krisk/Fuse` | 20,526 | Apache-2.0 | 7.1.0，2026-08 | `fuse/fuse.js`（UMD）。本地离线语音指令的模糊兜底，专治 ASR 同音错字；懒加载，不拖启动 |
| simplex-noise | `jwagner/simplex-noise.js` | 1,853 | MIT | 4.0.3，2024-07 | `simplex-noise/simplex-noise.mjs`（ESM）。花瓣雨的「一阵风」、小蛋漂移的连续扰动 |

## 接入方式

- `renderer/index.html` 先用普通 `<script>` 加载两个 UMD（jsfxr / bezier-easing），
  它们挂到 `window`；`renderer/oss.js` 是本项目自己的适配层，ESM 里读全局即可，
  simplex-noise 走原生 `import`。
- `main.js` 用 CommonJS `require` 加载 bezier-easing；Fuse 由 `intent.js` 懒加载。
- 适配层做了完整降级：库缺失时缓动退回 smoothstep、音效静默、意图只剩正则，桌宠不会白屏。
- 音效走**独立 AudioContext**，不碰音乐那条 `<audio>` + analyser 链，连击不会切歌、不会打断播放。
- 托盘菜单 / 右键菜单都有「交互音效（jsfxr）」开关，设置存在 `sfxOn`。

## 明确未采用（及其原因）

| 资源 | Star / 许可 | 跳过原因 |
| --- | --- | --- |
| `catdad/canvas-confetti` | 12,849 / ISC | 2D 硬边纸屑 + 独立 canvas 动画循环，与项目已有的 3D shader 柔光粒子、花脚特效重复且风格冲突（之前明确否掉过「彩环 / 实心球 / CSS 垃圾特效」） |
| `patriciogonzalezvivo/lygia` | 3,480 / NOASSERTION | 现为 Prosperity / Patron 双许可，带非商业与赞助限制，许可不清晰，不进开源分发 |
| `liabru/matter-js` | 18,604 / MIT | 完整刚体物理引擎，与现有自写甩出惯性 / 四边吸附 / 阻尼重复，多一套循环且体积大 |
| `juliangarnier/anime` | 74,391 / MIT | 自带时间轴与渲染循环，会和现有单一 rAF 主循环打架；缓动需求已由 bezier-easing 覆盖 |
| `goldfire/howler.js` | 25,430 / MIT | 音频管理库，与现有 `<audio>` 播放 + WebAudio 低频律动重复 |
| three.js `examples/jsm/postprocessing` | 117,799 / MIT | EffectComposer + Bloom 会让透明窗多跑一遍 render pass，显存和 CPU 上升，与 1.3s 启动 / 后台休眠目标冲突；柔光已由 `fx3d.js` 自写 shader 实现 |
| 97 套手绘待机动画 / 摄像头视觉 / 视频配音 / 模型热导入 | — | 美术量与隐私成本过大，之前已确认跳过 |
