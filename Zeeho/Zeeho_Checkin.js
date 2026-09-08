/*
Date: 2026年9月9日01:57:23
new Env('极核-ZEEHO');
@Author: ZahicX 极核全任务（双网关签名 + 真机UA优先版）
@Description: 每日签到 + 盲盒抽奖 + 发布打卡动态 + 点赞 + 评论 + 分享 + 自动清理动态 + 积分查询
@Workflow: 签到 → 查签到记录(满30天领盲盒) → 查今日任务状态(已做则跳过) → 发动态 → 取动态ID → 点赞 → 分享 → 删除动态(仅删本次所发) → 查总积分（评论任务默认关闭，POST_COMMENT=true 开启）
@Gateway: 签到/抽奖/积分走 H5 网关(h5.zeehoev.com)，社区动态走原生网关(tapi.zeehoev.com)，双签名体系
@Compat: Loon / Egern（Egern 以 Surge 兼容模式运行），另兼容 Surge / QX / Stash / NR / Node.js

图标: https://raw.githubusercontent.com/ZahicX/Script/main/icon/zeeho.png

[Loon 获取Cookie]（脚本页添加，需 MITM）:
http-response ^https:\/\/tapi\.zeehoev\.com\/v1\.0\/mine\/cfmotoservermine\/setting script-path=https://raw.githubusercontent.com/ZahicX/Script/main/Zeeho/Zeeho_Checkin.js,requires-body=true,timeout=10,tag=Zeeho_ck
[MITM] hostname = tapi.zeehoev.com
[Loon 定时任务]:
cron "06 00 * * *" script-path=https://raw.githubusercontent.com/ZahicX/Script/main/Zeeho/Zeeho_Checkin.js,tag=Zeeho_checkin,enable=true

[Egern 配置]（Profile.yaml，Egern 强兼容 Surge 脚本）:
scriptings:
  - http_response: { name: Zeeho_ck, match: "^https://tapi\\.zeehoev\\.com/v1\\.0/mine/cfmotoservermine/setting", script_url: "https://raw.githubusercontent.com/ZahicX/Script/main/Zeeho/Zeeho_Checkin.js", body_required: true, timeout: 30 }
  - schedule: { name: Zeeho_checkin, cron: "06 00 * * *", script_url: "https://raw.githubusercontent.com/ZahicX/Script/main/Zeeho/Zeeho_Checkin.js", timeout: 300 }
mitm: { enable: true, certificates: 需生成并信任根证书, domains: ["tapi.zeehoev.com"] }

[持久化数据]（脚本读写的本地存储键 / Node 环境变量）:
- zeeho_data        Cookie 主数据（JSON 数组: [{userId, token, userName, userAgent}]）
                    由 MITM 规则自动写入；Node 环境改用同名环境变量 zeeho_data
                    userAgent = 抓 Cookie 时保存的真机 UA，双网关请求均复用它（与真机行为一致）
- zeeho_is_debug    调试开关（值为 'true' 时打印每个接口的原始响应 JSON）
                    Node 环境改用环境变量 IS_DEBUG；Loon 插件模式可用 debug_mode 参数开启

[任务开关]:
全局配置区域下方的 let RUN_TASK = true（独立运行时生效）
  true  = 执行全部任务；false = 仅执行任务9积分查询
Loon 插件模式下由「执行全部任务」开关(full_task 参数)覆盖此默认值
说明：开启全部任务时，今日已完成的发帖/点赞/分享会按任务记录自动跳过，重复运行安全

[Loon 插件]（推荐，一键安装）:
使用同目录 Zeeho.lpx：run_cron 总开关控制 cron 是否执行、
full_task 开关控制全部任务/仅查询、cron_time 自定义执行时间、
debug_mode 调试开关；get_cookie 开关控制 Cookie 抓取（默认关闭）

====================================
⚠️【免责声明】
------------------------------------------
1、此脚本仅用于学习研究，不保证其合法性、准确性、有效性，请根据情况自行判断，本人对此不承担任何保证责任。
2、由于此脚本仅用于学习研究，您必须在下载后 24 小时内将所有内容从您的计算机或手机或任何存储设备中完全删除，若违反规定引起任何事件本人对此均不负责。
3、请勿将此脚本用于任何商业或非法目的，若违反规定请自行对此负责。
4、此脚本涉及应用与本人无关，本人对因此引起的任何隐私泄漏或其他后果不承担任何责任。
5、本人对任何脚本引发的问题概不负责，包括但不限于由脚本错误引起的任何损失和损害。
6、如果任何单位或个人认为此脚本可能涉嫌侵犯其权利，应及时通知并提供身份证明，所有权证明，我们将在收到认证文件确认后删除此脚本。
7、所有直接或间接使用、查看此脚本的人均应该仔细阅读此声明。本人保留随时更改或补充此声明的权利。一旦您使用或复制了此脚本，即视为您已接受此免责声明。
*/

//--------------------------- 全局配置区域 ----------------------------------
const $ = new Env("极核-ZEEHO");
const ckName = "zeeho_data";
const Notify = 1;
const notify = $.isNode() ? require('./sendNotify') : '';
let envSplitor = ["@"];
var userCookie = ($.isNode() ? process.env[ckName] : $.getdata(ckName)) || '';
let userList = [];
let userIdx = 0;
let userCount = 0;

// 插件参数（full_task 任务范围开关；debug_mode 调试开关）
// Loon/Egern 传入的 $argument 是字符串：JSON 对象串，或按 argument=[{full_task},{debug_mode}] 顺序的逗号分隔串（如 "true,false"）
let pluginArg = {};
if (typeof $argument === 'object' && $argument) {
  pluginArg = $argument;
} else if (typeof $argument === 'string' && $argument.trim()) {
  try {
    pluginArg = JSON.parse($argument);
  } catch (e) {
    const [ft, dm] = $argument.replace(/^\[|\]$/g, '').split(',');
    pluginArg = { full_task: ft, debug_mode: dm };
  }
}
// ⚙️ 任务总开关（常用）：true = 执行任务 1-8 + 任务9；false = 只执行任务9（查询积分与签到天数）
// 独立运行：直接改下面 RUN_TASK；Loon 插件运行：由插件「执行全部任务」开关(full_task)覆盖
let RUN_TASK = true;
// Loon 3.5 传布尔值 true/false，旧版/其他环境可能传字符串 'true'，两者都要兼容
if (pluginArg.full_task !== undefined) RUN_TASK = (pluginArg.full_task === true || pluginArg.full_task === 'true');
// ⚙️ 评论任务开关：false = 默认不执行评论（实测发帖后可直接分享得积分，评论并非分享前置条件）
let POST_COMMENT = false;
// ⚙️ 调试开关（不常用）：先初始化，再由插件参数覆盖（这两行顺序不可颠倒）
$.is_debug = ($.isNode() ? process.env.IS_DEBUG : $.getdata('zeeho_is_debug')) || 'false';
if (pluginArg.debug_mode === true || pluginArg.debug_mode === 'true') $.is_debug = 'true';
$.notifySummary = [];   // 全局汇总通知行
$.successCount = 0;     // 成功账号数
$.failCount = 0;        // 失败账号数

