#!/usr/bin/env node

/**
 * CDN 节点链接自动更新脚本
 *
 * 功能：
 * 1. 检测 nodes.json 中所有下载链接的可用性
 * 2. 自动替换失效链接（定时从互联网cdn节点中拉取有效链接更新到备用池,然后再从备用池选取同CDN的替代失效链接资源）
 * 3. 输出检测报告
 *
 * 用法：
 * node scripts/update-cdn-nodes.mjs              # 检测并修复
 * node scripts/update-cdn-nodes.mjs --check-only # 仅检测，不修改
 * node scripts/update-cdn-nodes.mjs --verbose    # 详细输出
 *
 * 定时任务（crontab -e）：
 * 0 3 * * * cd /path/to/NetworkPanel-cdn && node scripts/update-cdn-nodes.mjs >> /var/log/cdn-update.log 2>&1
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const NODES_JSON_PATH = path.join(PROJECT_ROOT, 'src', 'assets', 'nodes.json');
const BACKUP_POOL_PATH = path.join(PROJECT_ROOT, 'scripts', '.cdn-backup-pool.json');

// ============================================================
//  参数解析
// ============================================================

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check-only');
const VERBOSE = args.includes('--verbose');

function log(...a) { console.log(`[${new Date().toISOString()}]`, ...a); }
function vlog(...a) { if (VERBOSE) console.log(`[${new Date().toISOString()}] [V]`, ...a); }

// ============================================================
//  CDN 域名分组 — 用于匹配失效链接的替代来源
// ============================================================

const CDN_DOMAIN_GROUPS = {
  '和彩云CDN': [
    'mcloud.139.com',
  ],
  '天翼云CDN': [
    'ctyun.cn',
  ],
  'Speedo云CDN': [
    // 字节系
    'bytegoofy.com', 'bytedance.com', 'byteimg.com', 'vlabstatic.com',
    'toutiao.com', 'douyin.com', 'byted-static.com',
    // 七牛
    'qiniu.com', 'qnssl.com', 'qbox.me',
    // 阿里
    'alipay.com', 'alicdn.com', 'aliyun.com',
    // 新浪
    'sina.cn', 'sinaimg.cn', 'weibo.com', 'sina.com',
    // 网易
    'ws.126.net', '126.net', 'netease.com', 'nosdn.126.net',
    // 拼多多
    'pddpic.com',
    // 其它
    'aixifan.com', 'vivo.com.cn', 'jd.com', 'up366.cn',
    'ljcdn.com', 'ifeng.com',
  ],
  '360云CDN': [
    '360tpcdn.com', 'sogou.com', 'qq.com', 'cntv.cn',
    'dldir1.qq.com', 'gtimg.cn',
  ],
  '腾讯云CDN': [
    // 腾讯云测速节点走内部代理，不参与外部替换
  ],
};

// ============================================================
//  网络工具
// ============================================================

const FETCH_TIMEOUT = 15_000;   // 15s 超时
const CONCURRENCY = 6;          // 并发数

async function fetchWithTimeout(url, opts = {}, timeoutMs = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...opts, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 检测单个 URL 是否可用
 * @returns {{ ok: boolean, status: number, latencyMs: number, error?: string }}
 */
async function checkUrl(url) {
  // 内部代理路径跳过检测
  if (url.startsWith('/cdn-proxy/') || url.startsWith('/cors-proxy')) {
    // 对 cors-proxy 提取真实 URL 检测
    if (url.startsWith('/cors-proxy')) {
      try {
        const u = new URL(url, 'http://localhost');
        const real = u.searchParams.get('url');
        if (real) return await checkDirectUrl(real);
      } catch { /* ignore */ }
    }
    // 代理路径视为有效（无法从外部直接验证）
    return { ok: true, status: 0, latencyMs: 0, note: 'internal-proxy' };
  }
  return await checkDirectUrl(url);
}

