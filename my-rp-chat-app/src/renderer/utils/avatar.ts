/**
 * 头像工具函数模块
 * 根据角色 ID 映射对应的头像资源路径。
 */

/**
 * 根据角色 ID 获取对应的头像图片路径。
 * 通过角色名称（中文/英文）匹配预定义的头像资源，
 * 若无匹配则返回默认头像。
 * @param characterId - 角色标识符（可为中文名、英文名或 null/undefined）
 * @returns 头像图片的静态资源路径
 */
export function getAvatarPath(characterId: string | null | undefined): string {
  if (!characterId) return "/vite.svg";
  const id = characterId.toLowerCase();
  if (id.includes("芳乃") || id.includes("yoshino")) return "/yoshino.png";
  if (id.includes("茉子") || id.includes("mako")) return "/mako.png";
  if (id.includes("丛雨") || id.includes("murasame")) return "/murasame.png";
  if (id.includes("蕾娜") || id.includes("lena")) return "/lena.png";
  return "/vite.svg";
}
