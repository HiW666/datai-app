// 参数表：加载 param-schema.json（由主包 paralistkey + UI 分组生成）
// 没有 schema 时退化为“原始帧读写”，不臆造字段长度与缩放

// 11 个界面分组（与小程序参数页一致），仅用于 schema 缺失时的原始模式
export const GROUP_DEFS = [
  { title: '相线电流参数', msgId: '0x07', ids: [7001, 7002] },
  { title: '母线电流参数', msgId: '0x07', ids: [7101, 7102, 7003] },
  {
    title: '挡位控制',
    msgId: '0x0A',
    ids: [10001, 10003, 10004, 10101, 10201, 10102, 10202, 10302, 10103, 10203, 10303],
  },
  { title: '电机参数', msgId: '0x01', ids: [20001, 20002, 20003, 20005, 20004] },
  { title: '倒车功能', msgId: '0x0E', ids: [30001, 30007] },
  { title: '转把参数', msgId: '0x08', ids: [40001, 40002, 40007, 40008, 40009] },
  { title: '动能回收', msgId: '0x32', ids: [51001, 51002, 51003, 51004, 51005, 51006] },
  { title: '仪表速度', msgId: '0x12', ids: [17001, 17003] },
  { title: '功能开关', msgId: '0x33', ids: [52001, 52002, 52003, 52004] },
  { title: '限速设置', msgId: '0x10', ids: [54007] },
  {
    title: '自动翘头',
    msgId: '0x34',
    ids: [53001, 53002, 53005, 53003, 53004, 53006, 53007, 53008, 53009, 53010, 53011, 53012, 53013],
  },
];

const cache = { data: [], msgs: {}, source: 'none', loaded: false };

export function hexMsgId(v) {
  if (typeof v === 'string' && /^0x/i.test(v)) {
    return '0x' + v.slice(2).toUpperCase().padStart(2, '0');
  }
  return '0x' + Number(v).toString(16).toUpperCase().padStart(2, '0');
}

export async function loadSchema() {
  if (cache.loaded) return cache;
  cache.loaded = true;
  try {
    const res = await fetch('param-schema.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('not found');
    const json = await res.json();
    cache.data = normalizeGroups(json.groups);
    cache.msgs = normalizeMsgs(json.msgs);
    cache.source = cache.data.length ? 'file' : 'fallback';
  } catch (e) {
    cache.data = [];
    cache.msgs = {};
    cache.source = 'fallback';
  }
  return cache;
}

// 完整报文布局：msgId -> 按 paralistkey 顺序排列的全部字段（含未展示字段）
function normalizeMsgs(msgs) {
  const out = {};
  for (const [k, m] of Object.entries(msgs || {})) {
    out[hexMsgId(k)] = {
      name: m.name || '',
      vlen: Number(m.vlen) || 0,
      fields: (m.fields || []).map((f) => ({
        id: f.id,
        offset: Number(f.offset) || 0,
        dlen: Number(f.dlen) || 0,
        dr: f.dr != null ? Number(f.dr) : 1,
        dt: Number(f.dt) === 1 ? 1 : 0,
        formType: Number(f.formType),
      })),
    };
  }
  return out;
}

function normalizeGroups(groups) {
  return (Array.isArray(groups) ? groups : []).map((g) => {
    const fields = (g.rows || []).map((f) => {
      const metaReady = f.formType === 'bit-picker' || !!Number(f.dlen);
      return {
        id: f.id,
        key: f.key || 'field_' + f.id,
        label: f.name || `字段 ${f.id}`,
        type: f.formType || 'input',
        msgId: hexMsgId(f.msgId),
        offset: Number(f.offset) || 0,
        dlen: Number(f.dlen) || 0,
        dr: f.dr != null ? Number(f.dr) : 1,
        dt: Number(f.dt) === 1 ? 1 : 0,
        unit: f.unit || '',
        desc: f.desc,
        min: f.min,
        max: f.max,
        step: f.step,
        decimals: f.decimals,
        inputType: f.inputType,
        range: Array.isArray(f.range) ? f.range : undefined,
        bits: Array.isArray(f.bits) ? f.bits : undefined,
        bitIndices: Array.isArray(f.bitIndices) ? f.bitIndices : undefined,
        bitDescs: Array.isArray(f.bitDescs) ? f.bitDescs : undefined,
        bitIndex: f.bitIndex,
        left: f.leftLabel,
        right: f.rightLabel,
        gear: f.gear,
        hidden: !!f.hidden,
        metaReady,
      };
    });
    return {
      title: g.title || '参数组',
      msgId: hexMsgId(g.msgId),
      msgIds: (g.msgIds && g.msgIds.length ? g.msgIds : [g.msgId]).map(hexMsgId),
      gridLayout: !!g.gridLayout,
      requireImu: !!g.requireImu,
      fields,
      metaReady: fields.length > 0 && fields.every((f) => f.metaReady),
    };
  });
}

export function fallbackGroups() {
  return GROUP_DEFS.map((g) => ({
    title: g.title,
    msgId: hexMsgId(g.msgId),
    msgIds: [hexMsgId(g.msgId)],
    gridLayout: false,
    requireImu: false,
    metaReady: false,
    fields: g.ids.map((id) => ({
      id,
      key: 'field_' + id,
      label: `字段 ${id}`,
      type: 'raw',
      msgId: hexMsgId(g.msgId),
      dlen: 0,
      dr: 1,
      dt: 0,
      metaReady: false,
    })),
  }));
}

export const schemaState = cache;