//--------------------------- 任务编排区域 ----------------------------------
async function main() {
  try {
    $.log('\n================== 任务开始 ==================\n');
    for (let user of userList) {
      // 旧版 Cookie 未保存真机 UA：无法还原请求头，跳过并要求重新抓取
      if (!user.userAgent) {
        $.log(`⛔️ 账号${user.index} [${user.userName || '用户'}] Cookie 缺少 userAgent，跳过`);
        $.notifySummary.push(`❌「${user.userName || user.index}」Cookie 为旧版本（缺少真机 UA），请在 App 内重新进入「我的」页面抓取`);
        $.failCount++;
        continue;
      }
      console.log(`📱账号${user.index} [${user.userName || '用户'}] >> 开始执行任务`);

      let integral = 0;
      let integralScore = 0;
      let count = 0;
      let interactGain = 0;

      if (RUN_TASK) {
        // 1. 每日签到
        integral = (await user.signin()) || 0;

        if (user.ckStatus) {
          await $.wait(user.getRandomTime());

          // 2. 查询签到记录（本月累计签到天数）
          const record = await user.getSignRecord();
          count = record?.count || 0;

          // 3. 盲盒抽奖（新逻辑：本月累计签到满 30 天时领取盲盒奖励）
          if (count === 30) {
            await $.wait(user.getRandomTime());
            integralScore = (await user.lottery()) || 0;
          }

          // 4. 查询今日任务完成情况（发帖1023 / 分享1024 / 点赞1026），已做的跳过
          await $.wait(user.getRandomTime());
          const taskList = await user.getTaskList();
          const postDone = isToday(taskList.find(t => t.code === '1023')?.createDate);
          const shareDone = isToday(taskList.find(t => t.code === '1024')?.createDate);
          const likeDone = isToday(taskList.find(t => t.code === '1026')?.createDate);

          if (postDone && likeDone && shareDone) {
            $.log(`ℹ️ 今日发帖/点赞/分享任务均已完成，跳过动态任务`);
          } else {
            // 5. 发帖（仅今日未发帖时；保留随机内容）
            let postId = null;
            let postIdIsOwn = false;   // postId 是否为本次脚本新发（决定能否删除）
            if (!postDone) {
              const postContent = `骑行打卡美好生活 ${Date.now().toString().slice(-4)}`;
              if (await user.createArticle(postContent)) {
                await $.wait(user.getRandomTime());
                postId = await user.getMyLatestArticle();
                if (postId) {
                  postIdIsOwn = true;
                  interactGain += 1;
                }
              }
            } else {
              $.log(`ℹ️ 今日已发帖，跳过发帖任务`);
            }

            // 6. 今日未发帖但仍有互动任务时，从社区找自己的一条动态作为目标
            if (!postId && (!likeDone || !shareDone)) {
              await $.wait(user.getRandomTime());
              postId = await user.getCommunityArticle();
            }

            if (!postId) {
              $.log(`⛔️ 未获取到动态ID，跳过互动任务`);
            } else {
              // 7. 点赞（仅今日未点赞时）
              if (!likeDone) {
                await $.wait(user.getRandomTime());
                if (await user.thumbsUp(postId)) interactGain += 1;
              } else {
                $.log(`ℹ️ 今日已点赞，跳过点赞任务`);
              }

              // 8. 评论（默认关闭：实测发帖后可直接分享得积分；如需评论改 POST_COMMENT = true）
              if (POST_COMMENT && !shareDone) {
                await $.wait(user.getRandomTime());
                await user.comment(postId);
              }

              // 9. 分享（仅今日未分享时）
              if (!shareDone) {
                await $.wait(user.getRandomTime());
                if (await user.share(postId)) interactGain += 1;
              } else {
                $.log(`ℹ️ 今日已分享，跳过分享任务`);
              }

              // 10. 删除动态：只删本次脚本新发的动态；非本次所发（今日已发帖/社区兜底）一律不删
              if (postIdIsOwn) {
                await $.wait(user.getRandomTime());
                await user.deletePost(postId);
              } else {
                $.log(`ℹ️ 动态非本次脚本所发，不删除`);
              }
            }
          }

        }

        // Token 失效：通知一次后跳过积分查询，避免无效请求与重复通知
        if (!user.ckStatus) {
          $.notifySummary.push(`❌「${user.userName || user.index}」Token 失效或请求异常，请重新登录 App 抓取 Cookie`);
          $.failCount++;
          continue;
        }
      } else {
        $.log(`⏸️ 任务开关 RUN_TASK 已关闭：跳过签到/抽奖/发布/点赞/分享/删除，仅查询积分与签到天数`);
      }

      // 11. 查询最新总积分（不受开关控制，始终执行）
      await $.wait(user.getRandomTime());
      const score = await user.getSignInfo();
      if (!user.ckStatus) {
        $.notifySummary.push(`❌「${user.userName || user.index}」Token 失效或请求异常，请重新登录 App 抓取 Cookie`);
        $.failCount++;
        continue;
      }
      // 开关关闭时：积分查询成功才补查签到天数，避免无效请求
      if (!RUN_TASK && score != null) {
        await $.wait(user.getRandomTime());
        const record = await user.getSignRecord();
        count = record?.count || 0;
      }
      if (RUN_TASK) {
        // 汇总式：当前总分 (旧分 签到X 任务Y)；签到项=签到得分+盲盒抽奖，任务项=发帖/点赞/分享
        const signGain = Number(integral) + Number(integralScore);
        const gain = signGain + interactGain;
        const oldScore = typeof score === 'number' ? score - gain : '未知';
        $.log(`📱[${user.userName || user.index}] 当前积分: ${score ?? '未知'} 分, 累计签到: ${count || '未知'} 天`);
        $.notifySummary.push(`📱[${user.userName || user.index}] 积分: ${score ?? '未知'} (${oldScore} 签到${signGain} 任务${interactGain}), 累计签到: ${count || '未知'} 天`);
        $.successCount++;
      } else {
        $.log(`📱[${user.userName || user.index}] 当前积分: ${score ?? '未知'} 分, 累计签到: ${count || '未知'} 天`);
        $.notifySummary.push(`「${user.userName || user.index}」当前积分: ${score ?? '未知'} 分, 累计签到: ${count || '未知'} 天`);
        if (score != null) $.successCount++; else $.failCount++;
      }
    }
  } catch (e) {
    $.log(`⛔️ main run error => ${e.message || e}`);
    $.notifySummary.push(`⛔️ 脚本异常: ${e.message || e}`);
  }
}

//--------------------------- 用户任务类区域 --------------------------------
class UserInfo {
  constructor(user) {
    this.index = ++userIdx;
    let rawToken = user.token || user;
    if (typeof rawToken === 'string' && !rawToken.startsWith('Bearer ')) {
      this.token = `Bearer ${rawToken}`;
    } else {
      this.token = rawToken;
    }
    this.userId = String(user.userId || '');
    this.userName = user.userName || `账号${this.index}`;
    this.userAgent = user.userAgent || '';  // 抓 Cookie 时保存的真机 UA
    this.ckStatus = true;
    this.getRandomTime = () => randomInt(1000, 3000);

    this.fetch = async (o) => {
      try {
        if (typeof o === 'string') o = { url: o };
        const headers = Object.assign(
          {
            "Content-Type": "application/json;charset=UTF-8",
            "Authorization": this.token
          },
          this.userId ? { "cookie": `user_id=${this.userId}`, "user_id": this.userId } : {},
          o.headers || {}
        );
        // 双网关统一使用抓 Cookie 时保存的真机 UA（与真机行为一致，无需伪造指纹）
        if (headers['appid'] === 'S7qPWPU1') {
          // 原生网关：User-Agent 即 MOBILE 格式真机 UA
          headers['User-Agent'] = this.userAgent;
          headers['x-app-info'] = this.userAgent;
        } else {
          // H5 网关：zeeho-user-agent 用真机 UA，User-Agent 用由它换算的 WebView UA（与抓包一致）
          headers['User-Agent'] = toWebViewUa(this.userAgent);
          headers['zeeho-user-agent'] = this.userAgent;
        }

        const res = await Request({ ...o, headers });
        debug(res, o?.url?.replace(/\/+$/, '').substring(o?.url?.lastIndexOf('/') + 1));
        if (res?.code == 40001 || res?.code == 401) {
          this.ckStatus = false;
          throw new Error(res?.message || `用户登录已失效`);
        }
        return res;
      } catch (e) {
        this.ckStatus = false;
        $.log(`⛔️ 请求发起失败: ${e.message || e}`);
        return null;
      }
    };
  }

