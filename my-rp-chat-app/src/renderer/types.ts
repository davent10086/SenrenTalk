/**
 * 渲染进程类型定义
 * 包含渲染进程特有的扩展类型，如待发送附件的草稿表示。
 */
import type { PendingAttachmentInput } from "../common/types";

/**
 * 渲染进程中待发送附件的草稿表示。
 * 相比后端的 PendingAttachmentInput，增加了浏览器 File 对象的直接引用，
 * 用于在 FormData 中上传文件。
 * @extends PendingAttachmentInput - 继承基础附件输入类型
 */
export interface PendingAttachmentDraft extends Omit<PendingAttachmentInput, "absolutePath"> {
  /** 用户通过文件选择器选中的浏览器 File 对象 */
  file: File;
}
