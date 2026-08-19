出厂默认配置。首次运行时会被复制到用户数据目录（打包版是
%APPDATA%\PoeCrafting\config\，开发时直接用项目里的 config/）。

这里的文件只读，请不要把个人配方写进来 —— 它们会成为所有新用户看到的默认值。
运行时配置在 config/*.json，已被 .gitignore 忽略。

流程库（workflows.json）没有出厂文件：内置流程由代码里的 defaultLibrary()
生成，首次启动时自动写出，避免同一份数据维护两处。
