'use strict';

const MIN_STAGES = 1;
const MAX_STAGES = 3;
const MAX_TEETH = 100000;
const MAX_FRAC_DEN = '1000000000000';
const MAX_FRAC_VALUE = 1000000000000;

const stageRowsBox = document.getElementById('stage-rows');
const form = document.getElementById('backlash-form');
const formError = document.getElementById('form-error');
const resultPanel = document.getElementById('result-panel');
const resultSummary = document.getElementById('result-summary');
const verdictAlert = document.getElementById('verdict-alert');
const resultDetail = document.getElementById('result-detail');

const EXAMPLE_STAGES = [
  { driveTeeth: 20, drivenTeeth: 40, backlashLow: '1/20', backlashHigh: '1/10' },
  { driveTeeth: 24, drivenTeeth: 36, backlashLow: '1/6', backlashHigh: '1/3' },
];

function el(tag, className, html) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

/* ---------------- 齿轮级行 ---------------- */

function addStageRow(driveTeeth = '', drivenTeeth = '', backlashLow = '', backlashHigh = '') {
  const row = el('div', 'backlash-row');
  row.innerHTML = `
    <span class="backlash-index"></span>
    <input class="stage-drive-input" type="number" min="1" max="100000" step="1" placeholder="主动齿数" value="${driveTeeth}" />
    <input class="stage-driven-input" type="number" min="1" max="100000" step="1" placeholder="从动齿数" value="${drivenTeeth}" />
    <input class="backlash-low-input" type="text" inputmode="text" placeholder="如 1/6 或 0.25" value="${backlashLow}" />
    <input class="backlash-high-input" type="text" inputmode="text" placeholder="如 1/3 或 0.5" value="${backlashHigh}" />
    <button type="button" class="btn danger-ghost" title="删除该级">✕</button>`;
  row.querySelector('button').addEventListener('click', () => {
    if (stageRowsBox.querySelectorAll('.backlash-row').length <= MIN_STAGES) {
      alert(`至少保留 ${MIN_STAGES} 级`);
      return;
    }
    row.remove();
    refreshStageIndex();
  });
  stageRowsBox.appendChild(row);
  refreshStageIndex();
}

function refreshStageIndex() {
  const rows = [...stageRowsBox.querySelectorAll('.backlash-row')];
  rows.forEach((r, i) => {
    r.querySelector('.backlash-index').textContent = `第 ${i + 1} 级（轴 ${i + 1} → 轴 ${i + 2}）`;
  });
}

document.getElementById('btn-stage-add').addEventListener('click', () => {
  if (stageRowsBox.querySelectorAll('.backlash-row').length >= MAX_STAGES) {
    alert(`最多 ${MAX_STAGES} 级`);
    return;
  }
  addStageRow();
});

document.getElementById('btn-example').addEventListener('click', () => {
  stageRowsBox.innerHTML = '';
  EXAMPLE_STAGES.forEach((s) => addStageRow(s.driveTeeth, s.drivenTeeth, s.backlashLow, s.backlashHigh));
  document.getElementById('expected-turns').value = '2';
});

/* 初始：示例数据 */
EXAMPLE_STAGES.forEach((s) => addStageRow(s.driveTeeth, s.drivenTeeth, s.backlashLow, s.backlashHigh));

/* ---------------- 采集与校验 ---------------- */

function parsePosInt(v, label, max) {
  const s = String(v).trim();
  if (!/^\d+$/.test(s)) throw new Error(`${label}需为正整数`);
  const n = Number(s);
  if (n < 1 || n > max) throw new Error(`${label}需为 1～${max} 的正整数`);
  return n;
}