async function checkDirectUrl(url) {
  const start = Date.now();
  try {
    const resp = await fetchWithTimeout(url, { method: 'HEAD' }, FETCH_TIMEOUT);
    const latencyMs = Date.now() - start;
    const ok = resp.status >= 200 && resp.status < 400;
    return { ok, status: resp.status, latencyMs };
  } catch (err) {
    // HEAD 可能被拒绝，尝试 GET（仅读前 1 字节）
    try {
      const resp = await fetchWithTimeout(url, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
      }, FETCH_TIMEOUT);
      const latencyMs = Date.now() - start;
      const ok = resp.status >= 200 && resp.status < 400;
      return { ok, status: resp.status, latencyMs };
    } catch (err2) {
      return {
        ok: false,
        status: 0,
        latencyMs: Date.now() - start,
        error: err2.name === 'AbortError' ? 'timeout' : err2.message,
      };
    }
  }
}

/**
 * 并发批量检测
 */
async function checkUrls(urls) {
  const results = new Map();
  const queue = [...urls];
  const workers = Array.from({ length: Math.min(CONCURRENCY, urls.length) }, async () => {
    while (queue.length) {
      const url = queue.shift();
      if (results.has(url)) continue;
      const result = await checkUrl(url);
      results.set(url, result);
      vlog(`  ${result.ok ? '✅' : '❌'} [${result.status}] ${result.latencyMs}ms ${url}`);
    }
  });
  await Promise.all(workers);
  return results;
}

// ============================================================
//  备用池管理
// ============================================================

/**
 * 从已知大厂CDN下载源发现可用URL
 * 这些是公开的、长期稳定的CDN下载链接
 */
const KNOWN_CDN_SOURCES = {
  'Speedo云CDN': [
    // 字节系
    'https://lf3-cdn-tos.bytegoofy.com/obj/douyin-pc-client/7044145585217083655/releases/8293088/1.0.8/win32-ia32/douyin-v1.0.8-win32-ia32-douyin.exe',
    'https://lf6-cdn-tos.bytegoofy.com/obj/douyin-pc-client/7044145585217083655/releases/8293088/1.0.8/win32-ia32/douyin-v1.0.8-win32-ia32-douyin.exe',
    'https://lf3-package.vlabstatic.com/obj/faceu-packages/Jianying_split_4_8_0_10791_jianyingpro_0.exe',
    'https://lf6-package.vlabstatic.com/obj/faceu-packages/Jianying_split_4_8_0_10791_jianyingpro_0.exe',
    'https://lf9-package.vlabstatic.com/obj/faceu-packages/Jianying_split_4_8_0_10791_jianyingpro_0.exe',
    // 七牛
    'https://devtools.qiniu.com/linux/amd64/qrsctl',
    // 阿里
    'https://gw.alipayobjects.com/os/volans-demo/93211a67-0eed-40ff-8a48-f6c137a88781/MiniProgramStudio-3.1.3.exe',
    // 新浪
    'https://downapp.sina.cn/m/06/sinaNews_8.27.0_1719288606_4386_3538_armeabi-v7a.apk',
    'https://i1.sinaimg.cn/edu/sinaopen/SinaOpencourse_V2.02.apk',
    'https://statics.itc.cn/lt-app/sohumobile_official_gray_optimizeRelease_4_1.0.3_01161850.apk',
    // 网易
    'https://open-image.ws.126.net/android_phone_release-sp_open-v9.9.9-v0a5b3c1dc0df472bb2fb057d0a5426c3.apk',
    'https://open-image.ws.126.net/android_phone_release-sp_open-v9.10.1-vb7b79d6b531448baaca3a81e7fbdc13f.apk',
    'https://uu.gdl.netease.com/4112/UU-4.68.1.exe',
    // 拼多多
    'https://cd.pddpic.com/android_dev/2023-11-08/a35eaee8e1f9f018cc40ace12931f7a2.apk',
    'https://cd.pddpic.com/android_dev/2024-06-26/06027b4121edcd1f106d992128a7124b.apk',
    'https://cd.pddpic.com/volantis-open/volantis-common/app/com.xunmeng.workBench/Release_1834716.exe',
    // 其它
    'https://cdn.aixifan.com/downloads/AcfunLive-Setup-1.9.0.200-ReleaseX64_6d5c40.exe',
    'https://wwwstatic.vivo.com.cn/vivoportal/files/download/app/20231026/350bda07c8a0719919bcadbf5aea3538.apk',
    'https://cdn-ws.up366.cn/cn/files/setup/C72C242ED8400001EE2178A912E01146/2022/06/21/4dca83b3e1c461e070f75d2b485e75e7/up366-5.6.6.0.exe',
    'https://file.ljcdn.com/saas-pkg/asaas-new/new_asaas_4.0.56_win_prod.zip',
    'https://video19.ifeng.com/video09/2022/07/06/p6950362006465552946-102-162611.mp4',
    'https://download.jr.jd.com/downapp/jrapp_jr9631.apk',
  ],
  '360云CDN': [
    'https://cdn.qq.ime.sogou.com/QQPinyin_Setup_6.6.6304.400.exe',
    'http://softdlc.360tpcdn.com/auto/20201130/2000000064_f07aefc3d918ebdafa9418f3f5ef5f9c.exe',
    'https://dldir1.qq.com/qqtv/TencentVideo11.99.8523.0.exe',
    'http://softdlc.360tpcdn.com/auto/20201127/23_21ed487ededbbb428b2a7dcecc969c7c.exe',
    'https://download.cntv.cn/cbox/v6/ysyy_v6.0.3.3_1001_setup_x64.exe',
    'http://softdlc.360tpcdn.com/auto/20201127/100101123_879baf4f2d9d14f191be2443e16504af.exe',
    'http://bigsoftdlc.360tpcdn.com/auto/20200826/104511_999095167454c21f770b31e8f080ebb7.exe',
    'http://bigsoftdlc.360tpcdn.com/auto/20210401/103779382_99dafefbd4193095a95fa713348fe6e7.exe',
    'http://bigsoftdlc.360tpcdn.com/auto/20201125/105005364_74cbde2c220e12dbd49b2c86e0ab2c6f.exe',
  ],
  '和彩云CDN': [
    'https://img.mcloud.139.com/material_prod/material_media/20221128/1669626861087.png',
  ],
  '天翼云CDN': [
    'https://desk.ctyun.cn:8999/desktop-prod/software/windows_tob_client/15/64/202030001/CtyunClouddeskUniversal_2.3.0_202030001_x86_20240327104015_Setup.exe',
  ],
};

