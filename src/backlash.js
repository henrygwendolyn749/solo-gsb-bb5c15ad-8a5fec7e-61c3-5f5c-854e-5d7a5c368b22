'use strict';

/**
 * 反向空程预算算法（精确分数，基于 BigInt）
 *
 * 已装好的 1～3 级齿轮传动：第 k 级主动齿数 z_k、从动齿数 w_k，
 * 各级速比（主动/从动）t_k = z_k / w_k，输出轴相对输入轴的总速比
 *   R = t_1 · t_2 · … · t_m（全部以约分分数表示，无浮点误差）。
 *
 * 每级在“从动轴侧”测量反转齿隙闭区间 b_k ∈ [lo_k, hi_k]（非负分数，单位：转），
 * 即该级从动轴反转时先要吃掉的空转角。第 k 级的齿隙折算到输出轴，需乘以
 * 后续各级的速比：
 *   B_k = b_k · (t_{k+1} · … · t_m)
 * （末级后续速比为 1）。输出轴总空程闭区间为各折算区间之和：
 *   [BL, BH] = [Σ lo_k·f_k, Σ hi_k·f_k]，f_k = ∏_{j>k} t_j。
 *
 * 输入轴反转 N 圈（正整数）后，输出轴的实际有向转数区间为
 *   [max(0, N·R − BH), max(0, N·R − BL)]
 * （N·R 为名义转数；齿隙使实际转数在区间内减少，端点同样截断到 0）。
 *
 * 给定期望输出转数 D（正分数），要求“保证”输出至少达到 D，即
 *   N·R − BH ≥ D
 * 满足该式的最小正整数：
 *   N* = ceil((D + BH) / R)（结果若小于 1 取 1）。
 * 同时给出 N* − 1 圈的实际输出下界，证明少一圈都不能保证（下界 < D）。
 */

const { makeFrac, parseDecimal, parseTarget, MIN_TEETH, MAX_TEETH } = require('./search');

/** 级数范围 */
const MIN_STAGES = 1;
const MAX_STAGES = 3;
/** 分数输入约分后分母上限 / 数值上限（防止恶意大整数） */
const MAX_FRAC_DEN = 1000000000000n; // 10¹²
const MAX_FRAC_VALUE = 1000000000000n; // 10¹²

/** 正整数向上取整除法：ceil(a / b)，a、b 均为正 BigInt */
function ceilDiv(a, b) {
  return (a + b - 1n) / b;
}

/**
 * 解析正整数字段（齿数）：接受 JSON number 或纯数字字符串。
 * @returns {{ok:true,value:number}|{ok:false,error:string}}
 */
function parsePositiveInt(raw, label, max) {
  let v;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || !Number.isInteger(raw)) {
      return { ok: false, error: `${label}需为正整数` };
    }
    v = raw;
  } else if (typeof raw === 'string' && /^\s*\d+\s*$/.test(raw)) {
    v = Number(raw.trim());
  } else {
    return { ok: false, error: `${label}需为正整数` };
  }
  if (v < 1 || v > max) {
    return { ok: false, error: `${label}需为 1～${max} 的正整数` };
  }
  return { ok: true, value: v };
}

/**
 * 解析非负分数：接受 number 或字符串；字符串支持 p/q（p、q 为非负 / 正整数）
 * 或十进制小数。要求 0 ≤ 值，且约分后分母 ≤ 10¹²、值 ≤ 10¹²。
 * @returns {{ok:true,frac:object}|{ok:false,error:string}}
 */
function parseNonNegativeFrac(raw, label) {
  let s;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { ok: false, error: `${label}需为有限数值` };
    s = String(raw);
  } else if (typeof raw === 'string') {
    s = raw.trim();
  } else {
    return { ok: false, error: `${label}格式不正确：请填非负分数（如 1/6）或小数（如 0.25）` };
  }
  if (!s) return { ok: false, error: `${label}不能为空（无齿隙请填 0）` };

  let frac;
  if (s.includes('/')) {
    const parts = s.split('/');
    if (
      parts.length !== 2 ||
      !/^\d+$/.test(parts[0].trim()) ||
      !/^\d+$/.test(parts[1].trim())
    ) {
      return { ok: false, error: `${label}格式不正确：分数写法为 p/q（p、q 为非负整数，如 1/6）` };
    }
    const p = BigInt(parts[0].trim());
    const q = BigInt(parts[1].trim());
    if (q < 1n) return { ok: false, error: `${label}的分母需为正整数（当前 ${s}）` };
    frac = makeFrac(p, q);
  } else {
    frac = parseDecimal(s);
    if (!frac) {
      return { ok: false, error: `${label}格式不正确：请填非负分数（如 1/6）或小数（如 0.25）` };
    }
  }

  if (frac.num < 0n) {
    return { ok: false, error: `${label}不能为负数（当前 ${s}）` };
  }
  if (frac.den > MAX_FRAC_DEN) {
    return { ok: false, error: `${label}约分后分母不能超过 ${MAX_FRAC_DEN}（当前 ${frac.den}）` };
  }
  if (frac.num > MAX_FRAC_VALUE * frac.den) {
    return { ok: false, error: `${label}数值不能超过 ${MAX_FRAC_VALUE}（当前 ${s}）` };
  }
  return { ok: true, frac };
}

