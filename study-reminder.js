// ============================================================
// Knomi Agent - 学习提醒守护（M6a 主动期）
//
// 管什么：定时检查到期复习题（权威源 getQuestionsForReview），
//         到期>0 且超出提醒冷却时发系统通知触达用户 + 日志留痕。
// 不管什么：题目调度本身（SM-2/复习队列）、晨报生成（M6b）、
//          提醒策略配置化（M6c 走 configSchema）。
// 被谁调用：index.js activate（start）/deactivate（stop）/
//          checkStudyReminder（plugin:invoke，E2E 确定性触发口）。
// ============================================================

class StudyReminder {
  /**
   * @param {object} opts
   * @param {() => Promise<number>} opts.getDueCount 到期复习题数（权威源注入）
   * @param {(dueCount: number) => void} opts.notify 通知触达（Electron Notification + 日志，注入式——单测可 mock）
   * @param {(dueCount: number) => void} [opts.onDue] M20 学习教练主动化：到期时生成学习规划（注入式，失败不影响通知）
   * @param {(msg: string) => void} [opts.log] 检查日志
   * @param {number} [opts.intervalMs] 检查间隔（默认 30 分钟）
   * @param {number} [opts.cooldownMs] 提醒冷却（默认 4 小时，防止重复打扰）
   * @param {{load?: () => number|null, save?: (ts: number) => void}} [opts.state]
   *   冷却时间戳持久化（注入式，存 plugin_kv 'state'；可选——缺省纯内存，重启后冷却重置偏保守）
   * @param {() => boolean} [opts.isQuietHour] 免打扰时段判定（注入式；命中时自动检查静默，
   *   reason='quiet'——手动检查可传 { respectQuiet: false } 豁免）
   */
  constructor({ getDueCount, notify, onDue, log, intervalMs = 30 * 60 * 1000, cooldownMs = 4 * 60 * 60 * 1000, timers, state, isQuietHour }) {
    this._getDueCount = getDueCount
    this._notify = notify
    this._onDue = onDue || null
    this._log = log || (() => {})
    this._intervalMs = intervalMs
    this._cooldownMs = cooldownMs
    this._state = state || null
    this._isQuietHour = isQuietHour || null
    /** 上次提醒时间戳（冷却判定；0 = 从未提醒） */
    this.lastNotifiedAt = 0
    /** 手动路径置 true：跳过内部通知（托盘执行器统一发结果回执），冷却时间戳照常更新 */
    this.suppressNotify = false
    this._timer = null
    this._timerKey = 'check'
    this._fallbackTimers = new Map()
    // 定时器注入（ADR-202）：能力包运行时传 ctx.timers 宿主托管，契约签名
    // setInterval(key, fn, intervalMs) → {key, intervalMs} / clearInterval(key)；
    // 缺省退回同契约的进程内实现（单测免注入）。
    // 2026-09-16 事故：本类曾按旧 2 参签名 (fn, ms) 调用宿主——函数落进 key、
    // 毫秒落进 fn，intervalMs=undefined → NaN → 宿主 setInterval 以 1ms 热循环
    // 一夜刷出百万级 timer.error（审计文件 1.3GB）。修复后统一 3 参契约。
    this._timers = timers || {
      setInterval: (key, fn, intervalMs) => {
        const handle = setInterval(fn, intervalMs)
        this._fallbackTimers.set(key, handle)
        return { key, intervalMs, unref: () => handle.unref && handle.unref() }
      },
      clearInterval: (key) => {
        const handle = this._fallbackTimers.get(key)
        if (handle) {
          clearInterval(handle)
          this._fallbackTimers.delete(key)
        }
      },
    }
  }

  /** 启动定时检查（幂等：已启动则忽略；注入 state 时恢复上次冷却时间戳） */
  async start() {
    if (this._timer) return
    try {
      const saved = this._state && this._state.load ? await this._state.load() : null
      if (Number.isFinite(saved) && saved > 0) {
        this.lastNotifiedAt = saved
        this._log(`已恢复上次提醒时间: ${new Date(saved).toLocaleString()}`)
      }
    } catch (err) {
      this._log(`冷却时间恢复失败（按从未提醒处理）: ${(err && err.message) || err}`)
    }
    this._timer = this._timers.setInterval(this._timerKey, () => { void this.checkNow() }, this._intervalMs)
    this._log(`学习提醒守护已启动（每 ${Math.round(this._intervalMs / 60000)} 分钟检查，冷却 ${Math.round(this._cooldownMs / 3600000)} 小时）`)
  }

  /** 停止定时检查（幂等） */
  stop() {
    if (this._timer) {
      this._timers.clearInterval(this._timerKey)
      this._timer = null
      this._log('学习提醒守护已停止')
    }
  }

  /**
   * 立即检查一次：到期>0 且超出冷却 → 触发通知。
   * @param {object} [opts]
   * @param {boolean} [opts.respectQuiet] 是否受免打扰时段约束（默认 true；托盘/快捷键手动检查传 false 豁免）
   * @returns {Promise<{due: number, notified: boolean, reason?: string}>}
   */
  async checkNow(opts = {}) {
    const respectQuiet = opts.respectQuiet !== false
    let due = 0
    try {
      due = (await this._getDueCount()) || 0
    } catch (err) {
      this._log(`学习提醒检查失败: ${(err && err.message) || err}`)
      return { due: 0, notified: false, reason: 'getDueCount failed' }
    }

    if (due <= 0) {
      this._log('学习提醒检查: 无到期题目')
      return { due: 0, notified: false }
    }

    const sinceLast = Date.now() - this.lastNotifiedAt
    if (this.lastNotifiedAt > 0 && sinceLast < this._cooldownMs) {
      this._log(`学习提醒检查: ${due} 题到期，但处于提醒冷却期（距上次 ${Math.round(sinceLast / 60000)} 分钟）`)
      return { due, notified: false, reason: 'cooldown' }
    }

    if (respectQuiet && this._isQuietHour && this._isQuietHour()) {
      this._log(`学习提醒检查: ${due} 题到期，处于免打扰时段，保持静默`)
      return { due, notified: false, reason: 'quiet' }
    }

    try {
      if (!this.suppressNotify) this._notify(due)
      this.lastNotifiedAt = Date.now()
      try {
        if (this._state && this._state.save) this._state.save(this.lastNotifiedAt)
      } catch (err) {
        this._log(`冷却时间持久化失败（不影响本次提醒）: ${(err && err.message) || err}`)
      }
      this._log(`学习提醒已触达: ${due} 题到期`)
      // M20 学习教练主动化：异步生成学习规划（不阻塞通知，失败不影响提醒）
      if (this._onDue) {
        Promise.resolve(this._onDue(due)).catch((err) => {
          this._log(`学习规划生成失败: ${(err && err.message) || err}`)
        })
      }
      return { due, notified: true }
    } catch (err) {
      this._log(`学习提醒通知失败: ${(err && err.message) || err}`)
      return { due, notified: false, reason: 'notify failed' }
    }
  }
}

module.exports = { StudyReminder }
