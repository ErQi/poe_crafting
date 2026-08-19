electron-builder 的构建资源目录（package.json 的 build.directories.buildResources）。

缺一个应用图标：把 256×256 的 icon.ico 放到这里（文件名必须是 icon.ico），
electron-builder 会自动用它，package.json 不需要再改。

没有图标时 portable exe 用的是 Electron 默认图标；未签名 + 默认图标 + 自解压
这三项叠加，很容易被 SmartScreen 和杀软拦下。
