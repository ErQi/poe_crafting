/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");

if (!process.versions.electron) {
  console.error("请运行: npx electron scripts/calibrate-stash.cjs");
  process.exit(1);
}

const { app, nativeImage } = require("electron");
const cv = require("opencv-wasm").cv;

const ROOT = path.join(__dirname, "..");
const SCREENSHOT = path.join(ROOT, "assets", "templates", "PixPin_2026-08-19_01-43-08.jpg");
const TEMPLATE_DIR = path.join(ROOT, "assets", "templates");

// 3840×2160 原图量得；中心及尺寸均以客户区高度为单位。
const GRID = {
  centerXH: 108 / 2160,
  centerYH: 548 / 2160,
  pitchXH: 112 / 2160,
  pitchYH: 132 / 2160,
  cellH: 112 / 2160,
  rows: [-1, 0, 1, 2, 3, 4],
  cols: 10,
};

// 数字位置来自原图中的可读堆叠文字，用来独立检查网格几何；不参与图标分类。
const STACK_ANCHORS = [
  { stack: "3431", currency: "currency_alteration", x: 210, y: 524 },
  { stack: "6966", currency: "currency_jewellers", x: 210, y: 788 },
];

function loadFrame(file) {
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) throw new Error(`无法读取图片: ${file}`);
  const { width, height } = image.getSize();
  const rgba = cv.matFromArray(height, width, cv.CV_8UC4, new Uint8Array(image.toBitmap()));
  const stashRgba = rgba.roi(new cv.Rect(0, 0, Math.min(1300, width), Math.min(1200, height))).clone();
  rgba.delete();
  const bgr = new cv.Mat();
  cv.cvtColor(stashRgba, bgr, cv.COLOR_BGRA2BGR);
  stashRgba.delete();
  return { bgr, sourceHeight: height };
}

function loadTemplate(file) {
  const image = nativeImage.createFromPath(file);
  const { width, height } = image.getSize();
  const rgba = cv.matFromArray(height, width, cv.CV_8UC4, new Uint8Array(image.toBitmap()));
  const bgr = new cv.Mat();
  cv.cvtColor(rgba, bgr, cv.COLOR_BGRA2BGR);
  rgba.delete();
  const lower = bgr.roi(new cv.Rect(0, Math.round(height * 0.28), width, Math.round(height * 0.72))).clone();
  return { full: bgr, lower };
}

function finiteMax(result) {
  const data = result.data32F;
  let best = -1;
  for (let i = 0; i < data.length; i++) {
    if (Number.isFinite(data[i]) && data[i] > best) best = data[i];
  }
  return best;
}

function matchFragment(cell, template, baseScale) {
  let best = -1;
  for (let factor = 0.65; factor <= 1.15 + 1e-9; factor += 0.05) {
    const scale = baseScale * factor;
    const width = Math.round(template.cols * scale);
    const height = Math.round(template.rows * scale);
    if (width >= cell.cols || height >= cell.rows || width < 12 || height < 12) continue;
    const needle = new cv.Mat();
    cv.resize(template, needle, new cv.Size(width, height), 0, 0, cv.INTER_AREA);
    const result = new cv.Mat();
    try {
      cv.matchTemplate(cell, needle, result, cv.TM_CCOEFF_NORMED);
      best = Math.max(best, finiteMax(result));
    } finally {
      result.delete();
      needle.delete();
    }
  }
  return best;
}

function matchCell(cell, template, baseScale) {
  const full = matchFragment(cell, template.full, baseScale);
  const lower = matchFragment(cell, template.lower, baseScale);
  return full * 0.35 + lower * 0.65;
}

function cellAt(frame, sourceHeight, row, col) {
  const height = sourceHeight;
  const size = Math.round(GRID.cellH * height);
  const centerX = Math.round((GRID.centerXH + col * GRID.pitchXH) * height);
  const centerY = Math.round((GRID.centerYH + row * GRID.pitchYH) * height);
  const left = Math.round(centerX - size / 2);
  const top = Math.round(centerY - size / 2);
  return {
    centerX,
    centerY,
    mat: frame.roi(new cv.Rect(left, top, size, size)),
  };
}

