import * as P from './protocol.js';
import { BleClient } from './ble.js';
import { loadSchema, fallbackGroups, schemaState, GROUP_DEFS } from './schema.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const DEFAULT_SETTINGS = {
  namePrefix: 'DT',
  customServices: '',
  crc: 'sum8',
  chunkSize: 20,
  noResponse: true,
  poll: 200,
  autoPoll: true,
};

const settings = { ...DEFAULT_SETTINGS, ...safeParse(localStorage.getItem('ec.settings')) };
// 旧版本默认值 sum16be 有误，迁移到主包确认的单字节累加和
if (settings.crc === 'sum16be') settings.crc = 'sum8';
const ble = new BleClient(settings);

const state = {
  view: 'dash',
  connected: false,
  deviceName: '',
  deviceId: '',
  gatt: {},
  speed: 0,
  displaySpeed: 0,
  rpm: 0,
  rtd: null,
  learn: null,
  params: {},
  pending: [],
  schema: [],
  rxBuffer: '',
  log: [],
  ota: { running: false, abort: false, ack: false, file: null, bytes: null, name: '' },
  lastFaults: '',
};

function safeParse(s) {
  try {
    return JSON.parse(s) || {};
  } catch (e) {
    return {};
  }
}

let toastTimer = null;
function toast(msg, ms = 2200) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function log(type, text) {
  const t = new Date();
  const time = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}.${String(t.getMilliseconds()).padStart(3, '0')}`;
  state.log.push({ type, text, time });
  if (state.log.length > 500) state.log.shift();
  if (state.view === 'logs') appendLogItem(state.log[state.log.length - 1]);
}

function appendLogItem(item) {
  const list = $('#logList');
  const div = document.createElement('div');
  div.className = 'item';
  const text = item.text;
  if (item.type === 'tx') {
    div.innerHTML = `<span class="t">${item.time}</span><span class="tx">TX</span> ${escapeHtml(text.slice(0, -2))}<span class="crc">${escapeHtml(text.slice(-2))}</span>`;
  } else if (item.type === 'rx') {
    div.innerHTML = `<span class="t">${item.time}</span><span class="rx">RX</span> ${escapeHtml(text.slice(0, -2))}<span class="crc">${escapeHtml(text.slice(-2))}</span>`;
  } else {
    const cls = item.type === 'err' ? 'err' : '';
    div.innerHTML = `<span class="t">${item.time}</span><span class="${cls}">${escapeHtml(text)}</span>`;
  }
  list.appendChild(div);
  while (list.children.length > 300) list.removeChild(list.firstChild);
  list.scrollTop = list.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- 视图切换 ---------- */
function setView(name) {
  state.view = name;
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  $$('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'logs') renderLogs();
  if (name === 'params') renderParams();
  if (name === 'dash') startPoll();
  else stopPoll();
}

/* ---------- BLE ---------- */
ble.addEventListener('log', (e) => {
  const { type, text } = e.detail;
  log(type === 'err' ? 'err' : 'info', text);
  if (/失败|不支持|错误/.test(text) && type === 'err') toast(text.split('\n')[0]);
});

ble.addEventListener('gatt', (e) => {
  state.gatt = e.detail;
  $('#devSvc').textContent = e.detail.service || '--';
  $('#devChr').textContent = `${e.detail.write || '无'} / ${e.detail.notify || '--'}`;
});

ble.addEventListener('state', (e) => {
  state.connected = !!e.detail.connected;
  if (state.connected) {
    state.deviceName = e.detail.name || '';
    state.deviceId = e.detail.id || '';
    $('#devName').textContent = state.deviceName || '--';
    $('#devId').textContent = state.deviceId || '--';
    $('#connSub').textContent = '已连接 ' + (state.deviceName || '');
    $('#btnConnect').textContent = '断开';
    startPoll();
  } else {
    $('#connSub').textContent = '未连接';
    $('#btnConnect').textContent = '连接';
    stopPoll();
    setFault([]);
    $('#faultBanner').textContent = '已断开';
    $('#faultBanner').classList.remove('bad');
  }
  $('#connDot').classList.toggle('on', state.connected);
});

ble.addEventListener('data', (e) => onData(e.detail.hex));

async function connect() {
  if (state.connected) {
    ble.disconnect();
    toast('已断开');
    return;
  }
  const btn = $('#btnConnect');
  btn.disabled = true;
  btn.textContent = '连接中…';
  try {
    await ble.connect();
    setView('dash');
    toast('连接成功');
  } catch (err) {
    log('err', err.message || String(err));
    toast(err.message || '连接失败', 3200);
  } finally {
    btn.disabled = false;
    btn.textContent = state.connected ? '断开' : '连接';
  }
}

function send(payload, note) {
  if (!state.connected) {
    toast('请先连接蓝牙');
    return Promise.reject(new Error('未连接'));
  }
  const frame = P.buildFrame(payload, settings.crc);
  log('tx', frame);
  if (note) log('info', note);
  return ble.sendHex(frame).catch((e) => {
    log('err', '发送失败：' + e.message);
    throw e;
  });
}

function sendRaw(frame, note) {
  if (!state.connected) return Promise.reject(new Error('未连接'));
  log('tx', frame);
  if (note) log('info', note);
  return ble.sendHex(frame).catch((e) => {
    log('err', '发送失败：' + e.message);
    throw e;
  });
}

function waitFrame(matcher, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const entry = { matcher, resolve, reject };
    entry.timer = setTimeout(() => {
      state.pending = state.pending.filter((x) => x !== entry);
      reject(new Error('等待响应超时'));
    }, timeout);
    state.pending.push(entry);
  });
}

function resolvePending(frame) {
  for (const entry of [...state.pending]) {
    if (entry.matcher(frame)) {
      clearTimeout(entry.timer);
      state.pending = state.pending.filter((x) => x !== entry);
      entry.resolve(frame);
    }
  }
}

function onData(hex) {
  log('rx', hex);
  state.rxBuffer = (state.rxBuffer + hex).toUpperCase();
  if (state.rxBuffer.length > 4096) state.rxBuffer = state.rxBuffer.slice(-2048);
  const { frames, rest } = P.extractFrames(state.rxBuffer);
  state.rxBuffer = rest;

  if (state.ota.running) {
    const ack = findControllerAck(hex);
    if (ack) resolveOtaAck(ack);
  }

  for (const f of frames) {
    resolvePending(f);
    if (f.type === '00') handleRtd(f);
    else if (f.type === '03') {
      const text = P.reverseHexBytes(f.data);
      if (/^45[0-9A-F]{6}$/.test(text)) handleErrorFrame(f, text);
      else handleInfo(f);
    } else if (f.type === '02') handleParamFrame(f);
    else if (f.type === '01') handleLearnFrame(f);
  }
}

const ERROR_TEXT = {
  45000001: 'ETOT 传输超时',
  45000002: 'EBDI 无效设备',
  45000004: '数据无效',
  45000008: 'EBMT 无效类型',
  45000010: 'EBMI 无效对象',
  45000020: 'ELEN 长度错误',
  45000040: 'ECRC 校验失败',
  45000080: 'EDNE 对象为空',
  45000100: 'EACC 不支持访问',
  45000200: 'EWOM 只写错误',
  45000400: 'EROM 只读错误',
  45000800: 'EBOF 缓冲区满',
  45001000: 'EBIG 参数太大',
  45002000: 'ESMA 参数太小',
};

function handleErrorFrame(frame, code) {
  const text = ERROR_TEXT[code] || '控制器返回错误 ' + code;
  log('err', `错误帧 msgId ${frame.msgId}：${text}（${code}）`);
  toast(text, 3200);
}

// 参数写帧的确认（数据反序后为 53000001 / 53000002）
function handleParamFrame(frame) {
  const data = P.reverseHexBytes(frame.data);
  if (data === '53000001') log('info', `参数已接收 msgId ${frame.msgId}`);
  else if (data === '53000002') log('info', `参数已保存 msgId ${frame.msgId}`);
}

/* ---------- 实时数据 ---------- */
function sendRtd() {
  if (!state.connected) return;
  const frame = P.buildFrame('050101000000', settings.crc);
  ble.sendHex(frame).catch(() => {});
}

let pollTimer = null;
function startPoll() {
  stopPoll();
  if (!state.connected || !settings.autoPoll || state.view !== 'dash') return;
  sendRtd();
  pollTimer = setInterval(sendRtd, Math.max(100, Number(settings.poll) || 200));
}
function stopPoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function handleRtd(frame) {
  const r = P.parseRtd(frame);
  if (!r) return;
  state.rtd = r;
  state.speed = r.speed;
  state.rpm = r.state2.rpm;
  $('#speedVal').textContent = String(Math.round(r.speed));
  $('#rpmVal').textContent = r.state2.rpm + ' rpm';
  $('#gearLabel').textContent = r.state.gear;
  $('#mVolt').textContent = r.vbus.toFixed(1) + ' V';
  $('#mIbus').textContent = r.ibus.toFixed(1) + ' A';
  $('#mIph').textContent = r.iph.toFixed(1) + ' A';
  $('#mThrottle').textContent = r.state2.throttle + ' %';
  $('#mTpcu').textContent = r.tpcu.toFixed(1) + ' ℃';
  $('#mTmotor').textContent = r.tmotor.toFixed(1) + ' ℃';
  $('#mPitch').textContent = r.pitch.toFixed(1) + '°';
  $('#mRoll').textContent = r.roll.toFixed(1) + '°';
  $('#imuHint').textContent = 'IMU ' + (r.state.imuStatus === 2 ? '就绪' : r.state.imuStatus === 1 ? '校准中' : '未就绪');

  renderStatusChips(r.state.flags);
  setFault(r.faults);

  const f = r.faults;
  if (f.length && f[0] !== '正常' && f.join('|') !== state.lastFaults) {
    state.lastFaults = f.join('|');
    const tip = P.FAULT_TIPS[f[0]];
    if (tip) log('info', '故障提示：' + f[0] + ' - ' + tip);
  }
}

const STATUS_LABELS = [
  ['tractionControl', 'TCS动作'],
  ['motorStall', '堵转'],
  ['brake', '刹车'],
  ['reversing', '倒车'],
  ['repair', '修复'],
  ['powerRecovery', '能量回收'],
  ['cruise', '巡航'],
  ['antiTheft', '防盗'],
  ['parking', '驻车'],
  ['sideStandSwitch', '边撑'],
  ['hillDescentControl', '陡坡缓降'],
  ['seatSensor', '坐垫感应'],
  ['throttleReset', '转把复位'],
  ['powerRecoveryEnable', '动能使能'],
  ['charging', '充电'],
];

function renderStatusChips(flags) {
  const box = $('#statusChips');
  if (!box.dataset.ready) {
    box.innerHTML = STATUS_LABELS.map(([k, label]) => `<span class="chip" data-k="${k}">${label}</span>`).join('');
    box.dataset.ready = '1';
  }
  for (const [k] of STATUS_LABELS) {
    const el = box.querySelector(`[data-k="${k}"]`);
    if (el) el.classList.toggle('on', !!(flags && flags[k]));
  }
}

function setFault(list) {
  const banner = $('#faultBanner');
  const normal = !list || !list.length || list[0] === '正常';
  banner.textContent = normal ? '系统正常' : list.join(' / ');
  banner.classList.toggle('bad', !normal);
  banner.dataset.list = normal ? '' : list.join('|');
}

/* ---------- 设备信息 ---------- */
const INFO_MAP = {
  '01': ['infoModel', '控制器型号'],
  '02': ['infoMotor', '电机控制编号'],
  '03': ['infoApp', '应用程序版本'],
  '04': ['infoBoot', 'Bootloader'],
  '05': ['infoCtrl', '控制板编号'],
  '06': ['infoPower', '功率板编号'],
};

function handleInfo(frame) {
  const info = P.parseInfoFrame(frame);
  if (!info) return;
  const hit = INFO_MAP[info.id];
  if (hit) {
    $('#' + hit[0]).textContent = info.text || '--';
    log('info', `${hit[1]}：${info.text || '(空)'}`);
  }
}

async function readAllInfo() {
  if (!state.connected) return toast('请先连接蓝牙');
  for (const id of Object.keys(INFO_MAP)) {
    try {
      const wait = waitFrame((f) => f.type === '03' && f.msgId === id, 900);
      await send('05010103' + id + '00');
      await wait;
    } catch (e) {
      log('err', `读取 ${INFO_MAP[id][1]} 超时`);
    }
    await delay(120);
  }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 参数页 ---------- */
function paramKey(msgId) {
  return msgId.replace('0x', '').toUpperCase().padStart(2, '0');
}

async function initSchema() {
  await loadSchema();
  state.schema = schemaState.source === 'file' && schemaState.data.length ? schemaState.data : fallbackGroups();
  $('#paramNoticeText').textContent =
    schemaState.source === 'file' && schemaState.data.length
      ? `已加载参数表：${state.schema.length} 组，${state.schema.reduce((n, g) => n + g.fields.length, 0)} 个字段。`
      : '未找到 param-schema.json，当前为原始帧模式。解包 __APP__.wxapkg 生成该文件后，会自动显示完整参数控件。';
  renderParams();
}

function renderParams(openGi) {
  const box = $('#paramGroups');
  if (!box || !state.schema.length) return;
  const open = new Set();
  box.querySelectorAll('details[open]').forEach((d) => open.add(d.dataset.g));
  if (openGi != null) open.add(String(openGi));
  box.innerHTML = state.schema
    .map((g, gi) => {
      if (g.metaReady) return renderMetaGroup(g, gi);
      return renderRawGroup(g, gi);
    })
    .join('');
  box.querySelectorAll('details').forEach((d) => {
    if (open.has(d.dataset.g)) d.open = true;
  });
  bindParamEvents();
}

function renderMetaGroup(g, gi) {
  let gear = null;
  const rows = g.fields
    .map((f, fi) => {
      if (f.hidden) return '';
      let head = '';
      if (f.gear && f.gear !== gear) {
        gear = f.gear;
        head = `<div class="gear-head">${f.gear} 挡</div>`;
      }
      return head + renderFieldRow(g, gi, f, fi);
    })
    .join('');

  return `<details class="param-group" data-g="${gi}">
    <summary><span class="title">${escapeHtml(g.title)}</span><span class="meta">msgId ${g.msgId} · ${g.fields.filter((f) => !f.hidden).length} 项</span></summary>
    <div class="param-body">
      ${rows}
      <div class="param-actions">
        <button class="btn btn-sm" data-action="read" data-g="${gi}">读取</button>
        <button class="btn btn-sm btn-primary" data-action="save" data-g="${gi}">保存</button>
        <button class="btn btn-sm" data-action="reload" data-g="${gi}">撤销</button>
      </div>
      <div class="raw-hex" id="raw-${gi}">未读取</div>
    </div>
  </details>`;
}

function valOf(msgId, id, fallback = 0) {
  const box = state.params[msgId];
  return box && box[id] !== undefined ? box[id] : fallback;
}

function fmtVal(v, f) {
  const n = Number(v);
  let s;
  if (!Number.isFinite(n)) s = String(v);
  else if (f.decimals != null) s = n.toFixed(f.decimals);
  else s = String(n);
  return f.unit ? `${s} ${f.unit}` : s;
}

function renderFieldRow(g, gi, f, fi) {
  const v = Number(valOf(f.msgId, f.id, 0)) || 0;
  let control = '';
  let shown = fmtVal(v, f);

  if (f.type === 'switch') {
    control = `<label class="row"><input type="checkbox" data-g="${gi}" data-f="${fi}" ${v ? 'checked' : ''}> <span class="hint">启用</span></label>`;
    shown = v ? '开启' : '关闭';
  } else if (f.type === 'slider') {
    control = `<input type="range" data-g="${gi}" data-f="${fi}" min="${f.min ?? 0}" max="${f.max ?? 100}" step="${f.step ?? 1}" value="${v}">
      <div class="row"><span class="hint">${escapeHtml(String(f.left ?? f.min ?? 0))}</span><span class="hint">${escapeHtml(String(f.right ?? f.max ?? 100))}</span></div>`;
  } else if (f.type === 'picker' && Array.isArray(f.range)) {
    const opts = f.range
      .map((label, i) => `<option value="${i}" ${i === v ? 'selected' : ''}>${escapeHtml(String(label))}</option>`)
      .join('');
    control = `<select class="input" data-g="${gi}" data-f="${fi}">${opts}</select>`;
    shown = f.range[v] != null ? String(f.range[v]) : String(v);
  } else if (f.type === 'grid-switch' || f.type === 'bit-switch') {
    const bits = f.bits || [];
    const idxs = f.bitIndices || bits.map((_, i) => i);
    control =
      '<div class="bit-grid">' +
      bits
        .map((name, bi) => {
          const bitIdx = idxs[bi] != null ? idxs[bi] : bi;
          const on = (v >> bitIdx) & 1;
          const tip = (f.bitDescs && f.bitDescs[bi]) || '';
          return `<label class="bit-item" title="${escapeHtml(tip)}"><input type="checkbox" data-g="${gi}" data-f="${fi}" data-bit="${bitIdx}" ${on ? 'checked' : ''}><span>${escapeHtml(String(name))}</span></label>`;
        })
        .join('') +
      '</div>';
    shown = '0x' + (v >>> 0).toString(16).toUpperCase().padStart(Math.max(2, f.dlen * 2), '0');
  } else if (f.type === 'bit-picker') {
    const cur = (v >> f.bitIndex) & 1;
    const opts = (f.range || [])
      .map((label, i) => `<option value="${i}" ${i === cur ? 'selected' : ''}>${escapeHtml(String(label))}</option>`)
      .join('');
    control = `<select class="input" data-g="${gi}" data-f="${fi}">${opts}</select>`;
    shown = f.range && f.range[cur] != null ? String(f.range[cur]) : String(cur);
  } else {
    const step = f.step != null ? f.step : f.dr && f.dr < 1 ? f.dr : 1;
    const isText = f.inputType === 'text';
    control = `<input class="input" type="${isText ? 'text' : 'number'}" inputmode="decimal" data-g="${gi}" data-f="${fi}" value="${escapeHtml(String(v))}" step="${step}" ${f.min != null ? `min="${f.min}"` : ''} ${f.max != null ? `max="${f.max}"` : ''}>`;
  }

  const desc = Array.isArray(f.desc) ? f.desc.join('；') : f.desc;
  return `<div class="field">
    <div class="field-head"><span class="label">${escapeHtml(f.label)}</span><span class="val" id="pv-${gi}-${fi}">${escapeHtml(shown)}</span></div>
    ${control}
    ${desc ? `<div class="hint field-desc">${escapeHtml(String(desc))}</div>` : ''}
  </div>`;
}

function refreshGroupLabels(g, gi) {
  const body = $(`.param-group[data-g="${gi}"] .param-body`);
  if (!body) return;
  g.fields.forEach((f, fi) => {
    if (f.hidden) return;
    const out = body.querySelector('#pv-' + gi + '-' + fi);
    if (!out) return;
    const v = Number(valOf(f.msgId, f.id, 0)) || 0;
    let shown = fmtVal(v, f);
    if (f.type === 'switch') {
      shown = v ? '开启' : '关闭';
    } else if (f.type === 'picker' && f.range) {
      shown = f.range[v] != null ? String(f.range[v]) : String(v);
    } else if (f.type === 'bit-picker') {
      const cur = (v >> f.bitIndex) & 1;
      shown = f.range && f.range[cur] != null ? String(f.range[cur]) : String(cur);
      const sel = body.querySelector(`[data-f="${fi}"]`);
      if (sel) sel.value = String(cur);
    } else if (f.type === 'grid-switch' || f.type === 'bit-switch') {
      shown = '0x' + (v >>> 0).toString(16).toUpperCase().padStart(Math.max(2, f.dlen * 2), '0');
      body.querySelectorAll(`input[data-f="${fi}"][data-bit]`).forEach((el) => {
        el.checked = !!(v & (1 << Number(el.dataset.bit)));
      });
    }
    out.textContent = shown;
  });
}


function renderRawGroup(g, gi) {
  const ids = g.fields.map((f) => f.label).join('、');
  return `<details class="param-group" data-g="${gi}">
    <summary><span class="title">${escapeHtml(g.title)}</span><span class="meta">msgId ${g.msgId} · 原始模式</span></summary>
    <div class="param-body">
      <p class="muted">缺少字段元数据（长度/缩放），暂以原始十六进制读写。${escapeHtml(ids)}</p>
      <div class="param-actions">
        <button class="btn btn-sm" data-action="readRaw" data-g="${gi}">读取原始</button>
      </div>
      <div class="raw-hex" id="raw-${gi}">未读取</div>
      <div class="row" style="margin-top:8px">
        <input class="input" id="rawin-${gi}" placeholder="数据体 HEX，例如 0102AABB">
        <button class="btn btn-sm btn-primary" data-action="writeRaw" data-g="${gi}">写入</button>
      </div>
    </div>
  </details>`;
}

function bindParamEvents() {
  const box = $('#paramGroups');
  const onEdit = (e) => {
    const t = e.target;
    if (t.dataset.g == null || t.dataset.f == null) return;
    const gi = +t.dataset.g;
    const g = state.schema[gi];
    if (!g) return;
    const vals = collectGroupValues(g, gi);
    state.params[g.msgId] = { ...(state.params[g.msgId] || {}), ...vals };
    refreshGroupLabels(g, gi);
  };
  box.oninput = onEdit;
  box.onchange = onEdit;
  box.onclick = async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const gi = +btn.dataset.g;
    const g = state.schema[gi];
    if (!g) return;
    const action = btn.dataset.action;
    try {
      if (action === 'read') return await readGroup(g, gi);
      if (action === 'save') return await saveGroup(g, gi);
      if (action === 'reload') return await readGroup(g, gi);
      if (action === 'readRaw') return await readRawGroup(g, gi);
      if (action === 'writeRaw') return await writeRawGroup(g, gi);
    } catch (err) {
      toast(err.message || '操作失败');
    }
  };
}

// 从界面控件收集值；位开关合并成字节，位选择器写回源字段的某一位
function collectGroupValues(g, gi) {
  const body = $(`.param-group[data-g="${gi}"] .param-body`);
  if (!body) return {};
  const out = {};
  g.fields.forEach((f, fi) => {
    if (f.hidden || f.type === 'bit-picker') return;
    if (f.type === 'grid-switch' || f.type === 'bit-switch') {
      let bits = 0;
      body.querySelectorAll(`input[data-f="${fi}"][data-bit]`).forEach((el) => {
        if (el.checked) bits |= 1 << Number(el.dataset.bit);
      });
      out[f.id] = bits >>> 0;
      return;
    }
    const el = body.querySelector(`[data-f="${fi}"]`);
    if (!el) return;
    if (el.type === 'checkbox') out[f.id] = el.checked ? 1 : 0;
    else if (el.type === 'number' || el.type === 'range') {
      const n = Number(el.value);
      out[f.id] = Number.isFinite(n) ? n : 0;
    } else out[f.id] = el.value;
  });
  g.fields.forEach((f, fi) => {
    if (f.type !== 'bit-picker') return;
    const el = body.querySelector(`[data-f="${fi}"]`);
    if (!el) return;
    let base = out[f.id] !== undefined ? Number(out[f.id]) : Number(valOf(f.msgId, f.id, 0));
    base = Number.isFinite(base) ? base : 0;
    if (Number(el.value)) base |= 1 << f.bitIndex;
    else base &= ~(1 << f.bitIndex);
    out[f.id] = base >>> 0;
  });
  return out;
}


async function readMsg(msgId, openGi) {
  if (!state.connected) throw new Error('请先连接蓝牙');
  const id = paramKey(msgId);
  const wait = waitFrame((f) => f.type === '02' && f.msgId === id, 2000);
  await send('05010102' + id + '00');
  const frame = await wait;
  const data = frame.data;

  const layout = schemaState.msgs[msgId];
  if (!layout) {
    state.params[msgId] = { ...(state.params[msgId] || {}), raw: data };
    return data;
  }

  const fields = {};
  for (const f of layout.fields) {
    const slice = data.substr(f.offset * 2, f.dlen * 2);
    if (slice.length < f.dlen * 2) continue;
    fields[f.id] = decodeUiValue(P.decodeField(slice, f), f);
  }
  state.params[msgId] = { ...(state.params[msgId] || {}), ...fields };
  renderParams(openGi);
  return data;
}

function decodeUiValue(v, f) {
  if (f.formType === 2) return v ? 1 : 0;
  if (f.formType === 1 || f.formType === 99) return Math.round(v) >>> 0;
  const dec = f.decimals != null ? f.decimals : f.dr < 1 ? Math.abs(Math.floor(Math.log10(f.dr))) : 2;
  return Number(Number(v).toFixed(Math.min(4, Math.max(0, dec))));
}

async function readGroup(g, gi) {
  if (!state.connected) return toast('请先连接蓝牙');
  const rawEl = $('#raw-' + gi);
  if (rawEl) rawEl.textContent = '读取中…';
  const data = await readMsg(g.msgId, gi);
  const fresh = $('#raw-' + gi);
  if (fresh) fresh.textContent = data;
  toast('读取成功');
}

async function saveGroup(g, gi) {
  if (!state.connected) return toast('请先连接蓝牙');
  const id = paramKey(g.msgId);
  const layout = schemaState.msgs[g.msgId];
  if (!layout) throw new Error('缺少该 msgId 的参数布局');
  const edited = collectGroupValues(g, gi);
  const values = { ...(state.params[g.msgId] || {}), ...edited };

  let data = '';
  for (const f of layout.fields) {
    if (values[f.id] === undefined) throw new Error('请先读取该参数组，再保存');
    data += P.encodeField(values[f.id], f);
  }
  const len = (data.length / 2).toString(16).toUpperCase().padStart(2, '0');
  // 成功确认：type=02，data 反序后为 53000001
  const wait = waitFrame(
    (f) => f.type === '02' && f.msgId === id && P.reverseHexBytes(f.data) === '53000001',
    3000
  );
  await send('05010002' + id + len + data, `写入参数组 ${g.title} (msgId ${g.msgId})`);
  try {
    await wait;
    state.params[g.msgId] = { ...(state.params[g.msgId] || {}), ...edited };
    toast('保存成功');
  } catch (e) {
    toast('未收到确认，请重试');
  }
}

async function readRawGroup(g, gi) {
  if (!state.connected) return toast('请先连接蓝牙');
  const id = paramKey(g.msgId);
  const el = $('#raw-' + gi);
  el.textContent = '读取中…';
  const wait = waitFrame((f) => f.type === '02' && f.msgId === id, 2000);
  await send('05010102' + id + '00');
  const frame = await wait;
  el.textContent = frame.data;
  state.params[g.msgId] = { ...(state.params[g.msgId] || {}), raw: frame.data };
}

async function writeRawGroup(g, gi) {
  if (!state.connected) return toast('请先连接蓝牙');
  const input = $('#rawin-' + gi);
  const data = (input.value || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (!data || data.length % 2) return toast('请输入偶数长度的十六进制数据');
  const id = paramKey(g.msgId);
  const len = (data.length / 2).toString(16).toUpperCase().padStart(2, '0');
  const wait = waitFrame(
    (f) => f.type === '02' && f.msgId === id && P.reverseHexBytes(f.data) === '53000001',
    3000
  );
  await send('05010002' + id + len + data, `原始写入 msgId ${g.msgId}`);
  try {
    await wait;
    toast('已下发');
  } catch (e) {
    toast('未收到确认');
  }
}

async function factoryReset() {
  if (!state.connected) return toast('请先连接蓝牙');
  if (!confirm('确定恢复出厂设置？此操作不可撤销。')) return;
  await send('05010002FE0446525354', '恢复出厂设置');
  toast('已下发恢复出厂指令');
}

/* ---------- 自学习 ---------- */
const LEARN_STEPS = ['触发自学习', '电阻电感学习', '霍尔参数学习1', '霍尔参数学习2', '磁链学习', '油门参数学习', '完成'];

function renderLearn() {
  const steps = $('#learnSteps');
  const idx = P.learnStepIndex(state.learn);
  steps.innerHTML = LEARN_STEPS.map((s, i) => {
    const cls = idx < 0 ? '' : i < idx ? 'done' : i === idx ? 'active' : '';
    return `<div class="learn-step ${cls}"><i></i>${s}</div>`;
  }).join('');
  $('#learnStatus').textContent = P.learnStatusText(state.learn);
  $('#learnSeconds').textContent = state.learn ? `${state.learn.seconds}s` : '--';
}

function handleLearnFrame(frame) {
  if (frame.msgId === '08') {
    const s = P.parseLearnStatus(frame);
    if (s) {
      state.learn = { ...(state.learn || {}), ...s };
      renderLearn();
      renderLearnResults();
    }
    return;
  }
  if (frame.msgId === '00') {
    const p = P.parseLearnParams(frame);
    if (p) {
      state.learn = { ...(state.learn || {}), params: p };
      renderLearn();
      renderLearnResults();
    }
  }
}

function renderLearnResults() {
  const l = state.learn || {};
  const p = l.params;
  const r = l.results;
  const rows = [];
  if (p) {
    rows.push(['额定转速', p.speedRPM + ' rpm']);
    rows.push(['加速度', p.accelRPMs + ' rpm/s']);
    rows.push(['相电流参考', p.iphRefA + ' A']);
    rows.push(['电流爬升时间', p.irampMs + ' ms']);
    rows.push(['模式', String(p.mode)]);
    rows.push(['传感器类型', String(p.sensorType)]);
  }
  if (r) {
    rows.push(['电阻辨识', String(r.dianzhu)]);
    rows.push(['D 轴电感', String(r.diangand)]);
    rows.push(['Q 轴电感', String(r.dianganq)]);
    rows.push(['磁链', String(r.cilian)]);
    rows.push(['角度', r.jiaodu + '°']);
    rows.push(['转把方向', r.zbxiang]);
    rows.push(['转把最大', String(r.zbmax)]);
    rows.push(['转把最小', String(r.zbmin)]);
  }
  $('#learnResults').innerHTML = rows.length
    ? rows.map(([k, v]) => `<div><span>${escapeHtml(k)}</span><b>${escapeHtml(String(v))}</b></div>`).join('')
    : '<span class="muted">暂无数据</span>';
}

async function learnCmd(payload, note) {
  if (!state.connected) return toast('请先连接蓝牙');
  await send(payload, note);
}

/* ---------- OTA ---------- */
function otaLog(line) {
  const box = $('#otaLog');
  const div = document.createElement('div');
  div.textContent = `[${new Date().toLocaleTimeString()}] ${line}`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function setOtaState(text) {
  $('#otaState').textContent = text;
}

async function pickFirmware(file) {
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let data;
    const head = new TextDecoder().decode(bytes.slice(0, 64));
    if (head.includes(':') || /\.hex$/i.test(file.name)) {
      data = P.parseIntelHex(new TextDecoder().decode(bytes));
    } else {
      data = bytes;
    }
    const pad = (128 - (data.length % 128)) % 128;
    if (pad) {
      const padded = new Uint8Array(data.length + pad).fill(0xff);
      padded.set(data);
      data = padded;
    }
    state.ota.bytes = data;
    state.ota.name = file.name;
    state.ota.crc = P.crc32Add(data);
    const frames = data.length / 128;
    $('#otaFileInfo').innerHTML = `文件：${escapeHtml(file.name)}<br>大小：${data.length} 字节（${frames} 帧）<br>校验和：${state.ota.crc.toString(16).toUpperCase().padStart(8, '0')}`;
    $('#btnOtaStart').disabled = false;
    otaLog(`已载入 ${file.name}，${data.length} 字节`);
  } catch (e) {
    toast('固件解析失败：' + e.message, 3000);
    otaLog('解析失败：' + e.message);
  }
}

const IAP_ERROR = {
  '01': '固件超大小',
  '02': '擦除失败',
  '03': '写入失败',
  '04': '未锁车',
  '05': '丢包',
  '07': '数据格式错误',
  '08': '校验失败',
  '09': '复位失败',
};

// 控制器 IAP 应答：69 96 | h1 | h2，h2=00 成功
function findControllerAck(hex) {
  let i = 0;
  while ((i = hex.indexOf('6996', i)) >= 0) {
    const h1 = hex.substr(i + 4, 2);
    const h2 = hex.substr(i + 6, 2);
    if (h2 === '00' || IAP_ERROR[h2]) return { h1, h2 };
    i += 4;
  }
  return null;
}

let otaAckWaiters = [];
function resolveOtaAck(ack) {
  const list = otaAckWaiters;
  otaAckWaiters = [];
  list.forEach((w) => w(ack));
}

function waitOtaAck(timeout = 1200) {
  return new Promise((resolve) => {
    let done = false;
    const cb = (ack) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(ack);
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      otaAckWaiters = otaAckWaiters.filter((x) => x !== cb);
      resolve(null);
    }, timeout);
    otaAckWaiters.push(cb);
  });
}

async function sendOtaCmd(frame, label, expectH1, retries = 6) {
  for (let i = 0; i < retries; i++) {
    if (state.ota.abort) throw new Error('已中止');
    const wait = waitOtaAck(1200);
    await sendRaw(frame, label);
    const ack = await wait;
    if (ack) {
      if (ack.h2 !== '00') {
        throw new Error(`${label}：${IAP_ERROR[ack.h2] || '错误码 ' + ack.h2}`);
      }
      if (!expectH1 || ack.h1 === expectH1) return true;
    }
    otaLog(`${label} 第 ${i + 1} 次未收到应答，重试…`);
  }
  throw new Error(label + ' 无应答');
}

async function runOta() {
  const bytes = state.ota.bytes;
  if (!state.connected) return toast('请先连接蓝牙');
  if (!bytes) return toast('请先选择固件');
  if (!confirm('开始升级？请确保车辆断电或架空，升级过程中不要断开蓝牙。')) return;

  const ota = state.ota;
  ota.running = true;
  ota.abort = false;
  $('#btnOtaStart').disabled = true;
  $('#btnOtaAbort').disabled = false;
  $('#btnPickFw').disabled = true;
  $('#otaBar').style.width = '0%';
  $('#otaLog').innerHTML = '';
  setOtaState('升级中');

  const frames = bytes.length / 128;
  try {
    otaLog(`开始：${bytes.length} 字节 / ${frames} 帧`);
    await sendOtaCmd(P.iap.start(bytes.length), 'IAP 开始', '25');
    otaLog('IAP 开始帧已确认');

    for (let i = 0; i < frames; i++) {
      if (ota.abort) throw new Error('已中止');
      const chunk = P.bytesToHex(bytes.subarray(i * 128, (i + 1) * 128));
      const seq = i % 256;
      await sendOtaCmd(P.iap.frame(seq, chunk), `第 ${i + 1}/${frames} 帧`, '0B', 4);
      const pct = ((i + 1) / frames) * 100;
      $('#otaBar').style.width = pct.toFixed(1) + '%';
      if ((i + 1) % 10 === 0 || i + 1 === frames) otaLog(`已发送 ${i + 1}/${frames} 帧`);
      await delay(100);
    }

    await sendOtaCmd(P.iap.verify(ota.crc), '校验', null, 3);
    otaLog('校验帧已确认，等待模块校验…');
    setOtaState('校验中');
    await delay(1200);
    await sendOtaCmd(P.iap.reset(), '复位', null, 2).catch(() => otaLog('复位帧无应答（可能已重启）'));
    $('#otaBar').style.width = '100%';
    setOtaState('完成');
    toast('升级成功');
    otaLog('升级流程结束');
  } catch (e) {
    setOtaState('失败');
    otaLog('失败：' + e.message);
    toast('升级失败：' + e.message, 3200);
  } finally {
    ota.running = false;
    $('#btnOtaStart').disabled = !state.ota.bytes;
    $('#btnOtaAbort').disabled = true;
    $('#btnPickFw').disabled = false;
  }
}

/* ---------- 日志 ---------- */
function renderLogs() {
  const list = $('#logList');
  list.innerHTML = '';
  if (!state.log.length) {
    list.innerHTML = '<div class="muted">暂无收发记录。连接后会自动记录每一帧收发数据。</div>';
    return;
  }
  for (const item of state.log) appendLogItem(item);
}

/* ---------- 仪表绘制 ---------- */
function drawGauge(v) {
  const cvs = $('#gauge');
  if (!cvs) return;
  const ctx = cvs.getContext('2d');
  const W = 720;
  const cx = 360;
  const cy = 360;
  const R = 320;
  const start = Math.PI * 0.75;
  const sweep = Math.PI * 1.5;
  const max = 300;
  const ratio = Math.max(0, Math.min(1, v / max));

  ctx.clearRect(0, 0, W, W);

  // 外圈
  ctx.beginPath();
  ctx.arc(cx, cy, R - 26, 0, Math.PI * 2);
  ctx.strokeStyle = '#171e26';
  ctx.lineWidth = 2;
  ctx.stroke();

  // 底弧
  ctx.beginPath();
  ctx.arc(cx, cy, R - 40, start, start + sweep);
  ctx.strokeStyle = '#1b232c';
  ctx.lineWidth = 26;
  ctx.lineCap = 'round';
  ctx.stroke();

  // 数值弧
  if (ratio > 0.002) {
    const grad = ctx.createLinearGradient(120, 640, 600, 80);
    grad.addColorStop(0, '#2ee39c');
    grad.addColorStop(0.65, '#79e86a');
    grad.addColorStop(1, '#ffb020');
    ctx.beginPath();
    ctx.arc(cx, cy, R - 40, start, start + sweep * ratio);
    ctx.strokeStyle = grad;
    ctx.lineWidth = 26;
    ctx.shadowColor = 'rgba(53,224,161,.55)';
    ctx.shadowBlur = 24;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  // 刻度
  for (let i = 0; i <= max; i += 10) {
    const t = i / max;
    const a = start + sweep * t;
    const major = i % 20 === 0;
    const r1 = R - 76;
    const r2 = r1 - (major ? 20 : 10);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
    ctx.strokeStyle = major ? '#8ba0b3' : '#3b4755';
    ctx.lineWidth = major ? 3 : 2;
    ctx.stroke();
    if (major) {
      const rr = r2 - 24;
      ctx.font = '600 22px ui-monospace, Consolas, monospace';
      ctx.fillStyle = '#7f8fa0';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i), cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    }
  }

  // 指针
  const a = start + sweep * ratio;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(a);
  ctx.shadowColor = 'rgba(53,224,161,.75)';
  ctx.shadowBlur = 20;
  ctx.beginPath();
  ctx.moveTo(-28, 0);
  ctx.lineTo(R - 110, -7);
  ctx.lineTo(R - 96, 0);
  ctx.lineTo(R - 110, 7);
  ctx.closePath();
  ctx.fillStyle = '#35e0a1';
  ctx.fill();
  ctx.restore();

  // 中心盖
  ctx.beginPath();
  ctx.arc(cx, cy, 26, 0, Math.PI * 2);
  ctx.fillStyle = '#0d1217';
  ctx.fill();
  ctx.strokeStyle = '#2b3742';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, 7, 0, Math.PI * 2);
  ctx.fillStyle = '#35e0a1';
  ctx.fill();
}

function loop() {
  state.displaySpeed += (state.speed - state.displaySpeed) * 0.16;
  if (Math.abs(state.speed - state.displaySpeed) < 0.2) state.displaySpeed = state.speed;
  if (state.view === 'dash') drawGauge(state.displaySpeed);
  requestAnimationFrame(loop);
}

/* ---------- 设置 ---------- */
function openSettings() {
  $('#setNamePrefix').value = settings.namePrefix || '';
  $('#setServiceUuid').value = settings.customServices || '';
  $('#setCrc').value = settings.crc;
  $('#setChunk').value = settings.chunkSize;
  $('#setNoResp').checked = !!settings.noResponse;
  $('#setPoll').value = settings.poll;
  $('#setAutoPoll').checked = !!settings.autoPoll;
  $('#settings').showModal();
}

function saveSettings() {
  const prevPrefix = settings.namePrefix;
  const prevSvc = settings.customServices;
  settings.namePrefix = $('#setNamePrefix').value.trim();
  settings.customServices = $('#setServiceUuid').value.trim();
  settings.crc = $('#setCrc').value;
  settings.chunkSize = Math.max(8, Math.min(512, Number($('#setChunk').value) || 20));
  settings.noResponse = $('#setNoResp').checked;
  settings.poll = Math.max(100, Math.min(2000, Number($('#setPoll').value) || 200));
  settings.autoPoll = $('#setAutoPoll').checked;
  localStorage.setItem('ec.settings', JSON.stringify(settings));
  $('#devCrc').textContent = P.CRC_MODES[settings.crc] || settings.crc;
  startPoll();
  if (prevPrefix !== settings.namePrefix || prevSvc !== settings.customServices) {
    toast('设备前缀/服务 UUID 已修改，重连后生效');
  } else {
    toast('设置已保存');
  }
}

/* ---------- 事件绑定 ---------- */
function bind() {
  $('#btnConnect').addEventListener('click', connect);
  $('#btnSettings').addEventListener('click', openSettings);
  $('#btnSaveSettings').addEventListener('click', saveSettings);

  $$('.tabbar button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

  $('#faultBanner').addEventListener('click', () => {
    const list = ($('#faultBanner').dataset.list || '').split('|').filter(Boolean);
    if (!list.length) return toast('系统正常');
    const tip = list.map((f) => (P.FAULT_TIPS[f] ? `${f}：${P.FAULT_TIPS[f]}` : f)).join('\n');
    alert(tip);
  });

  $('#btnFactory').addEventListener('click', factoryReset);
  $('#btnReadInfo').addEventListener('click', readAllInfo);
  $('#btnDiscover').addEventListener('click', async () => {
    if (!state.connected) return toast('请先连接蓝牙');
    try {
      await ble.discover();
      toast('已重新枚举服务');
    } catch (e) {
      toast(e.message);
    }
  });

  // 自学习
  $('#btnLearnRead').addEventListener('click', async () => {
    await learnCmd('050101010800', '读取自学习状态');
    setTimeout(async () => {
      if (state.connected) await send('050101010000').catch(() => {});
    }, 300);
  });
  $('#btnLearnStart').addEventListener('click', async () => {
    if (!confirm('开始自学习会驱动电机，请确认车辆已架空。继续？')) return;
    await learnCmd('050100010701AA', '触发自学习');
    state.learn = { state: '01', sub: '00', seconds: 0 };
    renderLearn();
  });
  $('#btnLearnDir').addEventListener('click', () => learnCmd('05010001080155', '切换电机方向'));
  $('#btnLearnSave').addEventListener('click', () => learnCmd('05010001090155', '保存自学习参数'));

  // OTA
  $('#btnPickFw').addEventListener('click', () => $('#otaFile').click());
  $('#otaFile').addEventListener('change', (e) => pickFirmware(e.target.files[0]));
  $('#btnOtaStart').addEventListener('click', runOta);
  $('#btnOtaAbort').addEventListener('click', () => {
    state.ota.abort = true;
    otaLog('已请求中止');
  });

  // 日志
  $('#btnLogClear').addEventListener('click', () => {
    state.log = [];
    renderLogs();
  });
  $('#btnLogCopy').addEventListener('click', async () => {
    const text = state.log.map((l) => `${l.time} ${l.type.toUpperCase()} ${l.text}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制');
    } catch (e) {
      toast('复制失败');
    }
  });
  $('#btnRawSend').addEventListener('click', () => {
    const v = ($('#rawCmd').value || '').replace(/[^0-9a-fA-F]/g, '');
    if (!v) return toast('请输入指令');
    send(v.toUpperCase()).catch((e) => toast(e.message));
  });
  $$('button[data-cmd]').forEach((b) =>
    b.addEventListener('click', () => {
      $('#rawCmd').value = b.dataset.cmd;
      send(b.dataset.cmd).catch((e) => toast(e.message));
    })
  );

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopPoll();
    else startPoll();
  });
}

/* ---------- 启动 ---------- */
async function main() {
  bind();
  renderStatusChips(null);
  setFault([]);
  renderLearn();
  drawGauge(0);
  requestAnimationFrame(loop);
  $('#devCrc').textContent = P.CRC_MODES[settings.crc] || settings.crc;
  await initSchema();

  const initial = new URLSearchParams(location.search).get('view');
  if (initial && $('#view-' + initial)) setView(initial);

  if (!navigator.bluetooth) {
    toast('当前浏览器不支持 Web Bluetooth，请用 Android Chrome / Edge', 4000);
    log('err', '浏览器不支持 Web Bluetooth。请使用 HTTPS 或 localhost 打开。');
  } else if (!window.isSecureContext) {
    toast('需要通过 HTTPS 或 localhost 打开才能使用蓝牙', 4000);
  }
}

main();
