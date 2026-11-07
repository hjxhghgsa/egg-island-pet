# 蛋岛桌面宠物

从 [eggislandgame.xyz](https://eggislandgame.xyz) 扒下来的 3D 角色，做成桌面挂件。

Electron + Three.js，透明置顶窗口，悬浮在屏幕角落。

## 角色

| 名字 | 模型 |
|---|---|
| 蛋糕纯 | `character-cake.glb` |
| 珠玉纯 | `character-jade.glb` |

两个模型都**没有动画 clip**，只有骨骼。动画是用站点自己的 `renderer/animation.js`
（`setupCharacterRig` + `updateRig`）程序化驱动 Mixamo 风格骨骼实现的——
呼吸、悬浮、坐姿、转头全靠每帧算。

## 召唤

启动后她只露 3 秒，然后自动躲起来——不常驻屏幕。

- **Ctrl + Alt + E**：召唤 / 收起
- 点右下角托盘图标也行

被召唤出来时会蹦一下、转半圈。

## 操作

| 操作 | 效果 |
|---|---|
| 左键拖动 | 360° 旋转角色（带惯性） |
| 右键拖动 | 移动窗口 |
| 右键单击 | 菜单：和她说话 / 放首歌 / 换角色 / 退出 |
| 左键单击 | 播放 / 暂停音乐（顺带跳一下） |
| 双击 | 打开聊天窗口 |

透明区域不挡桌面点击，只有角色本体拦截鼠标。

## 放音乐

点她就会播放。歌放在：

```
%APPDATA%\EggIslandPet\music
```

右键菜单里有 **「打开音乐文件夹」**，点一下直接打开，把 mp3 / m4a / wav / flac 拖进去就行。
支持多首，按文件名顺序循环，一首放完自动下一首。

**歌要你自己准备**——版权在平台和歌手手里，程序只负责播本地文件。

## 待机行为

角色会自己换姿势：站久了坐下、偶尔蹦一下、转头看看四周。

## AI 对话

双击角色打开聊天窗（半透明玻璃质感），点右上角 ⚙ 填接口（OpenAI 兼容格式）：

- 本地 Ollama：`http://localhost:11434/v1`，模型填 `ollama list` 里的名字，Key 随便写
- 云端：`https://api.deepseek.com/v1` + 你的 Key + `deepseek-chat`

请求走主进程转发，绕开渲染层 CORS。

### 三种输入方式

| 方式 | 说明 |
|---|---|
| 打字 | Enter 发送，Shift+Enter 换行 |
| 🎤 按住说话 | 用 Web Speech API。**Electron 内置识别要连 Google，国内基本不可用**，失败会提示，别指望它 |
| 👁 看屏幕 | 截当前屏幕发给视觉模型。要在设置里填一个支持图片输入的模型（`glm-4v-flash` / `gpt-4o-mini` / `qwen-vl-max`），留空则用主模型 |

### 语音朗读

右上 🔊 开关。用系统 TTS（Windows 自带 Huihui / Kangkang / Yaoyao），离线可用，不花 token。

### 做不到的

**接不进 WorkBuddy**——它没有对外接口。她只能跟你配的模型 API 或本地 Ollama 说话。

## 开发

```bash
npm install
npm start
```

打包：

```bash
npm run dist
```

## 实现要点（踩过的坑）

1. `three.module.js` 只是个入口，真正实现在同目录 `three.core.js`，两个都得有。
2. `file://` 下加载 ES module 会失败，报错信息会误导成 CORS——实际是依赖文件没下全。
3. 相机按模型高度自适应，人物和宠物才能都占满画面约 3/4。
4. 窗口用 `setIgnoreMouseEvents(true, { forward: true })` 实现透明区穿透，
   渲染层用 raycast 判定是否悬停在模型上再切回可点击。

## 版权

模型和骨骼动画逻辑来自 [蛋岛 Egg Island](https://eggislandgame.xyz)，版权归原作者。
本项目仅作个人学习用途。