/**
 * 从公共 API / 已知列表发现更多可用的 CDN 下载链接
 */
async function discoverNewUrls(cdnName) {
  // 从 GitHub 上的公共 CDN 测速列表拉取
  const discoverySources = [
    // 常见公共测速文件列表
    'https://raw.githubusercontent.com/oneclickvirt/speedtest_cn/main/speedtest_urls.json',
    'https://raw.githubusercontent.com/xianshannan/speedtest/main/urls.json',
  ];

  const discovered = [];

  for (const sourceUrl of discoverySources) {
    try {
      const resp = await fetchWithTimeout(sourceUrl, {}, 10_000);
      if (!resp.ok) continue;
      const data = await resp.json();
      // 尝试解析各种格式
      const urls = Array.isArray(data) ? data :
        typeof data === 'object' ? Object.values(data).flat() : [];
      for (const item of urls) {
        const url = typeof item === 'string' ? item : item?.url || item?.downloadUrl;
        if (url && typeof url === 'string' && url.startsWith('http')) {
          discovered.push(url);
        }
      }
    } catch {
      vlog(`  发现源不可用: ${sourceUrl}`);
    }
  }

  return discovered;
}

function loadBackupPool() {
  try {
    if (fs.existsSync(BACKUP_POOL_PATH)) {
      return JSON.parse(fs.readFileSync(BACKUP_POOL_PATH, 'utf-8'));
    }
  } catch { /* ignore */ }
  return {};
}

function saveBackupPool(pool) {
  fs.writeFileSync(BACKUP_POOL_PATH, JSON.stringify(pool, null, 2), 'utf-8');
}

/**
 * 判断 URL 属于哪个 CDN 组
 */
function matchCdnGroup(url) {
  for (const [group, domains] of Object.entries(CDN_DOMAIN_GROUPS)) {
    for (const domain of domains) {
      if (url.includes(domain)) return group;
    }
  }
  return null;
}