  // 每日签到（任务1，H5 网关优先，失败回退 tapi 原生网关）
  async signin() {
    try {
      let res = await this.fetch({
        url: "https://h5.zeehoev.com/cfmotoservermine/signin",
        type: "post",
        headers: getSign("h5"),
        dataType: "json"
      });
      if (res?.code != '10000') {
        // H5 网关异常时回退原生网关（参照单 tapi 方案），必须改用 native 签名
        $.log(`⚠️ 签到: H5 网关未成功(${res?.message || '无响应'})，回退原生网关`);
        const body = { server_name: "SMART" };
        res = await this.fetch({
          url: "https://tapi.zeehoev.com/v1.0/mine/cfmotoservermine/signin",
          type: "post",
          headers: getSign("native", JSON.stringify(body)),
          body,
          dataType: "json"
        });
      }
      if (res?.code == '10000') {
        if (res?.data?.signInStatus == 0) {
          const gained = Number(res?.data?.integralScore) || 0;
          $.log(gained ? `✅ 签到任务: 签到成功，获得 ${gained} 积分` : `✅ 签到任务: 签到成功（未返回积分）`);
          return gained;
        } else {
          $.log(`✅ 签到任务: 今日已签到`);
          return 0;
        }
      } else {
        $.log(`⛔️ 签到任务: ${res?.message || ''}`);
        return 0;
      }
    } catch (e) {
      $.log(`⛔️ 签到异常: ${e.message || e}`);
      return 0;
    }
  }

  // 查询本月累计签到天数（任务2，H5 优先，失败回退原生网关）
  async getSignRecord() {
    try {
      const d = new Date();
      const month = `${d.getFullYear()}-${d.getMonth() + 1}`;
      let res = await this.fetch({
        url: `https://h5.zeehoev.com/cfmotoservermine/signin/info?month=${month}`,
        type: "get",
        headers: getSign("h5", `month=${month}`),
        dataType: "json"
      });
      if (res?.code != '10000') {
        $.log(`⚠️ 签到记录: H5 网关未成功，回退原生网关`);
        const q = `month=${month}&server_name=SMART`;
        res = await this.fetch({
          url: `https://tapi.zeehoev.com/v1.0/mine/cfmotoservermine/signin/info?${q}`,
          type: "get",
          headers: getSign("native", q),
          dataType: "json"
        });
      }
      if (res?.code == '10000' && res?.data) {
        const count = res.data.signCount || 0;
        $.log(count === 30 ? `🔄 本月累计签到: ${count} 天（满足盲盒条件）` : `🔄 本月累计签到: ${count} 天`);
        return { count };
      }
      return { count: 0 };
    } catch (e) {
      $.log(`⛔️ 查询签到记录失败: ${e.message || e}`);
      return { count: 0 };
    }
  }

  // 盲盒抽奖（任务3，累计签到满30天领取；H5 优先，失败回退原生网关）
  async lottery() {
    try {
      const date = new Date();
      const today = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      let res = await this.fetch({
        url: `https://h5.zeehoev.com/cfmotoservermine/signin/supplementPrize?supplementDate=${today}`,
        type: "get",
        headers: getSign("h5", `supplementDate=${today}`),
        dataType: "json"
      });
      if (res?.code != '10000') {
        $.log(`⚠️ 盲盒抽奖: H5 网关未成功，回退原生网关`);
        const q = `supplementDate=${today}`;
        res = await this.fetch({
          url: `https://tapi.zeehoev.com/v1.0/mine/cfmotoservermine/signin/supplementPrize?${q}`,
          type: "get",
          headers: getSign("native", q),
          dataType: "json"
        });
      }
      if (res?.code == '10000') {
        const integralScore = res?.data?.integral || res?.data?.integralScore || 0;
        const prizesName = res?.data?.prizesName || integralScore + "积分";
        $.log(`✅ 盲盒抽奖获得: ${prizesName}`);
        return Number(integralScore) || 0;
      } else {
        $.log(`⚠️ 盲盒抽奖(今日可能无盲盒): ${res?.message || '无响应'}`);
        return 0;
      }
    } catch (e) {
      $.log(`⛔️ 盲盒抽奖异常: ${e.message || e}`);
      return 0;
    }
  }

  // 创建动态（任务4，原生网关，body 参与签名）
  async createArticle(content) {
    try {
      const body = {
        "postSubInfo": { "topicList": [] },
        "topicid": "",
        "postcontent": content || "打卡极核社区"
      };
      const opts = {
        url: `https://tapi.zeehoev.com/v1.0/social/cfmotoserversocial/commonArticle`,
        type: "post",
        dataType: "json",
        headers: getSign("native", JSON.stringify(body)),
        body
      };
      let res = await this.fetch(opts);
      if (res?.code == '10000' && res?.data) {
        $.log(`✅ 创建动态: 成功`);
        return true;
      }
      $.log(`⛔️ 创建动态: ${res?.message || '无响应'}`);
      return false;
    } catch (e) {
      $.log(`⛔️ 创建动态异常: ${e.message || e}`);
      return false;
    }
  }

  // 获取自己刚发的动态 ID（任务5，递归多字段容错）
  async getMyLatestArticle() {
    try {
      const query = `pageSize=20&postModule=1&slidingType=1`;
      const opts = {
        url: `https://tapi.zeehoev.com/v1.0/social/cfmotoserversocial/community/qbTzInfoNewV2?${query}`,
        type: "get",
        headers: getSign("native", query),
        dataType: "json"
      };
      let res = await this.fetch(opts);
      if (res?.code == '10000' && Array.isArray(res?.data)) {
        const myPost = res.data.find(item => String(item.userid) === String(this.userId));
        const postId = getPostId(myPost);
        if (postId) {
          $.log(`✅ 获取动态ID成功: ${postId}`);
          return postId;
        }
      }
      return null;
    } catch (e) {
      $.log(`⛔️ 获取动态列表失败: ${e.message || e}`);
      return null;
    }
  }

  // 从社区动态列表找自己的一条动态（今日未发帖但需点赞/分享时的备用目标）
  async getCommunityArticle() {
    try {
      const query = `page=1&pageSize=20&postModule=2&slidingType=1`;
      const res = await this.fetch({
        url: `https://tapi.zeehoev.com/v1.0/social/cfmotoserversocial/community/qbTzInfoNewV2?${query}`,
        type: "get",
        headers: getSign("native", query),
        dataType: "json"
      });
      if (res?.code == '10000') {
        const list = Array.isArray(res?.data) ? res.data : [];
        const mine = list.find(item =>
          String(item.userid || item.userId || item.createBy || item.uid || '') === String(this.userId));
        return getPostId(mine);   // 只用自己的动态，不回退到他人帖子
      }
      return null;
    } catch (e) {
      $.log(`⛔️ 获取社区动态失败: ${e.message || e}`);
      return null;
    }
  }

  // 查询今日任务完成情况（发帖/分享/点赞的完成记录）
  async getTaskList() {
    try {
      const query = `userId=${this.userId}`;
      const res = await this.fetch({
        url: `https://tapi.zeehoev.com/v1.0/mine/cfmotoservermine/integral/getByUserId?${query}`,
        type: "get",
        headers: getSign("native", query),
        dataType: "json"
      });
      if (res?.code == '10000') {
        return res?.data?.ps0003_01_002_VOList || [];
      }
      return [];
    } catch (e) {
      $.log(`⛔️ 查询任务列表失败: ${e.message || e}`);
      return [];
    }
  }

