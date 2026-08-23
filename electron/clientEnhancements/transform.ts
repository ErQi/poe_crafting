import type { MinimapColor, ViewDistanceMultiplier } from "./types";

const CAMERA_CALL = /\bon_initial_position_set\s*=.*\b(?:ClearCameraZoomNodes|CreateCameraZoomNode)\s*\([^\r\n]*$/i;
const EASY_FARM_VISIBILITY = /if\s*\(\s*visibility_reset\s*>\s*0\.5f\s*\)\s*\{\s*res_color\s*=\s*float4\(\s*0\.18f\s*,\s*0(?:\.0f)?\s*,\s*0(?:\.0f)?\s*,\s*1(?:\.0f)?\s*\)\s*;\s*return\s+res_color\s*;\s*\}/i;
const RESET_ASSIGNMENT = /if\s*\(\s*visibility_reset\s*>\s*0\.5f\s*\)\s*(?:\{\s*)?res_color\s*=\s*float4\(\s*0(?:\.0f)?f?\s*,\s*0(?:\.0f)?f?\s*,\s*0(?:\.0f)?f?\s*,\s*1(?:\.0f)?f?\s*\)\s*;\s*\}?/i;
const POE_TOOLS_VISIBILITY = /\s*\/\/ POE Tools minimap reveal begin[\s\S]*?\/\/ POE Tools minimap reveal end\s*/gi;
const POE_TOOLS_OUTLINE = /^([\t ]*)\/\/ POE Tools minimap outline begin\r?\n[\s\S]*?^[\t ]*\/\/ POE Tools minimap outline end/gim;
const POE_TOOLS_COLOR = /^[\t ]*\/\/ POE Tools minimap color begin\r?\n[\s\S]*?^[\t ]*\/\/ POE Tools minimap color end\r?\n/gim;
const POE_TOOLS_ENVIRONMENT_DEFOG = /^([\t ]*)\/\/ POE Tools environment defog begin\r?\n[\t ]*return\s+iColour\s*;\r?\n[\t ]*\/\/ POE Tools environment defog end/gim;
const GEOMETRY_BLEND = /res_color\s*=\s*Uberblend\(\s*res_color\s*,\s*geometry_sample\s*\*\s*float4\(\s*1\.0f\s*,\s*1\.0f\s*,\s*1\.0f\s*,\s*visibility\s*\)\s*\)\s*;/i;
const ORIGINAL_GEOMETRY_BLEND = "res_color = Uberblend(res_color, geometry_sample * float4(1.0f, 1.0f, 1.0f, visibility));";
const ORIGINAL_FOG_RETURN = "return oColour;";

interface TextBuffer {
  text: string;
  encode(value: string): Buffer;
}

function decodeUtf16Le(buffer: Buffer): TextBuffer {
  const bom = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe;
  const offset = bom ? 2 : 0;
  const text = buffer.subarray(offset).toString("utf16le");
  return {
    text,
    encode(value) {
      const body = Buffer.from(value, "utf16le");
      return bom ? Buffer.concat([Buffer.from([0xff, 0xfe]), body]) : body;
    },
  };
}

function decodeUtf8(buffer: Buffer): TextBuffer {
  const bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  const offset = bom ? 3 : 0;
  const text = buffer.subarray(offset).toString("utf8");
  return {
    text,
    encode(value) {
      const body = Buffer.from(value, "utf8");
      return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
    },
  };
}

function newlineOf(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function blockRange(text: string, name: string): { open: number; close: number } {
  const start = text.search(new RegExp(`\\b${name}\\b`, "i"));
  if (start < 0) throw new Error(`客户端资源缺少 ${name} 块`);
  const open = text.indexOf("{", start);
  if (open < 0) throw new Error(`客户端资源中的 ${name} 块不完整`);
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) return { open, close: index };
    }
  }
  throw new Error(`客户端资源中的 ${name} 块括号不完整`);
}

function functionBlockRange(text: string, name: string): { open: number; close: number } {
  const match = new RegExp(`\\b${name}\\s*\\(`, "i").exec(text);
  if (!match || match.index === undefined) throw new Error(`客户端资源缺少 ${name} 函数`);
  const prefix = text.slice(0, match.index);
  // 从函数名开始复用通用括号扫描，同时避开文件头的 PRECOMPILE 注释。
  const range = blockRange(text.slice(prefix.length), name);
  return { open: range.open + prefix.length, close: range.close + prefix.length };
}

