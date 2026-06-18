import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 临时目录管理：创建唯一临时目录，并在测试结束后可靠清理。
 * Windows 上 better-sqlite3 关闭后文件句柄可能仍被短暂锁定，需要重试。
 */

const createdDirectories: string[] = [];

/** 创建一个唯一的临时目录，自动登记以便 afterEach 统一清理。 */
export function createTempDir(prefix = "senren-test-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdDirectories.push(dir);
  return dir;
}

/** 清理所有已登记的临时目录。应在测试文件的 afterEach 中调用。 */
export async function cleanupTempDirs(): Promise<void> {
  for (const directory of createdDirectories) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.rmSync(directory, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }
  createdDirectories.length = 0;
}