  // 点赞动态（任务6）
  async thumbsUp(postId) {
    try {
      const body = {
        postId: String(postId),
        kindFlag: "0"
      };
      const opts = {
        url: `https://tapi.zeehoev.com/v1.0/social/cfmotoserversocial/socialCommu/likeFavoriteInfo`,
        type: "post",
        headers: getSign("native", JSON.stringify(body)),
        dataType: "json",
        body
      };
      const res = await this.fetch(opts);
      if (res?.code == '10000') {
        $.log(`✅ 点赞动态: 成功`);
        return true;
      }
      $.log(`⛔️ 点赞动态: ${res?.message || '无响应'}`);
      return false;
    } catch (e) {
      $.log(`⛔️ 点赞动态异常: ${e.message || e}`);
      return false;
    }
  }

  // 评论动态（分享前置条件，评论本身不加分）
  async comment(postId) {
    try {
      const body = {
        postid: String(postId),
        userId: String(this.userId),
        comments: "厉害",
        sendTos: "[\n\n]"
      };
      const res = await this.fetch({
        url: `https://tapi.zeehoev.com/v1.0/social/cfmotoserversocial/commentInfo`,
        type: "post",
        headers: getSign("native", JSON.stringify(body)),
        dataType: "json",
        body
      });
      if (res?.code == '10000') {
        $.log(`✅ 评论动态: 成功`);
      } else {
        $.log(`⚠️ 评论动态: ${res?.message || '无响应'}`);
      }
    } catch (e) {
      $.log(`⛔️ 评论动态异常: ${e.message || e}`);
    }
  }

  // 分享动态（任务7，原生网关 PUT + 分享积分上报）
  async share(postId) {
    try {
      let res = await this.fetch({
        url: `https://tapi.zeehoev.com/v1.0/social/cfmotoserversocial/article/share/${postId}`,
        type: "put",
        headers: getSign("native"),
        dataType: "json"
      });
      if (res?.code != '10000') {
        $.log(`⛔️ 分享动态: ${res?.message || '无响应'}`);
        return false;
      }
      // 分享成功后上报积分调整 (与 App 行为一致)
      const up = await this.fetch({
        url: `https://tapi.zeehoev.com/v1.0/mine/cfmotoservermine/integral/adjustByShare`,
        type: "get",
        headers: getSign("native"),
        dataType: "json"
      });
      $.log(up?.code == '10000' ? `✅ 分享动态: 成功` : `⚠️ 分享动态: 已分享，积分上报 ${up?.message || '失败'}`);
      return true;
    } catch (e) {
      $.log(`⛔️ 分享异常: ${e.message || e}`);
      return false;
    }
  }

  // 清理临时动态（任务8，原生网关 DELETE，query 参与签名）
  async deletePost(postId) {
    try {
      const query = `articleId=${postId}&postType=1`;
      const opts = {
        url: `https://tapi.zeehoev.com/v1.0/social/cfmotoserversocial/commonArticle/deleteArticle?${query}`,
        type: "delete",
        headers: getSign("native", query),
        dataType: "json"
      };
      let res = await this.fetch(opts);
      if (res?.code == '10000') {
        $.log(`✅ 清理临时动态: 成功`);
      } else {
        $.log(`⚠️ 清理临时动态: ${res?.message || '接口未确认'}`);
      }
    } catch (e) {
      $.log(`⛔️ 删除动态异常: ${e.message || e}`);
    }
  }

  // 查询用户信息与积分（任务9）
  async getSignInfo() {
    try {
      if (!this.userId) return null;
      let res = await this.fetch({
        url: `https://h5.zeehoev.com/cfmotoservermine/setting/${this.userId}`,
        type: "get",
        headers: getSign("h5"),
        dataType: "json"
      });
      if (res?.code != '10000') {
        // H5 网关失败时回退原生网关，必须改用 native 签名，否则必然 permit error
        res = await this.fetch({
          url: `https://tapi.zeehoev.com/v1.0/mine/cfmotoservermine/setting/${this.userId}`,
          type: "get",
          headers: getSign("native"),
          dataType: "json"
        });
      }
      if (res?.code == '10000') {
        return res?.data?.score;
      }
      return null;
    } catch (e) {
      $.log(`⛔️ 查询用户信息失败: ${e.message || e}`);
      return null;
    }
  }
}

//--------------------------- Cookie抓取区域 --------------------------------
// Cookie 抓取（MITM 重写模式触发）
// 从响应体中提取 userId, token, userName, userAgent 并更新到全局 Cookie
async function getCookie() {
  if ($request && $request.method === 'OPTIONS') return;

  const header = ObjectKeys2LowerCase($request.headers);
  const token = header['authorization'];
  const userAgent = header['user-agent'] || header['zeeho-user-agent'];
  const body = $.toObj($response.body);
  if (!(body?.data) || !token || !userAgent) {
    $.msg($.name, `❌获取Cookie失败!`, userAgent ? "" : "未捕获到真机 UA，请在 App 内重新进入「我的」页面");
    return;
  }

  const { id, nickName } = body?.data;
  const newData = {
    "userId": String(id),
    "token": token.startsWith('Bearer ') ? token : `Bearer ${token}`,
    "userName": nickName,
    "userAgent": userAgent
  };

  let cookies = [];
  try {
    cookies = userCookie ? JSON.parse(userCookie) : [];
    if (!Array.isArray(cookies)) cookies = [cookies];
  } catch (e) {
    cookies = [];
  }

  const index = cookies.findIndex(e => String(e.userId) === String(newData.userId));
  if (index > -1) {
    cookies[index] = newData;
  } else {
    cookies.push(newData);
  }

  $.setjson(cookies, ckName);
  $.msg($.name, `🎉 [${newData.userName}] 更新Token成功!`, ``);
}

//----------------------- 签名与网络请求区域 ---------------------------------
// 核心：统一生成 100% 通过验签的微服务 Headers
// payload: 参与签名的负载。原生网关(tapi)必须把「实际发送的 body 或 query」拼在签名原文最前面；
//          H5 网关仅 GET 的 query 参与。可传字符串(直接用作前缀)或对象(自动转 query 串)。
function getSign(type = "h5", payload = "") {
  const isH5 = type === "h5";
  const appId = isH5 ? "Sw5F9uJi" : "S7qPWPU1";
  const appSecret = isH5 ? "46870a8f678a09109468f5b0168818b91c292845" : "c5e0da7f4da28df805694ec3dd1fc6792e9df99d";
  const timestamp = new Date().getTime();
  const nonce = isH5 ? getUuid() : `${timestamp}${getRandomChars(16)}`;

  const query = typeof payload === "string"
    ? payload
    : (Object.keys(payload).length ? Object.keys(payload).map(k => `${k}=${payload[k]}`).join('&') : '');
  const signatureRaw = `${query}appId=${appId}&nonce=${nonce}&timestamp=${timestamp}${appSecret}`;
  const sign = md5(sha1(signatureRaw), 32).toString();

  const headers = {
    'appid': appId,
    'timestamp': `${timestamp}`,
    'nonce': nonce,
    'cfmoto-x-param': `appId=${appId}&nonce=${nonce}&timestamp=${timestamp}`,
    'cfmoto-x-sign': sign,
    'cfmoto-x-sign-type': '0',
    'signature': sign,
    'interfaceversion': '2'
  };

  // UA 统一由 this.fetch 用 Cookie 中保存的真机 UA 写入，此处不再伪造
  return headers;
}

