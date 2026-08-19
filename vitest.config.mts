import { defineConfig } from "vitest/config";

// 只收 electron/ 下的测试：web/ 有自己的 Vite 配置，两边互不干扰。
export default defineConfig({
  test: {
    environment: "node",
    include: ["electron/**/*.test.ts"],
  },
});
