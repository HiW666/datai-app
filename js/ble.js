// BLE 传输层（Web Bluetooth）：自动发现可写/可通知特征、分片写入、通知转十六进制
import { bytesToHex } from './protocol.js';

const BASE = '-0000-1000-8000-00805f9b34fb';

// 大泰控制器固定串口透传服务
export const DT_SERVICE = '0000fff0' + BASE;
export const DT_NOTIFY = '0000fff1' + BASE;
export const DT_WRITE = '0000fff2' + BASE;

export const COMMON_SERVICES = [
  '0000ffe0' + BASE,
  '0000ffe5' + BASE,
  '0000fff0' + BASE,
  '0000ff00' + BASE,
  '0000ff01' + BASE,
  '0000ff10' + BASE,
  '0000ff20' + BASE,
  '0000fef0' + BASE,
  '0000fee0' + BASE,
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART
  '49535343-fe7d-4ae5-8fa9-9fafd205e455', // ISSC / Microchip
  '8ec90003-f315-4f60-9fb8-838830daea50', // Nordic buttonless DFU
].map((s) => s.toLowerCase());

export function expandUuid(u) {
  const s = String(u || '').trim().toLowerCase();
  if (!s) return '';
  if (/^[0-9a-f]{4}$/.test(s)) return '0000' + s + BASE;
  if (/^[0-9a-f]{8}$/.test(s)) return s + BASE;
  return s;
}

export function parseUuidList(text) {
  return String(text || '')
    .split(/[\s,;]+/)
    .map(expandUuid)
    .filter(Boolean);
}

