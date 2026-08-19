"""PoE1 花园自动工艺核心包（已废弃，不是运行入口）。

正式实现在 electron/engine/。保留本包的**唯一理由**是支撑 tests/ 里那套单元测试
——它是仓库中唯一的测试套件（electron/ 侧没有测试），覆盖词缀解析、阈值比较、
流程状态机与模板匹配这几处最容易悄悄改坏的逻辑。所以 tests/ 用不到的东西一律删掉，
也不要在这里加新功能：改行为请改 electron/engine/。

旧的 pywebview/customtkinter 界面（main.py 与 src/gui/）已删除。
"""