// 由真机 MOBILE UA 换算 WebView UA（H5 网关请求的 User-Agent，与抓包格式一致）
// 例：MOBILE|iOS|18.7|ZEEHO_APP|3.0.1|iPhone|iPhone 13 mini|375*812|... →
//     Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) ... zeeho/3.0.1 (iPhone 13 mini Build/18.7)iPhone
function toWebViewUa(mobileUa) {
  const parts = String(mobileUa).split('|');
  const osVer = (parts[2] || '18.7').replace(/\./g, '_');
  const appVer = parts[4] || '3.0.1';
  const model = parts[6] || 'iPhone';
  return `Mozilla/5.0 (iPhone; CPU iPhone OS ${osVer} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 zeeho/${appVer} (${model} Build/${parts[2] || '18.7'})iPhone`;
}

//-------------------------- 辅助函数区域 -----------------------------------
async function Request(o) {
  if (typeof o === 'string') o = { url: o };
  try {
    if (!o?.url) throw new Error('[发送请求] 缺少 url 参数');
    let { url: u, type, headers = {}, body: b, dataType = 'form' } = o;
    const method = type ? type.toLowerCase() : ('body' in o ? 'post' : 'get');
    const timeout = o.timeout ? ($.isSurge() ? o.timeout / 1e3 : o.timeout) : 8000;

    if (dataType === 'json') headers['Content-Type'] = 'application/json;charset=UTF-8';
    const body = b && dataType == 'form' ? $.queryStr(b) : $.toStr(b);
    const request = { ...o, url: u, headers, ...(method !== 'get' && { body }), timeout };
    // Env 的 $.http 仅有 get/post；put/delete 等特殊方法通过 post 入口携带 method 字段派发到底层 $httpClient
    // 注意必须 bind($.http)，裸函数引用会丢失 this 导致 Env 内部 this.send 崩溃
    const httpFn = (method === 'get' ? $.http.get : $.http.post).bind($.http);
    if (method !== 'get' && method !== 'post') request.method = method;

    const httpPromise = httpFn(request)
      .then(response => $.toObj(response.body) || response.body)
      .catch(err => {
        $.log(`❌请求发起失败！原因为：${err}`);
        return null;
      });

    return Promise.race([
      new Promise((_, e) => setTimeout(() => e(new Error('当前请求已超时')), timeout)),
      httpPromise
    ]);
  } catch (e) {
    console.log(`❌请求发起失败！原因为：${e.message || e}`);
    return null;
  }
}

function randomInt(n, r) {
  return Math.round(Math.random() * (r - n) + n);
}

// 判断日期字符串是否为今天
function isToday(dateStr) {
  if (!dateStr) return false;
  return new Date(dateStr).toDateString() === new Date().toDateString();
}

// 递归提取动态 ID：兼容多种字段名与嵌套结构，接口格式变化时容错
function getPostId(data) {
  if (!data) return null;
  if (typeof data === 'string' || typeof data === 'number') return String(data);
  if (Array.isArray(data)) return getPostId(data[0]);
  const direct = data.uuid || data.tuuid || data.postId || data.postid ||
    data.articleId || data.articleID || data.id || data.dataId || data.tid;
  if (direct) return String(direct);
  for (const key of ['records', 'list', 'rows', 'data', 'result']) {
    const postId = getPostId(data[key]);
    if (postId) return postId;
  }
  return null;
}

//调试: 仅在 is_debug 为 'true' 时打印接口原始响应
function debug(t, l = 'debug') {
  if ($.is_debug === 'true') {
    $.log(`\n-----------${l}------------\n`);
    $.log(typeof t == "string" ? t : $.toStr(t) || `debug error => t=${t}`);
    $.log(`\n-----------${l}------------\n`);
  }
}

async function SendMsg(summary, detail) {
  if (!summary && !detail) return;
  if (Notify <= 0) { console.log([summary, detail].filter(Boolean).join('\n')); return; }
  if ($.isNode()) {
    await notify.sendNotify($.name, [summary, detail].filter(Boolean).join('\n'));
  } else {
    $.msg($.name, summary || '', detail || '');
  }
}

function ObjectKeys2LowerCase(obj) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v]));
}

//---------------------- 主程序执行入口 -----------------------------------
!(async () => {
  if (typeof $request != "undefined") {
    await getCookie();
  } else {
    let parsed = $.toObj(userCookie);
    if (!parsed) {
      const e = envSplitor.find(o => userCookie.includes(o)) || envSplitor[0];
      parsed = userCookie ? userCookie.split(e).filter(Boolean) : [];
    }
    if (!Array.isArray(parsed)) parsed = [parsed];

    userList.push(...parsed.filter(Boolean).map(n => new UserInfo(n)));
    userCount = userList.length;
    console.log(`共找到 ${userCount} 个账号`);
    if (userList.length > 0) {
      await main();
    } else {
      $.log(`⚠️ 提示: 未读取到账号 Cookie，请先在 App 内进入「我的」页面获取！`);
    }
  }
})()
  .catch(e => $.notifySummary.push(`⛔️ ${e.message || e}`))
  .finally(async () => {
    // Cookie 抓取模式（$request 存在）已由 getCookie() 单独通知，不再发任务汇总
    if (typeof $request === 'undefined') {
      // 汇总式通知：全部成功只报成功数，全部失败只报失败数，部分失败两者都报 + 每号明细
      const summary = $.failCount === 0
        ? `共${userCount}个账号, 成功${$.successCount}个`
        : $.successCount === 0
          ? `共${userCount}个账号, 失败${$.failCount}个`
          : `共${userCount}个账号, 成功${$.successCount}个, 失败${$.failCount}个`;
      const detail = $.notifySummary.join('\n');
      await SendMsg(summary, detail);
    }
    $.done({ ok: 1 });
  });


