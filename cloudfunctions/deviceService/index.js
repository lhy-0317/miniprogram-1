/**
 * 设备服务 · 云函数
 *
 * action:
 *   status  GET  查询设备状态与余纸量
 *   report  POST 设备上报心跳与余量（需设备密钥）
 *
 * 安全说明：
 *   report 旧实现完全无鉴权——任何用户都能 callFunction 伪造任意设备的
 *   心跳、余量、在线状态。现改为要求请求携带设备密钥（部署时在云函数
 *   环境变量配置 DEVICE_SECRET），未配置时 fail-closed 一律拒绝。
 *   硬件侧预共享同一密钥，请求体携带 secret 字段。
 */

const crypto = require('crypto');
const { db, BizError, createHandler } = require('./common');

/** 设备上报密钥。未配置时 report 一律拒绝（fail-closed）。 */
const DEVICE_SECRET = process.env.DEVICE_SECRET || '';

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function describeStatus(device) {
  if (device.status === 'maintenance') return '设备维护中';
  if (device.status === 'offline') return '设备离线';
  if ((device.paperStock || 0) <= 0) return '纸张已用完';

  const percent =
    device.paperCapacity > 0 ? Math.round((device.paperStock / device.paperCapacity) * 100) : 0;
  if (percent < 20) return '纸张较少，请尽快补充';

  return '设备在线 · 纸张充足';
}

async function getStatus(event, ctx) {
  const deviceId = event.deviceId;
  if (!deviceId) throw new BizError('缺少设备ID');

  const result = await db.collection('devices').where({ deviceId }).limit(1).get();

  if (!result.data || result.data.length === 0) {
    // 未登记设备：自动建档并按在线处理，保证演示可跑通
    const now = new Date();
    await db.collection('devices').add({ data: {
      deviceId,
      deviceName: `取纸机-${String(deviceId).slice(-4)}`,
      location: '未登记位置',
      paperStock: 200,
      paperCapacity: 200,
      status: 'online',
      lastHeartbeat: now,
      createTime: now,
      updateTime: now,
    } });

    return {
      deviceId,
      deviceName: `取纸机-${String(deviceId).slice(-4)}`,
      location: '未登记位置',
      status: 'online',
      statusText: '设备在线 · 纸张充足',
      paperStock: 200,
      paperPercent: 100,
      autoRegistered: true,
    };
  }

  const device = result.data[0];
  const percent =
    device.paperCapacity > 0
      ? Math.round(((device.paperStock || 0) / device.paperCapacity) * 100)
      : 0;

  return {
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    location: device.location,
    status: device.status,
    statusText: describeStatus(device),
    paperStock: device.paperStock || 0,
    paperPercent: percent,
    lastHeartbeat: device.lastHeartbeat || null,
  };
}

/** 设备上报心跳与余量（需预共享密钥） */
async function report(event, ctx) {
  if (!DEVICE_SECRET) {
    console.error('未配置 DEVICE_SECRET，拒绝一切设备上报');
    throw new BizError('设备上报未启用', 503);
  }

  if (!safeEqual(event.secret, DEVICE_SECRET)) {
    throw new BizError('设备鉴权失败', 401);
  }

  const { deviceId, paper, batteryVoltage, firmwareVersion, error } = event;
  if (!deviceId) throw new BizError('缺少设备ID');

  const now = new Date();
  const patch = { lastHeartbeat: now, updateTime: now };

  // 设备上报字段名为 paper，映射为库内 paperStock
  if (paper !== undefined && paper !== null) patch.paperStock = Number(paper);
  if (batteryVoltage !== undefined) patch.batteryVoltage = Number(batteryVoltage);
  if (firmwareVersion !== undefined) patch.firmwareVersion = firmwareVersion;
  if (error) patch.status = 'maintenance';
  else if (patch.paperStock !== undefined && patch.paperStock <= 0) patch.status = 'offline';
  else patch.status = 'online';

  const existing = await db.collection('devices').where({ deviceId }).limit(1).get();

  if (!existing.data || existing.data.length === 0) {
    await db.collection('devices').add({ data: {
      deviceId,
      deviceName: `取纸机-${String(deviceId).slice(-4)}`,
      location: '未登记位置',
      paperStock: patch.paperStock ?? 200,
      paperCapacity: 200,
      ...patch,
      createTime: now,
    } });
  } else {
    await db.collection('devices').doc(existing.data[0]._id).update({ data: patch });
  }

  return { deviceId, status: patch.status || 'online' };
}

exports.main = createHandler({
  status: getStatus,
  report,
});