function cleanCameraText(text: string): string {
  const { open, close } = blockRange(text, "Positioned");
  const body = text.slice(open + 1, close);
  const newline = newlineOf(text);
  const lines = body.split(/\r?\n/).filter((line) => !CAMERA_CALL.test(line));
  const cleaned = lines.join(newline);
  return `${text.slice(0, open + 1)}${cleaned}${text.slice(close)}`;
}

export function cleanCameraResource(buffer: Buffer): Buffer {
  const decoded = decodeUtf16Le(buffer);
  return decoded.encode(cleanCameraText(decoded.text));
}

export function patchCameraResource(buffer: Buffer, enabled: boolean, multiplier: ViewDistanceMultiplier): Buffer {
  const decoded = decodeUtf16Le(buffer);
  let text = cleanCameraText(decoded.text);
  if (!enabled) return decoded.encode(text);
  const { open, close } = blockRange(text, "Positioned");
  const body = text.slice(open + 1, close);
  const newline = newlineOf(text);
  const team = /(^|\r?\n)([\t ]*)team\s*=\s*1\s*(?=\r?\n|$)/i.exec(body);
  if (!team || team.index === undefined) throw new Error("角色资源缺少 Positioned.team，无法安全写入视距");
  const full = team[0];
  const indent = team[2] || "\t";
  const at = open + 1 + team.index + full.length;
  const zoom = Number(multiplier).toString();
  const injection = [
    `${newline}${indent}on_initial_position_set = {ClearCameraZoomNodes();}`,
    `${newline}${indent}on_initial_position_set = {CreateCameraZoomNode(1000000000.0f, 1000000000.0f, ${zoom}f);}`,
  ].join("");
  text = `${text.slice(0, at)}${injection}${text.slice(at)}`;
  return decoded.encode(text);
}

function cleanVisibilityText(input: string): string {
  let text = input.replace(
    POE_TOOLS_VISIBILITY,
    "\n\tif(visibility_reset > 0.5f)\n\t\tres_color = float4(0.0f, 0.0f, 0.0f, 1.0f);\n",
  );
  text = text.replace(
    EASY_FARM_VISIBILITY,
    "if(visibility_reset > 0.5f)\n\t\tres_color = float4(0.0f, 0.0f, 0.0f, 1.0f);",
  );
  // 兼容其他同类补丁常用的最终阈值写法；原版该函数没有这条赋值。
  text = text.replace(/^\s*res_color\.r\s*=\s*max\(\s*res_color\.r\s*,\s*0\.\d+f\s*\)\s*;\s*$/gim, "");
  functionBlockRange(text, "RenderVisibility");
  if (!RESET_ASSIGNMENT.test(text)) throw new Error("小地图可见度着色器结构已变化，已拒绝盲目修改");
  return text;
}

export function cleanMinimapVisibilityResource(buffer: Buffer): Buffer {
  const decoded = decodeUtf8(buffer);
  return decoded.encode(cleanVisibilityText(decoded.text));
}

export function patchMinimapVisibilityResource(buffer: Buffer, enabled: boolean): Buffer {
  const decoded = decodeUtf8(buffer);
  // 全开只应改地图轮廓的混色，不能提高可见度纹理的初始值。
  // 保留参数是为了稳定现有调用接口；无论开关状态都清理旧版揭雾写法。
  void enabled;
  return decoded.encode(cleanVisibilityText(decoded.text));
}

function cleanBlendingText(input: string): string {
  let text = input.replace(POE_TOOLS_OUTLINE, (_match, indent: string) => `${indent}${ORIGINAL_GEOMETRY_BLEND}`);
  text = text.replace(POE_TOOLS_COLOR, "");
  text = text.replace(
    /\s*float3\s+desired_mist_color_rgb\s*=\s*float3\([^;]+\)\s*;\s*res_color\.rgb\s*=\s*lerp\(\s*res_color\.rgb\s*,\s*desired_mist_color_rgb\s*,\s*1\.0f\s*-\s*visibility\s*\)\s*;\s*/gi,
    "\n",
  );
  const { open, close } = functionBlockRange(text, "BlendMinimap");
  const body = text.slice(open + 1, close);
  if (!GEOMETRY_BLEND.test(body)) {
    throw new Error("小地图混色着色器缺少几何轮廓混合点");
  }
  if (!/res_color\.a\s*\*=\s*saturate\(\s*1\.0f\s*-\s*walkability_sample\.b\s*\*\s*2\.0f\s*\)\s*;/i.test(body)) {
    throw new Error("小地图混色着色器结构已变化，已拒绝盲目修改");
  }
  return text;
}

