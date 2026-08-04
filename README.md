# PoE1 花园自动工艺

Python 桌面工具：通过 **Ctrl+C 剪贴板** 读取简体中文装备词缀，用 **OpenCV 模板匹配** 点击园艺台工艺，按 GUI 规则循环洗到目标词缀为止。

> 警告：自动化可能违反《流放之路》用户协议，存在封号等风险，请自行承担。本项目仅供学习交流。

## 功能

- 解析中文客户端物品文本（稀有度、名称、词缀、数值）
- 目标规则：文本包含 + 可选数值比较（`>= > <= < =`），支持 ALL / ANY
- 工艺模式：
  - **通用**：重复点击你已在游戏内选中的工艺
  - **预设**：先点选模板对应工艺，再执行
- 安全停止：F8 热键、最大次数、连续解析失败、模板找不到、生命力不足模板、词缀连续无变化
- CustomTkinter GUI

## 环境

- Windows（依赖 `pywin32` 找窗口 / 前台）
- [uv](https://github.com/astral-sh/uv) + Python 3.11+ 推荐
- 游戏建议：**窗口 / 无边框窗口**，不要用互斥全屏
- 部分环境模拟键鼠或全局热键需要**以管理员身份**运行

```powershell
cd e:\projects\poe_crafting
uv sync
uv run python main.py
```

测试：

```powershell
uv run python -m unittest tests/test_parser_matcher.py -v
```

（仍保留 `requirements.txt`，也可用 `uv pip install -r requirements.txt`。）

## 模板准备

将 PNG 放到 `assets/templates/`，**推荐直接在 GUI 粘贴**：

1. 游戏内用 `Win+Shift+S`（或任意截图工具）截取按钮/物品槽  
2. 回到本工具窗口，在「模板配置」区选择保存目标（如 `craft_button`）  
3. 按 **Ctrl+V** 或点「从剪贴板粘贴」→「保存到模板」  
4. 右侧列表会显示是否已保存；也可用「打开模板目录」手动管理文件  

| 文件 | 说明 |
|------|------|
| `craft_button.png` | **必需** 执行工艺按钮 |
| `item_slot.png` | **必需** 工艺槽物品区域（悬停后 Ctrl+C） |
| `reforge.png` 等 | 预设模式：对应工艺条目（须在可见区域） |
| `not_enough_lifeforce.png` | 可选：生命力/材料不足提示 |

截取建议：

1. 游戏 UI 缩放固定，分辨率与日常游玩一致  
2. 只截按钮核心文字/图标，不要过大背景  
3. 在 GUI 调「模板阈值」并用「测试模板匹配」验证 score  

> 规则输入框内的 Ctrl+V 仍用于粘贴文字；焦点在输入框外时 Ctrl+V 会粘贴图片。

## 使用步骤

1. 启动游戏与本工具  
2. 放入园艺台物品，截好模板并测试匹配  
3. 配置目标规则（例：包含 `最大生命`，算子 `>=`，阈值 `80`）  
4. 选择通用或预设模式；通用模式请先在游戏内点好工艺  
5. 点「确认并开始」；紧急停止默认 **F8**  
6. 「刷新装备」可单次读取槽内物品；「解析当前剪贴板」可在游戏里手动 Ctrl+C 后调试解析  

## 配置

- `config/settings.json` — 延迟、次数、热键、窗口标题关键字、阈值等  
- `config/rules.json` — 目标规则  

## 项目结构

```
main.py
config/
assets/templates/
src/
  models.py item_parser.py matcher.py
  vision.py input_control.py clipboard_util.py
  automation.py hotkeys.py config_store.py
  gui/app.py gui/widgets.py
tests/
```

## 限制（V1）

- 仅简体中文物品文本
- 数值规则默认取词缀行**第一个**数字
- 预设工艺需目标在可见列表中（不自动滚动）
- 不读内存、不注入进程
