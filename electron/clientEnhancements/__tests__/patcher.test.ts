import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setProjectRoot } from "../../engine/configStore";
import type { PoeBundleTool } from "../../pricePatch/bundleTool";
import {
  CAMERA_RESOURCE,
  ClientEnhancementPatcher,
  ENVIRONMENT_FOG_RESOURCE,
  MINIMAP_BLENDING_RESOURCE,
  MINIMAP_VISIBILITY_RESOURCE,
} from "../patcher";
import {
  cleanCameraResource,
  cleanMinimapBlendingResource,
  cleanMinimapVisibilityResource,
  patchCameraResource,
  patchMinimapBlendingResource,
} from "../transform";
import { defaultClientEnhancementState } from "../types";

const testPaths = { root: "" };

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function utf16(text: string): Buffer {
  return Buffer.from(text, "utf16le");
}

function backupName(resource: string): string {
  return resource.replace(/[^A-Za-z0-9._-]+/g, "_");
}

const cameraOriginal = utf16([
  "Positioned",
  "{",
  "\tteam = 1",
  "\ton_initial_position_set = {ClearCameraZoomNodes();}",
  "\ton_initial_position_set = {CreateCameraZoomNode(1000000000.0f, 1000000000.0f, 1.5f);}",
  "}",
  "",
].join("\r\n"));

const visibilityOriginal = Buffer.from(`float4 RenderVisibility( const PS_INPUT input ) : PIXEL_RETURN_SEMANTIC
{
  float4 res_color = float4(0.0f, 0.0f, 0.0f, 1.0f);
  if(visibility_reset > 0.5f)
    res_color = float4(0.0f, 0.0f, 0.0f, 1.0f);
  return res_color;
}`);

const blendingOriginal = Buffer.from(`float4 BlendMinimap( const PS_INPUT input ) : PIXEL_RETURN_SEMANTIC
{
  float visibility = 0.5f;
  float4 geometry_sample = float4(1, 1, 1, 1);
  float4 res_color = float4(0, 0, 0, 1);
  res_color = Uberblend(res_color, geometry_sample * float4(1.0f, 1.0f, 1.0f, visibility));
  if( !use_royale_data )
  {
    res_color.a *= saturate(1.0f - walkability_sample.b * 2.0f);
    res_color.rgb *= res_color.a;
  }
  return res_color;
}`);

const fogOriginal = utf16(`DECLARATIONS fog_functions
{{
  float4 ApplyGlobalFog(float4 iPosition, float4 iColour)
  {
    float4 oFogValue = 0.f;
    float4 oColour = float4(iColour.rgb + oFogValue.rgb, iColour.a);
    return oColour;
  }
}}`);

