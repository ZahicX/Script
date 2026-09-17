/*
Date: 2026年9月18日01:52:30
Author: ZahicX
徕芬 Laifen App 每日签到 - Loon 脚本(支持多账户,最多 5 个)
接口来源:抓包记录 mall-gw.laifen.net
  - GET  /mall_marketing/sc/activity/sign/current  查询签到活动(含 activityId、当月日历)
  - POST /mall_marketing/sc/activity/sign/do       执行签到 body {"activityId":3}
  - GET  /mall_user/user/ma/user_detail_info       查询用户信息(昵称)
  - GET  /mall_user/sc/member/info                 查询会员信息(data.availablePoint 总积分)

[Script] 配置:
  # 脚本图标: https://raw.githubusercontent.com/ZahicX/Script/main/icon/laifen.png
  # (在 Loon 脚本配置中加 img-url=https://raw.githubusercontent.com/ZahicX/Script/main/icon/laifen.png 即可显示)
  # 每日 9:00 定时签到(cron),遍历所有已捕获账户依次签到,汇总为一条通知
  0 9 * * * laifen_checkin.js, tag=徕芬签到, enabled=true
  # 自动捕获 token:打开 App 签到页时把最新 authorization 存入本地,需配合 MITM
  # 捕获结果写入 $persistentStore(key=laifen_token),cron 签到时从此读取
  # 多账户:App 里切换到哪个账号打开签到页,就捕获/更新哪个账号(按 userId 识别账户,token 续期自动替换,最多 5 个)
  http-request ^https://mall-gw\.laifen\.net/mall_marketing/sc/activity/sign/current script-path=https://raw.githubusercontent.com/ZahicX/Script/main/Laifen/laifen_checkin.js, timeout=10, tag=徕芬签到Token捕获
[MITM]
  hostname = mall-gw.laifen.net
*/