/** 非负分数（p/q 或十进制小数，含 0）的宽松客户端预校验，精确判定以后端为准 */
function parseNonNegFraction(v, label) {
  const s = String(v).trim();
  if (!s) throw new Error(`${label}不能为空（无齿隙请填 0）`);
  let num;
  let den;
  if (s.includes('/')) {
    const parts = s.split('/');
    if (parts.length !== 2 || !/^\d+$/.test(parts[0].trim()) || !/^\d+$/.test(parts[1].trim())) {
      throw new Error(`${label}格式不正确：分数写法为 p/q（p、q 为非负整数，如 1/6）`);
    }
    num = BigInt(parts[0].trim());
    den = BigInt(parts[1].trim());
    if (den < 1n) throw new Error(`${label}的分母需为正整数`);
  } else {
    if (!/^\d*\.?\d+$/.test(s) && !/^\d+\.?$/.test(s)) {
      throw new Error(`${label}格式不正确：请填非负分数（如 1/6）或小数（如 0.25）`);
    }
    const dec = s.includes('.') ? s.split('.') : [s, ''];
    const fracPart = dec[1] || '';
    den = 10n ** BigInt(fracPart.length);
    num = BigInt(dec[0] || '0') * den + BigInt(fracPart || '0');
  }
  if (num < 0n) throw new Error(`${label}不能为负数`);
  if (den > BigInt(MAX_FRAC_DEN)) throw new Error(`${label}约分前分母过大（上限 ${MAX_FRAC_DEN}）`);
  if (num > BigInt(MAX_FRAC_VALUE) * den) throw new Error(`${label}数值不能超过 ${MAX_FRAC_VALUE}`);
  return { num, den };
}

/** 正分数（期望输出转数） */
function parsePositiveFraction(v, label) {
  const f = parseNonNegFraction(v, label);
  if (f.num <= 0n) throw new Error(`${label}需为正数`);
  return f;
}

function collectStages() {
  const rows = [...stageRowsBox.querySelectorAll('.backlash-row')];
  if (rows.length < MIN_STAGES || rows.length > MAX_STAGES) {
    throw new Error(`级数需为 ${MIN_STAGES}～${MAX_STAGES} 级`);
  }
  return rows.map((row, i) => {
    const drive = parsePosInt(row.querySelector('.stage-drive-input').value, `第 ${i + 1} 级主动齿数`, MAX_TEETH);
    const driven = parsePosInt(row.querySelector('.stage-driven-input').value, `第 ${i + 1} 级从动齿数`, MAX_TEETH);
    const lowF = parseNonNegFraction(
      row.querySelector('.backlash-low-input').value,
      `第 ${i + 1} 级反转齿隙下限`,
    );
    const highF = parseNonNegFraction(
      row.querySelector('.backlash-high-input').value,
      `第 ${i + 1} 级反转齿隙上限`,
    );
    if (lowF.num * highF.den > highF.num * lowF.den) {
      throw new Error(`第 ${i + 1} 级反转齿隙下限不能大于上限`);
    }
    return {
      driveTeeth: drive,
      drivenTeeth: driven,
      backlash: {
        low: row.querySelector('.backlash-low-input').value.trim(),
        high: row.querySelector('.backlash-high-input').value.trim(),
      },
    };
  });
}

/* ---------------- 结果渲染 ---------------- */

function fracText(f) {
  return `${f.num}/${f.den} ≈ ${f.decimal}`;
}