describe("客户端增强旧基线迁移", () => {
  beforeEach(async () => {
    testPaths.root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "poe-enhancement-test-"));
    setProjectRoot(testPaths.root);
  });

  afterEach(async () => {
    setProjectRoot(process.cwd());
    const resolved = path.resolve(testPaths.root);
    if (resolved.startsWith(path.resolve(os.tmpdir())) && path.basename(resolved).startsWith("poe-enhancement-test-")) {
      await fs.promises.rm(resolved, { recursive: true, force: true });
    }
  });

  it("保留旧三资源的首次备份，并把当前雾资源加入新基线", async () => {
    const clientRoot = path.join(testPaths.root, "client");
    const bundles = path.join(clientRoot, "Bundles2");
    await fs.promises.mkdir(bundles, { recursive: true });
    const executable = Buffer.from("test executable");
    await fs.promises.writeFile(path.join(clientRoot, "PathOfExile_x64.exe"), executable);
    await fs.promises.writeFile(path.join(bundles, "_.index.bin"), "test index");

    const cleanCamera = cleanCameraResource(cameraOriginal);
    const cleanVisibility = cleanMinimapVisibilityResource(visibilityOriginal);
    const cleanBlending = cleanMinimapBlendingResource(blendingOriginal);
    const currentResources: Record<string, Buffer> = {
      [CAMERA_RESOURCE]: patchCameraResource(cleanCamera, true, 2),
      [MINIMAP_VISIBILITY_RESOURCE]: cleanVisibility,
      [MINIMAP_BLENDING_RESOURCE]: patchMinimapBlendingResource(cleanBlending, true, "default"),
      [ENVIRONMENT_FOG_RESOURCE]: fogOriginal,
    };

    const baselineId = "legacy-baseline";
    const baselineDir = path.join(testPaths.root, "client-enhancements", "baselines", baselineId);
    const originals: Record<string, Buffer> = {
      [CAMERA_RESOURCE]: cameraOriginal,
      [MINIMAP_VISIBILITY_RESOURCE]: visibilityOriginal,
      [MINIMAP_BLENDING_RESOURCE]: blendingOriginal,
    };
    const cleans: Record<string, Buffer> = {
      [CAMERA_RESOURCE]: cleanCamera,
      [MINIMAP_VISIBILITY_RESOURCE]: cleanVisibility,
      [MINIMAP_BLENDING_RESOURCE]: cleanBlending,
    };
    const manifestResources = [];
    for (const resource of [CAMERA_RESOURCE, MINIMAP_VISIBILITY_RESOURCE, MINIMAP_BLENDING_RESOURCE]) {
      const name = backupName(resource);
      const originalPath = `original/${name}`;
      const cleanPath = `clean/${name}`;
      await fs.promises.mkdir(path.join(baselineDir, "original"), { recursive: true });
      await fs.promises.mkdir(path.join(baselineDir, "clean"), { recursive: true });
      await fs.promises.writeFile(path.join(baselineDir, originalPath), originals[resource]);
      await fs.promises.writeFile(path.join(baselineDir, cleanPath), cleans[resource]);
      manifestResources.push({
        resourcePath: resource,
        originalBackupPath: originalPath,
        originalSize: originals[resource].length,
        originalSha256: sha256(originals[resource]),
        cleanBackupPath: cleanPath,
        cleanSize: cleans[resource].length,
        cleanSha256: sha256(cleans[resource]),
      });
    }
    await fs.promises.writeFile(path.join(baselineDir, "manifest.json"), JSON.stringify({
      schemaVersion: 1,
      id: baselineId,
      createdAt: "2026-08-23T00:00:00.000Z",
      clientRoot,
      executableSha256: sha256(executable),
      resources: manifestResources,
    }));

    const tool = {
      listCustomBundles: vi.fn(async () => []),
      resourceBundles: vi.fn(async () => []),
      probeExclusive: vi.fn(async () => undefined),
      extract: vi.fn(async (
        _index: string,
        _readRoot: string,
        _overlayRoot: string,
        resource: string,
        output: string,
      ) => {
        await fs.promises.mkdir(path.dirname(output), { recursive: true });
        await fs.promises.writeFile(output, currentResources[resource]);
        return [];
      }),
      replace: vi.fn(async () => {
        throw new Error("资源未变化时不应进入写入阶段");
      }),
    } as unknown as PoeBundleTool;

    const state = defaultClientEnhancementState();
    state.clientRoot = clientRoot;
    state.baselineId = baselineId;
    state.viewDistanceEnabled = true;
    state.minimapEnabled = true;
    state.applied = true;
    state.executableSha256 = sha256(executable);
    state.appliedResourceSha256 = Object.fromEntries(
      [CAMERA_RESOURCE, MINIMAP_VISIBILITY_RESOURCE, MINIMAP_BLENDING_RESOURCE]
        .map((resource) => [resource, sha256(currentResources[resource])]),
    );

    const patcher = new ClientEnhancementPatcher(tool, async () => clientRoot, async () => false);
    const result = await patcher.apply(clientRoot, state, {
      viewDistanceEnabled: true,
      viewDistanceMultiplier: 2,
      minimapEnabled: true,
      minimapColor: "default",
      environmentDefogEnabled: false,
    });

    expect(result.changed).toBe(false);
    expect(result.baselineId).not.toBe(baselineId);
    expect(result.resourceSha256[ENVIRONMENT_FOG_RESOURCE]).toBe(sha256(fogOriginal));
    expect(fs.existsSync(path.join(baselineDir, "manifest.json"))).toBe(true);

    const migratedDir = path.join(testPaths.root, "client-enhancements", "baselines", result.baselineId);
    const migrated = JSON.parse(await fs.promises.readFile(path.join(migratedDir, "manifest.json"), "utf8"));
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.resources.map((item: { resourcePath: string }) => item.resourcePath)).toContain(ENVIRONMENT_FOG_RESOURCE);

    const migratedCamera = migrated.resources.find(
      (item: { resourcePath: string }) => item.resourcePath === CAMERA_RESOURCE,
    );
    const migratedFog = migrated.resources.find(
      (item: { resourcePath: string }) => item.resourcePath === ENVIRONMENT_FOG_RESOURCE,
    );
    expect(await fs.promises.readFile(path.join(migratedDir, migratedCamera.originalBackupPath))).toEqual(cameraOriginal);
    expect(await fs.promises.readFile(path.join(migratedDir, migratedFog.originalBackupPath))).toEqual(fogOriginal);
  });
});
