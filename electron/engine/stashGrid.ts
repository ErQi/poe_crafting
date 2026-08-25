import type { WindowInfo } from "./win32";
import { windowMetrics } from "./win32";
import type { MatchHit } from "./vision";

/**
 * 对照 PixPin_2026-08-19_01-43-08.jpg（3840×2160，全屏客户区）
 * 标定；所有长度均以客户区高度为单位。
 */
const ORIGIN_XH = 108 / 2160;
const ORIGIN_YH = 548 / 2160;
const PITCH_XH = 112 / 2160;
const PITCH_YH = 132 / 2160;
const CELL_H = 112 / 2160;
const GRID_LEFT_H = (108 - 56) / 2160;
const GRID_RIGHT_H = (1116 + 56) / 2160;
const GRID_TOP_H = (416 - 56) / 2160;
const GRID_BOTTOM_H = (944 + 56) / 2160;

const GRID_ROWS = 4;
const GRID_COLS = 10;

/** 0 基行列；主格网第一行为 0，卷轴/品质通货行为 -1。仅收录脚本可靠识别的格子。 */
const CURRENCY_CELLS: Record<string, readonly [number, number]> = {
  currency_wisdom: [-1, 1],
  currency_portal: [-1, 2],
  currency_whetstone: [-1, 7],
  currency_scrap: [-1, 8],
  currency_bauble: [-1, 9],
  currency_transmutation: [0, 0],
  currency_alteration: [0, 1],
  currency_annulment: [0, 2],
  currency_chance: [0, 3],
  currency_regal: [0, 7],
  currency_alchemy: [0, 8],
  currency_chaos: [0, 9],
  currency_chisel: [1, 1],
  currency_augmentation: [1, 3],
  currency_jewellers: [2, 1],
  currency_fusing: [2, 2],
  currency_chromatic: [2, 3],
  currency_scouring: [2, 7],
  currency_vaal: [2, 8],
  currency_exalted: [2, 9],
  currency_regret: [3, 7],
};

function inStashClient(win: WindowInfo, x: number, y: number): boolean {
  const { width, height } = windowMetrics(win);
  if (width <= 0 || height <= 0) return false;
  return (
    x >= height * GRID_LEFT_H &&
    x <= height * GRID_RIGHT_H &&
    y >= height * GRID_TOP_H &&
    y <= height * GRID_BOTTOM_H &&
    x < width &&
    y < height
  );
}

export function currencyCellHit(win: WindowInfo, name: string, row: number, col: number): MatchHit | null {
  const { height } = windowMetrics(win);
  if (height <= 0) return null;
  const cell = Math.max(8, Math.round(CELL_H * height));
  const clientX = Math.round((ORIGIN_XH + col * PITCH_XH) * height);
  const clientY = Math.round((ORIGIN_YH + row * PITCH_YH) * height);
  if (!inStashClient(win, clientX, clientY)) return null;
  return {
    name,
    score: 1,
    screenX: win.left + clientX,
    screenY: win.top + clientY,
    clientX,
    clientY,
    width: cell,
    height: cell,
  };
}

function neighborCells(row: number, col: number): [number, number][] {
  const out: [number, number][] = [];
  for (const [dr, dc] of [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ] as const) {
    const r = row + dr;
    const c = col + dc;
    if (r < -1 || r >= GRID_ROWS || c < 0 || c >= GRID_COLS) continue;
    out.push([r, c]);
  }
  return out;
}

export function hasCurrencyCell(templateName: string): boolean {
  return templateName in CURRENCY_CELLS;
}

export function currencySlotCandidates(win: WindowInfo, templateName: string): MatchHit[] {
  const slot = CURRENCY_CELLS[templateName];
  if (!slot) return [];
  const seen = new Set<string>();
  const hits: MatchHit[] = [];
  for (const [row, col] of [slot, ...neighborCells(slot[0], slot[1])]) {
    const key = `${row},${col}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const hit = currencyCellHit(win, templateName, row, col);
    if (hit) hits.push(hit);
  }
  return hits;
}
