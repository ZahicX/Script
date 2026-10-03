/*
Date: 2026年10月2日23:54:02
Author: ZahicX
国家电网(网上国网 95598) 签到金每日签到 - Loon 脚本(支持多账户,最多 5 个) v2
接口来源:抓包记录 csc-service.sgcc.com.cn:28630(网上国网 App,签到活动 ACT20208020/H5 包 V00000419)
  - POST /osg-omgmt1042/member/m1/0103514          提交签到(进 App 积分签到页自动触发)
  - POST /osg-omgmt1042/member/c1/q104051          查询签到金总额
  - POST /osg-omgmt1042/member/c1/q022607          查询签到记录(连签天数来源)
  - POST /emss-uia-center-front/member/c9/f03      查询账号资料(昵称/脱敏手机号)
  - 请求体为国密加密结构: {"data":"...","sign":"...","skey":"...","timestamp":"..."}
      data/skey 由 App 原生层 SM2+SM4 加密生成,脚本无法构造,采用"原样复用+刷新时间戳"的重放方案:
      sign = SM3(skey + data + timestamp),timestamp 每次重新生成(公式已对多组抓包数据验证一致)
  - 响应为加密数据({"respKey","encryptData"}),本脚本内置国密解密:
      respKey = SM2 密文(C1C3C2 格式,加密的是 SM4 密钥),encryptData = SM4-ECB 密文
      SM2 私钥为客户端内置(所有安装共用),仅用于解密响应内容;非用户凭证
      解密后可读取: 今日签到金金额(data.rtnData)/签到金总额/账号昵称与脱敏手机号
  - 连签天数来自签到记录接口(q022607)的服务端数据,重放查询后按记录日期计算;
    未捕获该请求时不显示连签天数。签到被拒时若记录含今日,则判定为今日已签
  - 鉴权: 请求头 t + userid + 设备头(appguid/appguidnew/devicetokentx/province 等),
    由 http-request 捕获规则自动抓取,无需账号密码/验证码

[Script] 配置:
  # 脚本图标: https://raw.githubusercontent.com/ZahicX/Script/main/icon/sgcc.png
  # 每日 8:30 定时签到(cron),遍历所有已捕获账户依次签到,汇总为一条通知
  30 8 * * * SGCC_checkin.js, tag=国家电网签到, enabled=true
  # 自动捕获凭证:打开 App 积分签到页与「我的」页时,把鉴权头与签到/总额/记录/资料请求体存入本地,需配合 MITM(requires-body)
  http-request ^https://csc-service\.sgcc\.com\.cn:28630\/.+\/member\/ script-path=SGCC_checkin.js, timeout=10, requires-body=true, tag=国家电网凭证捕获
[MITM]
  hostname = csc-service.sgcc.com.cn
  # t(token) 失效后签到会通知提醒;重新打开 App 积分签到页即可自动重抓(实测有效期数天)
  # 持久化数据: 存于 $persistentStore(key=sgcc_accounts),多账户结构:
  #   {"accounts":[{"userid":"...","headers":{t/userid/设备头/cookie},
  #     "sign":{data,skey,path}|null,    提交签到请求
  #     "total":{data,skey,path}|null,   签到金总额查询请求
  #     "records":{data,skey,path}|null, 签到记录查询请求(连签天数来源)
  #     "user":{data,skey,path}|null,    账号资料查询请求
  #     "nickname":"...","mobileDst":"...","updatedAt":0}]}
  #   打开 App 积分签到页(签到/总额/记录请求)与「我的」页(资料请求)即自动捕获/更新;
  #   手动导入(无抓包条件/测试): 在 Loon「脚本」页新建脚本运行
  #   $persistentStore.write(JSON.stringify(<上述结构>), "sgcc_accounts") 即完成导入;
  #   在 Loon 中清除该持久化数据即可删除全部账号
*/

