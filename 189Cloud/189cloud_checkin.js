/*
Date: 2026年9月30日17:36:03
Author: ZahicX
天翼云盘 绿色任务每日签到 - Loon 脚本(支持多账户,最多 5 个)
接口来源:抓包记录 m.cloud.189.cn(做绿色任务领特权 / 绿色成长体系,活动号 ACT2024cztx)
  - GET /market/signInNew.action?sessionKey=&activityId=      执行签到,返回 {result:true,status:0}(幂等,重复签到不报错)
  - GET /market/signInNewInfo.action?sessionKey=&activityId=  查询连签天数,返回 data=连签天数
  - GET /market/getGreenLevelList.action?sessionKey=&activityId= 查询绿色任务总积分,返回 data.userScore
  - GET /market/getUserTaskRecord.action?sessionKey=&activityId= 查询积分明细,用于汇总今日获取的积分
  - GET /v2/getUserBriefInfo.action                           用 Cookie(或 sessionKey)换取账号信息与最新 sessionKey

[Script] 配置:
  # 脚本图标: https://raw.githubusercontent.com/ZahicX/Script/main/icon/189cloud.png
  # (在 Loon 脚本配置中加 img-url=https://raw.githubusercontent.com/ZahicX/Script/main/icon/189cloud.png 即可显示)
  # 每日 8:30 定时签到(cron),遍历所有已捕获账户依次签到,汇总为一条通知
  30 8 * * * 189cloud_checkin.js, tag=天翼云盘签到, enabled=true
  # 自动捕获凭证:打开 App 绿色任务页时把 sessionKey 与 Cookie 存入本地,需配合 MITM
  http-request ^https://m\.cloud\.189\.cn/market/signInNewInfo\.action script-path=https://raw.githubusercontent.com/ZahicX/Script/main/189Cloud/189cloud_checkin.js, timeout=10, tag=天翼云盘凭证捕获
[MITM]
  hostname = m.cloud.189.cn
  # sessionKey 失效时会自动用 Cookie 换取新 sessionKey 续期;
  # 若两者均失效,打开 App 绿色任务页重新捕获即可
*/