/**
 * 解析正分数（期望输出转数）：复用选配页的速比解析（小数或 p/q，必须为正）。
 * @returns {{ok:true,frac:object}|{ok:false,error:string}}
 */
function parsePositiveFrac(raw, label) {
  const frac = parseTarget(typeof raw === 'number' ? String(raw) : raw);
  if (!frac) {
    return { ok: false, error: `${label}格式不正确：请填正分数（如 2/3）或正小数（如 1.5）` };
  }
  if (frac.den > MAX_FRAC_DEN) {
    return { ok: false, error: `${label}约分后分母不能超过 ${MAX_FRAC_DEN}（当前 ${frac.den}）` };
  }
  if (frac.num > MAX_FRAC_VALUE * frac.den) {
    return { ok: false, error: `${label}数值不能超过 ${MAX_FRAC_VALUE}` };
  }
  return { ok: true, frac };
}

/**
 * 校验全部请求参数：级数与齿数、每级从动轴侧反转齿隙闭区间、期望输出转数。
 * @param {*} body
 * @returns {{ok:true,stages:Array,expected:object}|{ok:false,error:string}}
 */
function validateBacklashInput(body) {
  const input = body && typeof body === 'object' ? body : {};

  if (!Array.isArray(input.stages)) {
    return { ok: false, error: '级列表（stages）格式不正确' };
  }
  if (input.stages.length < MIN_STAGES || input.stages.length > MAX_STAGES) {
    return {
      ok: false,
      error: `级数需为 ${MIN_STAGES}～${MAX_STAGES} 级（当前 ${
        Array.isArray(input.stages) ? input.stages.length : 0
      } 级）`,
    };
  }

  const stages = [];
  for (let i = 0; i < input.stages.length; i++) {
    const row = input.stages[i];
    if (!row || typeof row !== 'object') {
      return { ok: false, error: `第 ${i + 1} 级数据格式不正确` };
    }
    const drive = parsePositiveInt(row.driveTeeth, `第 ${i + 1} 级主动齿数`, MAX_TEETH);
    if (!drive.ok) return { ok: false, error: drive.error };
    const driven = parsePositiveInt(row.drivenTeeth, `第 ${i + 1} 级从动齿数`, MAX_TEETH);
    if (!driven.ok) return { ok: false, error: driven.error };

    const range = row.backlash;
    if (!range || typeof range !== 'object') {
      return { ok: false, error: `第 ${i + 1} 级缺少从动轴侧反转齿隙闭区间（backlash: {low, high}）` };
    }
    const low = parseNonNegativeFrac(range.low, `第 ${i + 1} 级反转齿隙下限`);
    if (!low.ok) return { ok: false, error: low.error };
    const high = parseNonNegativeFrac(range.high, `第 ${i + 1} 级反转齿隙上限`);
    if (!high.ok) return { ok: false, error: high.error };
    if (low.frac.num * high.frac.den > high.frac.num * low.frac.den) {
      return {
        ok: false,
        error: `第 ${i + 1} 级反转齿隙闭区间下限不能大于上限（当前 ${range.low} ～ ${range.high} 转）`,
      };
    }

    stages.push({
      stage: i + 1,
      driveTeeth: drive.value,
      drivenTeeth: driven.value,
      backlashLow: low.frac,
      backlashHigh: high.frac,
    });
  }

  const expected = parsePositiveFrac(input.expectedTurns, '期望输出转数');
  if (!expected.ok) return { ok: false, error: expected.error };

  return { ok: true, stages, expected: expected.frac };
}

function mulFrac(a, b) {
  return makeFrac(a.num * b.num, a.den * b.den);
}

function addFrac(a, b) {
  return makeFrac(a.num * b.den + b.num * a.den, a.den * b.den);
}

function subFrac(a, b) {
  return makeFrac(a.num * b.den - b.num * a.den, a.den * b.den);
}

/** 非负截断：max(0, f)（f 为精确分数） */
function clampNonNeg(f) {
  return f.num < 0n ? { num: 0n, den: 1n } : f;
}