function anchorCell(anchor, height) {
  const col = Math.round((anchor.x / height - GRID.centerXH) / GRID.pitchXH);
  const row = Math.round((anchor.y / height - GRID.centerYH) / GRID.pitchYH);
  const centerX = Math.round((GRID.centerXH + col * GRID.pitchXH) * height);
  const centerY = Math.round((GRID.centerYH + row * GRID.pitchYH) * height);
  return { row, col, centerX, centerY };
}

async function main() {
  await app.whenReady();
  const { bgr: frame, sourceHeight } = loadFrame(SCREENSHOT);
  const files = fs
    .readdirSync(TEMPLATE_DIR)
    .filter((name) => /^currency_.+\.png$/i.test(name))
    .sort();
  const templates = new Map(files.map((file) => [path.parse(file).name, loadTemplate(path.join(TEMPLATE_DIR, file))]));
  const baseScale = sourceHeight / 1080;
  const rows = [];

  try {
    for (const row of GRID.rows) {
      for (let col = 0; col < GRID.cols; col++) {
        const cell = cellAt(frame, sourceHeight, row, col);
        const ranked = [];
        try {
          for (const [name, template] of templates) {
            ranked.push({ name, score: matchCell(cell.mat, template, baseScale) });
          }
        } finally {
          cell.mat.delete();
        }
        ranked.sort((a, b) => b.score - a.score);
        rows.push({ row, col, x: cell.centerX, y: cell.centerY, ranked, best: ranked[0], second: ranked[1] });
      }
    }

    console.log("行,列,中心X,中心Y,最佳匹配通货,分数,次优通货,次优分数");
    for (const item of rows) {
      console.log(
        `${item.row},${item.col},${item.x},${item.y},${item.best.name},${item.best.score.toFixed(4)},` +
          `${item.second.name},${item.second.score.toFixed(4)}`,
      );
    }

    console.log("\n模板,最佳行,最佳列,中心X,中心Y,分数,次优行,次优列,次优分数");
    for (const name of templates.keys()) {
      const ranked = rows
        .map((item) => ({ ...item, score: item.ranked.find((entry) => entry.name === name).score }))
        .sort((a, b) => b.score - a.score);
      console.log(
        `${name},${ranked[0].row},${ranked[0].col},${ranked[0].x},${ranked[0].y},${ranked[0].score.toFixed(4)},` +
          `${ranked[1].row},${ranked[1].col},${ranked[1].score.toFixed(4)}`,
      );
    }

    const assignments = [];
    const assignedTemplates = new Set();
    const assignedCells = new Set();
    const edges = rows
      .flatMap((item) =>
        item.ranked.map((entry) => ({
          name: entry.name,
          score: entry.score,
          row: item.row,
          col: item.col,
          x: item.x,
          y: item.y,
        })),
      )
      .sort((a, b) => b.score - a.score);
    for (const edge of edges) {
      const cellKey = `${edge.row},${edge.col}`;
      if (assignedTemplates.has(edge.name) || assignedCells.has(cellKey)) continue;
      assignedTemplates.add(edge.name);
      assignedCells.add(cellKey);
      assignments.push(edge);
    }
    console.log("\n一对一去重映射（低于 0.50 仅供排查，不应写入运行时）:");
    for (const item of assignments.sort((a, b) => a.name.localeCompare(b.name))) {
      console.log(
        `${item.name}: row=${item.row}, col=${item.col}, center=(${item.x},${item.y}), ` +
          `score=${item.score.toFixed(4)}${item.score < 0.5 ? " [低置信]" : ""}`,
      );
    }

    console.log("\n交叉验证（堆叠数字只检查几何，不参与图标匹配）:");
    let failed = false;
    for (const anchor of STACK_ANCHORS) {
      const cell = anchorCell(anchor, sourceHeight);
      const result = rows.find((item) => item.row === cell.row && item.col === cell.col);
      const ok = result?.best.name === anchor.currency;
      failed ||= !ok;
      console.log(
        `${anchor.stack}: row=${cell.row}, col=${cell.col}, center=(${cell.centerX},${cell.centerY}), ` +
          `match=${result?.best.name ?? "无"} ${result?.best.score.toFixed(4) ?? ""}, ${ok ? "通过" : "失败"}`,
      );
    }
    if (failed) process.exitCode = 2;
  } finally {
    for (const template of templates.values()) {
      template.full.delete();
      template.lower.delete();
    }
    frame.delete();
    app.quit();
  }
}

main().catch((error) => {
  console.error(error);
  app.quit();
  process.exitCode = 1;
});