/**
 * 从 url 中提取真实目标（处理 /cors-proxy?url= 编码）
 */
function extractRealUrl(url) {
  if (url.startsWith('/cors-proxy?url=')) {
    try {
      return decodeURIComponent(url.replace('/cors-proxy?url=', ''));
    } catch { return url; }
  }
  return url;
}

/**
 * 将真实 URL 包装回 /cors-proxy 格式
 */
function wrapCorsProxy(realUrl) {
  return `/cors-proxy?url=${encodeURIComponent(realUrl)}`;
}

/**
 * 为失效链接寻找同 CDN 的替代
 * 保持 URL 格式一致性：直接 URL 替直接 URL，cors-proxy 替 cors-proxy
 * @param {boolean} forceDirect - 强制返回直接 URL（用于简单节点替换）
 */
function findReplacement(deadUrl, cdnGroup, backupPool, existingUrls, forceDirect = false) {
  const realDead = extractRealUrl(deadUrl);
  const deadDomain = (() => {
    try { return new URL(realDead).hostname; } catch { return ''; }
  })();
  const isWrapped = deadUrl.startsWith('/cors-proxy') && !forceDirect;

  // 备用池中所有候选（解包后去重）
  const pool = backupPool[cdnGroup] || [];
  // 生成候选列表：如果是 forceDirect，用解包后的 URL；否则用原始格式
  const candidateList = pool.map(c => ({
    original: c,
    real: extractRealUrl(c),
    display: forceDirect ? extractRealUrl(c) : c,
  }));

  // 从备用池中找同组、不同域名的可用链接
  const candidates = candidateList.filter(({ display, real }) => {
    // 排除已有链接
    if (existingUrls.has(display) || existingUrls.has(real)) return false;
    try {
      const host = new URL(real).hostname;
      return host !== deadDomain;
    } catch { return false; }
  });

  if (candidates.length > 0) {
    const picked = candidates[Math.floor(Math.random() * candidates.length)];
    return picked.display;
  }

  // 退而求其次：同域名也行
  const sameDomain = candidateList.filter(({ display, real }) => {
    return !existingUrls.has(display) && !existingUrls.has(real);
  });

  return sameDomain.length > 0 ? sameDomain[0].display : null;
}

// ============================================================
//  主流程
// ============================================================

