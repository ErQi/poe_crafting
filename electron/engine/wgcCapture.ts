import { desktopCapturer, type DesktopCapturerSource } from "electron";
import { isMinimizedWindow, type WindowInfo, windowMetrics } from "./win32";

/** 与 OpenCV/WASM 的整帧上限保持一致，避免枚举窗口时生成大量 4K 缩略图。 */
const WGC_MAX_SHORT_EDGE = 1080;

export interface WgcWindowCapture {
  bgra: Buffer;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  sourceId: string;
  title: string;
}

function sourceHwnd(sourceId: string): bigint | null {
  const match = /^window:([^:]+):/.exec(sourceId);
  if (!match) return null;
  try {
    return BigInt(match[1]);
  } catch {
    return null;
  }
}

function requestedThumbnail(width: number, height: number): { width: number; height: number } {
  const short = Math.min(width, height);
  const scale = short > WGC_MAX_SHORT_EDGE ? WGC_MAX_SHORT_EDGE / short : 1;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function selectWindowSource(sources: DesktopCapturerSource[], window: WindowInfo): DesktopCapturerSource | null {
  const byHandle = sources.find((source) => sourceHwnd(source.id) === window.hwnd);
  if (byHandle) return byHandle;

  // source.id 是首选且在 Windows 上对应 HWND。标题只在唯一精确命中时兜底，避免资源管理器等
  // 窗口标题里恰好包含“流放之路”时抓错窗口。
  const exactTitle = sources.filter((source) => source.name === window.title);
  return exactTitle.length === 1 ? exactTitle[0] : null;
}

/**
 * 通过 Electron/Chromium 的窗口捕获链路取得指定 HWND 的一帧。
 * 当前 Windows 版本会走 WGC；窗口可以被遮挡，但明确不支持最小化。
 */
export async function captureWindowWgcBgra(window: WindowInfo): Promise<WgcWindowCapture> {
  if (process.platform !== "win32") throw new Error("WGC 仅支持 Windows");
  if (isMinimizedWindow(window.hwnd)) throw new Error("游戏窗口已最小化");
  const { width: sourceWidth, height: sourceHeight } = windowMetrics(window);
  if (sourceWidth < 32 || sourceHeight < 32) throw new Error("游戏窗口尺寸无效");

  const thumbnailSize = requestedThumbnail(sourceWidth, sourceHeight);
  const sources = await desktopCapturer.getSources({
    types: ["window"],
    thumbnailSize,
    fetchWindowIcons: false,
  });
  const source = selectWindowSource(sources, window);
  if (!source) throw new Error(`WGC 未找到目标 HWND ${window.hwnd.toString()}`);
  if (source.thumbnail.isEmpty()) throw new Error("WGC 返回空帧");

  const size = source.thumbnail.getSize();
  if (size.width < 32 || size.height < 32) throw new Error(`WGC 帧尺寸异常 ${size.width}x${size.height}`);
  const bitmap = source.thumbnail.toBitmap();
  const expected = size.width * size.height * 4;
  if (bitmap.length < expected) throw new Error(`WGC 像素缓冲大小不符 ${bitmap.length}/${expected}`);

  return {
    bgra: Buffer.from(bitmap.subarray(0, expected)),
    width: size.width,
    height: size.height,
    sourceWidth,
    sourceHeight,
    sourceId: source.id,
    title: source.name,
  };
}
