// ============================================================
// 复习提醒（study-reminder 能力包，ADR-202 Phase 1 自中枢迁出）
//
// 管什么：到期复习题的主动触达——宿主托管定时器（ctx.timers）按配置间隔检查
//         到期数（sys-hub/各仓库题目权威源），到期>0 且超出冷却时经 ctx.notify
//         发系统通知（点击打开小诺停靠查看到期队列）；可选联动「当日学习规划」写入
//         sys-hub「小诺晨报/规划-日期.md」（M20 语义随包迁移）。
// 不管什么：题目调度/复习队列本身（practice 模块）；晨报（morning-report 包）；
//          托盘到期数状态展示（壳层读 storage 权威源）。
// 落点：学习规划写 sys-hub「小诺晨报/」；冷却时间戳存 plugin_kv 'state'
//       （daemon start 时经注入的 state.load 恢复，通知后 state.save 持久化）。
// ============================================================

const path = require('path')
const { StudyReminder } = require('./study-reminder')

let context = null
let daemon = null

function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 考试冲刺窗口判定已收敛到宿主 studyRhythm() 单一权威（2026-09-23 节奏计划）：
 *  本插件原 sprintInfo 镜像与 quiz-maker 镜像一并删除，冲刺/每日目标一律经 ctx.studyRhythm() 消费。 */

/** 解析学习规划写入仓库：插件配置 report_repo_name > 系统仓库 sys-hub > 第一个仓库 */
async function resolveRepo() {
  const repos = (await context.listRepositories()) || []
  if (repos.length === 0) return null
  let wanted = ''
  try {
    wanted = String(((await context.getConfig()) || {}).report_repo_name || '').trim()
  } catch { /* 配置读取失败按未配置处理 */ }
  if (wanted) {
    const hit = repos.find((r) => String(r.name || '').toLowerCase() === wanted.toLowerCase())
    if (hit) return hit
  }
  return repos.find((r) => r.name === 'sys-hub') || repos[0]
}

/** 最薄弱文档 Top1（正确率<60% 的题目所在文档，与中枢 study_coach 同源 SQL） */
async function weakestDoc() {
  try {
    const rows = await context.query(
      // 文档锚点制 P1（ADR-103 v3）：薄弱单元 = 文档（practice_attempts 按文档聚合）
      `SELECT d.title FROM documents d
       JOIN practice_attempts a ON a.document_id = d.id
       GROUP BY d.id, d.title
       HAVING (SUM(CASE WHEN a.correct = 1 THEN 100.0 ELSE 0 END) * 1.0 / COUNT(*)) < 60
       ORDER BY COUNT(*) DESC LIMIT 1`,
    )
    return rows && rows[0] ? rows[0].title : null
  } catch {
    return null
  }
}

/** M20：到期时生成当日学习规划（LLM）写入 sys-hub「小诺晨报/规划-日期.md」 */
async function writeStudyPlan(dueCount, weakTitles, sprint) {
  let values = {}
  try { values = (await context.getConfig()) || {} } catch { /* 配置读取失败按声明缺省 */ }
  if (values.plan_write_enabled === false) return
  const sprintNote = sprint && sprint.active ? `距考试 ${sprint.daysLeft} 天（冲刺阶段，规划需聚焦考前过题与薄弱点）\n` : ''
  const messages = [
    { role: 'system', content: '你是「小诺」。基于以下数据生成一段不超过 150 字的学习规划建议，直接输出纯文本（不要 Markdown 标题）。语气简洁友好。' },
    { role: 'user', content: `${sprintNote}到期复习题: ${dueCount} 道\n薄弱文档: ${weakTitles.join('、') || '无'}\n请给出今天的学习行动建议。` },
  ]
  const out = await context.llm.complete({ messages, temperature: 0.4, maxTokens: 300, timeoutMs: 60000 })
  const text = String(out || '').trim()
  if (!text) return
  const repo = await resolveRepo()
  if (!repo) return
  const dateStr = localDateStr()
  const planPath = path.join(repo.localPath, '小诺晨报', `规划-${dateStr}.md`)
  await context.writeFile(planPath, `# 学习规划 · ${dateStr}\n\n${text}\n`)
  await context.reindexRepository(repo.id)
  context.log(`学习规划已生成: ${planPath}`)
}

