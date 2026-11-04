#!/usr/bin/env node
/**
 * 一条命令收齐三个平台的凭据，输出一行 agent_state，贴进 Loon 就能签到。
 *
 * 最后更新：2026-11-05 01:07:46
 *
 * 单文件、零本地依赖：Trae / Qoder 的本机解密、WorkBuddy 的浏览器登录，全部内联在这一个文件里。
 * 迁移时只复制这一个文件即可（自带 shebang 和可执行位，可直接拖进终端回车）：
 *
 *   ./export-state.js          # 正常导出：每个平台拿到就打印，最后汇总 agent_state
 *   ./export-state.js --check  # 只核对取到了哪些字段 / 长度 / 过期时间，不打印凭据
 *
 * 顺序固定为 Trae → Qoder → WorkBuddy：前两个从本机客户端直接解密，不需要你动手；
 * WorkBuddy 没缓存时要你去浏览器登录，放最后，先跑完的两个平台已经把凭据打印出来了。
 *
 * agent_state 格式（一行，字段用 ; 分隔）：
 *   v=1;trae_token=…;trae_device_id=…;qoder_token=…;qoder_region=CN;wb_token=…;wb_refresh=…
 *
 * 为什么不用 JSON：粘贴长内容时会被插入空格/换行，用 ; 分隔的扁平格式可以先把所有空白删掉再解析，
 * 完全无损；JSON 里插入换行会直接解析失败。
 *
 * WorkBuddy 的 token 缓存写在「本文件所在目录/.workbuddy-tokens.json」（600 权限）；
 * 脚本换个地方放，缓存跟着走；换机器或删了缓存就要重新登录一次。
 *
 * 运行环境：系统 node（Homebrew 装的那个即可）+ macOS 自带的 security 命令。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const CHECK_ONLY = process.argv.indexOf("--check") >= 0;
const SUPPORT = path.join(os.homedir(), "Library", "Application Support");
const CACHE_FILE = path.join(__dirname, ".workbuddy-tokens.json");

/* ============================ 通用 ============================ */