function renderRatioTable(data) {
  const wrap = el('div');
  wrap.appendChild(el('h3', 'block-title', '① 各级速比与输出轴总速比（按齿数连乘，精确分数）'));
  const ratioLine = data.stages
    .map((st) => `第 ${st.stage} 级 ${st.driveTeeth}/${st.drivenTeeth} = ${st.stageRatio.num}/${st.stageRatio.den}`)
    .join('，');
  wrap.appendChild(el('p', 'muted', `各级速比（主动/从动）：${ratioLine}`));
  const table = el('table', 'pairs');
  table.innerHTML = `
    <thead><tr><th>级</th><th>主动齿数</th><th>从动齿数</th><th>本级速比</th><th>后续级速比之积 fₖ（折算系数）</th></tr></thead>`;
  const tbody = el('tbody');
  data.stages.forEach((st, i) => {
    const tr = el('tr');
    const factorChain =
      i === data.stages.length - 1
        ? '1（末级）'
        : data.stages
            .slice(i + 1)
            .map((s) => `${s.driveTeeth}/${s.drivenTeeth}`)
            .join(' × ');
    tr.innerHTML = `
      <td>第 ${st.stage} 级（轴 ${i + 1} → 轴 ${i + 2}）</td>
      <td>${st.driveTeeth}</td>
      <td>${st.drivenTeeth}</td>
      <td class="frac">${fracText(st.stageRatio)}</td>
      <td class="frac">${fracText(st.downstreamFactor)}<div class="torque-rated">= ${factorChain}</div></td>`;
    tbody.appendChild(tr);
  });
  const trTotal = el('tr');
  trTotal.innerHTML = `
    <td colspan="3"><strong>输出轴总速比 R（输入轴 → 输出轴）</strong></td>
    <td class="frac" colspan="2"><strong>${fracText(data.totalRatio)}</strong></td>`;
  tbody.appendChild(trTotal);
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function renderFoldTable(data) {
  const wrap = el('div');
  wrap.appendChild(el('h3', 'block-title', '② 各级反转齿隙折算到输出轴（齿隙 × 后续级速比之积）'));
  const table = el('table', 'pairs');
  table.innerHTML = `
    <thead><tr>
      <th>级</th><th>从动轴侧齿隙闭区间（转）</th><th>折算系数 fₖ</th>
      <th>折算空程区间（输出轴转）</th>
    </tr></thead>`;
  const tbody = el('tbody');
  data.stages.forEach((st) => {
    const tr = el('tr');
    tr.innerHTML = `
      <td>第 ${st.stage} 级</td>
      <td class="frac">[${st.backlashLow.num}/${st.backlashLow.den}, ${st.backlashHigh.num}/${st.backlashHigh.den}]
        <div class="torque-rated">[${st.backlashLow.decimal}, ${st.backlashHigh.decimal}]</div></td>
      <td class="frac">${fracText(st.downstreamFactor)}</td>
      <td class="frac">[${st.foldedLow.num}/${st.foldedLow.den}, ${st.foldedHigh.num}/${st.foldedHigh.den}]
        <div class="torque-rated">[${st.foldedLow.decimal}, ${st.foldedHigh.decimal}]</div></td>`;
    tbody.appendChild(tr);
  });
  const trTotal = el('tr');
  trTotal.innerHTML = `
    <td><strong>输出轴总空程区间</strong></td>
    <td class="frac" colspan="2">各级折算区间逐项相加</td>
    <td class="frac"><strong>[${data.backlashTotal.low.num}/${data.backlashTotal.low.den}, ${data.backlashTotal.high.num}/${data.backlashTotal.high.den}]（转）</strong>
      <div class="torque-rated">[${data.backlashTotal.low.decimal}, ${data.backlashTotal.high.decimal}] 转</div></td>`;
  tbody.appendChild(trTotal);
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function renderAnswer(data) {
  const wrap = el('div');
  wrap.appendChild(el('h3', 'block-title', '③ 最少正整数输入圈数与该圈数下的实际输出区间'));

  const expectedText = fracText(data.expectedTurns);
  const box = el('div', `solution ${data.guaranteed ? 'best' : 'miss'}`);
  box.innerHTML = `
    <div class="solution-head">
      <span class="solution-title">输入轴最少反转 <strong>${data.minTurns}</strong> 圈</span>
      <span class="badge">${data.guaranteed ? '保证达标' : '无法保证'}</span>
    </div>
    <div class="solution-meta">
      期望输出至少 <strong>${expectedText}</strong> 转；总速比 R = ${fracText(data.totalRatio)}，
      总空程上界 BH = ${data.backlashTotal.high.num}/${data.backlashTotal.high.den} 转；
      由 <strong>N* = ⌈(期望 + BH) / R⌉</strong> 得 N* = ${data.minTurns}（最小正整数）。
    </div>`;
  wrap.appendChild(box);

  const table = el('table', 'pairs');
  table.innerHTML = `
    <thead><tr><th>输入轴反转圈数 N</th><th>名义输出 N×R（转）</th>
      <th>实际输出转数区间<br/>[max(0,N·R−BH), max(0,N·R−BL)]</th><th>是否保证达到期望</th></tr></thead>`;
  const tbody = el('tbody');

  const nominalFrac = (nText) => ({
    num: (BigInt(nText) * BigInt(data.totalRatio.num)).toString(),
    den: data.totalRatio.den,
  });
  const nominalMin = nominalFrac(data.minTurns);
  const trMin = el('tr');
  trMin.innerHTML = `
    <td><strong>N* = ${data.minTurns}</strong></td>
    <td class="frac">${nominalMin.num}/${nominalMin.den}
      <div class="torque-rated">= ${data.minTurns} × ${data.totalRatio.num}/${data.totalRatio.den}</div></td>
    <td class="frac"><strong>[${data.outputAtMin.low.num}/${data.outputAtMin.low.den}, ${data.outputAtMin.high.num}/${data.outputAtMin.high.den}]</strong>
      <div class="torque-rated">[${data.outputAtMin.low.decimal}, ${data.outputAtMin.high.decimal}] 转</div></td>
    <td>${data.guaranteed ? '<span class="diag-ok">是 ✓（下界 ≥ 期望）</span>' : '<span class="diag-bad">否</span>'}</td>`;
  tbody.appendChild(trMin);

  const trPrev = el('tr');
  if (data.previousTurns === '0') {
    trPrev.innerHTML = `
      <td>N* − 1 = 0</td>
      <td class="frac">0</td>
      <td class="frac">[0, 0]</td>
      <td><span class="diag-bad">否</span><div class="torque-rated">0 圈输出为 0，少于期望，故 1 圈即最小</div></td>`;
  } else {
    const nominalPrev = nominalFrac(data.previousTurns);
    trPrev.innerHTML = `
      <td>N* − 1 = ${data.previousTurns}</td>
      <td class="frac">${nominalPrev.num}/${nominalPrev.den}</td>
      <td class="frac">[${data.outputAtPrevious.low.num}/${data.outputAtPrevious.low.den}, ${data.outputAtPrevious.high.num}/${data.outputAtPrevious.high.den}]
        <div class="torque-rated">[${data.outputAtPrevious.low.decimal}, ${data.outputAtPrevious.high.decimal}] 转</div></td>
      <td>${data.previousGuaranteed ? '<span class="diag-ok">是</span>' : '<span class="diag-bad">否（下界 &lt; 期望）</span>'}<div class="torque-rated">少反转一圈即不能保证，故 N* 为最少圈数</div></td>`;
  }
  tbody.appendChild(trPrev);
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

/* ---------------- 提交 ---------------- */

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  formError.hidden = true;
  resultPanel.hidden = true;

  let payload;
  try {
    const stages = collectStages();
    const expectedRaw = document.getElementById('expected-turns').value.trim();
    parsePositiveFraction(expectedRaw, '期望输出转数'); // 客户端预校验，精确判定以后端为准
    payload = { stages, expectedTurns: expectedRaw };
  } catch (e) {
    formError.textContent = e.message;
    formError.hidden = false;
    return;
  }

  try {
    const resp = await fetch('/api/backlash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '空程预算计算失败');

    resultPanel.hidden = false;
    resultDetail.innerHTML = '';

    resultSummary.textContent =
      `${data.stageCount} 级传动 / ${data.axisCount} 个轴 · 总速比 R = ${data.totalRatio.num}/${data.totalRatio.den}` +
      ` ≈ ${data.totalRatio.decimal} · 最少反转 ${data.minTurns} 圈`;

    verdictAlert.hidden = false;
    verdictAlert.className = `alert ${data.guaranteed ? 'ok' : 'error'}`;
    verdictAlert.innerHTML = `<strong>${data.guaranteed ? '可保证达标' : '无法保证'}：</strong>${data.message}`;

    resultDetail.appendChild(renderRatioTable(data));
    resultDetail.appendChild(renderFoldTable(data));
    resultDetail.appendChild(renderAnswer(data));
  } catch (e) {
    resultPanel.hidden = false;
    resultDetail.innerHTML = '';
    resultSummary.textContent = '';
    verdictAlert.hidden = false;
    verdictAlert.className = 'alert error';
    verdictAlert.textContent = `请求出错：${e.message}`;
  }
});
