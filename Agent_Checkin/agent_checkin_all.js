/**
 * Loon 定时签到 · WorkBuddy + Trae CN + Qoder（单脚本版）
 *
 * 最后更新：2026-11-05 01:07:46（与 Agent_Checkin.lpx 的 #!date 同步，每次改动两边一起改）
 * 图标：https://raw.githubusercontent.com/ZahicX/Script/main/icon/Agent_Checkin_3in1.png
 *
 * 执行顺序：Trae → Qoder → WorkBuddy（日志和通知都按这个顺序），最后合成一条通知；
 * 某个平台失败不影响另外几个。
 * 端点与鉴权口径对齐 CreditDaddy（MIT · techysy）。
 *
 * 平台一：WorkBuddy（腾讯 CodeBuddy 系）
 *   POST /v2/billing/meter/checkin-activity-status   今天签没签、连签天数
 *   POST /v2/billing/meter/daily-checkin             签到（400 + code 10001 = 今日已签）
 *   POST /v2/plugin/auth/token/refresh               凭据过期时换新
 *
 * 平台二：Trae CN
 *   POST https://api.trae.cn/trae/api/v2/ug/checkin_credits/status
 *   POST https://api.trae.cn/trae/api/v2/ug/checkin_credits/claim
 *   x-device-id 必须纯数字；code 9074 = 风控，会换派生设备号重试
 *
 * 平台三：Qoder
 *   GET  /sash/api/v1/me/campaigns?clientType=10
 *   POST /sash/api/v1/me/campaigns/{id}/claim
 *   pt- 令牌会先兑换成 job token；CN 版必须带与客户端一致的 Cosy-MachineId
 *
 * 发请求前会先校验每个 token 的形状（段数 / 非法字符位置），贴错字段能当场看出来，
 * 不用等服务端回一个看不懂的错。
 */

var PLATFORMS = ["WorkBuddy", "Trae", "Qoder"];

var WB_UA = "CLI/2.108.1 CodeBuddy/2.108.1";
var TRAE_API = "https://api.trae.cn";
var TRAE_STATUS = TRAE_API + "/trae/api/v2/ug/checkin_credits/status";
var TRAE_CLAIM = TRAE_API + "/trae/api/v2/ug/checkin_credits/claim";
var TRAE_DEFAULT_CREDITS = 100;
var QODER_CN = "https://openapi.qoder.com.cn";
var QODER_INTL = "https://openapi.qoder.sh";

var KEY = {
  wbSeed: "wb_seed",
  wbAccess: "wb_access",
  wbRefresh: "wb_refresh",
  wbExpires: "wb_expires",
  qoderMachine: "qoder_machine_id"
};

var EXPIRY_SKEW = 5 * 60 * 1000;

/* ============================== 通用 ============================== */

var ARGS = (typeof $argument === "undefined" || !$argument || typeof $argument !== "object") ? {} : $argument;

function arg(name, fallback) {
  var value = ARGS[name];
  if (value === undefined || value === null || value === "") return fallback;
  return value;
}

function flag(name, fallback) {
  var value = ARGS[name];
  if (value === undefined || value === null || value === "") return fallback;
  return value === true || value === "true" || value === 1 || value === "1";
}

/* ---------------- agent_state（一把梭状态） ---------------- */

/**
 * agent_state 格式（v1）：一行 key=value，字段之间用 ; 分隔，允许任意空白。
 *   v=1;wb_token=…;wb_refresh=…;trae_token=…;trae_device_id=…;qoder_token=…;qoder_region=CN
 *
 * 用 ; 而不是 JSON：粘贴进手机时会被插入空格/换行，这种扁平格式可以先把空白全删掉再解析，无损；
 * JSON 里插进换行会直接解析失败。万一真被贴成 JSON，也能兜住。
 */
function parseState(blob) {
  var text = String(blob || "").replace(/\s+/g, "");
  var out = {};
  if (!text) return out;

  if (text.charAt(0) === "{") {
    try {
      var json = JSON.parse(text);
      for (var key in json) {
        if (Object.prototype.hasOwnProperty.call(json, key) && typeof json[key] === "string") out[key] = json[key];
      }
      return out;
    } catch (e) {
      /* 不是合法 JSON，继续按扁平格式解 */
    }
  }

  var parts = text.split(";");
  for (var i = 0; i < parts.length; i++) {
    var item = parts[i];
    if (!item) continue;
    var eq = item.indexOf("=");
    if (eq <= 0) continue;
    out[item.slice(0, eq)] = item.slice(eq + 1);
  }
  return out;
}

var CRED = {};

/**
 * 取值只认插件参数：优先 agent_state 里那一行，其次插件里的单项参数，最后用默认值。
 * 不再读持久化，也不再回写持久化 —— 换 token 时重新导出一行贴进插件参数即可。
 */
function cred(name, fallback) {
  var value = CRED[name];
  if (value === undefined || value === null || value === "") value = arg(name, fallback);
  return value;
}

