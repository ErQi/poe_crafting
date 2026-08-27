const fs = require("fs");
const path = require("path");
const { app, desktopCapturer } = require("electron");

const root = path.join(__dirname, "..");
const output = path.join(root, ".electron-data", "wgc-probe.png");
const keywords = ["Path of Exile", "流放之路"];

function isTarget(source) {
  const title = String(source.name || "");
  return keywords.some((keyword) => title.toLowerCase().includes(keyword.toLowerCase()));
}

function selectTarget(sources) {
  const exact = sources.filter((source) => keywords.some((keyword) => source.name === keyword));
  if (exact.length === 1) return exact[0];
  const matches = sources.filter(isTarget);
  if (matches.length === 1) return matches[0];
  throw new Error(`期望唯一 POE 窗口，实际 ${matches.length} 个: ${matches.map((x) => x.name).join(" | ")}`);
}

app.whenReady().then(async () => {
  let exitCode = 0;
  try {
    const sources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: { width: 1920, height: 1080 },
      fetchWindowIcons: false,
    });
    const source = selectTarget(sources);
    const size = source.thumbnail.getSize();
    if (source.thumbnail.isEmpty() || size.width < 100 || size.height < 100) {
      throw new Error(`WGC 返回空帧或尺寸异常: ${size.width}x${size.height}`);
    }
    const bitmapBytes = source.thumbnail.toBitmap().length;
    if (bitmapBytes < size.width * size.height * 4) {
      throw new Error(`WGC 像素缓冲大小异常: ${bitmapBytes}`);
    }
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, source.thumbnail.toPNG());
    process.stdout.write(
      `${JSON.stringify({ sourceId: source.id, title: source.name, width: size.width, height: size.height, output })}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    exitCode = 1;
  } finally {
    app.exit(exitCode);
  }
});