export class BleClient extends EventTarget {
  constructor(settings) {
    super();
    this.settings = settings;
    this.device = null;
    this.server = null;
    this.service = null;
    this.writeChar = null;
    this.notifyChar = null;
    this.connected = false;
    this._queue = Promise.resolve();
    this._handleNotify = this._handleNotify.bind(this);
    this._handleDisconnect = this._handleDisconnect.bind(this);
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  get supported() {
    return !!(navigator.bluetooth && navigator.bluetooth.requestDevice);
  }

  async connect() {
    if (!this.supported) throw new Error('当前浏览器不支持 Web Bluetooth');
    if (!window.isSecureContext) throw new Error('Web Bluetooth 需要 HTTPS 或 localhost 环境');

    const custom = parseUuidList(this.settings.customServices);
    const optionalServices = Array.from(new Set([...COMMON_SERVICES, ...custom]));
    const prefix = String(this.settings.namePrefix || '').trim();

    const opts = prefix
      ? { filters: [{ namePrefix: prefix }], optionalServices }
      : { acceptAllDevices: true, optionalServices };

    this._emit('log', { type: 'info', text: '请求蓝牙设备…' });
    const device = await navigator.bluetooth.requestDevice(opts);
    this.device = device;
    device.removeEventListener('gattserverdisconnected', this._handleDisconnect);
    device.addEventListener('gattserverdisconnected', this._handleDisconnect);

    this._emit('log', { type: 'info', text: `连接 ${device.name || '(未命名)'} …` });
    this.server = await device.gatt.connect();
    await this.discover();

    this.connected = true;
    this._emit('state', { connected: true, name: device.name || '', id: device.id || '' });
    this._emit('log', { type: 'info', text: '蓝牙已连接' });
    return { name: device.name || '', id: device.id || '' };
  }

  async discover() {
    if (!this.server) throw new Error('尚未连接');
    this._emit('log', { type: 'info', text: '查找 FFF0 串口服务…' });

    // 优先使用大泰固定 UUID：FFF0 / 通知 FFF1 / 写入 FFF2
    try {
      const svc = await this.server.getPrimaryService(DT_SERVICE);
      let notifyChar = null;
      let writeChar = null;
      try {
        notifyChar = await svc.getCharacteristic(DT_NOTIFY);
      } catch (e) {}
      try {
        writeChar = await svc.getCharacteristic(DT_WRITE);
      } catch (e) {}
      if (notifyChar) {
        if (!writeChar) {
          const chars = await svc.getCharacteristics();
          writeChar =
            chars.find((c) => c.properties.write || c.properties.writeWithoutResponse) || null;
        }
        await this._use(svc, writeChar, notifyChar);
        return;
      }
    } catch (e) {
      this._emit('log', { type: 'info', text: '未找到 FFF0 服务，改为自动发现…' });
    }

    this._emit('log', { type: 'info', text: '枚举 GATT 服务…' });
    let services = [];
    try {
      services = await this.server.getPrimaryServices();
    } catch (e) {
      this._emit('log', { type: 'err', text: '枚举服务失败：' + e.message });
    }

    let best = null;
    const candidates = [];
    for (const svc of services) {
      let chars = [];
      try {
        chars = await svc.getCharacteristics();
      } catch (e) {
        continue;
      }
      for (const ch of chars) {
        const p = ch.properties || {};
        const canWrite = p.write || p.writeWithoutResponse;
        const canNotify = p.notify || p.indicate;
        if (canWrite || canNotify) {
          candidates.push({ svc, ch, canWrite, canNotify });
        }
        if (canWrite && canNotify) {
          best = { svc, writeChar: ch, notifyChar: ch };
          break;
        }
      }
      if (best) break;
    }

    if (!best) {
      // 写入与通知分开的特征
      const w = candidates.find((c) => c.canWrite);
      const n = candidates.find((c) => c.canNotify);
      if (n) best = { svc: n.svc, writeChar: w ? w.ch : null, notifyChar: n.ch };
    }

    if (!best || !best.notifyChar) {
      const list = candidates.map((c) => `${c.ch.uuid} [${c.canWrite ? '写' : ''}${c.canNotify ? '通知' : ''}]`).join('\n');
      throw new Error('未找到可通知的 BLE 特征。可用特征：\n' + (list || '(无)'));
    }

    await this._use(best.svc, best.writeChar, best.notifyChar);
  }

  async _use(svc, writeChar, notifyChar) {
    this.service = svc;
    this.writeChar = writeChar;
    this.notifyChar = notifyChar;

    try {
      await this.notifyChar.startNotifications();
    } catch (e) {
      this._emit('log', { type: 'err', text: '开启通知失败：' + e.message });
      throw e;
    }
    this.notifyChar.removeEventListener('characteristicvaluechanged', this._handleNotify);
    this.notifyChar.addEventListener('characteristicvaluechanged', this._handleNotify);

    this._emit('gatt', {
      service: this.service.uuid,
      write: this.writeChar ? this.writeChar.uuid : '',
      notify: this.notifyChar.uuid,
      writeWithoutResponse: !!(this.writeChar && this.writeChar.properties.writeWithoutResponse),
    });
    this._emit('log', {
      type: 'info',
      text: `服务 ${this.service.uuid} / 写 ${this.writeChar ? this.writeChar.uuid : '无'} / 通知 ${this.notifyChar.uuid}`,
    });
  }

  _handleNotify(event) {
    const value = event.target.value;
    if (!value) return;
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    this._emit('data', { hex: bytesToHex(bytes) });
  }

  _handleDisconnect() {
    this.connected = false;
    this._emit('state', { connected: false });
    this._emit('log', { type: 'err', text: '蓝牙已断开' });
  }

  disconnect() {
    this.connected = false;
    try {
      if (this.device && this.device.gatt && this.device.gatt.connected) this.device.gatt.disconnect();
    } catch (e) {}
    this.server = null;
    this.service = null;
    this.writeChar = null;
    this.notifyChar = null;
  }

  sendHex(hex) {
    const job = () => this._writeChunks(hex);
    this._queue = this._queue.then(job, job);
    return this._queue;
  }

  async _writeChunks(hex) {
    if (!this.writeChar) throw new Error('没有可写特征');
    const clean = String(hex || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
    const bytes = [];
    for (let i = 0; i < clean.length; i += 2) bytes.push(parseInt(clean.substr(i, 2), 16));
    const chunk = Math.max(8, Math.min(512, Number(this.settings.chunkSize) || 20));
    const noResp = !!this.settings.noResponse && this.writeChar.properties.writeWithoutResponse;

    for (let i = 0; i < bytes.length; i += chunk) {
      const part = new Uint8Array(bytes.slice(i, i + chunk));
      if (noResp) await this.writeChar.writeValueWithoutResponse(part);
      else await this.writeChar.writeValue(part);
      if (i + chunk < bytes.length) await new Promise((r) => setTimeout(r, 8));
    }
  }
}