/** 免打扰时段解析（'HH:MM-HH:MM'，支持跨天如 22:00-08:00）；非法/留空返回 null（全天提醒） */
function buildQuietHoursChecker(values) {
  const m = String(values.reminder_quiet_hours || '').trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const start = Number(m[1]) * 60 + Number(m[2])
  const end = Number(m[3]) * 60 + Number(m[4])
  if (start === end) return null
  return () => {
    const d = new Date()
    const cur = d.getHours() * 60 + d.getMinutes()
    return start < end ? cur >= start && cur < end : cur >= start || cur < end
  }
}

/** 今日已答题数（动机触达：通知里的进度感；与学习分析师同口径 SQL，插件隔离各自实现） */
async function todayAnswered() {
  try {
    const rows = await context.query(
      // 文档锚点制 P1：作答流水在 practice_attempts
      `SELECT COUNT(*) AS n FROM practice_attempts WHERE DATE(answered_at, 'localtime') = ?`,
      [localDateStr()],
    )
    return Number(rows?.[0]?.n) || 0
  } catch { return 0 }
}

/** 构建守护实例（参数读插件配置，声明缺省已由宿主合并） */
async function buildDaemon() {
  let values = {}
  try { values = (await context.getConfig()) || {} } catch { /* 配置读取失败按声明缺省 */ }
  const intervalMin = Math.max(1, Number(values.reminder_interval_minutes) || 30)
  const cooldownH = Math.max(1, Number(values.reminder_cooldown_hours) || 4)

  return new StudyReminder({
    getDueCount: async () => {
      const nowIso = new Date().toISOString()
      // 文档锚点制 P1（ADR-103 v3）：到期单元 = 文档
      const rows = await context.query(
        `SELECT COUNT(*) AS n FROM documents WHERE (next_review_at IS NULL OR next_review_at <= ?)`,
        [nowIso],
      )
      return Number(rows?.[0]?.n) || 0
    },
    isQuietHour: buildQuietHoursChecker(values),
    notify: async (dueCount) => {
      // 通知正文附最薄弱 Top1 与今日进度（动机触达）；点击打开小诺停靠查看到期队列（app:focus-view 通道）
      // 冲刺窗口内升级为「距考试 N 天」考前语境（清库建议指向题目库一键开练）
      const sprint = (await context.studyRhythm()).sprint
      const weak = await weakestDoc()
      const weakNote = weak ? `，最薄弱：「${weak}」` : ''
      const answered = await todayAnswered()
      const progressNote = answered > 0 ? `，今日已答 ${answered} 题` : ''
      if (sprint.active) {
        await context.notify.show({
          title: `小诺 · 考试冲刺（距 ${sprint.daysLeft} 天）`,
          body: `距考试 ${sprint.daysLeft} 天：${dueCount} 题到期${weakNote}${progressNote}。建议到「题目库」点「开始做题」考前清库（全部在库题，到期优先）。`,
          click: { type: 'focusView', panelId: 'agent.chat', tab: 'learning' },
        })
        context.log(`考试冲刺提醒已触达: 距 ${sprint.daysLeft} 天，${dueCount} 题到期`)
        return
      }
      await context.notify.show({
        title: '小诺 · 学习提醒',
        body: `今天有 ${dueCount} 道题到期复习${weakNote}${progressNote}，点击进入知识库开始练习。`,
        click: { type: 'focusView', panelId: 'agent.chat', tab: 'learning' },
      })
      context.log(`学习提醒已触达: ${dueCount} 题到期`)
    },
    // M20 随包迁移：提醒触发 → 异步生成学习规划（不阻塞通知，失败不影响提醒）
    onDue: async (dueCount) => {
      try {
        const weakRows = await context.query(
          // 文档锚点制 P1：薄弱单元 = 文档
          `SELECT d.title FROM documents d
           JOIN practice_attempts a ON a.document_id = d.id
           GROUP BY d.id, d.title
           HAVING (SUM(CASE WHEN a.correct = 1 THEN 100.0 ELSE 0 END) * 1.0 / COUNT(*)) < 60
           ORDER BY COUNT(*) DESC LIMIT 3`,
        )
        await writeStudyPlan(dueCount, (weakRows || []).map((r) => r.title).filter(Boolean), (await context.studyRhythm()).sprint)
      } catch (err) {
        context.log(`学习规划生成失败: ${(err && err.message) || err}`)
      }
    },
    log: (msg) => context.log(msg),
    intervalMs: intervalMin * 60 * 1000,
    cooldownMs: cooldownH * 60 * 60 * 1000,
    // 冷却时间戳持久化（plugin_kv 'state'，db:read/db:write 已声明）：重启后冷却期内不重复打扰
    state: {
      load: () => context.storage.get('state', 'lastNotifiedAt'),
      save: (ts) => context.storage.set('state', 'lastNotifiedAt', ts),
    },
    // ADR-202：定时器注入宿主托管——插件停用/卸载自动清理，杜绝自滚 setInterval
    timers: context.timers,
  })
}