async function main() {
  log('=== CDN 节点链接自动更新脚本 ===');
  log(`模式: ${CHECK_ONLY ? '仅检测' : '检测并修复'}`);

  // 1. 读取 nodes.json
  if (!fs.existsSync(NODES_JSON_PATH)) {
    log(`❌ 未找到 nodes.json: ${NODES_JSON_PATH}`);
    process.exit(1);
  }

  const nodes = JSON.parse(fs.readFileSync(NODES_JSON_PATH, 'utf-8'));
  log(`📦 加载 nodes.json，共 ${Object.keys(nodes).length} 个分组`);

  // 2. 加载备用池
  const backupPool = loadBackupPool();

  // 3. 收集所有待检测的 URL
  const allUrls = [];
  const urlMeta = []; // { group, nodeName, url, type: 'download'|'upload'|'ping' }

  for (const [groupName, group] of Object.entries(nodes)) {
    if (typeof group !== 'object' || group === null) continue;

    // 分组本身就是 CDN 配置
    if ('downloadUrls' in group) {
      for (const url of group.downloadUrls || []) {
        allUrls.push(url);
        urlMeta.push({ group: groupName, nodeName: groupName, url, type: 'download' });
      }
      continue;
    }

    // 分组包含多个节点
    for (const [nodeName, val] of Object.entries(group)) {
      if (typeof val === 'object' && val !== null && 'downloadUrls' in val) {
        for (const url of val.downloadUrls || []) {
          allUrls.push(url);
          urlMeta.push({ group: groupName, nodeName, url, type: 'download' });
        }
      } else if (typeof val === 'string') {
        allUrls.push(val);
        urlMeta.push({ group: groupName, nodeName, url: val, type: 'simple' });
      }
    }
  }

  log(`🔗 共 ${allUrls.length} 个链接待检测`);

  // 4. 批量检测
  const results = await checkUrls(allUrls);

  // 5. 汇总结果
  const dead = [];
  const alive = [];
  const report = { total: allUrls.length, alive: 0, dead: 0, skipped: 0, replaced: 0, details: [] };

  for (const meta of urlMeta) {
    const result = results.get(meta.url);
    if (!result) continue;

    const entry = { ...meta, ...result };

    if (result.note === 'internal-proxy') {
      report.skipped++;
      vlog(`⏭ 跳过内部代理: ${meta.url}`);
    } else if (result.ok) {
      report.alive++;
      alive.push(entry);
    } else {
      report.dead++;
      dead.push(entry);
      log(`❌ 失效 [${meta.group} > ${meta.nodeName}]: ${meta.url} (${result.error || result.status})`);
    }
    report.details.push(entry);
  }

  log(`\n📊 检测报告:`);
  log(`  总计: ${report.total}`);
  log(`  ✅ 可用: ${report.alive}`);
  log(`  ❌ 失效: ${report.dead}`);
  log(`  ⏭ 跳过(内部代理): ${report.skipped}`);

  // 6. 更新备用池
  log('\n🔄 更新备用池...');

  // 将所有已知可用的 URL 加入备用池
  for (const entry of alive) {
    const cdnGroup = matchCdnGroup(extractRealUrl(entry.url));
    if (!cdnGroup) continue;
    if (!backupPool[cdnGroup]) backupPool[cdnGroup] = [];
    if (!backupPool[cdnGroup].includes(entry.url)) {
      backupPool[cdnGroup].push(entry.url);
    }
  }

  // 合并静态已知源
  for (const [group, urls] of Object.entries(KNOWN_CDN_SOURCES)) {
    if (!backupPool[group]) backupPool[group] = [];
    for (const url of urls) {
      const wrapped = wrapCorsProxy(url);
      if (!backupPool[group].includes(url) && !backupPool[group].includes(wrapped)) {
        backupPool[group].push(wrapped);
      }
    }
  }

  // 尝试从互联网发现新链接
  log('🌐 尝试从互联网发现新 CDN 链接...');
  for (const cdnGroup of Object.keys(CDN_DOMAIN_GROUPS)) {
    if (cdnGroup === '腾讯云CDN') continue; // 内部代理，跳过
    try {
      const discovered = await discoverNewUrls(cdnGroup);
      if (discovered.length > 0) {
        if (!backupPool[cdnGroup]) backupPool[cdnGroup] = [];
        let added = 0;
        for (const url of discovered) {
          const wrapped = wrapCorsProxy(url);
          if (!backupPool[cdnGroup].includes(url) && !backupPool[cdnGroup].includes(wrapped)) {
            backupPool[cdnGroup].push(wrapped);
            added++;
          }
        }
        if (added > 0) log(`  📥 ${cdnGroup}: 新增 ${added} 个候选链接`);
      }
    } catch {
      vlog(`  发现过程出错: ${cdnGroup}`);
    }
  }

  // 验证备用池中的链接可用性
  log('🔍 验证备用池链接...');
  for (const [group, urls] of Object.entries(backupPool)) {
    const toCheck = urls.map(u => extractRealUrl(u));
    const poolResults = await checkUrls([...new Set(toCheck)]);
    const valid = [];
    for (const url of urls) {
      const real = extractRealUrl(url);
      const r = poolResults.get(real);
      if (r && r.ok) valid.push(url);
    }
    const removed = urls.length - valid.length;
    backupPool[group] = valid;
    if (removed > 0) vlog(`  ${group}: 移除 ${removed} 个失效备用链接`);
  }

  saveBackupPool(backupPool);
  log('💾 备用池已更新');

  // 7. 替换失效链接
  if (dead.length > 0 && !CHECK_ONLY) {
    log('\n🔧 开始替换失效链接...');

    for (const entry of dead) {
      const cdnGroup = matchCdnGroup(extractRealUrl(entry.url));
      if (!cdnGroup) {
        log(`  ⚠ 无法匹配 CDN 组: ${entry.url}`);
        continue;
      }

      // 收集当前已有 URL（避免重复）
      const existingUrls = new Set();
      const nodeData = nodes[entry.group];
      if (typeof nodeData === 'object') {
        if ('downloadUrls' in nodeData) {
          nodeData.downloadUrls.forEach(u => existingUrls.add(u));
        } else {
          const subNode = nodeData[entry.nodeName];
          if (typeof subNode === 'object' && subNode.downloadUrls) {
            subNode.downloadUrls.forEach(u => existingUrls.add(u));
          }
        }
      }

      // 简单节点强制返回直接URL
      const isSimpleNode = entry.type === 'simple';
      const replacement = findReplacement(entry.url, cdnGroup, backupPool, existingUrls, isSimpleNode);

      if (replacement) {
        // 在 nodes.json 中替换
        const nodeData = nodes[entry.group];
        if (typeof nodeData === 'object') {
          if ('downloadUrls' in nodeData) {
            const idx = nodeData.downloadUrls.indexOf(entry.url);
            if (idx !== -1) {
              nodeData.downloadUrls[idx] = replacement;
              report.replaced++;
              log(`  ✅ 替换 [${entry.nodeName}]: ${extractRealUrl(entry.url).substring(0, 60)}... → ${extractRealUrl(replacement).substring(0, 60)}...`);
            }
          } else {
            const subNode = nodeData[entry.nodeName];
            if (typeof subNode === 'object' && subNode.downloadUrls) {
              const idx = subNode.downloadUrls.indexOf(entry.url);
              if (idx !== -1) {
                subNode.downloadUrls[idx] = replacement;
                report.replaced++;
                log(`  ✅ 替换 [${entry.nodeName}]: ${extractRealUrl(entry.url).substring(0, 60)}... → ${extractRealUrl(replacement).substring(0, 60)}...`);
              }
            } else if (typeof subNode === 'string' && subNode === entry.url) {
              // 简单节点：保持格式一致，如果原值是直接URL则解包 cors-proxy
              let finalReplacement = replacement;
              if (!entry.url.startsWith('/cors-proxy') && replacement.startsWith('/cors-proxy')) {
                finalReplacement = extractRealUrl(replacement);
              }
              nodeData[entry.nodeName] = finalReplacement;
              report.replaced++;
              log(`  ✅ 替换 [${entry.nodeName}]: ${entry.url.substring(0, 60)}... → ${finalReplacement.substring(0, 60)}...`);
            }
          }
        }
      } else {
        log(`  ⚠ 无可用替代 [${entry.nodeName}]: ${entry.url}`);
      }
    }

    // 写回 nodes.json
    if (report.replaced > 0) {
      fs.writeFileSync(NODES_JSON_PATH, JSON.stringify(nodes, null, 2) + '\n', 'utf-8');
      log(`\n💾 nodes.json 已更新，共替换 ${report.replaced} 个链接`);
    }
  } else if (dead.length > 0 && CHECK_ONLY) {
    log(`\n⚠ 检测到 ${dead.length} 个失效链接（--check-only 模式，不修改）`);
  }

  // 8. 最终报告
  log('\n========================================');
  log('📋 最终报告');
  log('========================================');
  log(`  总链接数: ${report.total}`);
  log(`  ✅ 可用:   ${report.alive}`);
  log(`  ❌ 失效:   ${report.dead}`);
  log(`  ⏭ 跳过:   ${report.skipped}`);
  log(`  🔄 替换:   ${report.replaced}`);
  log(`  📦 备用池: ${Object.values(backupPool).reduce((s, a) => s + a.length, 0)} 个候选链接`);
  log('========================================\n');

  // 输出 JSON 报告（便于自动化处理）
  const reportPath = path.join(PROJECT_ROOT, 'scripts', '.last-report.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    ...report,
    backupPoolSize: Object.fromEntries(
      Object.entries(backupPool).map(([k, v]) => [k, v.length])
    ),
  }, null, 2), 'utf-8');

  if (report.dead > 0 && report.replaced < report.dead) {
    log('⚠ 部分失效链接无法自动替换，请手动检查');
    process.exit(1);
  }

  log('✅ 完成');
}

main().catch(err => {
  log('❌ 致命错误:', err.message);
  process.exit(1);
});