/** N（BigInt 正整数）圈下的实际输出转数闭区间 [max(0,N·R−BH), max(0,N·R−BL)] */
function outputInterval(N, totalRatio, backLow, backHigh) {
  const nominal = makeFrac(N * totalRatio.num, totalRatio.den);
  return {
    low: clampNonNeg(subFrac(nominal, backHigh)),
    high: clampNonNeg(subFrac(nominal, backLow)),
  };
}

/**
 * 主入口：逐级折算空程 → 输出轴总空程区间 → 最少保证圈数 → 该圈数下输出区间。
 *
 * @param {Array<{stage:number,driveTeeth:number,drivenTeeth:number,backlashLow:object,backlashHigh:object}>} stages
 * @param {{num:bigint,den:bigint}} expected 期望输出转数（正分数）
 */
function planBacklash(stages, expected) {
  const stageCount = stages.length;

  // 各级速比 t_k 与输出轴总速比 R（齿数连乘，精确分数）
  const stageRatios = stages.map((st) =>
    makeFrac(BigInt(st.driveTeeth), BigInt(st.drivenTeeth)),
  );
  let totalRatio = makeFrac(1n, 1n);
  for (const r of stageRatios) totalRatio = mulFrac(totalRatio, r);

  // f_k = ∏_{j>k} t_j：从末级向前累积。f_last = 1
  const downstream = new Array(stageCount);
  let acc = makeFrac(1n, 1n);
  for (let k = stageCount - 1; k >= 0; k--) {
    downstream[k] = acc;
    acc = mulFrac(acc, stageRatios[k]);
  }

  // 每级齿隙折算到输出轴：B_k = b_k · f_k；总空程 [BL, BH] = 各折算区间之和
  let backLow = makeFrac(0n, 1n);
  let backHigh = makeFrac(0n, 1n);
  const stageRows = stages.map((st, i) => {
    const factor = downstream[i];
    const low = mulFrac(st.backlashLow, factor);
    const high = mulFrac(st.backlashHigh, factor);
    backLow = addFrac(backLow, low);
    backHigh = addFrac(backHigh, high);
    return {
      stage: st.stage,
      driveTeeth: st.driveTeeth,
      drivenTeeth: st.drivenTeeth,
      stageRatio: stageRatios[i],
      backlashLow: st.backlashLow,
      backlashHigh: st.backlashHigh,
      downstreamFactor: factor,
      foldedLow: low,
      foldedHigh: high,
    };
  });

  // 最小正整数 N*：N·R ≥ D + BH ⟺ N ≥ (D + BH)/R；ceil，且至少 1
  const threshold = addFrac(expected, backHigh);
  const rawMin = ceilDiv(threshold.num * totalRatio.den, threshold.den * totalRatio.num);
  const minTurns = rawMin < 1n ? 1n : rawMin;

  // 该圈数下的实际输出区间；以及 N*−1 圈（用于证明最小性，N* = 1 时为 0 圈）
  const output = outputInterval(minTurns, totalRatio, backLow, backHigh);
  const prevTurns = minTurns - 1n;
  const previous = outputInterval(prevTurns, totalRatio, backLow, backHigh);
  const guaranteed = subFrac(output.low, expected).num >= 0n;
  const previousGuaranteed = prevTurns > 0n && subFrac(previous.low, expected).num >= 0n;

  const message = buildMessage({
    minTurns,
    expected,
    output,
    backLow,
    backHigh,
    totalRatio,
    guaranteed,
  });

  return {
    stageCount,
    axisCount: stageCount + 1,
    stages: stageRows,
    totalRatio,
    expected,
    backlashLow: backLow,
    backlashHigh: backHigh,
    minTurns,
    output,
    previousTurns: prevTurns,
    previousOutput: previous,
    guaranteed,
    previousGuaranteed,
    message,
  };
}

function buildMessage(ctx) {
  const { minTurns, expected, output, backLow, backHigh, guaranteed } = ctx;
  const backZero = backLow.num === 0n && backHigh.num === 0n;
  const span = backZero
    ? '各级齿隙均为 0，输出轴总空程区间为 [0, 0]'
    : `输出轴总空程区间为 [${backLow.num}/${backLow.den}, ${backHigh.num}/${backHigh.den}] 转`;
  const head = `最少反转输入轴 ${minTurns} 圈即可保证输出达到期望的 ${expected.num}/${expected.den} 转：`;
  const tail = guaranteed
    ? `该圈数下实际输出区间下界 ${output.low.num}/${output.low.den} 转不低于期望值。`
    : '该圈数下仍无法保证达到期望输出，请检查输入数据。';
  return `${head}${span}；${tail}`;
}

module.exports = {
  MIN_STAGES,
  MAX_STAGES,
  MAX_FRAC_DEN,
  MAX_FRAC_VALUE,
  validateBacklashInput,
  planBacklash,
};