/** 启动守护（幂等；配置变更即重建） */
async function startDaemon() {
  if (daemon) {
    daemon.stop()
    daemon = null
  }
  let values = {}
  try { values = (await context.getConfig()) || {} } catch { /* 配置读取失败按声明缺省 */ }
  if (values.reminder_enabled === false) {
    context.log('学习提醒守护未启用（插件配置「学习提醒」可开启）')
    return
  }
  daemon = await buildDaemon()
  await daemon.start()
}

module.exports = {
  id: 'study-reminder',
  name: '复习提醒',
  version: '0.5.0',
  description: '学习提醒守护：定时检查到期复习题，系统通知触达（附最薄弱点），并可自动生成当日学习规划写入 sys-hub「小诺晨报/」',
  usage: '让到期复习不被遗忘：\n1. 激活后自动守护：按检查间隔扫描到期题目，到期>0 且超出冷却时发系统通知（点击通知打开小诺停靠查看到期队列）。\n2. 托盘右键「立即检查复习提醒」——不等间隔手动触发一次检查。\n3. 规划写入开启时，提醒触发会同时让小诺生成当日学习规划，写入 sys-hub「小诺晨报/规划-日期.md」。\n与晨报管家的关系：晨报管家管每日晨报；本插件管到期复习的主动触达与学习规划。',

  async activate(ctx) {
    context = ctx
    await startDaemon()
    context.log('复习提醒已激活（守护定时器 + 托盘检查入口就绪）')
  },

  async deactivate() {
    if (daemon) {
      daemon.stop()
      daemon = null
    }
    context = null
  },

  /** 配置变更即时重建守护（宿主托管定时器随 stop 自动清理） */
  async onConfigChange(namespace) {
    if (namespace !== 'config') return
    if (!context) return
    await startDaemon()
  },

  /** 托盘挂载入口（tray.menu method）：立即检查一次并通知反馈结果 */
  async checkNowFromTray() {
    try {
      if (!daemon) {
        daemon = await buildDaemon()
      }
      // 手动路径只发一条通知（托盘执行器的结果回执，点击打开小诺停靠）；
      // 守护内部通知仅在本次检查窗口内抑制，避免双重弹窗——检查完成后必须复位，
      // 否则常驻守护的自动提醒从此被永久静音
      daemon.suppressNotify = true
      let r
      try {
        // 手动检查是用户主动行为，豁免免打扰时段
        r = await daemon.checkNow({ respectQuiet: false })
      } finally {
        daemon.suppressNotify = false
      }
      return {
        ok: true,
        focus: { panelId: 'agent.chat', tab: 'learning' },
        message:
          r.due > 0
            ? r.notified
              ? `${r.due} 题到期复习（已触达，冷却期内不再重复提醒）`
              : r.reason === 'cooldown'
                ? `${r.due} 题到期复习（冷却期内未重复提醒）`
                : r.reason === 'quiet'
                  ? `${r.due} 题到期复习（免打扰时段，稍后自动提醒）`
                  : `${r.due} 题到期复习`
            : '今日无到期题目',
      }
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) }
    }
  },
}
