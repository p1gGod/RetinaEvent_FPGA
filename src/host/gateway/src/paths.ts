// 资源定位。为什么不能靠 cwd：双击 exe/从别的目录启动时 cwd 可能不是 exe 目录（实测事实 H44，
// 04 §11.3 第 3 条），所以一律先按 process.execPath 所在目录找，再用源码目录兜底。
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const GATEWAY_SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
/** gateway/src → gateway → app → host */
export const HOST_ROOT = path.resolve(GATEWAY_SRC_DIR, "..", "..", "..");
export const WORKSPACE_ROOT = path.resolve(HOST_ROOT, "..");

export function exeDir(): string {
  return path.dirname(process.execPath);
}

/** 按 exe 目录 → host 根 → workspace 根 依次找；都不存在时返回 exe 目录下的路径（报错信息指向部署位置） */
export function resolveResource(rel: string, roots: readonly string[] = [exeDir(), HOST_ROOT, WORKSPACE_ROOT]): string {
  for (const root of roots) {
    const candidate = path.resolve(root, rel);
    if (existsSync(candidate)) return candidate;
  }
  const first = roots[0];
  return path.resolve(first === undefined ? exeDir() : first, rel);
}

/** 用户传入的输入路径：绝对路径原样；相对路径按 workspace/host/exe 解析，绝不拼 cwd */
export function resolveInputPath(p: string): string {
  if (path.isAbsolute(p)) return p;
  return resolveResource(p, [WORKSPACE_ROOT, HOST_ROOT, exeDir()]);
}

/** 开发期源码路径（测试与 golden 向量用）：相对 host 根解析 */
export function hostPath(rel: string): string {
  return path.resolve(HOST_ROOT, rel);
}