function decodeJwt(token) {
  try {
    const seg = String(token).split(".")[1];
    return JSON.parse(Buffer.from(seg.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch (e) {
    return null;
  }
}

const isoSec = (sec) => (sec ? new Date(sec * 1000).toISOString().slice(0, 19).replace("T", " ") : null);

/* ============================ Trae CN ============================ */

// Trae 自研的 "tc" 信封：6 字节头 + 32 字节盐 + AES-128-CBC 密文，明文前 64 字节是 SHA-512 完整性校验
const TC_HEADER = Buffer.from([116, 99, 5, 16, 0, 0]);
const WOE = [82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251, 124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203, 84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78, 8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37];
const VOE = [31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95, 96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239, 160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97, 23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125];
const JOE = [191, 192, 216, 250, 122, 246, 220, 97, 31, 254, 98, 27, 8, 72, 71, 176, 135, 99, 96, 18, 127, 101, 203, 104, 211, 102, 191, 125, 37, 72, 150, 156, 51, 229, 121, 35, 17, 153, 141, 177, 110, 131, 150, 128, 172, 255, 254, 6, 18, 140, 55, 62, 236, 249, 135, 64, 135, 12, 117, 4, 89, 149, 168, 209];
const HOE = [246, 204, 26, 232, 232, 70, 129, 109, 223, 146, 169, 242, 23, 241, 105, 145, 50, 196, 165, 42, 254, 120, 3, 54, 244, 207, 209, 85, 53, 6, 138, 106, 175, 148, 31, 204, 186, 186, 165, 182, 87, 142, 49, 10, 39, 110, 26, 154, 86, 56, 173, 125, 18, 64, 198, 225, 99, 99, 83, 82, 191, 134, 76, 170];

const sha512 = (buf) => crypto.createHash("sha512").update(buf).digest();
const pepper = (a, b) => Buffer.from(a.map((v, i) => v ^ b[i]));

function tcDecrypt(b64) {
  if (typeof b64 !== "string" || !b64) return null;
  const raw = Buffer.from(b64.trim(), "base64");
  if (raw.length < 54 || !raw.subarray(0, 6).equals(TC_HEADER)) return null;
  const cipher = raw.subarray(38);
  for (const p of [pepper(WOE, VOE), pepper(JOE, HOE)]) {
    try {
      const key = sha512(Buffer.concat([sha512(raw.subarray(6, 38)), p]));
      const d = crypto.createDecipheriv("aes-128-cbc", key.subarray(0, 16), key.subarray(16, 32));
      const plain = Buffer.concat([d.update(cipher), d.final()]);
      if (plain.length <= 64) continue;
      const body = plain.subarray(64);
      if (!sha512(body).equals(plain.subarray(0, 64))) continue;
      return JSON.parse(body.toString("utf8"));
    } catch (e) {
      /* 换下一个 pepper 模式 */
    }
  }
  return null;
}

function readTraeAuth() {
  const names = ["Trae CN", "Trae", "TRAE SOLO CN", "TRAE SOLO"];
  let dir = null;
  for (const n of names) {
    if (fs.existsSync(path.join(SUPPORT, n, "User", "globalStorage", "storage.json"))) {
      dir = path.join(SUPPORT, n);
      break;
    }
  }
  if (!dir) return { error: "没找到 storage.json（Trae 客户端装了吗）" };

  let storage = null;
  try {
    storage = JSON.parse(fs.readFileSync(path.join(dir, "User", "globalStorage", "storage.json"), "utf8"));
  } catch (e) {
    return { error: "storage.json 解析失败" };
  }
  const auth = tcDecrypt(storage["iCubeAuthInfo://icube.cloudide"]);
  if (!auth || typeof auth.token !== "string") return { error: "storage.json 里没有可解开的登录态" };

  let deviceId = null;
  for (const key of Object.keys(storage)) {
    if (!key.startsWith("iCubeAuthInfo://icube-dc:")) continue;
    const id = key.slice("iCubeAuthInfo://icube-dc:".length);
    if (/^\d{8,}$/.test(id)) {
      deviceId = id;
      break;
    }
  }
  const payload = decodeJwt(auth.token) || {};
  return {
    dir,
    token: auth.token,
    uid: payload.data && payload.data.id ? String(payload.data.id) : "",
    exp: payload.exp ? isoSec(payload.exp) : null,
    host: auth.host || null,
    deviceId
  };
}

/* ============================ Qoder CN ============================ */

// Electron safeStorage：密钥在钥匙串，PBKDF2(password, "saltysalt", 1003) 派生 AES-128-CBC，IV 全空格
function keychainPassword(service) {
  try {
    const pwd = execFileSync("security", ["find-generic-password", "-w", "-s", service], {
      timeout: 60000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return String(pwd).trim();
  } catch (e) {
    return null;
  }
}

// 捞所有形如「X Safe Storage」且和 Qoder 有关的服务名，兜住客户端改名的版本
function discoverServices() {
  try {
    const dump = execFileSync("security", ["dump-keychain"], { timeout: 60000, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    const found = new Set();
    for (const line of dump.split("\n")) {
      const m = line.match(/"svce"<blob>="([^"]+)"/);
      if (m && /qoder/i.test(m[1]) && /storage/i.test(m[1])) found.add(m[1]);
    }
    return [...found];
  } catch (e) {
    return [];
  }
}

function decryptSafeStorage(data, password) {
  const key = crypto.pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const iv = Buffer.alloc(16, " ");
  const offsets = [];
  // 实测这个文件的前缀是 "v10 "（4 字节，带空格）；标准 Electron 是 "v10"（3 字节），两种都试
  if (data.subarray(0, 4).toString() === "v10 ") offsets.push(4);
  if (data.subarray(0, 3).toString() === "v10") offsets.push(3);
  for (const offset of offsets) {
    try {
      const d = crypto.createDecipheriv("aes-128-cbc", key, iv);
      return Buffer.concat([d.update(data.subarray(offset)), d.final()]).toString("utf8");
    } catch (e) {
      /* 试下一个 offset */
    }
  }
  return null;
}

function readQoderAuth() {
  const dir = path.join(SUPPORT, "com.qodercn.app.stable");
  const file = path.join(dir, "auth.v1.dat");
  if (!fs.existsSync(file)) return { error: "没找到 auth.v1.dat（Qoder CN 客户端装了吗）" };

  const candidates = ["Qoder CN App Safe Storage", "Qoder App Safe Storage", "Qoder Safe Storage", "QoderWork CN Safe Storage"];
  for (const extra of discoverServices()) if (candidates.indexOf(extra) < 0) candidates.push(extra);

  let password = null;
  let usedService = null;
  for (const service of candidates) {
    password = keychainPassword(service);
    if (password) {
      usedService = service;
      break;
    }
  }
  if (!password) return { error: "钥匙串里没找到 Safe Storage 密钥（试过：" + candidates.join("、") + "）" };

  const plain = decryptSafeStorage(fs.readFileSync(file), password);
  if (!plain) return { error: "auth.v1.dat 解密失败（密钥来自「" + usedService + "」）" };

  let obj = null;
  try {
    obj = JSON.parse(plain);
  } catch (e) {
    return { error: "解密结果不是 JSON" };
  }

  let machineId = null;
  try {
    machineId = fs.readFileSync(path.join(dir, "auth.machine-id"), "utf8").trim();
  } catch (e) {
    machineId = null;
  }

  const payload = decodeJwt(obj.token) || {};
  return {
    file,
    service: usedService,
    token: obj.token || "",
    exp: payload.exp ? isoSec(payload.exp) : obj.expiresAt || null,
    machineId,
    keys: Object.keys(obj)
  };
}

/* ============================ WorkBuddy ============================ */

// 客户端把本机 token 加密了（$wbEncrypted 信封），所以走「浏览器登录换明文 token」这条通路：
//   1. POST /v2/plugin/auth/state?platform=WorkBuddy   → state + 登录 URL
//   2. 浏览器打开该 URL 完成登录
//   3. 轮询 /v2/plugin/auth/token?state=…              → code 11217 表示还在等
//   4. 拿到 accessToken / refreshToken
const WB_HOST = "www.codebuddy.cn";
const WB_PLATFORM = "WorkBuddy";
const WB_UA = "CLI/2.108.1 CodeBuddy/2.108.1";
const POLL_INTERVAL_MS = 3000;
const MAX_WAIT_MS = 10 * 60 * 1000;

function wbHeaders(extra) {
  return Object.assign(
    {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": WB_UA,
      "X-Requested-With": "XMLHttpRequest",
      "X-Domain": WB_HOST,
      "X-Product": "SaaS"
    },
    extra || {}
  );
}

const WB_ANON = {
  "X-No-Authorization": "true",
  "X-No-User-Id": "true",
  "X-No-Enterprise-Id": "true",
  "X-No-Department-Info": "true"
};

async function fetchJson(url, init) {
  const res = await fetch(url, Object.assign({ signal: AbortSignal.timeout(15000) }, init));
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (e) {
    body = null;
  }
  return { res, body };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readCache() {
  try {
    const json = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    if (!json || !json.accessToken) return null;
    const payload = decodeJwt(json.accessToken) || {};
    const exp = payload.exp ? payload.exp * 1000 : json.expiresAt || 0;
    if (exp && exp - 5 * 60 * 1000 <= Date.now()) return null; // 快过期就当没有
    return json;
  } catch (e) {
    return null;
  }
}

function writeCache(data) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.chmodSync(CACHE_FILE, 0o600);
  } catch (e) {
    /* 缓存写不进去不影响主流程 */
  }
}

async function loginWorkbuddy({ log = console.log } = {}) {
  log("1) 申请登录会话…");
  const start = await fetchJson(`https://${WB_HOST}/v2/plugin/auth/state?platform=${WB_PLATFORM}`, {
    method: "POST",
    headers: wbHeaders({ "X-No-Authorization": "true", "X-No-User-Id": "true" }),
    body: "{}"
  });
  const d = start.body && start.body.data;
  if (!start.res.ok || !start.body || start.body.code !== 0 || !d || !d.state || !d.authUrl) {
    throw new Error("登录初始化失败：" + ((start.body && start.body.msg) || "HTTP " + start.res.status));
  }

  log("");
  log("2) 在浏览器里打开下面这个链接，用你的 WorkBuddy 账号登录：");
  log("");
  log("   " + d.authUrl);
  log("");
  log("   （10 分钟内有效，授权完不用回来按回车，这边会自动继续）");

  const deadline = Date.now() + MAX_WAIT_MS;
  let dots = false;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const poll = await fetchJson(`https://${WB_HOST}/v2/plugin/auth/token?state=${encodeURIComponent(d.state)}`, {
      headers: wbHeaders(WB_ANON)
    });
    const body = poll.body || {};
    if (body.code === 11217 || poll.res.status >= 500 || poll.res.status === 429) {
      if (!dots) {
        process.stdout.write("   等待授权");
        dots = true;
      }
      process.stdout.write(".");
      continue;
    }
    if (!poll.res.ok || body.code !== 0 || !body.data || !body.data.accessToken) {
      throw new Error("授权失败：" + (body.msg || "HTTP " + poll.res.status));
    }
    if (dots) process.stdout.write("\n");

    const t = body.data;
    const payload = decodeJwt(t.accessToken) || {};
    const result = {
      accessToken: t.accessToken,
      refreshToken: t.refreshToken || "",
      expiresAt: payload.exp ? payload.exp * 1000 : null,
      uid: payload.sub || null,
      name: payload.name || payload.preferred_username || null,
      obtainedAt: new Date().toISOString()
    };
    writeCache(result);
    return result;
  }
  throw new Error("等了 10 分钟没等到授权，重新跑一次吧");
}

/* ============================ 输出排版 ============================ */

// 标签都是 ASCII，按字符数补空格即可对齐；分区标题固定 60 字符宽
const KEY_WIDTH = 14;
const kv = (key, value) => "  " + (key + " ".repeat(KEY_WIDTH)).slice(0, KEY_WIDTH) + "  " + value;
const show = (name, value) => kv(name, "= " + (CHECK_ONLY ? "<len=" + String(value || "").length + ">" : value));

let firstSection = true;

function section(title) {
  const head = "=== " + title + " ";
  if (!firstSection) console.log("");
  firstSection = false;
  console.log(head + "=".repeat(Math.max(4, 60 - head.length)));
}

function note(text) {
  console.log("  ! " + text);
}

/** 两个来源的过期时间格式不同（Trae 是本地串、Qoder 是 ISO Z），统一成本地时间 */
function fmtExp(value) {
  if (!value) return "未知";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(value)) return value.slice(0, 16);
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  const pad = (n) => (n < 10 ? "0" : "") + n;
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

/* ============================ 主流程 ============================ */

async function main() {
  const fields = [];
  const failed = [];

  /* ---------------- [1/3] Trae ---------------- */
  section("[1/3] Trae CN");
  const trae = readTraeAuth();
  if (trae.error) {
    note("失败：" + trae.error);
    failed.push("Trae");
  } else {
    fields.push(["trae_token", trae.token]);
    if (trae.deviceId) fields.push(["trae_device_id", trae.deviceId]);
    console.log(kv("source", trae.dir + "/User/globalStorage/storage.json"));
    console.log(kv("uid", trae.uid || "未知"));
    console.log(kv("exp", fmtExp(trae.exp)));
    console.log(kv("device_id", trae.deviceId || "没取到（会按 uid 派生，可能被拒）"));
    console.log("");
    console.log(show("trae_token", trae.token));
    if (trae.deviceId) console.log(show("trae_device_id", trae.deviceId));
    if (!trae.deviceId) note("没取到真机设备号，签到可能被拒（code 9074）");
  }

  /* ---------------- [2/3] Qoder ---------------- */
  section("[2/3] Qoder CN");
  const qoder = readQoderAuth();
  if (qoder.error) {
    note("失败：" + qoder.error);
    failed.push("Qoder");
  } else {
    fields.push(["qoder_token", qoder.token]);
    fields.push(["qoder_region", "CN"]);
    if (qoder.machineId) fields.push(["qoder_machine_id", qoder.machineId]);
    console.log(kv("source", qoder.file));
    console.log(kv("keychain", qoder.service));
    console.log(kv("exp", fmtExp(qoder.exp)));
    console.log(kv("region", "CN"));
    if (qoder.machineId) console.log(kv("machine_id", String(qoder.machineId).slice(0, 8) + "…（CN 版可不填）"));
    console.log("");
    console.log(show("qoder_token", qoder.token));
  }

  /* ---------------- [3/3] WorkBuddy ---------------- */
  section("[3/3] WorkBuddy");
  let wb = readCache();
  if (wb) {
    console.log(kv("source", ".workbuddy-tokens.json（本地缓存）"));
  } else if (CHECK_ONLY) {
    note("跳过：没有可用缓存（--check 模式不触发登录）");
    failed.push("WorkBuddy");
  } else {
    console.log(kv("source", "浏览器登录（token 在客户端里是加密的，只能这样拿）"));
    console.log("");
    wb = await loginWorkbuddy({ log: (m) => console.log(m ? "    " + m : "") });
  }

  if (wb) {
    const payload = decodeJwt(wb.accessToken) || {};
    fields.push(["wb_token", wb.accessToken]);
    if (wb.refreshToken) fields.push(["wb_refresh", wb.refreshToken]);
    if (!wb.refreshToken) failed.push("WorkBuddy（没有 refreshToken，到期要重新登录）");
    console.log("");
    console.log(kv("account", wb.name || "未知"));
    console.log(kv("uid", wb.uid || "未知"));
    console.log(kv("exp", fmtExp(payload.exp ? payload.exp * 1000 : wb.expiresAt)));
    console.log("");
    console.log(show("wb_token", wb.accessToken));
    if (wb.refreshToken) console.log(show("wb_refresh", wb.refreshToken));
  }

  /* ---------------- 汇总 ---------------- */
  if (CHECK_ONLY) {
    console.log("");
    console.log("（--check 模式：不打印凭据、不汇总。去掉 --check 才会输出可粘贴的 agent_state）");
    if (failed.length) console.log("未取到：" + failed.join("、"));
    console.log("");
    return;
  }

  const state = ["v=1"].concat(fields.map(([k, v]) => k + "=" + v)).join(";");

  console.log("");
  console.log("---------- agent_state（" + fields.length + " 个字段） ----------");
  console.log(state);
  console.log("----------------------------------------------------------");
  console.log("");
  console.log("贴进 Loon：插件「每日签到」→ 参数 → Agent State，把上面那一行整段粘进去覆盖旧的。");
  console.log("然后等下一次 cron（默认每天 10:05）；想立刻验证就把签到时间临时改成 * * * * *。");
  console.log("");
  console.log("（这一行里含有效凭据，别贴到聊天/文档里。）");
  if (failed.length) console.log("⚠️ 未完整：" + failed.join("、"));
  console.log("");
}

main().catch((error) => {
  console.error("\n导出失败：" + ((error && error.message) || error));
  process.exit(1);
});
