/**
 * 配置转发层
 *
 * ⚠️ 新代码请直接从 `../config/env` 导入。
 * 本文件仅为兼容既有引用而保留（app.ts、pages/home/home.ts 等），
 * 所有真实配置值集中在 config/env.ts，避免多处硬编码导致环境不一致。
 */

export {
  CLOUD_ENV_ID,
  IS_DEV,
  ADMIN_HTTP_BASE,
  CLOUD_FUNCTIONS,
  DISPENSE_POLL_INTERVAL,
  DISPENSE_POLL_TIMEOUT,
} from '../config/env';