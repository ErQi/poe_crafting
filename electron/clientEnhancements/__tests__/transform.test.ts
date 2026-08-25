import { describe, expect, it } from "vitest";
import {
  cleanCameraResource,
  cleanEnvironmentFogResource,
  cleanMinimapBlendingResource,
  cleanMinimapVisibilityResource,
  patchCameraResource,
  patchEnvironmentFogResource,
  patchMinimapBlendingResource,
  patchMinimapVisibilityResource,
} from "../transform";

function ot(text: string): Buffer {
  return Buffer.from(text, "utf16le");
}

function otText(buffer: Buffer): string {
  return buffer.toString("utf16le");
}

const camera = [
  "version 3",
  "Positioned",
  "{",
  "\tobject_size = 2",
  "\tteam = 1",
  "\ton_initial_position_set = {ClearCameraZoomNodes();}",
  "\ton_initial_position_set = {CreateCameraZoomNode(1000000000.0f, 1000000000.0f, 2f);}",
  "}",
  "Pathfinding { base_speed = 37 }",
  "",
].join("\r\n");

const visibility = `float4 RenderVisibility( const PS_INPUT input ) : PIXEL_RETURN_SEMANTIC
{
  float4 res_color = float4(0.0f, 0.0f, 0.0f, 1.0f);
  if(visibility_reset > 0.5f)
    res_color = float4(0.0f, 0.0f, 0.0f, 1.0f);
  return res_color;
}`;

const originalGeometryBlend = "res_color = Uberblend(res_color, geometry_sample * float4(1.0f, 1.0f, 1.0f, visibility));";

const blending = `float4 BlendMinimap( const PS_INPUT input ) : PIXEL_RETURN_SEMANTIC
{
  float visibility = 0.5f;
  float unexplored_edge = saturate(visibility * (1.0f - visibility) * 4.0f);
  float4 geometry_sample = float4(1, 1, 1, 1);
  float4 res_color = float4(0, 0, 0, 1);
  ${originalGeometryBlend}
  if( !use_royale_data )
  {
    res_color.a *= saturate(1.0f - walkability_sample.b * 2.0f);
    res_color.rgb *= res_color.a;
  }
  return res_color;
}`;

const fog = `DECLARATIONS fog_functions
{{
  float4 ApplyGlobalFog(float4 iPosition, float4 iColour)
  {
    float4 oFogValue = 0.f;
    float4 oColour = float4(iColour.rgb + oFogValue.rgb, iColour.a);
    return oColour;
  }
}}`;

describe("客户端增强资源转换", () => {
  it("清理已有相机节点并只写入一个所选倍率", () => {
    const patched = otText(patchCameraResource(ot(camera), true, 3.5));
    expect(patched.match(/ClearCameraZoomNodes/g)).toHaveLength(1);
    expect(patched.match(/CreateCameraZoomNode/g)).toHaveLength(1);
    expect(patched).toContain("3.5f");
    expect(otText(cleanCameraResource(Buffer.from(patched, "utf16le")))).not.toContain("CameraZoomNode");
  });

  it("可见度全开强制整图渲染，真未探索量写入蓝通道供混色做阴影", () => {
    const patched = patchMinimapVisibilityResource(Buffer.from(visibility), true).toString();
    expect(patched).toContain("POE Tools minimap reveal begin");
    expect(patched).toContain("res_color.r = max(poe_tools_true, 0.5f);");
    expect(patched).toContain("res_color.b = 1.0f - poe_tools_true;");

    const cleaned = cleanMinimapVisibilityResource(Buffer.from(patched)).toString();
    expect(cleaned).not.toContain("POE Tools minimap reveal");
    expect(cleaned).toContain("float4(0.0f, 0.0f, 0.0f, 1.0f)");
  });

  it("黑底阴影之上只在未探索区叠加地图轮廓，alpha 尊重地形透明度", () => {
    const plain = patchMinimapBlendingResource(Buffer.from(blending), true, "default").toString();
    expect(plain).toContain("// POE Tools minimap layout begin");
    expect(plain).toContain("float poe_tools_reveal = saturate(walkability_sample.b * 2.0f);");
    expect(plain).toContain("saturate(geometry_opacity * 1.3f) * poe_tools_reveal");
    expect(plain).not.toContain("poe_tools_mist_color_rgb");
    const cleaned = cleanMinimapBlendingResource(Buffer.from(plain)).toString();
    expect(cleaned).not.toContain("POE Tools minimap layout");
    expect(cleaned).toContain(originalGeometryBlend);
  });

  it("自定义色重复应用时，布局覆盖与迷雾混色不重复注入", () => {
    const purple = patchMinimapBlendingResource(Buffer.from(blending), true, "purple").toString();
    expect(purple).toContain("float3(0.55f, 0.00f, 0.55f)");
    const blue = patchMinimapBlendingResource(Buffer.from(purple), true, "blue").toString();
    expect(blue.match(/poe_tools_mist_color_rgb/g)).toHaveLength(2);
    expect(blue.match(/POE Tools minimap layout begin/g)).toHaveLength(1);
    expect(cleanMinimapBlendingResource(Buffer.from(blue)).toString()).not.toContain("POE Tools minimap color");
  });

  it("环境去雾只改全局雾函数的最终返回值，并且可重复应用和还原", () => {
    const withBom = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(fog, "utf16le")]);
    const first = patchEnvironmentFogResource(withBom, true);
    const second = patchEnvironmentFogResource(first, true);
    const patched = second.subarray(2).toString("utf16le");

    expect(second.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
    expect(patched.match(/POE Tools environment defog begin/g)).toHaveLength(1);
    expect(patched).toContain("return iColour;");
    expect(patched).toContain("float4 oFogValue = 0.f;");

    const cleaned = cleanEnvironmentFogResource(second).subarray(2).toString("utf16le");
    expect(cleaned).not.toContain("POE Tools environment defog");
    expect(cleaned).toContain("return oColour;");
    expect(patchEnvironmentFogResource(Buffer.from(cleaned, "utf16le"), false).toString("utf16le")).toBe(cleaned);
  });
});
