// 权限门槛的「拒绝路径」探针。
//
// 作用：真宿主验证只能覆盖当前会话的档位（本机是 danger-full-access），
// 因此「低于该档位会不会被拒」必须在这里用假服务补齐，否则一个恒放行的
// 门槛在真机测试里看起来也完全一样。
//
// 运行：node test/gate-deny.probe.mjs
import { apply } from '../index.js';

function makeCtx(presetName, sandbox) {
  const tools = new Map();
  const services = {
    webApp: { getAdvertisedUrl: () => 'http://127.0.0.1:12345' },
    connection: { authenticatedUrl: (o) => `${o}/?token=` + 'X'.repeat(43) },
    permissionPresets: {
      current: () => presetName,
      resolve: () => ({ sandbox }),
    },
  };
  return {
    get: (k) => services[k],
    logger: { warn() {} },
    tools: { register: (def) => { tools.set(def.name, def); return () => {}; } },
    toolsMap: tools,
  };
}

const session = { id: 'session-test' };
const execution = { agent: { session }, signal: new AbortController().signal };

for (const [preset, sandbox, label] of [
  ['danger-full-access', 'danger-full-access', '应放行'],
  ['workspace-write', 'workspace-write', '应拒绝'],
  ['read-only', 'read-only', '应拒绝'],
  ['custom', undefined, '应拒绝（custom 无 sandbox）'],
]) {
  const ctx = makeCtx(preset, sandbox);
  apply(ctx);
  const tool = ctx.toolsMap.get('dsh_web_url');
  const r = await tool.execute({ includeToken: true }, execution);
  const leaked = JSON.stringify(r).includes('X'.repeat(43));
  console.log(
    label.padEnd(18),
    'ok=' + r.ok,
    '| tokenIncluded=' + r.tokenIncluded,
    '| code=' + (r.error?.code ?? '-'),
    '| 明文泄露=' + leaked,
  );
  if (r.error) console.log('   reason:', r.error.message.slice(0, 90));
}