/** ---------------------------------固定算法区域----------------------------------------- */
// prettier-ignore
function randomPattern(pattern,chars="abcdef0123456789"){let result="";for(let char of pattern){if(char==="x"){result+=chars.charAt(Math.floor(Math.random()*chars.length))}else if(char==="X"){result+=chars.charAt(Math.floor(Math.random()*chars.length)).toUpperCase()}else{result+=char}}return result}
function getUuid(){const uuid=[randomPattern("xxxxxxxx"),randomPattern("xxxx"),randomPattern("4xxx"),randomPattern("xxxx"),randomPattern("xxxxxxxxxxxx")];return uuid.join("-")}
function getRandomChars(n=16){const chars='0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';let result='';for(let i=0;i<n;i++){result+=chars.charAt(Math.floor(Math.random()*chars.length))}return result}
function md5(t,e){function n(t,e){return t<<e|t>>>32-e}function r(t,e){var n,r,o,i,a;return o=2147483648&t,i=2147483648&e,a=(1073741823&t)+(1073741823&e),(n=1073741824&t)&(r=1073741824&e)?2147483648^a^o^i:n|r?1073741824&a?3221225472^a^o^i:1073741824&a?3221225472^a^o^i:1073741824^a^o^i:a^o^i}function o(t,e,o,i,a,u,c){return t=r(t,r(r(function(t,e,n){return t&e|~t&n}(e,o,i),a),c)),r(n(t,u),e)}function i(t,e,o,i,a,u,c){return t=r(t,r(r(function(t,e,n){return t&n|e&~n}(e,o,i),a),c)),r(n(t,u),e)}function a(t,e,o,i,a,u,c){return t=r(t,r(r(function(t,e,n){return t^e^n}(e,o,i),a),c)),r(n(t,u),e)}function u(t,e,o,i,a,u,c){return t=r(t,r(r(function(t,e,n){return e^(t|~n)}(e,o,i),a),c)),r(n(t,u),e)}function c(t){var e,n="",r="";for(e=0;e<=3;e++)n+=(r="0"+(t>>>8*e&255).toString(16)).substr(r.length-2,2);return n}var s,l,f,p,d,h,v,y,g,m=Array();for(m=function(t){for(var e,n=t.length,r=n+8,o=16*((r-r%64)/64+1),i=Array(o-1),a=0,u=0;u<n;)a=u%4*8,i[e=(u-u%4)/4]=i[e]|t.charCodeAt(u)<<a,u++;return a=u%4*8,i[e=(u-u%4)/4]=i[e]|128<<a,i[o-2]=n<<3,i[o-1]=n>>>29,i}(t=function(t){t=t.replace(/\r\n/g,"\n");for(var e="",n=0;n<t.length;n++){var r=t.charCodeAt(n);r<128?e+=String.fromCharCode(r):r>127&&r<2048?(e+=String.fromCharCode(r>>6|192),e+=String.fromCharCode(63&r|128)):(e+=String.fromCharCode(r>>12|224),e+=String.fromCharCode(r>>6&63|128),e+=String.fromCharCode(63&r|128))}return e}(t)),h=1732584193,v=4023233417,y=2562383102,g=271733878,s=0;s<m.length;s+=16)l=h,f=v,p=y,d=g,h=o(h,v,y,g,m[s+0],7,3614090360),g=o(g,h,v,y,m[s+1],12,3905402710),y=o(y,g,h,v,m[s+2],17,606105819),v=o(v,y,g,h,m[s+3],22,3250441966),h=o(h,v,y,g,m[s+4],7,4118548399),g=o(g,h,v,y,m[s+5],12,1200080426),y=o(y,g,h,v,m[s+6],17,2821735955),v=o(v,y,g,h,m[s+7],22,4249261313),h=o(h,v,y,g,m[s+8],7,1770035416),g=o(g,h,v,y,m[s+9],12,2336552879),y=o(y,g,h,v,m[s+10],17,4294925233),v=o(v,y,g,h,m[s+11],22,2304563134),h=o(h,v,y,g,m[s+12],7,1804603682),g=o(g,h,v,y,m[s+13],12,4254626195),y=o(y,g,h,v,m[s+14],17,2792965006),h=i(h,v=o(v,y,g,h,m[s+15],22,1236535329),y,g,m[s+1],5,4129170786),g=i(g,h,v,y,m[s+6],9,3225465664),y=i(y,g,h,v,m[s+11],14,643717713),v=i(v,y,g,h,m[s+0],20,3921069994),h=i(h,v,y,g,m[s+5],5,3593408605),g=i(g,h,v,y,m[s+10],9,38016083),y=i(y,g,h,v,m[s+15],14,3634488961),v=i(v,y,g,h,m[s+4],20,3889429448),h=i(h,v,y,g,m[s+9],5,568446438),g=i(g,h,v,y,m[s+14],9,3275163606),y=i(y,g,h,v,m[s+3],14,4107603335),v=i(v,y,g,h,m[s+8],20,1163531501),h=i(h,v,y,g,m[s+13],5,2850285829),g=i(g,h,v,y,m[s+2],9,4243563512),y=i(y,g,h,v,m[s+7],14,1735328473),h=a(h,v=i(v,y,g,h,m[s+12],20,2368359562),y,g,m[s+5],4,4294588738),g=a(g,h,v,y,m[s+8],11,2272392833),y=a(y,g,h,v,m[s+11],16,1839030562),v=a(v,y,g,h,m[s+14],23,4259657740),h=a(h,v,y,g,m[s+1],4,2763975236),g=a(g,h,v,y,m[s+4],11,1272893353),y=a(y,g,h,v,m[s+7],16,4139469664),v=a(v,y,g,h,m[s+10],23,3200236656),h=a(h,v,y,g,m[s+13],4,681279174),g=a(g,h,v,y,m[s+0],11,3936430074),y=a(y,g,h,v,m[s+3],16,3572445317),v=a(v,y,g,h,m[s+6],23,76029189),h=a(h,v,y,g,m[s+9],4,3654602809),g=a(g,h,v,y,m[s+12],11,3873151461),y=a(y,g,h,v,m[s+15],16,530742520),h=u(h,v=a(v,y,g,h,m[s+2],23,3299628645),y,g,m[s+0],6,4096336452),g=u(g,h,v,y,m[s+7],10,1126891415),y=u(y,g,h,v,m[s+14],15,2878612391),v=u(v,y,g,h,m[s+5],21,4237533241),h=u(h,v,y,g,m[s+12],6,1700485571),g=u(g,h,v,y,m[s+3],10,2399980690),y=u(y,g,h,v,m[s+10],15,4293915773),v=u(v,y,g,h,m[s+1],21,2240044497),h=u(h,v,y,g,m[s+8],6,1873313359),g=u(g,h,v,y,m[s+15],10,4264355552),y=u(y,g,h,v,m[s+6],15,2734768916),v=u(v,y,g,h,m[s+13],21,1309151649),h=u(h,v,y,g,m[s+4],6,4149444226),g=u(g,h,v,y,m[s+11],10,3174756917),y=u(y,g,h,v,m[s+2],15,718787259),v=u(v,y,g,h,m[s+9],21,3951481745),h=r(h,l),v=r(v,f),y=r(y,p),g=r(g,d);return 32==e?(c(h)+c(v)+c(y)+c(g)).toLowerCase():(c(v)+c(y)).toLowerCase()}
function sha1(msg){function rotate_left(n,s){var t4=(n<<s)|(n>>>(32-s));return t4};function lsb_hex(val){var str='';var i;var vh;var vl;for(i=0;i<=6;i+=2){vh=(val>>>(i*4+4))&0x0f;vl=(val>>>(i*4))&0x0f;str+=vh.toString(16)+vl.toString(16)}return str};function cvt_hex(val){var str='';var i;var v;for(i=7;i>=0;i--){v=(val>>>(i*4))&0x0f;str+=v.toString(16)}return str};function Utf8Encode(string){string=string.replace(/\r\n/g,'\n');var utftext='';for(var n=0;n<string.length;n++){var c=string.charCodeAt(n);if(c<128){utftext+=String.fromCharCode(c)}else if((c>127)&&(c<2048)){utftext+=String.fromCharCode((c>>6)|192);utftext+=String.fromCharCode((c&63)|128)}else{utftext+=String.fromCharCode((c>>12)|224);utftext+=String.fromCharCode(((c>>6)&63)|128);utftext+=String.fromCharCode((c&63)|128)}}return utftext};var blockstart;var i,j;var W=new Array(80);var H0=0x67452301;var H1=0xEFCDAB89;var H2=0x98BADCFE;var H3=0x10325476;var H4=0xC3D2E1F0;var A,B,C,D,E;var temp;msg=Utf8Encode(msg);var msg_len=msg.length;var word_array=new Array();for(i=0;i<msg_len-3;i+=4){j=msg.charCodeAt(i)<<24|msg.charCodeAt(i+1)<<16|msg.charCodeAt(i+2)<<8|msg.charCodeAt(i+3);word_array.push(j)}switch(msg_len%4){case 0:i=0x080000000;break;case 1:i=msg.charCodeAt(msg_len-1)<<24|0x0800000;break;case 2:i=msg.charCodeAt(msg_len-2)<<24|msg.charCodeAt(msg_len-1)<<16|0x08000;break;case 3:i=msg.charCodeAt(msg_len-3)<<24|msg.charCodeAt(msg_len-2)<<16|msg.charCodeAt(msg_len-1)<<8|0x80;break}word_array.push(i);while((word_array.length%16)!=14)word_array.push(0);word_array.push(msg_len>>>29);word_array.push((msg_len<<3)&0x0ffffffff);for(blockstart=0;blockstart<word_array.length;blockstart+=16){for(i=0;i<16;i++)W[i]=word_array[blockstart+i];for(i=16;i<=79;i++)W[i]=rotate_left(W[i-3]^W[i-8]^W[i-14]^W[i-16],1);A=H0;B=H1;C=H2;D=H3;E=H4;for(i=0;i<=19;i++){temp=(rotate_left(A,5)+((B&C)|(~B&D))+E+W[i]+0x5A827999)&0x0ffffffff;E=D;D=C;C=rotate_left(B,30);B=A;A=temp}for(i=20;i<=39;i++){temp=(rotate_left(A,5)+(B^C^D)+E+W[i]+0x6ED9EBA1)&0x0ffffffff;E=D;D=C;C=rotate_left(B,30);B=A;A=temp}for(i=40;i<=59;i++){temp=(rotate_left(A,5)+((B&C)|(B&D)|(C&D))+E+W[i]+0x8F1BBCDC)&0x0ffffffff;E=D;D=C;C=rotate_left(B,30);B=A;A=temp}for(i=60;i<=79;i++){temp=(rotate_left(A,5)+(B^C^D)+E+W[i]+0xCA62C1D6)&0x0ffffffff;E=D;D=C;C=rotate_left(B,30);B=A;A=temp}H0=(H0+A)&0x0ffffffff;H1=(H1+B)&0x0ffffffff;H2=(H2+C)&0x0ffffffff;H3=(H3+D)&0x0ffffffff;H4=(H4+E)&0x0ffffffff}var temp=cvt_hex(H0)+cvt_hex(H1)+cvt_hex(H2)+cvt_hex(H3)+cvt_hex(H4);return temp.toLowerCase()}
function Env(t, e) { class s { constructor(t) { this.env = t } send(t, e = "GET") { t = "string" == typeof t ? { url: t } : t; let s = this.get; return "POST" === e && (s = this.post), new Promise(((e, r) => { s.call(this, t, ((t, s, a) => { t ? r(t) : e(s) })) })) } get(t) { return this.send.call(this.env, t) } post(t) { return this.send.call(this.env, t, "POST") } } return new class { constructor(t, e) { this.name = t, this.http = new s(this), this.data = null, this.dataFile = "box.dat", this.logs = [], this.isMute = !1, this.isNeedRewrite = !1, this.logSeparator = "\n", this.encoding = "utf-8", this.startTime = (new Date).getTime(), Object.assign(this, e), this.log("", `🔔${this.name}, 开始!`) } getEnv() { return "undefined" != typeof $environment && $environment["surge-version"] ? "Surge" : "undefined" != typeof $environment && $environment["stash-version"] ? "Stash" : "undefined" != typeof module && module.exports ? "Node.js" : "undefined" != typeof $task ? "Quantumult X" : "undefined" != typeof $loon ? "Loon" : "undefined" != typeof $rocket ? "Shadowrocket" : "undefined" != typeof $httpClient ? "Surge" : void 0 } isNode() { return "Node.js" === this.getEnv() } isQuanX() { return "Quantumult X" === this.getEnv() } isSurge() { return "Surge" === this.getEnv() } isLoon() { return "Loon" === this.getEnv() } isShadowrocket() { return "Shadowrocket" === this.getEnv() } isStash() { return "Stash" === this.getEnv() } toObj(t, e = null) { try { return JSON.parse(t) } catch { return e } } toStr(t, e = null) { try { return JSON.stringify(t) } catch { return e } } getjson(t, e) { let s = e; if (this.getdata(t)) try { s = JSON.parse(this.getdata(t)) } catch { } return s } setjson(t, e) { try { return this.setdata(JSON.stringify(t), e) } catch { return !1 } } getScript(t) { return new Promise((e => { this.get({ url: t }, ((t, s, r) => e(r))) })) } runScript(t, e) { return new Promise((s => { let r = this.getdata("@chavy_boxjs_userCfgs.httpapi"); r = r ? r.replace(/\n/g, "").trim() : r; let a = this.getdata("@chavy_boxjs_userCfgs.httpapi_timeout"); a = a ? 1 * a : 20, a = e && e.timeout ? e.timeout : a; const [i, o] = r.split("@"), n = { url: `http://${o}/v1/scripting/evaluate`, body: { script_text: t, mock_type: "cron", timeout: a }, headers: { "X-Key": i, Accept: "*/*" }, timeout: a }; this.post(n, ((t, e, r) => s(r))) })).catch((t => this.logErr(t))) } loaddata() { if (!this.isNode()) return {}; { this.fs = this.fs ? this.fs : require("fs"), this.path = this.path ? this.path : require("path"); const t = this.path.resolve(this.dataFile), e = this.path.resolve(process.cwd(), this.dataFile), s = this.fs.existsSync(t), r = !s && this.fs.existsSync(e); if (!s && !r) return {}; { const r = s ? t : e; try { return JSON.parse(this.fs.readFileSync(r)) } catch (t) { return {} } } } } writedata() { if (this.isNode()) { this.fs = this.fs ? this.fs : require("fs"), this.path = this.path ? this.path : require("path"); const t = this.path.resolve(this.dataFile), e = this.path.resolve(process.cwd(), this.dataFile), s = this.fs.existsSync(t), r = !s && this.fs.existsSync(e), a = JSON.stringify(this.data); s ? this.fs.writeFileSync(t, a) : r ? this.fs.writeFileSync(e, a) : this.fs.writeFileSync(t, a) } } lodash_get(t, e, s = void 0) { const r = e.replace(/\[(\d+)\]/g, ".$1").split("."); let a = t; for (const t of r) if (a = Object(a)[t], void 0 === a) return s; return a } lodash_set(t, e, s) { return Object(t) !== t || (Array.isArray(e) || (e = e.toString().match(/[^.[\]]+/g) || []), e.slice(0, -1).reduce(((t, s, r) => Object(t[s]) === t[s] ? t[s] : t[s] = Math.abs(e[r + 1]) >> 0 == +e[r + 1] ? [] : {}), t)[e[e.length - 1]] = s), t } getdata(t) { let e = this.getval(t); if (/^@/.test(t)) { const [, s, r] = /^@(.*?)\.(.*?)$/.exec(t), a = s ? this.getval(s) : ""; if (a) try { const t = JSON.parse(a); e = t ? this.lodash_get(t, r, "") : e } catch (t) { e = "" } } return e } setdata(t, e) { let s = !1; if (/^@/.test(e)) { const [, r, a] = /^@(.*?)\.(.*?)$/.exec(e), i = this.getval(r), o = r ? "null" === i ? null : i || "{}" : "{}"; try { const e = JSON.parse(o); this.lodash_set(e, a, t), s = this.setval(JSON.stringify(e), r) } catch (e) { const i = {}; this.lodash_set(i, a, t), s = this.setval(JSON.stringify(i), r) } } else s = this.setval(t, e); return s } getval(t) { switch (this.getEnv()) { case "Surge": case "Loon": case "Stash": case "Shadowrocket": return $persistentStore.read(t); case "Quantumult X": return $prefs.valueForKey(t); case "Node.js": return this.data = this.loaddata(), this.data[t]; default: return this.data && this.data[t] || null } } setval(t, e) { switch (this.getEnv()) { case "Surge": case "Loon": case "Stash": case "Shadowrocket": return $persistentStore.write(t, e); case "Quantumult X": return $prefs.setValueForKey(t, e); case "Node.js": return this.data = this.loaddata(), this.data[e] = t, this.writedata(), !0; default: return this.data && this.data[e] || null } } initGotEnv(t) { this.got = this.got ? this.got : require("got"), this.cktough = this.cktough ? this.cktough : require("tough-cookie"), this.ckjar = this.ckjar ? this.ckjar : new this.cktough.CookieJar, t && (t.headers = t.headers ? t.headers : {}, void 0 === t.headers.Cookie && void 0 === t.cookieJar && (t.cookieJar = this.ckjar)) } get(t, e = (() => { })) { switch (t.headers && (delete t.headers["Content-Type"], delete t.headers["Content-Length"], delete t.headers["content-type"], delete t.headers["content-length"]), t.params && (t.url += "?" + this.queryStr(t.params)), void 0 === t.followRedirect || t.followRedirect || ((this.isSurge() || this.isLoon()) && (t["auto-redirect"] = !1), this.isQuanX() && (t.opts ? t.opts.redirection = !1 : t.opts = { redirection: !1 })), this.getEnv()) { case "Surge": case "Loon": case "Stash": case "Shadowrocket": default: this.isSurge() && this.isNeedRewrite && (t.headers = t.headers || {}, Object.assign(t.headers, { "X-Surge-Skip-Scripting": !1 })), $httpClient.get(t, ((t, s, r) => { !t && s && (s.body = r, s.statusCode = s.status ? s.status : s.statusCode, s.status = s.statusCode), e(t, s, r) })); break; case "Quantumult X": this.isNeedRewrite && (t.opts = t.opts || {}, Object.assign(t.opts, { hints: !1 })), $task.fetch(t).then((t => { const { statusCode: s, statusCode: r, headers: a, body: i, bodyBytes: o } = t; e(null, { status: s, statusCode: r, headers: a, body: i, bodyBytes: o }, i, o) }), (t => e(t && t.error || "UndefinedError"))); break; case "Node.js": let s = require("iconv-lite"); this.initGotEnv(t), this.got(t).on("redirect", ((t, e) => { try { if (t.headers["set-cookie"]) { const s = t.headers["set-cookie"].map(this.cktough.Cookie.parse).toString(); s && this.ckjar.setCookieSync(s, null), e.cookieJar = this.ckjar } } catch (t) { this.logErr(t) } })).then((t => { const { statusCode: r, statusCode: a, headers: i, rawBody: o } = t, n = s.decode(o, this.encoding); e(null, { status: r, statusCode: a, headers: i, rawBody: o, body: n }, n) }), (t => { const { message: r, response: a } = t; e(r, a, a && s.decode(a.rawBody, this.encoding)) })) } } post(t, e = (() => { })) { const s = t.method ? t.method.toLocaleLowerCase() : "post"; switch (t.body && t.headers && !t.headers["Content-Type"] && !t.headers["content-type"] && (t.headers["content-type"] = "application/x-www-form-urlencoded"), t.headers && (delete t.headers["Content-Length"], delete t.headers["content-length"]), void 0 === t.followRedirect || t.followRedirect || ((this.isSurge() || this.isLoon()) && (t["auto-redirect"] = !1), this.isQuanX() && (t.opts ? t.opts.redirection = !1 : t.opts = { redirection: !1 })), this.getEnv()) { case "Surge": case "Loon": case "Stash": case "Shadowrocket": default: this.isSurge() && this.isNeedRewrite && (t.headers = t.headers || {}, Object.assign(t.headers, { "X-Surge-Skip-Scripting": !1 })), $httpClient[s](t, ((t, s, r) => { !t && s && (s.body = r, s.statusCode = s.status ? s.status : s.statusCode, s.status = s.statusCode), e(t, s, r) })); break; case "Quantumult X": t.method = s, this.isNeedRewrite && (t.opts = t.opts || {}, Object.assign(t.opts, { hints: !1 })), $task.fetch(t).then((t => { const { statusCode: s, statusCode: r, headers: a, body: i, bodyBytes: o } = t; e(null, { status: s, statusCode: r, headers: a, body: i, bodyBytes: o }, i, o) }), (t => e(t && t.error || "UndefinedError"))); break; case "Node.js": let r = require("iconv-lite"); this.initGotEnv(t); const { url: a, ...i } = t; this.got[s](a, i).then((t => { const { statusCode: s, statusCode: a, headers: i, rawBody: o } = t, n = r.decode(o, this.encoding); e(null, { status: s, statusCode: a, headers: i, rawBody: o, body: n }, n) }), (t => { const { message: s, response: a } = t; e(s, a, a && r.decode(a.rawBody, this.encoding)) })) } } time(t, e = null) { const s = e ? new Date(e) : new Date; let r = { "M+": s.getMonth() + 1, "d+": s.getDate(), "H+": s.getHours(), "m+": s.getMinutes(), "s+": s.getSeconds(), "q+": Math.floor((s.getMonth() + 3) / 3), S: s.getMilliseconds() }; /(y+)/.test(t) && (t = t.replace(RegExp.$1, (s.getFullYear() + "").substr(4 - RegExp.$1.length))); for (let e in r) new RegExp("(" + e + ")").test(t) && (t = t.replace(RegExp.$1, 1 == RegExp.$1.length ? r[e] : ("00" + r[e]).substr(("" + r[e]).length))); return t } queryStr(t) { let e = ""; for (const s in t) { let r = t[s]; null != r && "" !== r && ("object" == typeof r && (r = JSON.stringify(r)), e += `${s}=${r}&`) } return e = e.substring(0, e.length - 1), e } msg(e = t, s = "", r = "", a) { const i = t => { switch (typeof t) { case void 0: return t; case "string": switch (this.getEnv()) { case "Surge": case "Stash": default: return { url: t }; case "Loon": case "Shadowrocket": return t; case "Quantumult X": return { "open-url": t }; case "Node.js": return }case "object": switch (this.getEnv()) { case "Surge": case "Stash": case "Shadowrocket": default: return { url: t.url || t.openUrl || t["open-url"] }; case "Loon": return { openUrl: t.openUrl || t.url || t["open-url"], mediaUrl: t.mediaUrl || t["media-url"] }; case "Quantumult X": return { "open-url": t["open-url"] || t.url || t.openUrl, "media-url": t["media-url"] || t.mediaUrl, "update-pasteboard": t["update-pasteboard"] || t.updatePasteboard }; case "Node.js": return }default: return } }; if (!this.isMute) switch (this.getEnv()) { case "Surge": case "Loon": case "Stash": case "Shadowrocket": default: $notification.post(e, s, r, i(a)); break; case "Quantumult X": $notify(e, s, r, i(a)); case "Node.js": }if (!this.isMuteLog) { let t = ["", "==============📣系统通知📣=============="]; t.push(e), s && t.push(s), r && t.push(r), console.log(t.join("\n")), this.logs = this.logs.concat(t) } } log(...t) { t.length > 0 && (this.logs = [...this.logs, ...t]), console.log(t.join(this.logSeparator)) } logErr(t, e) { switch (this.getEnv()) { case "Surge": case "Loon": case "Stash": case "Shadowrocket": case "Quantumult X": default: this.log("", `❗️${this.name}, 错误!`, t); break; case "Node.js": this.log("", `❗️${this.name}, 错误!`, t.stack) } } wait(t) { return new Promise((e => setTimeout(e, t))) } done(t = {}) { const e = ((new Date).getTime() - this.startTime) / 1e3; switch (this.log("", `🔔${this.name}, 结束! 🕛 ${e} 秒`), this.log(), this.getEnv()) { case "Surge": case "Loon": case "Stash": case "Shadowrocket": case "Quantumult X": default: $done(t); break; case "Node.js": process.exit(1) } } }(t, e) }