!(function () {
  "use strict";

  const NAME = "laifen_checkin";

  // ==================== 配置区 ====================
  // token 不写在脚本里(避免分发泄露隐私),仅从 $persistentStore 读取。
  // 由 http-request 捕获规则自动写入:打开 App 签到页即可
  const MAX_ACCOUNTS = 5; // 最多支持的账户数
  // 签到活动 ID(公开值)
  const ACTIVITY_ID = 3;
  // ================================================

  const BASE = "https://mall-gw.laifen.net";
  const UA =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 laifenapp";

  // ---------- 存储 ----------
  const store = {
    read: (k) =>
      typeof $persistentStore !== "undefined" ? $persistentStore.read(k) : null,
    write: (v, k) =>
      typeof $persistentStore !== "undefined" ? $persistentStore.write(v, k) : null,
  };

  // 持久化结构: {"accounts":[{"userId":123456,"token":"xxx","nickName":"xxx"}, ...]}
  // 账户以 userId 为唯一标识;无 userId 的旧数据(按 token 识别)仍保留,待下次捕获时归并
  // 兼容旧格式: 单账户对象 {"token":...,"nickName":...} 或纯字符串(仅 token)
  function readAccounts() {
    const raw = store.read("laifen_token");
    if (!raw) return [];
    try {
      const o = JSON.parse(raw);
      if (o && Array.isArray(o.accounts)) return o.accounts;
      if (o && o.token) return [o];
    } catch (e) {}
    return [{ token: raw }];
  }

  function saveAccounts(accounts) {
    store.write(JSON.stringify({ accounts }), "laifen_token");
  }

  // ---------- HTTP ----------
  // Loon 的 $httpClient 提供 get/post/request,没有 fetch
  function http(opts, cb) {
    const done = (error, response, data) => {
      if (error) return cb(error);
      let body = data;
      if (typeof body === "string") {
        try {
          body = JSON.parse(body);
        } catch (e) {}
      }
      cb(null, response, body);
    };
    if (typeof $httpClient.request === "function") {
      $httpClient.request(opts, done);
    } else if (opts.method === "POST" || opts.method === "post") {
      $httpClient.post(opts, done);
    } else {
      $httpClient.get(opts, done);
    }
  }

  function headers(token) {
    return {
      Accept: "*/*",
      "Content-Type": "application/json",
      Origin: "https://mall.laifen.net",
      Referer: "https://mall.laifen.net/",
      "User-Agent": UA,
      Locale: "zh_CN",
      authorization: token,
    };
  }

  // ---------- 工具 ----------
  // 仅推送通知(不结束脚本),供需要自行控制 $done 时机的流程使用
  function push(title, body) {
    console.log(`[${NAME}] ${title}: ${body}`);
    if (typeof $notification !== "undefined") {
      $notification.post(title, "", body);
    }
  }

  function notify(title, body) {
    push(title, body);
    if (typeof $done !== "undefined") $done({});
  }

  function todayStr() {
    // 北京时间 YYYY-MM-DD
    try {
      return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
    } catch (e) {
      const d = new Date();
      const p = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    }
  }

  // ---------- 用户信息 ----------
  // 查询用户信息接口,回调返回 {userId, nickName}(失败返回 null)
  function fetchUserInfo(token, cb) {
    http(
      { url: `${BASE}/mall_user/user/ma/user_detail_info`, method: "GET", headers: headers(token) },
      (_err, _resp, data) => {
        if (data && data.success && data.data) {
          const d = data.data;
          cb({ userId: d.userId || null, nickName: d.nickName || d.userName || null });
        } else {
          cb(null);
        }
      }
    );
  }

  // ---------- 连续签到奖励 ----------
  // 活动规则:同一自然月周期内连续签到满 5 天,额外奖励 5 积分(服务器自动发放,每周期仅计 1 次)
  // 仅在达成当天(连续第 5 天)追加提示,其他天数按原格式显示
  const STREAK_GOAL = 5;
  const STREAK_BONUS = 5;
  function streakInfo(days) {
    if (days === STREAK_GOAL) return `(连续签到${STREAK_GOAL}天，奖励${STREAK_BONUS}积分)`;
    return "";
  }

  // ---------- 总积分 ----------
  // GET /mall_user/sc/member/info 返回 data.availablePoint(当前可用总积分),失败回调 null
  function fetchTotalPoint(token, cb) {
    http(
      { url: `${BASE}/mall_user/sc/member/info`, method: "GET", headers: headers(token) },
      (_err, _resp, data) => {
        if (data && data.success && data.data && data.data.availablePoint != null) {
          cb(data.data.availablePoint);
        } else {
          cb(null);
        }
      }
    );
  }

  // ---------- 单账户签到 ----------
  // 完成回调 done(resultText),resultText 为签到结果描述
  function signAccount(acc, done) {
    const token = acc.token;
    const nick = acc.nickName || "未知账号";
    http(
      { url: `${BASE}/mall_marketing/sc/activity/sign/current`, method: "GET", headers: headers(token) },
      (err, _resp, data) => {
        if (err || !data || !data.success || !data.data) {
          return done(
            nick,
            `失败(查询活动异常:${(data && (data.msg || data.code)) || err || "网络错误"},若登录过期请重新打开签到页捕获 Token)`
          );
        }
        const d = data.data;
        const today = (d.calendarList || []).find((x) => x.date === todayStr());
        if (today && today.status === 1) {
          const s = streakInfo(d.continuousDays);
          const txt = `已签到 ${d.continuousDays} 天(今日已签到)${s}`;
          return fetchTotalPoint(token, (total) =>
            done(nick, total != null ? `${txt}\nLaifen总积分：${total} 积分` : txt)
          );
        }
        http(
          {
            url: `${BASE}/mall_marketing/sc/activity/sign/do`,
            method: "POST",
            headers: headers(token),
            body: JSON.stringify({ activityId: d.activityId || ACTIVITY_ID }),
          },
          (err2, _resp2, data2) => {
            if (err2 || !data2) {
              return done(nick, `失败(请求异常:${err2 || "网络错误"})`);
            }
            if (data2.success && data2.code === "00000") {
              const r = data2.data || {};
              const days = r.continuousDays != null ? r.continuousDays : d.continuousDays;
              const s = streakInfo(days);
              const txt = `成功 已签到 ${days} 天,获得 ${r.rewardValue || d.dailyRewardValue || 1} 积分${s}`;
              return fetchTotalPoint(token, (total) =>
                done(nick, total != null ? `${txt}\nLaifen总积分：${total} 积分` : txt)
              );
            }
            done(nick, `失败(${data2.code}: ${data2.msg || "未知错误"})`);
          }
        );
      }
    );
  }

  // ---------- 主流程(cron) ----------
  // 通知格式(多账户依次列出):
  //   Laifen账号: xxx
  //   Laifen签到：成功 已签到 N 天
  function main() {
    const accounts = readAccounts();
    if (!accounts.length) {
      return notify(
        "徕芬未配置 Token",
        "请配置 http-request 捕获规则并开启 MITM,打开 App 签到页即可完成 Token 捕获"
      );
    }
    const lines = [];
    let i = 0;
    const next = () => {
      if (i >= accounts.length) {
        return notify("Laifen", lines.join("\n\n"));
      }
      const acc = accounts[i++];
      signAccount(acc, (nick, result) => {
        lines.push(`Laifen账号: ${nick}\nLaifen签到：${result}`);
        next();
      });
    };
    next();
  }

  // ---------- 入口分流 ----------
  if (typeof $request !== "undefined") {
    // http-request 模式:按 userId 识别账户;token 续期时自动替换旧 token
    const auth =
      $request.headers["authorization"] || $request.headers["Authorization"];
    if (!auth) {
      // 命中规则但请求头无 authorization:排除 OPTIONS 预检(预检本就不带凭证);
      // 仅在还没有任何账户时提醒一次,避免刷屏
      const method = ($request.method || "").toUpperCase();
      if (method !== "OPTIONS" && !readAccounts().length) {
        push("Laifen", "LaifenToken：获取失败(请求头无 authorization),请检查 MITM 配置");
      }
      $done({});
      return;
    }
    const accounts = readAccounts();
    // 1) token 与已有账户完全一致 → 仅刷新用户信息(回填 userId、更新昵称)
    const byToken = accounts.findIndex((a) => a.token === auth);
    if (byToken !== -1) {
      fetchUserInfo(auth, (info) => {
        const acc = accounts[byToken];
        let extra = "";
        if (info) {
          if (info.userId) {
            acc.userId = info.userId;
            // 归并:若存在同 userId 的重复账户(旧 token 条目),删除之
            const dup = accounts.findIndex((a) => a !== acc && a.userId === info.userId);
            if (dup !== -1) accounts.splice(dup, 1);
          }
          if (info.nickName) {
            if (acc.nickName && acc.nickName !== info.nickName) extra = "\n昵称已更新";
            acc.nickName = info.nickName;
          }
          saveAccounts(accounts);
        }
        push(
          "Laifen",
          `Laifen账号: ${acc.nickName || "未知账号"}\nLaifenToken：有效(未变化)${extra}\nToken 已捕获,若无需继续添加账户,可关闭 mall-gw.laifen.net 的 MITM`
        );
        $done({});
      });
      return;
    }
    // 2) 新 token → 查用户信息,按 userId 匹配账户
    fetchUserInfo(auth, (info) => {
      const uid = info && info.userId;
      const idx = uid ? accounts.findIndex((a) => a.userId === uid) : -1;
      let status;
      if (idx !== -1) {
        // 同一账户 token 续期:替换旧 token
        accounts[idx].token = auth;
        if (info.nickName) accounts[idx].nickName = info.nickName;
        status = "已续期(旧 Token 已替换)";
      } else {
        if (accounts.length >= MAX_ACCOUNTS) {
          push(
            "Laifen",
            `LaifenToken：发现新 Token,但账户数已达上限(${MAX_ACCOUNTS} 个),未保存`
          );
          $done({});
          return;
        }
        accounts.push({ userId: uid || null, token: auth, nickName: (info && info.nickName) || null });
        status = `捕获成功(账户 ${accounts.length}/${MAX_ACCOUNTS})`;
      }
      saveAccounts(accounts);
      push(
        "Laifen",
        `Laifen账号: ${(info && info.nickName) || "未知账号"}\nLaifenToken：${status}`
      );
      $done({});
    });
  } else {
    // cron / 手动执行模式
    main();
  }
})();
