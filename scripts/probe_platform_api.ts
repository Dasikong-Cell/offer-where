/**
 * 平台 API 通道自检：打印 BOSS/猎聘 的 CDP 端点、登录态（关键鉴权 Cookie）、以及
 * 逆向 Web API / 官方开放平台两条通道的开关状态。
 *
 * 运行：./node/node.exe node_modules/tsx/dist/cli.mjs scripts/probe_platform_api.ts
 * 可选：PLATFORM_WEBAPI_ENABLED=1 验证「检索通道」是否具备前置条件。
 */
import { probePlatformApi } from '../server/services/platformApi/bossOpenApi.js';

const r = await probePlatformApi();
console.log(JSON.stringify(r, null, 2));
process.exit(0);
