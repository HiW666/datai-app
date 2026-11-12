// 协议层：帧编解码、CRC、实时数据/故障/状态解析、参数编解码、IAP 固件帧
// 全部基于对 pages_v2_classic 分包的分析，未使用原程序任何素材

export const hexToBytes = (hex) => {
  const h = String(hex || '').replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(Math.floor(h.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
};

export const bytesToHex = (u8) =>
  Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();

export const reverseHexBytes = (hex) => {
  const h = String(hex || '').replace(/[^0-9a-fA-F]/g, '');
  let out = '';
  for (let i = h.length - 2; i >= 0; i -= 2) out += h.substr(i, 2);
  return out.toUpperCase();
};

export const sum16Not = (u8) => {
  let s = 0;
  for (let i = 0; i < u8.length; i++) s = (s + u8[i]) & 0xffff;
  return (~s) & 0xffff;
};

// 主包 crc()：单字节累加和（取低字节），这是控制器的实际帧校验
export const sum8 = (u8) => {
  let s = 0;
  for (let i = 0; i < u8.length; i++) s = (s + u8[i]) & 0xff;
  return s;
};


export const crc16Modbus = (u8) => {
  let crc = 0xffff;
  for (let i = 0; i < u8.length; i++) {
    crc ^= u8[i];
    for (let j = 0; j < 8; j++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc & 0xffff;
};

export const xor8 = (u8) => {
  let x = 0;
  for (let i = 0; i < u8.length; i++) x ^= u8[i];
  return x & 0xff;
};

export const CRC_MODES = {
  sum8: '单字节累加和(默认)',
  sum16be: '累加和取反16位(大端)',
  sum16le: '累加和取反16位(小端)',
  crc16mb: 'CRC16 Modbus(大端)',
  crc16mble: 'CRC16 Modbus(小端)',
  xor8: 'XOR8',
  none: '不追加',
};

export function appendChecksum(payloadHex, mode = 'sum8') {
  const u8 = hexToBytes(payloadHex);
  const be = (v) => v.toString(16).toUpperCase().padStart(4, '0');
  switch (mode) {
    case 'sum16le':
      return reverseHexBytes(be(sum16Not(u8)));
    case 'crc16mb':
      return be(crc16Modbus(u8));
    case 'crc16mble':
      return reverseHexBytes(be(crc16Modbus(u8)));
    case 'xor8':
      return xor8(u8).toString(16).toUpperCase().padStart(2, '0');
    case 'none':
      return '';
    case 'sum16be':
      return be(sum16Not(u8));
    case 'sum8':
    default:
      return sum8(u8).toString(16).toUpperCase().padStart(2, '0');
  }
}

export function buildFrame(payloadHex, mode = 'sum8') {
  const p = String(payloadHex || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  return p + appendChecksum(p, mode);
}

// 响应帧：01 05 02 TT | msgId | len | data(len) | crc(1)
// 从可能粘包的十六进制流中提取完整帧
export function extractFrames(bufferHex) {
  const hex = String(bufferHex || '').toUpperCase();
  const frames = [];
  let i = 0;
  for (;;) {
    const idx = hex.indexOf('010502', i);
    if (idx < 0) break;
    if (idx + 12 > hex.length) break;
    const len = parseInt(hex.substr(idx + 10, 2), 16);
    if (!Number.isFinite(len)) break;
    const end = idx + 12 + len * 2;
    if (end > hex.length) break;
    frames.push({
      raw: hex.slice(idx, end),
      type: hex.substr(idx + 6, 2),
      msgId: hex.substr(idx + 8, 2),
      len,
      data: hex.substr(idx + 12, len * 2),
    });
    i = end + 2; // 跳过 1 字节校验
  }
  const trimmed = hex.length > 128 ? hex.slice(-128) : hex;
  return { frames, rest: frames.length ? hex.slice(i) : trimmed };
}

const leToInt = (hex) => parseInt(reverseHexBytes(hex), 16) || 0;
const leToBig = (hex) => BigInt('0x' + (reverseHexBytes(hex) || '0'));

// 实时数据帧（请求 05 01 01 00 00 00）
export function parseRtd(frame) {
  if (!frame || frame.type !== '00') return null;
  const d = frame.data;
  let p = 0;
  const take = (n) => {
    const s = d.substr(p, n * 2);
    p += n * 2;
    return s;
  };
  if (d.length < 40) return null;
  const out = {
    speed: leToInt(take(2)),
    vbus: +(leToInt(take(2)) * 0.1).toFixed(1),
    ibus: +(leToInt(take(2)) * 0.1).toFixed(1),
    iph: +(leToInt(take(2)) * 0.1).toFixed(1),
    tmotor: +(leToInt(take(2)) * 0.1).toFixed(1),
    tpcu: +(leToInt(take(2)) * 0.1).toFixed(1),
    fault1: leToBig(take(4)),
    fault2: leToBig(take(4)),
    state1: leToBig(take(4)),
    state2: leToBig(take(4)),
    pitch: 0,
    roll: 0,
    yaw: 0,
  };
  if (p + 12 <= d.length) {
    out.pitch = +(leToInt(take(2)) / 32).toFixed(1);
    out.roll = +(leToInt(take(2)) / 32).toFixed(1);
    out.yaw = +(leToInt(take(2)) / 32).toFixed(1);
  }
  const s1 = decodeState1(out.state1);
  const s2 = decodeState2(out.state2);
  return { ...out, state: s1, state2: s2, faults: decodeFaults(out.fault1, out.fault2) };
}

const bit = (n, i) => ((n >> BigInt(i)) & 1n) === 1n;
const bits = (n, from, to) => (n >> BigInt(from)) & ((1n << BigInt(to - from + 1)) - 1n);

export function decodeFault1(v) {
  const n = BigInt(v || 0);
  const e = [];
  if (n === 0n) return ['正常'];
  if (bit(n, 0)) e.push('硬件过流故障');
  if (bit(n, 1)) e.push('软件过流故障');
  if (bits(n, 4, 7) !== 0n) e.push('自检故障');
  if (bit(n, 8)) e.push('A相电流传感器故障');
  if (bit(n, 9)) e.push('B相电流传感器故障');
  if (bit(n, 10)) e.push('C相电流传感器故障');
  if (bits(n, 12, 15) !== 0n) e.push('缺相故障');
  if (bits(n, 16, 19) !== 0n) e.push('短路故障');
  if (bit(n, 20)) e.push('电机过热故障');
  if (bit(n, 21)) e.push('控制器过热故障');
  if (bit(n, 24)) e.push('过压故障');
  if (bit(n, 25)) e.push('低压故障');
  if (bit(n, 26)) e.push('任务调度故障');
  if (bit(n, 27)) e.push('用户参数故障');
  if (bit(n, 28)) e.push('过载故障');
  if (bit(n, 29)) e.push('驱动故障');
  if (bit(n, 30)) e.push('控制器过温降额故障');
  return e.length ? e : ['正常'];
}

export function decodeFault2(v) {
  const n = BigInt(v || 0);
  const e = [];
  if (n === 0n) return ['正常'];
  if (bits(n, 0, 3) !== 0n) e.push('油门传感器故障');
  if (bits(n, 4, 7) !== 0n) e.push('刹车传感器故障');
  if (bits(n, 8, 11) !== 0n) e.push('霍尔传感器故障');
  if (bits(n, 12, 15) !== 0n) e.push('编码器故障');
  if (bits(n, 16, 19) !== 0n) e.push('温度传感器故障');
  if (bit(n, 20)) e.push('欠压故障');
  if (bit(n, 21)) e.push('电机堵转');
  if (bits(n, 22, 27) !== 0n) e.push('参数识别故障');
  return e.length ? e : ['正常'];
}

export function decodeFaults(f1, f2) {
  const a = decodeFault1(f1);
  const b = decodeFault2(f2);
  const list = [...new Set([...a, ...b])].filter((x) => x !== '正常');
  return list.length ? list : ['正常'];
}

export function decodeState1(v) {
  const n = BigInt(v || 0);
  const reverse = bit(n, 4);
  const auto = bit(n, 14);
  const gearNo = Number(bits(n, 10, 13));
  return {
    gear: reverse ? 'R' : auto ? 'A' : gearNo === 0 ? 'P' : gearNo >= 1 && gearNo <= 4 ? String(gearNo) : 'P',
    imuStatus: Number(bits(n, 24, 25)),
    seatSensorStatus: Number(bits(n, 26, 27)),
    flags: {
      tractionControl: bit(n, 0),
      motorStall: bit(n, 1),
      brake: bit(n, 2),
      motorLocked: bit(n, 3),
      reversing: bit(n, 4),
      repair: bit(n, 5),
      powerRecovery: bit(n, 6),
      cruise: bit(n, 7),
      assist: bit(n, 8),
      antiTheft: bit(n, 9),
      walking: bit(n, 14),
      parking: bit(n, 15),
      ready: bit(n, 16),
      pAuto: bit(n, 17),
      pSwitch: bit(n, 18),
      saddleSwitch: bit(n, 19),
      sideStandSwitch: bit(n, 20),
      hillDescentControl: bit(n, 21),
      antiSlipControl: bit(n, 22),
      vehicleHoldAssist: bit(n, 23),
      throttleReset: bit(n, 28),
      powerRecoveryEnable: bit(n, 29),
      estDirection: bit(n, 30),
      charging: bit(n, 31),
    },
  };
}

export function decodeState2(v) {
  const n = BigInt(v || 0);
  return { rpm: Number(bits(n, 0, 15)), throttle: Math.max(0, Math.min(100, Number(bits(n, 16, 31)))) };
}

// 设备信息帧：01 05 02 03 | msgId | len | ascii(倒序) | crc
export function parseInfoFrame(frame) {
  if (!frame || frame.type !== '03') return null;
  const text = reverseHexBytes(frame.data)
    .replace(/00+$/g, '')
    .match(/.{1,2}/g)
    ?.map((h) => String.fromCharCode(parseInt(h, 16)))
    .join('')
    .replace(/[\u0000-\u001f]/g, '')
    .trim();
  return { id: frame.msgId, text: text || '' };
}

// 参数响应：01 05 02 02 | msgId | len | data
export function parseParamFrame(frame, msgId) {
  if (!frame || frame.type !== '02') return null;
  if (msgId && frame.msgId.toUpperCase() !== msgId.replace('0x', '').toUpperCase()) return null;
  return frame.data;
}

// 字段编解码：dlen 字节长度，dr 缩放，dt=1 表示有符号
export function encodeField(value, meta) {
  const { dlen = 2, dr = 1, dt = 0 } = meta || {};
  let raw = Math.round(Number(value) / (dr || 1));
  if (!Number.isFinite(raw)) raw = 0;
  const mod = Math.pow(2, dlen * 8);
  if (dt === 1 && raw < 0) raw = mod + raw;
  if (!dt && raw < 0) raw = 0;
  let hex = (raw >>> 0).toString(16).toUpperCase();
  const need = dlen * 2;
  if (hex.length > need) hex = hex.slice(-need);
  hex = hex.padStart(need, '0');
  return reverseHexBytes(hex);
}

export function decodeField(hexLE, meta) {
  const { dlen = 2, dr = 1, dt = 0 } = meta || {};
  let raw = parseInt(reverseHexBytes(hexLE), 16);
  if (!Number.isFinite(raw)) raw = 0;
  if (dt === 1) {
    const half = Math.pow(2, dlen * 8 - 1);
    if (raw >= half) raw -= half * 2;
  }
  return raw * (dr || 1);
}

// Intel HEX -> Uint8Array
export function parseIntelHex(text) {
  const lines = String(text).split(/\r?\n/);
  const map = new Map();
  let base = 0;
  let max = -1;
  for (const line of lines) {
    const s = line.trim();
    if (!s.startsWith(':') || s.length < 11) continue;
    const len = parseInt(s.substr(1, 2), 16);
    const addr = parseInt(s.substr(3, 4), 16);
    const type = parseInt(s.substr(7, 2), 16);
    if (!Number.isFinite(len) || !Number.isFinite(addr) || !Number.isFinite(type)) continue;
    const dataHex = s.substr(9, len * 2);
    if (type === 0x00) {
      for (let i = 0; i < len; i++) {
        const a = base + addr + i;
        map.set(a, parseInt(dataHex.substr(i * 2, 2), 16));
        if (a > max) max = a;
      }
    } else if (type === 0x02) {
      base = parseInt(s.substr(9, 4), 16) << 4;
    } else if (type === 0x04) {
      base = parseInt(s.substr(9, 4), 16) << 16;
    } else if (type === 0x01) break;
  }
  if (max < 0) throw new Error('HEX 文件没有有效数据');
  const out = new Uint8Array(max + 1).fill(0xff);
  for (const [a, b] of map) out[a] = b;
  return out;
}

// 控制器固件校验用的 crc_32：32 位累加和（不是多项式 CRC32）
export const crc32Add = (u8) => {
  let s = 0;
  for (let i = 0; i < u8.length; i++) s = (s + u8[i]) >>> 0;
  return s >>> 0;
};

export const u32leHex = (v) => reverseHexBytes((v >>> 0).toString(16).toUpperCase().padStart(8, '0'));

// 控制器 IAP：6996 + payload + 累加和取反(小端)
export function iapWrap(payloadHex) {
  const cs = sum16Not(hexToBytes(payloadHex));
  return '6996' + payloadHex.toUpperCase() + reverseHexBytes(cs.toString(16).toUpperCase().padStart(4, '0'));
}

export const iap = {
  start: (totalBytes) => iapWrap('2100220204' + u32leHex(totalBytes)),
  frame: (seq, chunkHex) => iapWrap('22' + (seq & 0xff).toString(16).toUpperCase().padStart(2, '0') + '220280' + chunkHex),
  verify: (crc) => iapWrap('2300220204' + u32leHex(crc)),
  reset: () => iapWrap('2400220200'),
};

// 自学习帧
export function parseLearnParams(frame) {
  if (!frame || frame.type !== '01' || frame.msgId !== '00') return null;
  const d = frame.data;
  if (d.length < 24) return null;
  return {
    speedRPM: leToInt(d.substr(0, 4)),
    accelRPMs: leToInt(d.substr(4, 4)),
    iphRefA: +(leToInt(d.substr(8, 4)) * 0.1).toFixed(1),
    irampMs: leToInt(d.substr(12, 4)),
    mode: parseInt(d.substr(16, 2), 16),
    sensorType: parseInt(d.substr(18, 2), 16),
  };
}

export function parseLearnStatus(frame) {
  if (!frame || frame.type !== '01' || frame.msgId !== '08') return null;
  const d = frame.data;
  if (d.length < 36) return null;
  const u16 = (loByteIdx) => parseInt(d.substr(loByteIdx * 2 + 2, 2) + d.substr(loByteIdx * 2, 2), 16);
  const state = d.substr(0, 2);
  const sub = d.substr(2, 2);
  const seconds = u16(14) || 0;
  const fAngle = u16(16) || 0;
  let angle = (fAngle >> 1) & 0x7fff;
  if (angle & 0x4000) angle -= 0x8000;
  const yaw = (angle / 4096) * (180 / Math.PI);
  const ratioRaw = (u16(8) || 0).toString(2).padStart(16, '0');
  const cilian = parseInt(ratioRaw.slice(0, 11), 2) + parseInt(ratioRaw.slice(11), 2) / 32;
  return {
    state,
    sub,
    seconds,
    yaw: Number.isFinite(yaw) ? +yaw.toFixed(2) : 0,
    results: {
      dianzhu: u16(2) || 0,
      diangand: u16(4) || 0,
      dianganq: u16(6) || 0,
      cilian: Number.isFinite(cilian) ? +cilian.toFixed(3) : 0,
      jiaodu: Number.isFinite(yaw) ? +yaw.toFixed(2) : 0,
      zbxiang: fAngle & 1 ? '是' : '否',
      zbmax: u16(10) || 0,
      zbmin: u16(12) || 0,
    },
  };
}

export function learnStatusText(s) {
  if (!s) return '未开始';
  const { state, sub, seconds } = s;
  if (state === 'FF') return '自学习失败';
  if (state === '07' && sub !== '00') {
    const m = {
      '01': '参数辩识触发超时1', '02': '检查霍尔线缆2', '03': '无法发波3', '04': '无法发波4',
      '05': '未定义故障5', '06': '磁链辨识电机无法启动6', '07': '未定义故障7', '08': '磁链辨识结果异常8',
      '09': '转把范围异常9', '0A': '状态机超时10', '0B': '状态机超时11', '0C': '状态机超时12',
    };
    return m[sub] || '自学习失败' + sub;
  }
  switch (state) {
    case '01': return '触发自学习';
    case '02': return '电阻电感学习';
    case '03': return '霍尔参数学习1';
    case '04': return '霍尔参数学习2';
    case '05': return '磁链学习';
    case '06': return `油门参数学习，请在 ${seconds} 秒内转动转把到底后释放`;
    case '07': return '油门参数学习完成';
    case '08': return '自学习成功';
    default: return '状态 ' + state;
  }
}
export const learnStepIndex = (s) => {
  if (!s) return -1;
  const map = { '01': 0, '02': 1, '03': 2, '04': 3, '05': 4, '06': 5, '07': 5, '08': 6 };
  return map[s.state] ?? -1;
};

// 故障排查提示（据界面文案整理）
export const FAULT_TIPS = {
  油门传感器故障: '检查转把接线、边撑感应线；静态信号应约 0.8V，必要时更换转把。',
  刹车传感器故障: '检查高/低刹车信号是否接反、刹把是否回弹到位。',
  霍尔传感器故障: '转动电机看是否消除；检查霍尔线序与正负极。',
  欠压故障: '检查电池欠压设定、电量与压降，必要时减小母线电流。',
  低压故障: '检查主电源正极、保险丝与接线螺丝。',
  过压故障: '检查过欠压设定与回充电压，重新自学习。',
  硬件过流故障: '检查电机相线是否短路，断开相线转动电机判断电机/控制器。',
  软件过流故障: '重启电源；仍报错需升级控制器固件或更换控制器。',
  控制器过热故障: '控制器高温降载，停车通风散热。',
  控制器过温降额故障: '控制器高温降载，停车通风散热。',
  电机过热故障: '停车降温；检查电机温度传感器参数是否匹配。',
  缺相故障: '检查电机相线连接与插头退针。',
  短路故障: '检查相线绝缘与电机绕组。',
  自检故障: '重启电源；仍报错联系售后。',
  过载故障: '降低负载或减小电流参数。',
  驱动故障: '重启电源；仍报错需检修控制器。',
};
