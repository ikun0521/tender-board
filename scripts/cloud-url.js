'use strict';
/**
 * 云端 API 地址统一配置 —— 全项目唯一来源
 *
 * 为什么有这个文件：
 *   以前函数 URL 硬编码在 8~10 个脚本里，SCF 函数一旦重建、URL 变更，
 *   就得全局搜索替换，漏一处就静默失效（2026-09-09 事故教训）。
 *   现在所有脚本统一 require 本文件，换地址只改这一行。
 *
 * 覆盖方式（便于临时切换/测试，优先级从高到低）：
 *   1. 环境变量 TENDER_API_BASE
 *   2. 下面的 DEFAULT_API_BASE
 *
 * 注意：scf-crrcgo/index.js 是部署到云端的独立包，不引用本文件，
 *       它通过 env FUNCTION_URL 取值（控制台配置），硬编码仅作兜底。
 */
const DEFAULT_API_BASE = 'https://1457331256-0xrmb7p9md.ap-guangzhou.tencentscf.com';

const API_BASE = (process.env.TENDER_API_BASE || DEFAULT_API_BASE).replace(/\/$/, '');

module.exports = { API_BASE, DEFAULT_API_BASE };