!(function () {
  "use strict";

  const NAME = "SGCC_checkin";

  // ==================== 配置区 ====================
  // 凭证不写在脚本里(避免分发泄露隐私),仅从 $persistentStore 读取。
  // 由 http-request 捕获规则自动写入:打开 App 积分签到页与「我的」页即可
  const MAX_ACCOUNTS = 5; // 最多支持的账户数
  const MAX_RETRY = 3; // 单账户签到失败重试次数
  const RETRY_DELAY = 3000; // 重试间隔(ms)
  // ================================================

  const BASE = "https://csc-service.sgcc.com.cn:28630";
  const SIGN_PATH = "/osg-omgmt1042/member/m1/0103514"; // 提交签到(进签到页自动触发)
  const TOTAL_PATH = "/osg-omgmt1042/member/c1/q104051"; // 签到金总额查询
  const RECORDS_PATH = "/osg-omgmt1042/member/c1/q022607"; // 签到记录查询(连签天数)
  const USER_PATH = "/emss-uia-center-front/member/c9/f03"; // 账号资料查询
  const STORE_KEY = "sgcc_accounts";
  // 需要捕获并复用的鉴权/设备头(与抓包核对)
  const AUTH_KEYS = [
    "t",
    "userid",
    "province",
    "appguid",
    "appguidnew",
    "devicetokentx",
    "devicetokentxtime",
    "wsgwtype",
    "accessmethod",
    "appcode",
    "os",
    "version",
    "ip",
    "language",
    "user-agent",
  ];

  // ==================== 存储 ====================
  const store = {
    read: (k) =>
      typeof $persistentStore !== "undefined" ? $persistentStore.read(k) : null,
    write: (v, k) =>
      typeof $persistentStore !== "undefined" ? $persistentStore.write(v, k) : null,
  };

  // 持久化结构: {"accounts":[{
  //   userid, headers:{...鉴权/设备头}, sign:{data,skey,path}|null,
  //   total:{data,skey,path}|null, user:{data,skey,path}|null,
  //   nickname, mobileDst, streak, lastSignDate("YYYY-MM-DD"), updatedAt
  // }, ...]}
  // 账户以请求头 userid 为唯一标识
  function readAccounts() {
    const raw = store.read(STORE_KEY);
    if (!raw) return [];
    try {
      const o = JSON.parse(raw);
      if (o && Array.isArray(o.accounts)) return o.accounts;
    } catch (e) {}
    return [];
  }

  function saveAccounts(accounts) {
    store.write(JSON.stringify({ accounts }), STORE_KEY);
  }

  // ==================== 工具 ====================
  // 通知中的账号展示:优先 昵称(脱敏手机号),缺失时降级为 userid 前 6 位…后 4 位脱敏
  function accountLabel(acc) {
    const id = acc.userid || "";
    const masked = id.length > 10 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id || "未知账号";
    if (acc.nickname) return acc.mobileDst ? `${acc.nickname}(${acc.mobileDst})` : acc.nickname;
    return masked;
  }

  function maskTail(s, head, tail) {
    s = String(s || "");
    return s.length > head + tail ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;
  }

  function pad2(n) {
    return n < 10 ? "0" + n : "" + n;
  }

  function dateStr(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  // 仅推送通知(不结束脚本),供需要自行控制 $done 时机的流程使用
  function push(title, subtitle, body) {
    console.log(`[${NAME}] ${title} | ${subtitle} | ${body}`);
    if (typeof $notification !== "undefined") {
      $notification.post(title, subtitle, body);
    }
  }

  function notify(title, subtitle, body) {
    push(title, subtitle, body);
    if (typeof $done !== "undefined") $done({});
  }

  // ==================== HTTP ====================
  function http(opts, cb) {
    const done = (error, response, data) => {
      if (error) return cb(error);
      cb(null, response, data);
    };
    if (typeof $httpClient.request === "function") {
      $httpClient.request(opts, done);
    } else if (opts.method === "POST" || opts.method === "post") {
      $httpClient.post(opts, done);
    } else {
      $httpClient.get(opts, done);
    }
  }

  // ==================== 请求构建 ====================
  // 重放捕获的请求:data/skey 原样复用,timestamp 刷新并重算 sign
  function buildSignBody(req) {
    const ts = String(Date.now());
    return JSON.stringify({
      data: req.data,
      sign: sm3Hex(req.skey + req.data + ts),
      skey: req.skey,
      timestamp: ts,
    });
  }

  function buildHeaders(acc) {
    const h = {
      "content-type": "application/json",
      accept: "application/json;charset=UTF-8",
      // 标记脚本自身发出的请求,避免被捕获规则二次捕获
      "x-script": NAME,
    };
    AUTH_KEYS.forEach((k) => {
      if (acc.headers && acc.headers[k] != null) h[k] = acc.headers[k];
    });
    if (acc.headers && acc.headers.cookie) h.Cookie = acc.headers.cookie;
    return h;
  }

  // 重放一条捕获的加密请求(sign/total/user 通用),回调 (err, respBody)
  function replayReq(acc, req, cb) {
    http(
      {
        url: BASE + req.path,
        method: "POST",
        headers: buildHeaders(acc),
        body: buildSignBody(req),
      },
      cb
    );
  }

  // 连签天数(来自服务端签到记录): 记录含今日则从今日回数,否则从昨日回数,中断即止
  function calcStreak(recs, todayStr) {
    if (!Array.isArray(recs) || !recs.length) return null;
    const days = new Set(
      recs.map((r) => String((r && r.signTime) || "").slice(0, 10)).filter(Boolean)
    );
    let d = new Date(`${todayStr}T00:00:00`);
    if (!days.has(dateStr(d))) d = new Date(d.getTime() - 24 * 3600 * 1000);
    let n = 0;
    while (days.has(dateStr(d))) {
      n++;
      d = new Date(d.getTime() - 24 * 3600 * 1000);
    }
    return n || null;
  }

  // ==================== 签到 ====================
  // 返回 done(err, dec): dec 为解密后的响应(decryptGateway 结果)
  function signAttempt(acc, n, done) {
    if (!acc.sign || !acc.sign.data || !acc.sign.skey) {
      return done("失败(缺少签到请求,请打开 App 积分签到页重新捕获)");
    }
    replayReq(acc, acc.sign, (err, _resp, data) => {
      if (err) {
        if (n < MAX_RETRY) {
          return setTimeout(() => signAttempt(acc, n + 1, done), RETRY_DELAY);
        }
        return done(`失败(网络错误,重试 ${MAX_RETRY} 次未成功: ${String(err).slice(0, 60)})`);
      }
      let ok = false;
      let msg = String(data || "").slice(0, 80);
      try {
        const j = JSON.parse(data);
        ok = !!j.encryptData; // 成功响应为加密数据;失败为明文错误信息
        if (!ok) msg = j.message || msg;
      } catch (e) {}
      if (ok) {
        acc.updatedAt = Date.now();
        return done(null, decryptGateway(data));
      }
      // 服务器对各类失败(含已签到/Cookie 失效)均只回"系统正忙",无法细分
      if (n < MAX_RETRY) {
        return setTimeout(() => signAttempt(acc, n + 1, done), RETRY_DELAY);
      }
      done(`失败(重试 ${MAX_RETRY} 次仍失败: ${msg})`);
    });
  }

  // 查询账号资料(c9/f03),成功回调 {nickname, mobileDst},失败回调 null
  function fetchUserInfo(acc, cb) {
    if (!acc.user || !acc.user.data || !acc.user.skey) return cb(null);
    replayReq(acc, acc.user, (err, _resp, data) => {
      if (err) return cb(null);
      const dec = decryptGateway(data);
      if (!dec.ok) return cb(null);
      try {
        const u = dec.json.data.bizrt.userInfo;
        cb({
          nickname: u.nickname || null,
          mobileDst: u.mobile_dst || null,
        });
      } catch (e) {
        cb(null);
      }
    });
  }

  // 查询签到金总额(q104051),成功回调金额数值,失败回调 null
  function fetchTotal(acc, cb) {
    if (!acc.total || !acc.total.data || !acc.total.skey) return cb(null);
    replayReq(acc, acc.total, (err, _resp, data) => {
      if (err) return cb(null);
      const dec = decryptGateway(data);
      if (!dec.ok) return cb(null);
      const v = extractRtn(dec);
      cb(typeof v === "number" || typeof v === "string" ? v : null);
    });
  }

  // 查询签到记录(q022607),成功回调记录数组,失败回调 null
  function fetchRecords(acc, cb) {
    if (!acc.records || !acc.records.data || !acc.records.skey) return cb(null);
    replayReq(acc, acc.records, (err, _resp, data) => {
      if (err) return cb(null);
      const dec = decryptGateway(data);
      if (!dec.ok) return cb(null);
      const d = dec.json.data;
      cb(Array.isArray(d) ? d : null);
    });
  }

  // ==================== 单账户完整流程 ====================
  // 签到 → 记录 → 资料 → 总额,回调 done(blockText, dataMissing)
  function signAccount(acc, done) {
    signAttempt(acc, 1, (err, dec) => {
      let result;
      let signed = false;
      if (!err) {
        signed = true;
        const amount = extractRtn(dec);
        result = amount != null ? `签到成功, ${amount} 签到金` : `签到成功`;
      } else {
        result = err;
      }
      // 签到记录(连签天数/今日已签判定,来自服务端)
      fetchRecords(acc, (recs) => {
        const today = dateStr(new Date());
        const streak = recs ? calcStreak(recs, today) : null;
        const recToday =
          recs &&
          recs.find((r) => String((r && r.signTime) || "").slice(0, 10) === today);
        if (!signed && recToday) {
          // 服务器拒绝但服务端记录含今日: 确证今日已签
          const gold = recToday.signGold != null ? recToday.signGold : extractRtn(dec);
          result = gold != null ? `今日已签, ${gold} 签到金` : `今日已签`;
        }
        if (streak != null) result += `, 连续成功 ${streak} 天`;
        // 资料(更新昵称/手机号缓存)
        fetchUserInfo(acc, (info) => {
          if (info) {
            if (info.nickname) acc.nickname = info.nickname;
            if (info.mobileDst) acc.mobileDst = info.mobileDst;
          }
          // 总额
          fetchTotal(acc, (total) => {
            if (!signed && !recs && total != null && /系统正忙/.test(result)) {
              // 记录请求未捕获/解密失败时无法确证,退回推断
              result += ",凭证有效,可能今日已签";
            }
            let block = `国网账号: ${accountLabel(acc)}\n今日签到: ${result}`;
            if (total != null) block += `\n签到金总额: ${total} 签到金`;
            const missing = total == null || !acc.user || (!info && !!acc.user);
            done(block, signed ? missing : false);
          });
        });
      });
    });
  }

  // ==================== 主流程(cron) ====================
  // 通知格式:
  //   国家电网签到金
  //   国网账号: 昵称(138*****0000)
  //   今日签到: 签到成功, 5 签到金,连续成功 3 天
  //   签到金总额: 60 签到金
  function main() {
    const accounts = readAccounts();
    if (!accounts.length) {
      return notify(
        "国家电网签到金未配置凭证",
        "",
        "请配置 http-request 捕获规则并开启 MITM,打开 App 积分签到页即可完成凭证捕获"
      );
    }
    const lines = [];
    let anyMissing = false;
    let i = 0;
    const next = () => {
      if (i >= accounts.length) {
        if (anyMissing)
          lines.push("💡 数据不全?打开 App 积分签到页与「我的」页即可自动补全总额/资料请求");
        return notify("国家电网签到金", "", lines.join("\n\n"));
      }
      const acc = accounts[i++];
      signAccount(acc, (block, missing) => {
        saveAccounts(accounts);
        if (missing) anyMissing = true;
        lines.push(block);
        next();
      });
    };
    next();
  }

  // ==================== 字节工具 ====================
  function hexToBytes(hex) {
    const out = [];
    for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.substr(i, 2), 16));
    return out;
  }

  function bytesToBigInt(bytes) {
    let v = 0n;
    for (const b of bytes) v = (v << 8n) | BigInt(b);
    return v;
  }

  function bigIntToBytes(v) {
    const out = new Array(32).fill(0);
    for (let i = 31; i >= 0; i--) {
      out[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    return out;
  }

  // UTF-8 解码(Loon 的 JS 引擎无 TextDecoder,手写以支持中文)
  function utf8Decode(bytes) {
    let out = "";
    let i = 0;
    while (i < bytes.length) {
      const b = bytes[i++];
      if (b < 0x80) out += String.fromCharCode(b);
      else if (b < 0xe0) out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i++] & 0x3f));
      else if (b < 0xf0)
        out += String.fromCharCode(
          ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f)
        );
      else {
        const cp =
          ((b & 0x07) << 18) |
          ((bytes[i++] & 0x3f) << 12) |
          ((bytes[i++] & 0x3f) << 6) |
          (bytes[i++] & 0x3f);
        const c = cp - 0x10000;
        out += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 0x3ff));
      }
    }
    return out;
  }

  // ==================== SM3 ====================
  // 国密 SM3 杂凑(实现已按标准测试向量 "abc" 与抓包实测数据双重验证)
  function sm3Bytes(input /* 字节数组 */) {
    function rotl(x, n) {
      if (!n) return x >>> 0;
      return ((x << n) | (x >>> (32 - n))) >>> 0;
    }
    function p1(x) {
      return (x ^ rotl(x, 15) ^ rotl(x, 23)) >>> 0;
    }
    const IV = [
      0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600, 0xa96f30bc, 0x163138aa,
      0xe38dee4d, 0xb0fb0e4e,
    ];
    const bytes = input.slice();
    const bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    for (let i = 7; i >= 0; i--) bytes.push((bitLen / Math.pow(2, i * 8)) & 0xff);
    let v = IV.slice();
    for (let off = 0; off < bytes.length; off += 64) {
      const w = [];
      for (let i = 0; i < 16; i++)
        w.push(
          ((bytes[off + i * 4] << 24) |
            (bytes[off + i * 4 + 1] << 16) |
            (bytes[off + i * 4 + 2] << 8) |
            bytes[off + i * 4 + 3]) >>>
            0
        );
      for (let i = 16; i < 68; i++)
        w.push(
          (
            p1(w[i - 16] ^ w[i - 9] ^ rotl(w[i - 3], 15)) ^
            rotl(w[i - 13], 7) ^
            w[i - 6]
          ) >>> 0
        );
      const w1 = [];
      for (let i = 0; i < 64; i++) w1.push((w[i] ^ w[i + 4]) >>> 0);
      let A = v[0], B = v[1], C = v[2], D = v[3],
        E = v[4], F = v[5], G = v[6], H = v[7];
      for (let i = 0; i < 64; i++) {
        const ss1 = rotl((rotl(A, 12) + E + rotl(i < 16 ? 0x79cc4519 : 0x7a879d8a, i % 32)) >>> 0, 7);
        const ss2 = (ss1 ^ rotl(A, 12)) >>> 0;
        const ff = i < 16 ? A ^ B ^ C : (A & B) | (A & C) | (B & C);
        const gg = i < 16 ? E ^ F ^ G : (E & F) | (~E & G);
        const tt1 = (ff + D + ss2 + w1[i]) >>> 0;
        const tt2 = (gg + H + ss1 + w[i]) >>> 0;
        D = C;
        C = rotl(B, 9);
        B = A;
        A = tt1;
        H = G;
        G = rotl(F, 19);
        F = E;
        E = (tt2 ^ rotl(tt2, 9) ^ rotl(tt2, 17)) >>> 0;
      }
      const nv = [A, B, C, D, E, F, G, H];
      for (let i = 0; i < 8; i++) v[i] = (v[i] ^ nv[i]) >>> 0;
    }
    return v.map((x) => ("00000000" + x.toString(16)).slice(-8)).join("");
  }

  // ASCII 字符串 → SM3 hex(签到 sign 计算用)
  function sm3Hex(str) {
    const bytes = [];
    for (let i = 0; i < str.length; i++) bytes.push(str.charCodeAt(i) & 0xff);
    return sm3Bytes(bytes);
  }

  // SM2 KDF(基于 SM3,X9.63 格式)
  function gmKdf(z /* 字节数组 */, klen) {
    let out = [];
    let ct = 1;
    while (out.length < klen) {
      const inp = z.concat([(ct >>> 24) & 0xff, (ct >>> 16) & 0xff, (ct >>> 8) & 0xff, ct & 0xff]);
      const h = sm3Bytes(inp); // 返回 hex 字符串
      for (let i = 0; i + 1 < h.length; i += 2) out.push(parseInt(h.substr(i, 2), 16));
      ct++;
    }
    return out.slice(0, klen);
  }

  // ==================== SM2 解密 ====================
  // 曲线参数(SM2 标准曲线)
  const SM2_P = 0xfffffffeffffffffffffffffffffffffffffffff00000000ffffffffffffffffn;
  const SM2_A = SM2_P - 3n;
  // 响应解密私钥: 客户端内置(所有安装共用),仅用于解密响应内容,非用户凭证
  const SM2_PRIV = 0x2b7664aca72e7adc77b8e8e441ea7baa765fa070cfcdb81d0f280a2f397a9a02n;

  function normP(v) {
    v %= SM2_P;
    return v < 0n ? v + SM2_P : v;
  }

  function modInvP(x) {
    // 模逆: x^(P-2) mod P(费马小定理,P 为素数)
    let e = SM2_P - 2n;
    let base = normP(x);
    let r = 1n;
    while (e > 0n) {
      if (e & 1n) r = (r * base) % SM2_P;
      base = (base * base) % SM2_P;
      e >>= 1n;
    }
    return r;
  }

  // 椭圆曲线点加(P/Q 为 [x,y] 的 BigInt 数组,null 表示无穷远点)
  function ecAdd(P1, Q) {
    if (!P1) return Q;
    if (!Q) return P1;
    const [x1, y1] = P1;
    const [x2, y2] = Q;
    if (x1 === x2) {
      if ((y1 + y2) % SM2_P === 0n) return null;
      const lam = ((3n * x1 * x1 + SM2_A) % SM2_P) * modInvP(2n * y1) % SM2_P;
      const x3 = normP(lam * lam - x1 - x2);
      const y3 = normP(lam * (x1 - x3) - y1);
      return [x3, y3];
    }
    const lam = normP(y2 - y1) * modInvP(normP(x2 - x1)) % SM2_P;
    const x3 = normP(lam * lam - x1 - x2);
    const y3 = normP(lam * (x1 - x3) - y1);
    return [x3, y3];
  }

  // 椭圆曲线点乘(倍加法)
  function ecMul(k, Pt) {
    let R = null;
    let P2 = Pt;
    while (k > 0n) {
      if (k & 1n) R = ecAdd(R, P2);
      P2 = ecAdd(P2, P2);
      k >>= 1n;
    }
    return R;
  }

  // SM2 解密(C1C3C2 格式, cipher 为字节数组,返回明文字节数组;校验失败返回 null)
  function sm2DecryptC1C3C2(cipher) {
    try {
      if (cipher[0] !== 4 || cipher.length < 129) return null;
      const x1 = bytesToBigInt(cipher.slice(1, 33));
      const y1 = bytesToBigInt(cipher.slice(33, 65));
      const C3 = cipher.slice(65, 97); // SM3 摘要
      const C2 = cipher.slice(97); // 密文本体
      const pt = ecMul(SM2_PRIV, [x1, y1]);
      if (!pt) return null;
      const x2b = bigIntToBytes(pt[0]);
      const y2b = bigIntToBytes(pt[1]);
      const t = gmKdf(x2b.concat(y2b), C2.length);
      const M = C2.map((c, i) => (c ^ t[i]) & 0xff);
      // C3 完整性校验: SM3(x2 || M || y2)
      const u = hexToBytes(sm3Bytes(x2b.concat(M, y2b)));
      for (let i = 0; i < 32; i++) {
        if (u[i] !== C3[i]) return null;
      }
      return M;
    } catch (e) {
      return null;
    }
  }

  // ==================== SM4 解密 ====================
  const SM4_SBOX=[0xd6,0x90,0xe9,0xfe,0xcc,0xe1,0x3d,0xb7,0x16,0xb6,0x14,0xc2,0x28,0xfb,0x2c,0x05,0x2b,0x67,0x9a,0x76,0x2a,0xbe,0x04,0xc3,0xaa,0x44,0x13,0x26,0x49,0x86,0x06,0x99,0x9c,0x42,0x50,0xf4,0x91,0xef,0x98,0x7a,0x33,0x54,0x0b,0x43,0xed,0xcf,0xac,0x62,0xe4,0xb3,0x1c,0xa9,0xc9,0x08,0xe8,0x95,0x80,0xdf,0x94,0xfa,0x75,0x8f,0x3f,0xa6,0x47,0x07,0xa7,0xfc,0xf3,0x73,0x17,0xba,0x83,0x59,0x3c,0x19,0xe6,0x85,0x4f,0xa8,0x68,0x6b,0x81,0xb2,0x71,0x64,0xda,0x8b,0xf8,0xeb,0x0f,0x4b,0x70,0x56,0x9d,0x35,0x1e,0x24,0x0e,0x5e,0x63,0x58,0xd1,0xa2,0x25,0x22,0x7c,0x3b,0x01,0x21,0x78,0x87,0xd4,0x00,0x46,0x57,0x9f,0xd3,0x27,0x52,0x4c,0x36,0x02,0xe7,0xa0,0xc4,0xc8,0x9e,0xea,0xbf,0x8a,0xd2,0x40,0xc7,0x38,0xb5,0xa3,0xf7,0xf2,0xce,0xf9,0x61,0x15,0xa1,0xe0,0xae,0x5d,0xa4,0x9b,0x34,0x1a,0x55,0xad,0x93,0x32,0x30,0xf5,0x8c,0xb1,0xe3,0x1d,0xf6,0xe2,0x2e,0x82,0x66,0xca,0x60,0xc0,0x29,0x23,0xab,0x0d,0x53,0x4e,0x6f,0xd5,0xdb,0x37,0x45,0xde,0xfd,0x8e,0x2f,0x03,0xff,0x6a,0x72,0x6d,0x6c,0x5b,0x51,0x8d,0x1b,0xaf,0x92,0xbb,0xdd,0xbc,0x7f,0x11,0xd9,0x5c,0x41,0x1f,0x10,0x5a,0xd8,0x0a,0xc1,0x31,0x88,0xa5,0xcd,0x7b,0xbd,0x2d,0x74,0xd0,0x12,0xb8,0xe5,0xb4,0xb0,0x89,0x69,0x97,0x4a,0x0c,0x96,0x77,0x7e,0x65,0xb9,0xf1,0x09,0xc5,0x6e,0xc6,0x84,0x18,0xf0,0x7d,0xec,0x3a,0xdc,0x4d,0x20,0x79,0xee,0x5f,0x3e,0xd7,0xcb,0x39,0x48];
  const SM4_CK=[0x00070e15,0x1c232a31,0x383f464d,0x545b6269,0x70777e85,0x8c939aa1,0xa8afb6bd,0xc4cbd2d9,0xe0e7eef5,0xfc030a11,0x181f262d,0x343b4249,0x50575e65,0x6c737a81,0x888f969d,0xa4abb2b9,0xc0c7ced5,0xdce3eaf1,0xf8ff060d,0x141b2229,0x30373e45,0x4c535a61,0x686f767d,0x848b9299,0xa0a7aeb5,0xbcc3cad1,0xd8dfe6ed,0xf4fb0209,0x10171e25,0x2c333a41,0x484f565d,0x646b7279];
  const SM4_FK = [0xa3b1bac6, 0x56aa3350, 0x677d9197, 0xb27022dc];

  function rotl32(x, n) {
    return ((x << n) | (x >>> (32 - n))) >>> 0;
  }

  // S 盒代换
  function sm4Tau(w) {
    return (
      (((SM4_SBOX[(w >>> 24) & 0xff] << 24) |
        (SM4_SBOX[(w >>> 16) & 0xff] << 16) |
        (SM4_SBOX[(w >>> 8) & 0xff] << 8) |
        SM4_SBOX[w & 0xff]) >>>
        0)
    );
  }

  // 轮密钥(解密用逆序)
  function sm4RoundKeys(key /*16 字节*/) {
    const mk = [];
    for (let i = 0; i < 4; i++)
      mk.push(((key[4 * i] << 24) | (key[4 * i + 1] << 16) | (key[4 * i + 2] << 8) | key[4 * i + 3]) >>> 0);
    const k = [];
    for (let i = 0; i < 4; i++) k.push((mk[i] ^ SM4_FK[i]) >>> 0);
    const rk = [];
    for (let i = 0; i < 32; i++) {
      let tmp = (k[i + 1] ^ k[i + 2] ^ k[i + 3] ^ SM4_CK[i]) >>> 0;
      tmp = sm4Tau(tmp);
      tmp = (tmp ^ rotl32(tmp, 13) ^ rotl32(tmp, 23)) >>> 0;
      k.push((k[i] ^ tmp) >>> 0);
      rk.push(k[i + 4]);
    }
    return rk.reverse();
  }

  function sm4DecryptBlock(rk, blk) {
    const x = [];
    for (let i = 0; i < 4; i++)
      x.push(((blk[4 * i] << 24) | (blk[4 * i + 1] << 16) | (blk[4 * i + 2] << 8) | blk[4 * i + 3]) >>> 0);
    for (let i = 0; i < 32; i++) {
      let tmp = (x[i + 1] ^ x[i + 2] ^ x[i + 3] ^ rk[i]) >>> 0;
      tmp = sm4Tau(tmp);
      tmp = (tmp ^ rotl32(tmp, 2) ^ rotl32(tmp, 10) ^ rotl32(tmp, 18) ^ rotl32(tmp, 24)) >>> 0;
      x.push((x[i] ^ tmp) >>> 0);
    }
    const y = [x[35], x[34], x[33], x[32]];
    const out = [];
    y.forEach((w) => out.push((w >>> 24) & 0xff, (w >>> 16) & 0xff, (w >>> 8) & 0xff, w & 0xff));
    return out;
  }

  function sm4EcbDecrypt(key, data) {
    const rk = sm4RoundKeys(key);
    const out = [];
    for (let off = 0; off + 16 <= data.length; off += 16)
      sm4DecryptBlock(rk, data.slice(off, off + 16)).forEach((b) => out.push(b));
    return out;
  }

  // 剥离 PKCS#7 填充(服务端 SM4-ECB 带填充;非法填充则原样返回)
  function pkcs7Trim(bytes) {
    if (!bytes.length) return bytes;
    const v = bytes[bytes.length - 1];
    if (v >= 1 && v <= 16 && bytes.length >= v) {
      for (let i = bytes.length - v; i < bytes.length; i++) {
        if (bytes[i] !== v) return bytes;
      }
      return bytes.slice(0, bytes.length - v);
    }
    return bytes;
  }

  // ==================== 网关响应解密 ====================
  // {"respKey","encryptData"} → 明文 JSON
  function decryptGateway(raw) {
    try {
      const j = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!j || !j.respKey || !j.encryptData) return { ok: false };
      const M = sm2DecryptC1C3C2(hexToBytes(j.respKey));
      if (!M || M.length < 16) return { ok: false };
      // SM4 密钥 = SM2 明文的前 16 字节(ASCII 形式,实测确认)
      const pt = sm4EcbDecrypt(M.slice(0, 16), hexToBytes(j.encryptData));
      const txt = utf8Decode(pkcs7Trim(pt)).replace(/\u0000+$/, "");
      return { ok: true, json: JSON.parse(txt) };
    } catch (e) {
      return { ok: false };
    }
  }

  // 解密结果里取 rtnData({code,data:{rtnCode:1,rtnData:X}})
  function extractRtn(dec) {
    const d = dec && dec.json && dec.json.data;
    if (d && typeof d === "object" && d.rtnCode === 1 && d.rtnData != null) return d.rtnData;
    if (typeof d === "number") return d;
    return null;
  }

  // ==================== 入口分流 ====================
  if (typeof $request !== "undefined") {
    // http-request 模式:捕获鉴权头 + 三类加密请求体(签到/总额/资料)
    const hdr = $request.headers || {};
    const low = {};
    for (const k in hdr) low[k.toLowerCase()] = hdr[k];
    // 脚本自身发出的请求不重复捕获
    if ((low["x-script"] || "") === NAME) {
      $done({});
      return;
    }
    const url = $request.url || "";
    const uid = low["userid"];
    if (!uid || !low["t"]) {
      $done({});
      return;
    }

    const accounts = readAccounts();
    const idx = accounts.findIndex((a) => a.userid === uid);
    const isNew = idx === -1;
    if (isNew && accounts.length >= MAX_ACCOUNTS) {
      push(
        "国家电网签到金",
        "",
        `发现新账户,但账户数已达上限(${MAX_ACCOUNTS} 个),未保存`
      );
      $done({});
      return;
    }

    const picked = {};
    AUTH_KEYS.forEach((k) => {
      if (low[k] != null) picked[k] = low[k];
    });
    const cookie = low["cookie"];
    if (cookie) picked.cookie = cookie;

    const acc = isNew ? { userid: uid, streak: 0 } : accounts[idx];
    const prevT = acc.headers && acc.headers.t;
    const prevKinds = capturedKinds(acc);
    acc.headers = picked;
    acc.updatedAt = Date.now();

    // 按路径抓对应的加密请求体(需 requires-body)
    let got = "";
    const saveReq = (key, path) => {
      try {
        const b = JSON.parse($request.body || "{}");
        if (b.data && b.skey) {
          acc[key] = { data: b.data, skey: b.skey, path };
          got = key;
        }
      } catch (e) {}
    };
    if (url.indexOf(SIGN_PATH) > -1) saveReq("sign", SIGN_PATH);
    else if (url.indexOf(TOTAL_PATH) > -1) saveReq("total", TOTAL_PATH);
    else if (url.indexOf(RECORDS_PATH) > -1) saveReq("records", RECORDS_PATH);
    else if (url.indexOf(USER_PATH) > -1) saveReq("user", USER_PATH);

    if (isNew) {
      accounts.push(acc);
      saveAccounts(accounts);
      push(
        "国家电网签到金凭证已捕获",
        `账户 ${accounts.length}/${MAX_ACCOUNTS}`,
        `国网账号: ${accountLabel(acc)}\nt: ${maskTail(low["t"], 6, 4)}\n已捕获请求: ${capturedKinds(acc).join("/") || "无"}`
      );
    } else {
      saveAccounts(accounts);
      const nowKinds = capturedKinds(acc);
      // t 未变化且没有新捕获类别时静默,避免刷屏
      if (prevT !== low["t"]) {
        push(
          "国家电网签到金凭证已更新",
          accountLabel(acc),
          `已捕获请求: ${nowKinds.join("/") || "无"}`
        );
      } else if (got && nowKinds.length > prevKinds.length) {
        push("国家电网签到金凭证已更新", accountLabel(acc), `✅ 新捕获: ${kindName(got)}请求`);
      }
    }
    $done({});
  } else {
    // cron / 手动执行模式
    main();
  }

  // 已捕获的请求类别(签到/总额/记录/资料)
  function capturedKinds(acc) {
    const kinds = [];
    if (acc.sign && acc.sign.data) kinds.push("签到");
    if (acc.total && acc.total.data) kinds.push("总额");
    if (acc.records && acc.records.data) kinds.push("记录");
    if (acc.user && acc.user.data) kinds.push("资料");
    return kinds;
  }

  function kindName(key) {
    return key === "sign" ? "签到" : key === "total" ? "总额" : key === "records" ? "记录" : "资料";
  }
})();