!(function () {
  "use strict";

  const NAME = "189cloud_checkin";

  // ==================== 配置区 ====================
  // 凭证不写在脚本里(避免分发泄露隐私),仅从 $persistentStore 读取。
  // 由 http-request 捕获规则自动写入:打开 App 绿色任务页即可
  const MAX_ACCOUNTS = 5; // 最多支持的账户数
  // 签到活动 ID(公开值)
  const ACTIVITY_ID = "ACT2024cztx";
  // ================================================

  const BASE = "https://m.cloud.189.cn";
  const UA =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Ecloud/11.1.1 iOS/27.2";
  const REFERER =
    "https://m.cloud.189.cn/zt/2024/green-task-system/index.html?uxChannel=10021140000";
  const STORE_KEY = "189cloud_accounts";

  // ---------- 存储 ----------
  const store = {
    read: (k) =>
      typeof $persistentStore !== "undefined" ? $persistentStore.read(k) : null,
    write: (v, k) =>
      typeof $persistentStore !== "undefined" ? $persistentStore.write(v, k) : null,
  };

  // 持久化结构: {"accounts":[{"id":"encryptAccount","account":"...","nickname":"...","sessionKey":"...","cookie":"...","updatedAt":0}, ...]}
  // 账户以 encryptAccount 为唯一标识;账号信息获取失败时以 sessionKey 暂存,下次捕获时归并
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

  function headers(cookie) {
    const h = {
      Accept: "application/json, text/plain, */*",
      "User-Agent": UA,
      Referer: REFERER,
      // 标记脚本自身发出的请求,避免被捕获规则二次捕获
      "x-script": NAME,
    };
    if (cookie) h.Cookie = cookie;
    return h;
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

  // ---------- 账号信息 / sessionKey ----------
  // GET /v2/getUserBriefInfo.action
  //   只用 Cookie:可用长效 Cookie 换取最新 sessionKey(自动续期)
  //   只用 sessionKey:校验有效性并取回账号信息
  // 成功回调 {id, account, nickname, sessionKey},失败回调 null
  function fetchUserInfo(opts, cb) {
    const q = `noCache=${Date.now()}`;
    const url = opts.sessionKey
      ? `${BASE}/v2/getUserBriefInfo.action?${q}&sessionKey=${encodeURIComponent(opts.sessionKey)}`
      : `${BASE}/v2/getUserBriefInfo.action?${q}`;
    http({ url, method: "GET", headers: headers(opts.cookie) }, (_err, _resp, data) => {
      if (data && data.res_code === 0 && data.sessionKey) {
        cb({
          id: data.encryptAccount || null,
          account: data.userAccount || null,
          nickname: data.nickname || null,
          sessionKey: data.sessionKey,
        });
      } else {
        cb(null);
      }
    });
  }

  // ---------- 签到相关接口 ----------
  function apiGet(url, cb) {
    http({ url, method: "GET", headers: headers() }, (err, _resp, data) => {
      if (err) return cb(err);
      cb(null, data);
    });
  }

  // 解析 {result,status,data} 结构;失败返回 {ok:false,invalid,msg},成功返回 {ok:true,days}
  function parse(resp) {
    if (!resp || typeof resp !== "object") return { ok: false, msg: "响应异常" };
    if (resp.errorCode) {
      return {
        ok: false,
        invalid: resp.errorCode === "InvalidSessionKey",
        msg: `${resp.errorCode}${resp.errorMsg ? ":" + resp.errorMsg : ""}`,
      };
    }
    if (resp.status === 0 && resp.result === true) {
      return { ok: true, days: typeof resp.data === "number" ? resp.data : null };
    }
    return { ok: false, msg: JSON.stringify(resp).slice(0, 120) };
  }

  const signUrl = (sk) =>
    `${BASE}/market/signInNew.action?sessionKey=${encodeURIComponent(sk)}&activityId=${ACTIVITY_ID}`;
  const infoUrl = (sk) =>
    `${BASE}/market/signInNewInfo.action?sessionKey=${encodeURIComponent(sk)}&activityId=${ACTIVITY_ID}`;
  const scoreUrl = (sk) =>
    `${BASE}/market/getGreenLevelList.action?sessionKey=${encodeURIComponent(sk)}&activityId=${ACTIVITY_ID}`;

  // 查询当前绿色任务积分(GET /market/getGreenLevelList.action,取 data.userScore);失败回调 null
  function fetchScore(sk, cb) {
    apiGet(scoreUrl(sk), (_err, data) => {
      cb(
        data && data.data && typeof data.data.userScore === "number"
          ? data.data.userScore
          : null
      );
    });
  }

  const recordUrl = (sk) =>
    `${BASE}/market/getUserTaskRecord.action?sessionKey=${encodeURIComponent(sk)}&activityId=${ACTIVITY_ID}&pageNum=1&pageSize=100`;

  // 汇总今日获取的绿色积分(GET /market/getUserTaskRecord.action,
  // 取 recordList 中 completeTime 为当天的记录累加 rewardValue);查询失败或当天无记录回调 null
  function fetchTodayEarned(sk, cb) {
    const d = new Date();
    const pad = (n) => (n < 10 ? "0" + n : "" + n);
    const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    apiGet(recordUrl(sk), (_err, data) => {
      const list =
        data && data.data && Array.isArray(data.data.recordList)
          ? data.data.recordList
          : null;
      if (!list) return cb(null);
      let sum = 0;
      let found = false;
      list.forEach((r) => {
        if (typeof r.completeTime === "string" && r.completeTime.indexOf(today) === 0) {
          found = true;
          if (typeof r.rewardValue === "number") sum += r.rewardValue;
        }
      });
      cb(found ? sum : null);
    });
  }

  // ---------- 凭证续期 ----------
  // 1) 优先用 Cookie 单独换取(避免已过期的 sessionKey 影响结果)
  // 2) 回退:用已存 sessionKey 直接校验
  function resolveSession(acc, cb) {
    if (!acc.cookie) return fetchUserInfo({ sessionKey: acc.sessionKey }, cb);
    fetchUserInfo({ cookie: acc.cookie }, (info) => {
      if (info) return cb(info);
      fetchUserInfo({ sessionKey: acc.sessionKey }, (info2) => cb(info2));
    });
  }

  // ---------- 单账户签到 ----------
  // 通知中的账号展示:优先 "账号(昵称)",账号与昵称均来自接口查询,缺失时降级
  function accountLabel(acc) {
    const id = acc.account ? acc.account.split("@")[0] : "";
    if (id && acc.nickname) return `${id}(${acc.nickname})`;
    return id || acc.nickname || "未知账号";
  }

  // 完成回调 done(label, resultText),label 为账号展示名,resultText 为签到结果描述
  function signAccount(acc, done) {
    resolveSession(acc, (info) => {
      if (!info) {
        return done(
          accountLabel(acc),
          "失败(登录已失效,请打开 App 绿色任务页重新捕获凭证)"
        );
      }
      // 回填/更新账号信息与最新 sessionKey
      if (info.id) acc.id = info.id;
      if (info.account) acc.account = info.account;
      if (info.nickname) acc.nickname = info.nickname;
      acc.sessionKey = info.sessionKey;
      acc.updatedAt = Date.now();
      const sk = info.sessionKey;

      // 签到前连签天数(同时用于校验 sessionKey)
      apiGet(infoUrl(sk), (_e1, before) => {
        const pb = parse(before);
        if (!pb.ok && pb.invalid) {
          return done(
            accountLabel(acc),
            "失败(登录已失效,请打开 App 绿色任务页重新捕获凭证)"
          );
        }
        // 执行签到(重复签到同样返回成功,不会中断连签)
        apiGet(signUrl(sk), (_e2, signed) => {
          const ps = parse(signed);
          if (!ps.ok) {
            return done(
              accountLabel(acc),
              `失败(${ps.invalid ? "登录已失效,请打开 App 绿色任务页重新捕获凭证" : ps.msg})`
            );
          }
          // 签到后连签天数:天数发生变化说明本次为当日首次签到
          apiGet(infoUrl(sk), (_e3, after) => {
            const pa = parse(after);
            // 积分均为查询所得:总积分与今日获取积分(签到后查询,可反映本次签到收益)
            fetchScore(sk, (score) => {
              fetchTodayEarned(sk, (todayEarned) => {
                let text;
                if (!pa.ok || pa.days == null) {
                  text = "签到成功(查询连签天数失败)";
                } else {
                  const newlySigned = pb.ok && pb.days != null && pa.days !== pb.days;
                  text =
                    (newlySigned ? "签到成功" : "已签到") +
                    `,已连签 ${pa.days} 天`;
                }
                if (todayEarned != null) text += `,今日获取 ${todayEarned} 积分`;
                if (score != null) text += `\n天翼云盘绿色总积分: ${score} 积分`;
                done(accountLabel(acc), text);
              });
            });
          });
        });
      });
    });
  }

  // ---------- 主流程(cron) ----------
  // 通知格式(多账户依次列出,积分均为查询所得):
  //   天翼云盘账号: 138****0000(昵称)
  //   天翼云盘签到：签到成功,已连签 3 天,今日获取 10 积分
  //   天翼云盘绿色总积分: 110 积分
  function main() {
    const accounts = readAccounts();
    if (!accounts.length) {
      return notify(
        "天翼云盘绿色任务未配置凭证",
        "请配置 http-request 捕获规则并开启 MITM,打开 App 绿色任务页即可完成凭证捕获"
      );
    }
    const lines = [];
    let i = 0;
    const next = () => {
      if (i >= accounts.length) {
        return notify("天翼云盘绿色任务", lines.join("\n\n"));
      }
      const acc = accounts[i++];
      signAccount(acc, (nick, result) => {
        saveAccounts(accounts);
        lines.push(`天翼云盘账号: ${nick}\n天翼云盘签到：${result}`);
        next();
      });
    };
    next();
  }

  // ---------- 入口分流 ----------
  if (typeof $request !== "undefined") {
    // http-request 模式:从签到天数查询请求上捕获 sessionKey 与登录 Cookie
    const hdr = $request.headers || {};
    // 脚本自身发出的请求不重复捕获
    if ((hdr["x-script"] || hdr["X-Script"]) === NAME) {
      $done({});
      return;
    }
    const skMatch = ($request.url || "").match(/[?&]sessionKey=([^&]+)/);
    const sessionKey = skMatch ? decodeURIComponent(skMatch[1]) : null;
    if (!sessionKey) {
      push("天翼云盘绿色任务", "凭证捕获失败(请求 URL 无 sessionKey),请检查 MITM 配置");
      $done({});
      return;
    }
    // 只保留登录相关 Cookie(同一 Cookie 名可能有多条,需全部保留)
    const keep = ["COOKIE_LOGIN_USER", "COOKIE_EACCESSTOKEN"];
    const cookie = (hdr["Cookie"] || hdr["cookie"] || "")
      .split(/;\s*/)
      .filter((x) => keep.some((k) => x.indexOf(k + "=") === 0))
      .join("; ");

    fetchUserInfo({ sessionKey, cookie }, (info) => {
      const accounts = readAccounts();
      const id = (info && info.id) || null;
      let idx = -1;
      if (id) idx = accounts.findIndex((a) => a.id === id);
      if (idx === -1) idx = accounts.findIndex((a) => a.sessionKey === sessionKey);

      const patch = { sessionKey, updatedAt: Date.now() };
      if (info && info.account) patch.account = info.account;
      if (info && info.nickname) patch.nickname = info.nickname;
      if (cookie) patch.cookie = cookie;

      let status;
      if (idx !== -1) {
        // 归并:暂存条目(sessionKey 为 id)修正为 encryptAccount
        if (id && accounts[idx].id === sessionKey) accounts[idx].id = id;
        Object.assign(accounts[idx], patch);
        status = "已更新";
      } else {
        if (accounts.length >= MAX_ACCOUNTS) {
          push(
            "天翼云盘绿色任务",
            `凭证：发现新账户,但账户数已达上限(${MAX_ACCOUNTS} 个),未保存`
          );
          $done({});
          return;
        }
        accounts.push(Object.assign({ id: id || sessionKey }, patch));
        status = `捕获成功(账户 ${accounts.length}/${MAX_ACCOUNTS})`;
      }
      saveAccounts(accounts);
      const entry = accounts[idx !== -1 ? idx : accounts.length - 1];
      push(
        "天翼云盘绿色任务",
        `天翼云盘账号: ${accountLabel(entry)}\n` +
          (info ? `凭证${status},已保存` : `凭证${status},账号信息获取失败,已暂存 sessionKey`) +
          ",若无需继续添加账户,可关闭 m.cloud.189.cn 的 MITM"
      );
      $done({});
    });
  } else {
    // cron / 手动执行模式
    main();
  }
})();