function loadCredState() {
  var blob = String(arg("agent_state", ""));
  CRED = parseState(blob);
  var names = [];
  for (var key in CRED) {
    if (Object.prototype.hasOwnProperty.call(CRED, key) && key !== "v") names.push(key);
  }
  // 字段清单按平台顺序列出（trae → qoder → wb），不受 state 里粘贴顺序影响
  var order = ["trae", "qoder", "wb"];
  var rankOf = function (name) {
    for (var i = 0; i < order.length; i++) if (name.indexOf(order[i]) === 0) return i;
    return order.length;
  };
  names.sort(function (a, b) {
    return rankOf(a) - rankOf(b) || (a < b ? -1 : a > b ? 1 : 0);
  });
  if (blob) log("参数", "来源 插件参数 agent_state（" + names.length + " 个字段：" + names.join(",") + "）");
  else log("参数", "插件参数 agent_state 是空的，回退到单项参数");
}

/**
 * 终端对齐要按「显示宽度」算，不能按字符数：中文/全角在等宽字体里占 2 格。
 * 只用于日志排版，不影响任何判定。
 */
function displayWidth(text) {
  var width = 0;
  var str = String(text || "");
  for (var i = 0; i < str.length; i++) {
    var code = str.charCodeAt(i);
    var wide = (code >= 0x1100 && code <= 0x115f) ||
      code === 0x2329 || code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
}

function padRight(text, width) {
  var pad = width - displayWidth(text);
  return pad > 0 ? text + new Array(pad + 1).join(" ") : text;
}

// [WorkBuddy] 是最长的标签，其余标签补到同样宽，后面的内容就能上下对齐
var TAG_WIDTH = displayWidth("[WorkBuddy]");
var STATUS_WIDTH = 10;

function padStatus(status) {
  return padRight(String(status || ""), STATUS_WIDTH);
}

function log(platform) {
  var parts = [];
  for (var i = 1; i < arguments.length; i++) {
    var item = arguments[i];
    parts.push(typeof item === "string" ? item : JSON.stringify(item));
  }
  console.log(padRight("[" + platform + "]", TAG_WIDTH) + " " + parts.join(" "));
}

var finished = false;
function finish() {
  if (finished) return;
  finished = true;
  $done();
}

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

/* ---------------- JWT 形状校验 ---------------- */

var JWT_CHARS = /[A-Za-z0-9\-_.]/;

/**
 * 只检查形状，不解密：
 *   segments  段数（正常 JWT 是 3）
 *   badAt     第一个非法字符的位置（-1 表示全合法），用来区分「贴了中文说明」「带引号」
 */
function shape(token) {
  var text = String(token || "");
  var badAt = -1;
  for (var i = 0; i < text.length; i++) {
    if (!JWT_CHARS.test(text.charAt(i))) {
      badAt = i;
      break;
    }
  }
  return {
    length: text.length,
    segments: text.split(".").length,
    badAt: badAt,
    badCode: badAt >= 0 ? text.charCodeAt(badAt) : 0
  };
}

/** 形状不合格时返回一句人话，合格返回 null */
function shapeProblem(name, token) {
  var s = shape(token);
  if (!s.length) return name + " 是空的";
  if (s.badAt >= 0) {
    return name + " 第 " + (s.badAt + 1) + " 个字符不是 JWT 允许的字符（charCode " + s.badCode +
      "），看起来像贴了引号、空格或说明文字，长度 " + s.length;
  }
  if (s.segments !== 3) {
    return name + " 只有 " + s.segments + " 段（JWT 应该是 3 段，用 . 分隔），可能贴错字段或被截断，长度 " + s.length;
  }
  return null;
}

/**
 * 清掉粘贴过程带进来的垃圾字符。
 *
 * 真机实测：Loon 的参数输入框在粘贴超长 token 时会插入空格（换行/缩进被转成 charCode 32），
 * 一个 1003 字符的 JWT 会变成 1233 字符、第 16 位开始带空格 —— 服务端只会回一句看不懂的
 * 「illegal base64 data」。JWT 和 base64url 里本来就不可能出现空白，所以直接全删是无损的，
 * 顺手把可能误带的前缀/引号也去掉。
 */
function cleanToken(value) {
  if (value === undefined || value === null) return "";
  var text = String(value);
  text = text.replace(/\s+/g, "");                    // 空格、换行、制表符、全角空格
  text = text.replace(/^["'`“”‘’]+/, "").replace(/["'`“”‘’]+$/, "");
  text = text.replace(/^Bearer/i, "").replace(/^Cloud-IDE-JWT/i, "");
  return text;
}

/* ---------------- base64 / JWT 解析 ---------------- */

var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64ToBytes(input) {
  var text = String(input).replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  var out = [];
  var buffer = 0;
  var bits = 0;
  for (var i = 0; i < text.length; i++) {
    var idx = B64.indexOf(text.charAt(i));
    if (idx < 0) continue;
    buffer = (buffer << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return out;
}

function utf8Decode(bytes) {
  var out = "";
  var i = 0;
  while (i < bytes.length) {
    var b = bytes[i++];
    var cp;
    if (b < 0x80) cp = b;
    else if (b >= 0xc0 && b < 0xe0) cp = ((b & 0x1f) << 6) | (bytes[i++] & 0x3f);
    else if (b >= 0xe0 && b < 0xf0) cp = ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    else cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    if (cp > 0xffff) {
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else {
      out += String.fromCharCode(cp);
    }
  }
  return out;
}

function decodeJwt(token) {
  var seg = String(token || "").split(".");
  if (seg.length < 2) return null;
  try {
    return JSON.parse(utf8Decode(base64ToBytes(seg[1])));
  } catch (e) {
    return null;
  }
}

/* ---------------- HTTP ---------------- */

function request(method, url, headers, body) {
  return new Promise(function (resolve) {
    var options = { url: url, headers: headers, timeout: 20000 };
    if (body !== undefined && body !== null) options.body = body;
    var handler = function (error, response, data) {
      var parsed = null;
      try {
        parsed = data ? JSON.parse(data) : null;
      } catch (e) {
        parsed = null;
      }
      resolve({
        error: error ? String(error) : null,
        status: response && response.status ? Number(response.status) : 0,
        body: parsed,
        text: typeof data === "string" ? data : ""
      });
    };
    if (method === "GET") $httpClient.get(options, handler);
    else $httpClient.post(options, handler);
  });
}

function randomHex(byteCount) {
  var chars = "0123456789abcdef";
  var out = "";
  for (var i = 0; i < byteCount * 2; i++) out += chars.charAt(Math.floor(Math.random() * 16));
  return out;
}

/* ============================ WorkBuddy ============================ */

function wbLoadState() {
  var argToken = cleanToken(cred("wb_token", ""));
  var argRefresh = cleanToken(cred("wb_refresh", ""));
  var seed = $persistentStore.read(KEY.wbSeed) || "";

  // 换了新 token 就丢掉旧缓存（旧 refreshToken 早被轮换，继续用只会一直失败）
  if (argToken && argToken !== seed) {
    log("WorkBuddy", "检测到新 token，重置本地凭据缓存");
    $persistentStore.write(argToken, KEY.wbSeed);
    $persistentStore.write(argToken, KEY.wbAccess);
    if (argRefresh) $persistentStore.write(argRefresh, KEY.wbRefresh);
    else $persistentStore.write(undefined, KEY.wbRefresh);
    $persistentStore.write(undefined, KEY.wbExpires);
  }

  var access = $persistentStore.read(KEY.wbAccess) || argToken;
  var refresh = $persistentStore.read(KEY.wbRefresh) || argRefresh;
  var expires = Number($persistentStore.read(KEY.wbExpires)) || 0;
  if (!expires && access) {
    var payload = decodeJwt(access);
    if (payload && payload.exp) expires = payload.exp * 1000;
  }
  return { access: access, refresh: refresh, expires: expires, retried: false };
}

function wbSaveState(state) {
  if (state.access) $persistentStore.write(state.access, KEY.wbAccess);
  if (state.refresh) $persistentStore.write(state.refresh, KEY.wbRefresh);
  if (state.expires) $persistentStore.write(String(state.expires), KEY.wbExpires);
}

function wbResolveHost(access) {
  var override = cleanToken(cred("wb_domain", ""));
  if (override) return { host: override, intl: /\.ai$|\.cc$/i.test(override) };
  var payload = decodeJwt(access);
  var iss = payload && payload.iss ? String(payload.iss).replace(/^https?:\/\//i, "").replace(/\/.*$/, "") : "";
  if (iss && /(codebuddy|workbuddy)\.ai$|workbuddy\.cc$/i.test(iss)) return { host: iss, intl: true };
  if (iss && /(codebuddy|workbuddy)\.cn$/i.test(iss)) return { host: iss, intl: false };
  if (iss === "copilot.tencent.com") return { host: "www.codebuddy.cn", intl: false };
  return { host: "www.codebuddy.cn", intl: false };
}

/**
 * 企业号（飞书 / 企业租户）的请求必须多带两个头，个人号带了也无害 —— 所以只在填了才发。
 * token 的 JWT 里没有这个字段（Keycloak claims 只有 sub/email 那些），只能从客户端配置里抄。
 */
function wbEnterpriseId() {
  return cleanToken(cred("wb_enterprise_id", ""));
}

function wbApiHeaders(token, host) {
  var payload = decodeJwt(token);
  var headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: "Bearer " + token,
    "X-User-Id": payload && typeof payload.sub === "string" ? payload.sub : "",
    "X-Domain": host,
    "X-Product": "SaaS",
    "User-Agent": WB_UA
  };
  var enterprise = wbEnterpriseId();
  if (enterprise) {
    headers["X-Enterprise-Id"] = enterprise;
    headers["X-Tenant-Id"] = enterprise;
  }
  return headers;
}

function wbRefresh(hostInfo, state) {
  var hosts = [hostInfo.host];
  if (!hostInfo.intl && hosts.indexOf("copilot.tencent.com") < 0) hosts.push("copilot.tencent.com");
  var index = 0;

  function attempt() {
    var host = hosts[index++];
    var channel = wbEnterpriseId();
    var headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": WB_UA,
      "X-Requested-With": "XMLHttpRequest",
      "X-Domain": host,
      "X-Refresh-Token": state.refresh,
      "X-Auth-Refresh-Source": "plugin",
      "X-Product": "SaaS"
    };
    if (channel) headers["X-Enterprise-Id"] = channel;
    return request("POST", "https://" + host + "/v2/plugin/auth/token/refresh", headers, "{}").then(function (res) {
      var data = res.body && res.body.data;
      if (res.status >= 200 && res.status < 300 && res.body && res.body.code === 0 && data && data.accessToken) {
        var payload = decodeJwt(data.accessToken);
        var expires = data.expiresIn ? Date.now() + Number(data.expiresIn) * 1000 : (payload && payload.exp ? payload.exp * 1000 : 0);
        return { access: data.accessToken, refresh: data.refreshToken || state.refresh, expires: expires || 0 };
      }
      var message = (res.body && (res.body.msg || res.body.message)) || (res.text || "").slice(0, 120);
      var error = new Error("刷新失败：HTTP " + res.status + " " + message);
      error.authInvalid = res.status === 401 || String(res.body && res.body.code) === "12153";
      throw error;
    }).catch(function (error) {
      if (error.authInvalid || index >= hosts.length) throw error;
      return attempt();
    });
  }

  return attempt();
}

function wbEnsureToken(hostInfo, state) {
  var expired = !state.expires || state.expires - EXPIRY_SKEW <= Date.now();
  if (!expired || !state.refresh) return Promise.resolve(state.access);
  return wbRefresh(hostInfo, state).then(function (next) {
    state.access = next.access;
    state.refresh = next.refresh;
    state.expires = next.expires;
    wbSaveState(state);
    log("WorkBuddy", "凭据已刷新");
    return state.access;
  });
}

function wbPost(hostInfo, path, state) {
  return wbEnsureToken(hostInfo, state).then(function (token) {
    return request("POST", "https://" + hostInfo.host + path, wbApiHeaders(token, hostInfo.host), "{}").then(function (res) {
      if (res.status !== 401 || state.retried || !state.refresh) return res;
      state.retried = true;
      log("WorkBuddy", "接口返回 401，换 token 后重试");
      return wbRefresh(hostInfo, state).then(function (next) {
        state.access = next.access;
        state.refresh = next.refresh;
        state.expires = next.expires;
        wbSaveState(state);
        return request("POST", "https://" + hostInfo.host + path, wbApiHeaders(state.access, hostInfo.host), "{}");
      });
    });
  });
}

var WB_ALREADY_RE = /已签到|签到过|重复签到|already|repeat/i;

function runWorkbuddy() {
  if (!flag("wb_enable", true)) {
    log("WorkBuddy", "插件里这个平台的开关是关的，跳过");
    return Promise.resolve({ name: "WorkBuddy", status: "disabled", message: "开关已关闭" });
  }

  var state = wbLoadState();
  if (!state.access && !state.refresh) {
    log("WorkBuddy", "未填写 wb_token，跳过");
    return Promise.resolve({ name: "WorkBuddy", status: "skipped", message: "未填 token" });
  }

  // 发请求前先看形状：贴错字段 / 带引号 / 被截断，在这里就能说清楚
  var problem = state.access ? shapeProblem("wb_token", state.access) : "wb_token 为空";
  if (problem) {
    log("WorkBuddy", problem);
    return Promise.resolve({ name: "WorkBuddy", status: "failed", message: problem });
  }
  if (state.refresh) {
    var refreshProblem = shapeProblem("wb_refresh", state.refresh);
    if (refreshProblem) {
      log("WorkBuddy", refreshProblem);
      // accessToken 还能用就不拦，只是过期后没法续
      state.refresh = "";
    }
  }

  var hostInfo = wbResolveHost(state.access);
  log("WorkBuddy", "API 域名 " + hostInfo.host + (hostInfo.intl ? "（国际版）" : "（国内版）"));

  return wbPost(hostInfo, "/v2/billing/meter/checkin-activity-status", state).then(function (status) {
    if (status.status === 401) {
      var hint = state.refresh
        ? "鉴权失败（401）：accessToken 被拒，且 refreshToken 也没能换到新 token"
        : "鉴权失败（401）：accessToken 被拒，且没填 wb_refresh，无法自动续期";
      return { name: "WorkBuddy", status: "failed", message: hint };
    }
    var data = status.status === 200 && status.body && status.body.code === 0 ? (status.body.data || {}) : null;
    var streak = data ? Number(data.streak_days) || 0 : 0;

    if (data && (data.today_checked_in === true || data.checked_in === true)) {
      return { name: "WorkBuddy", status: "already", message: "今日已签" + (streak ? "（连签 " + streak + " 天）" : "") };
    }

    return wbPost(hostInfo, "/v2/billing/meter/daily-checkin", state).then(function (res) {
      var code = res.body ? (res.body.code !== undefined ? res.body.code : res.body.error_code) : undefined;
      var message = (res.body && (res.body.msg || res.body.message)) || "";
      if (res.status >= 200 && res.status < 300 && (code === 0 || code === undefined)) {
        var pack = res.body && res.body.data ? res.body.data : {};
        var amount = Number(pack.credit || pack.today_credit || pack.daily_credit || (data ? data.today_credit || data.daily_credit : 0)) || 0;
        return {
          name: "WorkBuddy",
          status: "checked-in",
          message: "签到成功" + (amount ? " +" + amount + " 积分" : "") + "（连签 " + (streak + 1) + " 天）"
        };
      }
      if ((res.status === 400 || (res.status === 200 && code !== 0)) && (String(code) === "10001" || WB_ALREADY_RE.test(message))) {
        return { name: "WorkBuddy", status: "already", message: "今日已签" };
      }
      if (res.status === 404) {
        return { name: "WorkBuddy", status: "no-activity", message: hostInfo.host + " 暂无签到活动（404）" };
      }
      return {
        name: "WorkBuddy",
        status: "failed",
        message: "签到失败：HTTP " + res.status + " " + (message || (res.text || "").slice(0, 120))
      };
    });
  });
}

/* ============================== Trae ============================== */

var K256 = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

function rotr(x, n) {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

function utf8Bytes(str) {
  var out = [];
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      var c2 = str.charCodeAt(++i);
      var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return out;
}

function sha256(bytes) {
  var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  var bitLen = bytes.length * 8;
  var data = bytes.slice(0);
  data.push(0x80);
  while (data.length % 64 !== 56) data.push(0);
  var hi = Math.floor(bitLen / 4294967296);
  var lo = bitLen >>> 0;
  data.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff);
  data.push((lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff);

  var w = new Array(64);
  for (var offset = 0; offset < data.length; offset += 64) {
    for (var i = 0; i < 16; i++) {
      w[i] = ((data[offset + i * 4] << 24) | (data[offset + i * 4 + 1] << 16) | (data[offset + i * 4 + 2] << 8) | data[offset + i * 4 + 3]) >>> 0;
    }
    for (i = 16; i < 64; i++) {
      var x = w[i - 15];
      var y = w[i - 2];
      var s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
      var s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], k = h[7];
    for (i = 0; i < 64; i++) {
      var S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      var ch = ((e & f) ^ (~e & g)) >>> 0;
      var t1 = (k + S1 + ch + K256[i] + w[i]) >>> 0;
      var S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      var maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      var t2 = (S0 + maj) >>> 0;
      k = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + k) >>> 0;
  }

  var out = [];
  for (i = 0; i < 8; i++) out.push((h[i] >>> 24) & 0xff, (h[i] >>> 16) & 0xff, (h[i] >>> 8) & 0xff, h[i] & 0xff);
  return out;
}

function toHex(bytes) {
  var out = "";
  for (var i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
  return out;
}

// 与 CreditDaddy 的 seeded() 同款：sha256("<salt>:<uid>:<counter>") 拼接后取前 n 字节
function seeded(uid, salt, n) {
  var prefix = salt + ":" + uid;
  var out = [];
  for (var counter = 0; out.length < n; counter++) {
    out = out.concat(sha256(utf8Bytes(prefix + ":" + counter)));
  }
  return out.slice(0, n);
}

function uuidFrom(bytes) {
  var hex = toHex(bytes);
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20, 32);
}

function traeDevice(uid, storedDeviceId, attempt) {
  var market = seeded(uid, "market:" + attempt, 16);
  market[6] = (market[6] & 0x0f) | 0x40;
  market[8] = (market[8] & 0x3f) | 0x80;
  var sessionId = toHex(seeded(uid, "sess", 32));

  if (attempt === 0 && storedDeviceId && /^\d{8,}$/.test(String(storedDeviceId))) {
    return { deviceId: String(storedDeviceId), marketUserId: uuidFrom(market), sessionId: sessionId };
  }

  var digits = seeded(uid, "devid:" + attempt, 15);
  var deviceId = "";
  for (var i = 0; i < digits.length; i++) deviceId += String(48 + (digits[i] % 10));
  return { deviceId: deviceId, marketUserId: uuidFrom(market), sessionId: sessionId };
}

function traeHeaders(jwt, dev) {
  var token = String(jwt).indexOf("Cloud-IDE-JWT ") === 0 ? String(jwt) : "Cloud-IDE-JWT " + String(jwt).trim();
  return {
    accept: "*/*",
    "accept-language": "zh-CN",
    authorization: token,
    "content-type": "application/json",
    "user-agent": "VSCode 1.107.1 (TRAE SOLO CN)",
    "x-market-client-id": "VSCode 1.107.1",
    "x-market-user-id": dev.marketUserId,
    "x-user-region": "CN",
    "x-device-id": dev.deviceId,
    "x-lgw-req-sdk-type": "3",
    "package-type": "stable_cn",
    "x-request-id": randomHex(16),
    "x-lscbd-aid": "787976",
    // 上游按 process.platform 取值（darwin / windows / linux）。这里必须是 darwin：
    // UA 已经声明自己是桌面版 VSCode，报 ios 等于自相矛盾。
    "x-lscbd-platform": "darwin",
    "app-version": "0.1.45",
    "x-tt-trace-id": "00-" + randomHex(8) + "-01",
    "vscode-sessionid": dev.sessionId
  };
}

function traePost(url, jwt, uid, attempt) {
  return new Promise(function (resolve) {
    $httpClient.post(
      {
        url: url,
        headers: traeHeaders(jwt, traeDevice(uid, cleanToken(cred("trae_device_id", "")), attempt)),
        body: "{}",
        timeout: 20000
      },
      function (error, response, data) {
        var parsed = null;
        try {
          parsed = data ? JSON.parse(data) : null;
        } catch (e) {
          parsed = null;
        }
        var code = parsed && parsed.code !== undefined && parsed.code !== null ? Number(parsed.code) : null;
        resolve({
          error: error ? String(error) : null,
          status: response && response.status ? Number(response.status) : 0,
          body: parsed,
          code: typeof code === "number" && isFinite(code) ? code : null,
          message: String((parsed && (parsed.message || parsed.msg)) || "")
        });
      }
    );
  });
}

// checked_in / credits 可能被包在 data / result 信封里
function findField(obj, key, depth) {
  if (!obj || typeof obj !== "object" || depth > 2) return undefined;
  if (obj[key] !== undefined) return obj[key];
  var children = [obj.data, obj.result, obj.Result];
  for (var i = 0; i < children.length; i++) {
    var found = findField(children[i], key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function withCode(message, code) {
  return code !== null && code !== 0 ? message + "（code " + code + "）" : message;
}

var TRAE_ALREADY_RE = /已经签到|已签到|already.*sign/i;

function traeClaimWithRetry(jwt, uid) {
  var backoff = [0, 3000, 8000, 15000];
  function step(index) {
    return traePost(TRAE_CLAIM, jwt, uid, index).then(function (res) {
      if (res.code !== 9074 || index >= backoff.length - 1) return res;
      log("Trae", "服务端拒绝（code 9074），" + backoff[index + 1] / 1000 + "s 后换设备号重试（" + (index + 1) + "/" + (backoff.length - 1) + "）");
      return sleep(backoff[index + 1]).then(function () {
        return step(index + 1);
      });
    });
  }
  return step(0);
}

function traeFinalize(res, expectedCredits) {
  if (res.error) return { name: "Trae", status: "failed", message: "网络错误：" + res.error };
  if (res.status === 401 || res.code === 1001) {
    return {
      name: "Trae",
      status: "failed",
      message: withCode(res.message || "服务端不认这个 JWT（1001）", res.code) +
        " —— 请到 Trae 客户端重新登录，再跑 tools/export-state.js 重新导出 token"
    };
  }
  if (res.code !== null && res.code !== 0) {
    if (TRAE_ALREADY_RE.test(res.message)) return { name: "Trae", status: "already", message: "今日已签" };
    return { name: "Trae", status: "failed", message: withCode(res.message || "签到失败", res.code) };
  }
  var claimed = Number(findField(res.body, "credits")) || expectedCredits;
  return { name: "Trae", status: "checked-in", message: claimed ? "签到成功 +" + claimed + " 积分" : "签到成功" };
}

function runTrae() {
  if (!flag("trae_enable", true)) {
    log("Trae", "插件里这个平台的开关是关的，跳过");
    return Promise.resolve({ name: "Trae", status: "disabled", message: "开关已关闭" });
  }

  var jwt = cleanToken(cred("trae_token", ""));
  if (!jwt) {
    log("Trae", "未填写 trae_token，跳过");
    return Promise.resolve({ name: "Trae", status: "skipped", message: "未填 token" });
  }

  var problem = shapeProblem("trae_token", jwt);
  if (problem) {
    log("Trae", problem);
    return Promise.resolve({ name: "Trae", status: "failed", message: problem });
  }

  var payload = decodeJwt(jwt);
  var uid = payload && payload.data && payload.data.id ? String(payload.data.id) : "";
  if (!uid) {
    return Promise.resolve({ name: "Trae", status: "failed", message: "token 里没有用户 id，确认填的是 Trae 的 Cloud-IDE-JWT" });
  }
  if (payload.exp && payload.exp * 1000 < Date.now()) {
    return Promise.resolve({
      name: "Trae",
      status: "failed",
      message: "token 已于 " + new Date(payload.exp * 1000).toLocaleString() + " 过期，请重新登录后重取"
    });
  }

  var stored = cleanToken(cred("trae_device_id", ""));
  log("Trae", "uid " + uid + " · 设备号 " + (stored && /^\d{8,}$/.test(stored) ? stored + "（真机号）" : "按 uid 派生"));

  return traePost(TRAE_STATUS, jwt, uid, 0).then(function (res) {
    if (res.error) return { name: "Trae", status: "failed", message: "网络错误：" + res.error };
    if (res.status === 401 || res.code === 1001) return traeFinalize(res, 0);

    if (res.code !== null && res.code !== 0) {
      if (TRAE_ALREADY_RE.test(res.message)) return { name: "Trae", status: "already", message: "今日已签" };
      if (res.code === 9074) {
        return traeClaimWithRetry(jwt, uid).then(function (claim) {
          return traeFinalize(claim, TRAE_DEFAULT_CREDITS);
        });
      }
      return { name: "Trae", status: "failed", message: withCode(res.message || "签到失败", res.code) };
    }

    var checked = findField(res.body, "checked_in");
    if (checked === true || checked === 1) return { name: "Trae", status: "already", message: "今日已签" };

    var credits = findField(res.body, "credits");
    var expected = Number(credits !== undefined ? credits : findField(res.body, "extra_credits")) || TRAE_DEFAULT_CREDITS;
    return traeClaimWithRetry(jwt, uid).then(function (claim) {
      return traeFinalize(claim, expected);
    });
  });
}

/* ============================== Qoder ============================== */

function qoderRegion() {
  return String(cred("qoder_region", "CN")).toUpperCase() === "INTL" ? "INTL" : "CN";
}

function qoderBase() {
  return qoderRegion() === "CN" ? QODER_CN : QODER_INTL;
}

/**
 * Cosy-MachineId 必须是登录这台设备时客户端自己用的那个值（存在 auth.machine-id 里）。
 * 优先用插件参数；没填才退化成随机 UUID —— 不一致时服务端会直接 401。
 */
function qoderMachineId() {
  var override = cleanToken(cred("qoder_machine_id", ""));
  if (override) return override;
  var cached = $persistentStore.read(KEY.qoderMachine);
  if (cached) return cached;
  var hex = randomHex(16);
  var id = hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-4" + hex.slice(13, 16) + "-a" + hex.slice(17, 20) + "-" + hex.slice(20, 32);
  $persistentStore.write(id, KEY.qoderMachine);
  return id;
}

function qoderHeaders(token) {
  var headers = {
    Authorization: "Bearer " + token,
    "Cosy-ClientType": "10",
    "Cosy-Version": "0.3.3",
    // 客户端真实格式是「<arch>_<platform>」（aarch64_darwin / x86_64_win32），
    // 上游 qoderApp.machineOs() 就是拼这个。别写 ios / macos 这种简写。
    "Cosy-MachineOS": "aarch64_darwin",
    "Cosy-MachineId": qoderMachineId(),
    "User-Agent": "Qoder",
    Accept: "application/json"
  };
  var machineToken = cleanToken(cred("qoder_machine_token", ""));
  var machineCode = cleanToken(cred("qoder_machine_code", ""));
  var machineType = cleanToken(cred("qoder_machine_type", ""));
  if (machineToken) headers["Cosy-MachineToken"] = machineToken;
  if (machineCode) headers["Cosy-MachineCode"] = machineCode;
  if (machineType) headers["Cosy-MachineType"] = machineType;
  return headers;
}

function qoderJobKey() {
  return "qoder_job_" + qoderRegion().toLowerCase();
}

function qoderExchangePat(pat) {
  var key = qoderJobKey();
  var cached = $persistentStore.read(key);
  if (cached) {
    try {
      var saved = JSON.parse(cached);
      if (saved && saved.token && saved.expires && new Date(saved.expires).getTime() - 60000 > Date.now()) {
        return Promise.resolve(saved.token);
      }
    } catch (e) {
      /* 缓存坏了当没有 */
    }
  }
  var headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "qodercli/1.0.0",
    "Cosy-Version": "1.0.0",
    "Cosy-ClientType": "5"
  };
  return request("POST", qoderBase() + "/api/v1/jobToken/exchange", headers, JSON.stringify({ personal_token: pat })).then(function (res) {
    if (!res.body || !res.body.token) {
      throw new Error("PAT 兑换失败：HTTP " + res.status + " " + ((res.text || "").slice(0, 120) || "响应不是 JSON"));
    }
    $persistentStore.write(JSON.stringify({ token: res.body.token, expires: res.body.expires_at || null }), key);
    return res.body.token;
  });
}

function qoderToken() {
  var token = cleanToken(cred("qoder_token", ""));
  if (!token) return Promise.resolve(null);
  if (token.indexOf("pt-") === 0) {
    return qoderExchangePat(token).then(function (jobToken) {
      log("Qoder", "PAT 已兑换为 job token");
      return jobToken;
    });
  }
  return Promise.resolve(token);
}

function qoderCampaigns(token) {
  return request("GET", qoderBase() + "/sash/api/v1/me/campaigns?clientType=10", qoderHeaders(token), null).then(function (res) {
    if (res.error) throw new Error("网络错误：" + res.error);
    if (res.status === 401 || res.status === 403) {
      var error = new Error("鉴权失败（HTTP " + res.status + "）");
      error.auth = true;
      throw error;
    }
    if (!res.body || typeof res.body !== "object") {
      throw new Error("活动列表响应不是 JSON（HTTP " + res.status + "）");
    }
    return Array.isArray(res.body.campaigns) ? res.body.campaigns : [];
  });
}

function qoderCheckin(token) {
  return qoderCampaigns(token).then(function (list) {
    var credits = list.filter(function (item) {
      return item && item.actionType === "CLAIM_BENEFIT";
    });
    var claimable = credits.filter(function (item) {
      return item.claimStatus === "CLAIMABLE";
    });

    if (claimable.length === 0) {
      if (credits.length === 0) {
        return {
          name: "Qoder",
          status: "no-activity",
          message: qoderRegion() === "INTL" ? "当前无可领取的活动（国际版每设备每天限一次，且必须带风控头）" : "当前无可领取的活动"
        };
      }
      return { name: "Qoder", status: "already", message: "今日已签" };
    }

    var total = 0;
    var claimed = 0;
    var failures = [];

    function step(index) {
      if (index >= claimable.length) return Promise.resolve();
      var item = claimable[index];
      return request("POST", qoderBase() + "/sash/api/v1/me/campaigns/" + encodeURIComponent(item.campaignId) + "/claim", qoderHeaders(token), null)
        .then(function (res) {
          if (res.error) {
            failures.push(item.campaignId + " 网络错误");
          } else if (res.status >= 200 && res.status < 300) {
            total += Number(res.body && res.body.benefit && res.body.benefit.amount) || Number(item.benefit && item.benefit.amount) || 0;
            claimed++;
          } else {
            failures.push(item.campaignId + " HTTP " + res.status);
          }
          return step(index + 1);
        });
    }

    return step(0).then(function () {
      if (claimed > 0) {
        return {
          name: "Qoder",
          status: "checked-in",
          message: "签到成功" + (total ? " +" + total + " Credits" : "") + (failures.length ? "（" + failures.length + " 项失败）" : "")
        };
      }
      return { name: "Qoder", status: "failed", message: "领取失败：" + (failures.join("；") || "未知原因") };
    });
  });
}

function runQoder() {
  if (!flag("qoder_enable", true)) {
    log("Qoder", "插件里这个平台的开关是关的，跳过");
    return Promise.resolve({ name: "Qoder", status: "disabled", message: "开关已关闭" });
  }

  var token = cleanToken(cred("qoder_token", ""));
  if (!token) {
    log("Qoder", "未填写 qoder_token，跳过");
    return Promise.resolve({ name: "Qoder", status: "skipped", message: "未填 token" });
  }

  log("Qoder", "区域 " + qoderRegion() + " · API " + qoderBase() + " · MachineId " + (cred("qoder_machine_id", "") ? "用插件填的" : "随机生成（可能被服务端拒）"));

  return qoderToken()
    .then(function (resolved) {
      if (!resolved) throw new Error("token 不可用");
      return qoderCheckin(resolved);
    })
    .catch(function (error) {
      var message = error && error.message ? error.message : "网络错误";
      if (error && error.auth) {
        var extra = qoderRegion() === "CN"
          ? "；CN 版要求 Cosy-MachineId 与客户端一致，把 auth.machine-id 填进 qoder_machine_id 再试"
          : "；国际版还需要 Cosy-MachineToken/Code/Type（约 1 小时过期）";
        message += extra;
      }
      return { name: "Qoder", status: "failed", message: message };
    });
}

/* ============================== 主流程 ============================== */

function notifyAll(results) {
  // 开关关掉的平台既不参与统计，也不出现在通知里
  var enabled = results.filter(function (item) {
    return item.status !== "disabled";
  });

  if (!enabled.length) {
    console.log("[签到] 三个平台的开关都是关的，本次什么都没做");
    return;
  }

  var actionable = enabled.filter(function (item) {
    return item.status !== "skipped";
  });
  if (!actionable.length) {
    console.log("[签到] 没有可执行的平台（开关关闭或未填 token），本次什么都没做");
    return;
  }

  var okCount = actionable.filter(function (item) {
    return item.status === "checked-in" || item.status === "already";
  }).length;

  var lines = enabled.map(function (item) {
    return item.name + "：" + (item.status === "skipped" ? "跳过（" + item.message + "）" : item.message);
  });

  var title = okCount === actionable.length ? "签到全部完成（" + okCount + "/" + actionable.length + "）" : "签到 " + okCount + "/" + actionable.length + " 成功";
  if (flag("notify", true)) $notification.post(title, "", lines.join("\n"));

  // 日志末尾回显通知正文：Loon 会吞掉空行，用两条等宽 ASCII 分隔线框住
  var rule = "------------------------------------";
  console.log(rule);
  console.log("Loon 消息通知如下：");
  for (var i = 0; i < lines.length; i++) console.log(lines[i]);
  console.log(rule);
}

/**
 * 把插件传进来的参数报个形状（长度/段数/前 3 个字符），用来区分「参数在 Loon 里坏了」
 * 和「参数没问题、是网络出口被服务端拒了」。只露前 3 个字符，不打印凭据。
 */
function describeArg(name, value) {
  if (value === undefined || value === null || value === "") return name + "(len=0,空)";
  var raw = String(value);
  var text = cleanToken(raw);
  var removed = raw.length - text.length;
  var s = shape(text);
  return name + "(len=" + raw.length + (removed > 0 ? "→" + text.length + ",清掉" + removed + "个垃圾字符" : "") +
    ",seg=" + s.segments + (s.badAt >= 0 ? ",bad@" + (s.badAt + 1) : "") + ",start=" + text.slice(0, 3) + ")";
}

function main() {
  var results = [];

  loadCredState();
  log("参数", [
    describeArg("trae_token", cred("trae_token", "")),
    describeArg("qoder_token", cred("qoder_token", "")),
    describeArg("wb_token", cred("wb_token", "")),
    describeArg("wb_refresh", cred("wb_refresh", ""))
  ].join("  "));

  function record(result) {
    results.push(result);
    log(result.name, padStatus(result.status) + " · " + result.message);
    return result;
  }

  // 每个平台单独兜异常：某个平台炸了不能把后面的平台一起带走
  function safe(name, runner) {
    return function () {
      return runner()
        .then(record)
        .catch(function (error) {
          return record({ name: name, status: "failed", message: (error && error.message) || "未知错误" });
        });
    };
  }

  // 执行顺序固定 Trae → Qoder → WorkBuddy，日志和通知都按这个顺序出
  Promise.resolve()
    .then(safe("Trae", runTrae))
    .then(safe("Qoder", runQoder))
    .then(safe("WorkBuddy", runWorkbuddy))
    .then(function () {
      notifyAll(results);
      finish();
    })
    .catch(function (error) {
      var message = (error && error.message) || "未知错误";
      console.log("[签到] 主流程异常 " + message);
      notifyAll(results.concat([{ name: "主流程", status: "failed", message: message }]));
      finish();
    });
}

try {
  main();
} catch (error) {
  var fatal = (error && error.message) || String(error);
  console.log("[签到] 脚本异常 " + fatal);
  if (flag("notify", true)) $notification.post("签到脚本异常", "", fatal);
  finish();
}