export function cleanMinimapBlendingResource(buffer: Buffer): Buffer {
  const decoded = decodeUtf8(buffer);
  return decoded.encode(cleanBlendingText(decoded.text));
}

const COLOR_RGB: Record<Exclude<MinimapColor, "default">, [number, number, number]> = {
  purple: [0.55, 0, 0.55],
  orange: [1, 0.35, 0],
  blue: [0, 0.5, 1],
};

function float(value: number): string {
  return `${value.toFixed(2)}f`;
}

export function patchMinimapBlendingResource(buffer: Buffer, enabled: boolean, color: MinimapColor): Buffer {
  const decoded = decodeUtf8(buffer);
  let text = cleanBlendingText(decoded.text);
  if (!enabled) return decoded.encode(text);
  const newline = newlineOf(text);
  const outline = [
    "// POE Tools minimap outline begin",
    "float poe_tools_outline_visibility = max(visibility, 0.36f);",
    "res_color = Uberblend(res_color, geometry_sample * float4(1.0f, 1.0f, 1.0f, poe_tools_outline_visibility));",
    "// POE Tools minimap outline end",
  ].join(newline);
  text = text.replace(GEOMETRY_BLEND, outline);
  if (color === "default") return decoded.encode(text);
  const rgb = COLOR_RGB[color];
  const { open, close } = functionBlockRange(text, "BlendMinimap");
  const body = text.slice(open + 1, close);
  const anchor = /(^|\r?\n)([\t ]*)res_color\.a\s*\*=\s*saturate\(\s*1\.0f\s*-\s*walkability_sample\.b\s*\*\s*2\.0f\s*\)\s*;/i.exec(body);
  if (!anchor || anchor.index === undefined) throw new Error("小地图混色着色器缺少颜色插入点");
  const indent = anchor[2] || "\t\t";
  const at = open + 1 + anchor.index + (anchor[1] ? anchor[1].length : 0);
  const injection = [
    `${indent}// POE Tools minimap color begin`,
    `${indent}float3 poe_tools_mist_color_rgb = float3(${float(rgb[0])}, ${float(rgb[1])}, ${float(rgb[2])});`,
    `${indent}res_color.rgb = lerp(res_color.rgb, poe_tools_mist_color_rgb, 1.0f - visibility);`,
    `${indent}// POE Tools minimap color end`,
    "",
  ].join(newline);
  text = `${text.slice(0, at)}${injection}${text.slice(at)}`;
  return decoded.encode(text);
}

function cleanEnvironmentFogText(input: string): string {
  const text = input.replace(
    POE_TOOLS_ENVIRONMENT_DEFOG,
    (_match, indent: string) => `${indent}${ORIGINAL_FOG_RETURN}`,
  );
  const { open, close } = functionBlockRange(text, "ApplyGlobalFog");
  const body = text.slice(open + 1, close);
  if (!/\breturn\s+oColour\s*;/i.test(body)) {
    throw new Error("环境雾着色器缺少最终颜色返回点，已拒绝盲目修改");
  }
  return text;
}

export function cleanEnvironmentFogResource(buffer: Buffer): Buffer {
  const decoded = decodeUtf16Le(buffer);
  return decoded.encode(cleanEnvironmentFogText(decoded.text));
}

export function patchEnvironmentFogResource(buffer: Buffer, enabled: boolean): Buffer {
  const decoded = decodeUtf16Le(buffer);
  let text = cleanEnvironmentFogText(decoded.text);
  if (!enabled) return decoded.encode(text);

  const { open, close } = functionBlockRange(text, "ApplyGlobalFog");
  const body = text.slice(open + 1, close);
  const target = /^([\t ]*)return\s+oColour\s*;/im.exec(body);
  if (!target || target.index === undefined) {
    throw new Error("环境雾着色器缺少安全插入点");
  }
  const indent = target[1] || "\t\t";
  const newline = newlineOf(text);
  const replacement = [
    `${indent}// POE Tools environment defog begin`,
    `${indent}return iColour;`,
    `${indent}// POE Tools environment defog end`,
  ].join(newline);
  const at = open + 1 + target.index;
  text = `${text.slice(0, at)}${replacement}${text.slice(at + target[0].length)}`;
  return decoded.encode(text);
}
