const https = require('https');
const fs = require('fs');
const path = require('path');
const SmartDataParser = require('./smart-data-parser');
const UnifiedStats = require('./unified-stats');
const { Client } = require('@notionhq/client');
const LocalDatabase = require('./local-database');
const config = require('./config.json');

// Token隔离和实例管理
const LOCK_FILE = path.join(__dirname, '.bot.lock');
const INSTANCE_ID = `bot-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

// 创建进程锁
function createLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const lockData = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      const lockAge = Date.now() - lockData.timestamp;
      
      // 如果锁文件超过5分钟，认为是僵尸锁，删除
      if (lockAge > 5 * 60 * 1000) {
        console.log('[锁管理] 检测到僵尸锁文件，自动清理');
        fs.unlinkSync(LOCK_FILE);
      } else {
        console.log('[锁管理] 检测到其他实例正在运行，等待...');
        return false;
      }
    }
    
    fs.writeFileSync(LOCK_FILE, JSON.stringify({
      instanceId: INSTANCE_ID,
      timestamp: Date.now(),
      pid: process.pid
    }));
    
    console.log(`[锁管理] 成功获取实例锁: ${INSTANCE_ID}`);
    return true;
  } catch (error) {
    console.log('[锁管理] 创建锁文件失败:', error.message);
    return false;
  }
}

// 更新锁时间戳（心跳机制）
function updateLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const lockData = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      if (lockData.instanceId === INSTANCE_ID) {
        lockData.timestamp = Date.now();
        fs.writeFileSync(LOCK_FILE, JSON.stringify(lockData));
      }
    }
  } catch (error) {
    console.log('[锁管理] 更新锁文件失败:', error.message);
  }
}

// 清理锁文件
function cleanupLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const lockData = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      if (lockData.instanceId === INSTANCE_ID) {
        fs.unlinkSync(LOCK_FILE);
        console.log('[锁管理] 已清理锁文件');
      }
    }
  } catch (error) {
    console.log('[锁管理] 清理锁文件失败:', error.message);
  }
}

// 进程退出时清理
process.on('exit', cleanupLock);
process.on('SIGINT', () => {
  cleanupLock();
  process.exit(0);
});
process.on('SIGTERM', () => {
  cleanupLock();
  process.exit(0);
});

// 配置
const TOKEN = config.telegram.botToken;
const ADMIN_IDS = ['8032000739', '1294080275', '7513425288', '8154907183', '8483048692'];

// 提交者代号映射
const SUBMITTER_ALIAS = {
  '8032000739': 'hea ao',   // hea ao
  '1294080275': '风雨',      // 风雨
  '7513425288': '小歪',      // 小歪
  '8154907183': 'silence',  // Arlen
  '8483048692': '有有'       // keats
};

// 获取提交者代号
function getSubmitterAlias(submitterId) {
  return SUBMITTER_ALIAS[submitterId] || submitterId;
}
  // 支持多个管理员

// Notion配置 - 使用正确的数据库ID
const notion = new Client({
  auth: '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'
});
const DATABASE_ID = '23f7fa1f53e5800497a7f4cdfbfabbdc';

// 会话存储
const sessions = {};
const pendingApprovals = {};
const editSessions = {};
const outboundSessions = {};
const banSessions = {};
const findSessions = {};  // 查找会话
const limitSessions = {};  // 限额设置会话
const emailOutboundSessions = {};  // 邮箱指定出库会话
let lastUpdateId = 0;

// 会话管理配置
const SESSION_CONFIG = {
  timeout: 30 * 60 * 1000, // 30分钟会话超时
  cleanupInterval: 5 * 60 * 1000, // 5分钟清理一次
  persistenceEnabled: true // 启用会话持久化
};

// 会话管理功能
function updateSessionActivity(chatId) {
  if (sessions[chatId]) {
    sessions[chatId].lastActivity = Date.now();
  }
}

function isSessionExpired(session) {
  if (!session || !session.lastActivity) return true;
  return Date.now() - session.lastActivity > SESSION_CONFIG.timeout;
}

function cleanupExpiredSessions() {
  const now = Date.now();
  let cleaned = 0;
  
  // 清理主会话
  Object.keys(sessions).forEach(chatId => {
    if (isSessionExpired(sessions[chatId])) {
      delete sessions[chatId];
      cleaned++;
    }
  });
  
  // 清理其他类型会话
  [editSessions, outboundSessions, banSessions, findSessions, limitSessions, emailOutboundSessions].forEach(sessionStore => {
    Object.keys(sessionStore).forEach(chatId => {
      const session = sessionStore[chatId];
      if (session && session.lastActivity && isSessionExpired(session)) {
        delete sessionStore[chatId];
      }
    });
  });
  
  if (cleaned > 0) {
    console.log(`[会话清理] 清理了 ${cleaned} 个过期会话`);
  }
}

// 启动会话清理定时器
setInterval(cleanupExpiredSessions, SESSION_CONFIG.cleanupInterval);

// 每日限额配置文件路径
const LIMITS_FILE = path.join(__dirname, 'daily-limits.json');

// 查询缓存（减少重复的Notion查询）
const queryCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5分钟缓存

// 格式化日期函数
function formatDate(date) {
  if (!date) return new Date().toISOString().split('T')[0];
  if (typeof date === 'string') return date.split('T')[0];
  return new Date(date).toISOString().split('T')[0];
}

// 初始化本地数据库
const localDB = new LocalDatabase(config.localDatabase);
const statsManager = new UnifiedStats(localDB);

// 限额管理函数
function loadLimits() {
  try {
    if (fs.existsSync(LIMITS_FILE)) {
      const data = fs.readFileSync(LIMITS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('[限额管理] 读取限额配置失败:', error);
  }
  return { limits: {}, lastUpdate: null, updatedBy: null };
}

function saveLimits(limits) {
  try {
    fs.writeFileSync(LIMITS_FILE, JSON.stringify(limits, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('[限额管理] 保存限额配置失败:', error);
    return false;
  }
}

// 获取某个类型的当前在库数量
async function getCurrentStock(accountType) {
  try {
    // 从本地数据库获取
    const accounts = await localDB.findAccounts({
      status: '在库',
      accountType: accountType
    });
    return accounts.length;
  } catch (error) {
    console.error('[限额管理] 获取库存失败:', error);
    return 0;
  }
}

// 检查配额
async function checkQuota(accountType) {
  const limitsData = loadLimits();
  const limit = limitsData.limits[accountType];
  
  if (!limit || limit <= 0) {
    // 没有设置限额，可以自由入库
    return { allowed: true, limit: null, current: 0, remaining: null };
  }
  
  const current = await getCurrentStock(accountType);
  const remaining = limit - current;
  
  return {
    allowed: remaining > 0,
    limit: limit,
    current: current,
    remaining: remaining > 0 ? remaining : 0
  };
}

console.log('🚀 启动高级账号管理机器人...\n');

// Telegram API 请求
function telegramRequest(method, data = {}) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(data);
    
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${TOKEN}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      agent: new https.Agent({
        keepAlive: true,
        keepAliveMsecs: 30000,  // 增加到30秒保持连接
        maxSockets: 50,         // 增加最大连接数
        maxFreeSockets: 10
      }),
      timeout: 15000  // 增加到15秒超时
    };
    
    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', chunk => responseData += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(responseData);
          if (result.ok) {
            resolve(result.result);
          } else {
            reject(new Error(result.description || 'API Error'));
          }
        } catch (e) {
          reject(new Error('解析响应失败: ' + e.message));
        }
      });
    });
    
    req.on('error', (error) => {
      reject(new Error('网络请求失败: ' + error.message));
    });
    
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('请求超时'));
    });
    
    req.write(postData);
    req.end();
  });
}

// Telegram API 表单请求（用于发送文件）
function telegramRequestForm(method, form) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${TOKEN}/${method}`,
      method: 'POST',
      headers: form.getHeaders(),
      agent: new https.Agent({
        keepAlive: true,
        keepAliveMsecs: 30000,
        maxSockets: 50,
        maxFreeSockets: 10
      }),
      timeout: 30000  // 文件上传需要更长时间
    };
    
    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', chunk => responseData += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(responseData);
          if (result.ok) {
            resolve(result.result);
          } else {
            reject(new Error(result.description || 'API Error'));
          }
        } catch (e) {
          reject(new Error('解析响应失败: ' + e.message));
        }
      });
    });
    
    req.on('error', (error) => {
      reject(new Error('网络请求失败: ' + error.message));
    });
    
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('请求超时'));
    });
    
    form.pipe(req);
  });
}

// 发送消息（优化版-需要返回值时等待）
async function sendMessage(chatId, text, options = {}) {
  const data = {
    chat_id: chatId,
    text: text,
    ...options
  };
  
  try {
    const result = await telegramRequest('sendMessage', data);
    console.log(`[发送] 消息已发送到 ${chatId}`);
    return result;
  } catch (error) {
    console.error('[错误] 发送消息失败:', error.message);
    throw error;
  }
}

// 快速发送消息（不需要返回值）
async function quickSendMessage(chatId, text, options = {}) {
  const data = {
    chat_id: chatId,
    text: text,
    ...options
  };
  
  // 异步发送，不等待结果
  telegramRequest('sendMessage', data)
    .then(() => {
      console.log(`[发送] 消息已发送到 ${chatId}`);
    })
    .catch(error => {
      console.error('[错误] 发送消息失败:', error.message);
    });
}

// 发送文档
async function sendDocument(chatId, document, options = {}) {
  const FormData = require('form-data');
  const form = new FormData();
  
  form.append('chat_id', chatId);
  form.append('document', document.source, document.filename);
  
  if (options.caption) {
    form.append('caption', options.caption);
  }
  
  try {
    const result = await telegramRequestForm('sendDocument', form);
    console.log(`[发送] 文档已发送到 ${chatId}`);
    return result;
  } catch (error) {
    console.error('[错误] 发送文档失败:', error.message);
    throw error;
  }
}

// 编辑消息
async function editMessage(chatId, messageId, text, options = {}) {
  const data = {
    chat_id: chatId,
    message_id: messageId,
    text: text,
    ...options
  };
  
  // 异步编辑，不等待结果
  telegramRequest('editMessageText', data)
    .then(() => {
      console.log(`[编辑] 消息已更新`);
    })
    .catch(error => {
      // 忽略"消息内容相同"的错误
      if (error.message.includes('message is not modified')) {
        console.log('[编辑] 消息内容未变化，跳过更新');
      } else {
        console.error('[错误] 编辑消息失败:', error.message);
      }
    });
}

// 删除消息
async function deleteMessage(chatId, messageId) {
  try {
    await telegramRequest('deleteMessage', {
      chat_id: chatId,
      message_id: messageId
    });
  } catch (error) {
    console.error('[错误] 删除消息失败:', error.message);
  }
}

// 回答回调
async function answerCallback(callbackId, text = '') {
  try {
    await telegramRequest('answerCallbackQuery', {
      callback_query_id: callbackId,
      text: text
    });
  } catch (error) {
    console.error('[错误] 回答回调失败:', error.message);
  }
}

// 通知所有管理员
async function notifyAdmins(message, options = {}) {
  for (const adminId of ADMIN_IDS) {
    try {
      await sendMessage(adminId, message, options);
    } catch (error) {
      console.error(`[错误] 无法通知管理员 ${adminId}:`, error.message);
    }
  }
}

// 检查重复邮箱 - 增强版：区分在库、已出库和被封状态
async function checkDuplicateEmails(emails) {
  console.log('[重复检查] 检查邮箱:', emails);
  
  // 只检查本地数据库，不查询Notion
  let localResult = await checkLocalDuplicates(emails);
  const localDuplicates = localResult.duplicates;
  const localOutbound = localResult.outboundAccounts;
  const localBanned = localResult.bannedAccounts;
  
  // 优先级逻辑：被封账号 > 已出库账号 > 在库重复
  // 从已出库列表中移除被封的账号（被封优先级更高）
  const combinedOutbound = localOutbound.filter(email => !localBanned.includes(email));
  
  // 从重复列表中移除已出库和被封的账号
  const combinedDuplicates = localDuplicates.filter(email => 
    !combinedOutbound.includes(email) && !localBanned.includes(email));
  
  console.log(`[重复检查] 本地在库重复: ${localDuplicates.length}`);
  console.log(`[重复检查] 本地已出库: ${localOutbound.length}`);
  console.log(`[重复检查] 本地被封: ${localBanned.length}`);
  console.log(`[重复检查] 最终在库重复: ${combinedDuplicates.length}, 最终已出库: ${combinedOutbound.length}, 最终被封: ${localBanned.length}`);
  
  return {
    duplicates: combinedDuplicates,
    outboundAccounts: combinedOutbound,
    bannedAccounts: localBanned
  };
}

// 同步账号到 Notion
async function syncAccountToNotion(account) {
  try {
    // 构建 Notion 页面属性
    const properties = {
      // title 字段 - 使用邮箱作为标题
      '无': {
        title: [{
          text: { content: account.email || '' }
        }]
      },
      '客户邮箱': {
        email: account.email || ''
      },
      '账号类型': {
        rich_text: [{
          text: { content: account.accountType || '未分类' }
        }]
      },
      '状态': {
        select: { name: account.status || '在库' }
      },
      '入库日期': {
        date: account.inboundDate ? { start: account.inboundDate } : null
      },
      '入库价格': {
        number: account.inboundPrice || 0
      },
      '提交者ID': {
        rich_text: [{
          text: { content: String(account.submitterId || '') }
        }]
      }
    };
    
    // 添加可选字段
    if (account.auxiliaryEmail) {
      properties['铺助邮箱'] = {
        rich_text: [{
          text: { content: account.auxiliaryEmail }
        }]
      };
    }
    
    if (account.auxiliaryPassword) {
      properties['铺助邮箱密码'] = {
        rich_text: [{
          text: { content: account.auxiliaryPassword }
        }]
      };
    }
    
    if (account.twoFACode) {
      properties['2fa密码'] = {
        rich_text: [{
          text: { content: account.twoFACode }
        }]
      };
    }
    
    if (account.emailPassword) {
      properties['主邮箱密码'] = {
        rich_text: [{
          text: { content: account.emailPassword }
        }]
      };
    }
    
    // 将额外信息添加到备注中
    let notesArray = [];
    if (account.notes) notesArray.push(account.notes);
    if (account.submitterName) notesArray.push(`提交者: ${account.submitterName}`);
    
    if (notesArray.length > 0) {
      properties['备注'] = {
        rich_text: [{
          text: { content: notesArray.join('\n') }
        }]
      };
    }
    
    // 创建 Notion 页面
    const response = await notion.pages.create({
      parent: { database_id: DATABASE_ID },
      properties: properties
    });
    
    return response.id;
  } catch (error) {
    throw new Error(`同步到 Notion 失败: ${error.message}`);
  }
}

// 检查本地数据库中的重复账号 - 增强版：区分在库、已出库和被封状态
async function checkLocalDuplicates(emails) {
  try {
    const allAccounts = await localDB.getAllAccounts();
    const duplicates = [];
    const outboundAccounts = [];
    const bannedAccounts = [];
    
    for (const email of emails) {
      const existingAccount = allAccounts.find(acc => acc.email.toLowerCase() === email.toLowerCase());
      if (existingAccount) {
        if (existingAccount.status === '在库') {
          duplicates.push(email);
        } else if (existingAccount.status === '出库') {
          outboundAccounts.push(email);
        } else if (existingAccount.status === '被封') {
          bannedAccounts.push(email);
        }
      }
    }
    
    return {
      duplicates,
      outboundAccounts,
      bannedAccounts
    };
  } catch (error) {
    console.error('[错误] 检查本地数据库重复失败:', error);
    return {
      duplicates: [],
      outboundAccounts: [],
      bannedAccounts: []
    };
  }
}

// 将已出库账号转换为在库状态
async function convertOutboundToInStock(emails) {
  const results = {
    success: [],
    failed: [],
    errors: []
  };

  console.log(`[状态转换] 开始转换 ${emails.length} 个账号从已出库到在库`);

  for (const email of emails) {
    try {
      console.log(`[状态转换] 处理账号: ${email}`);
      
      // 1. 更新本地数据库
      const localUpdateResult = await localDB.updateAccountStatus(email, '在库', {
        outboundPrice: null,
        outboundDate: null
      });
      
      if (localUpdateResult) {
        console.log(`[状态转换] 本地数据库更新成功: ${email}`);
        
        // 2. 更新Notion数据库
        try {
          const notionResponse = await notion.databases.query({
            database_id: DATABASE_ID,
            filter: {
              property: '客户邮箱',
              email: { equals: email }
            }
          });

          if (notionResponse.results.length > 0) {
            const pageId = notionResponse.results[0].id;
            
            await notion.pages.update({
              page_id: pageId,
              properties: {
                '状态': { select: { name: '在库' } },
                '出库日期': { date: null },
                '出库价格': { number: null }
              }
            });
            
            console.log(`[状态转换] Notion数据库更新成功: ${email}`);
            results.success.push(email);
          } else {
            console.log(`[状态转换] 在Notion中未找到账号: ${email}，但本地数据库已更新`);
            results.success.push(email);
          }
        } catch (notionError) {
          console.error(`[状态转换] Notion更新失败: ${email}`, notionError.message);
          results.errors.push(`Notion更新失败: ${email} - ${notionError.message}`);
          results.success.push(email); // 本地已成功，仍算作成功
        }
      } else {
        console.error(`[状态转换] 本地数据库更新失败: ${email}`);
        results.failed.push(email);
      }
    } catch (error) {
      console.error(`[状态转换] 处理账号失败: ${email}`, error.message);
      results.failed.push(email);
      results.errors.push(`${email}: ${error.message}`);
    }
  }

  console.log(`[状态转换] 完成。成功: ${results.success.length}, 失败: ${results.failed.length}`);
  
  // 清除相关账号的查询缓存
  for (const email of emails) {
    const cacheKey = `dup_${email}`;
    if (queryCache.has(cacheKey)) {
      queryCache.delete(cacheKey);
      console.log(`[缓存] 已清除 ${email} 的缓存`);
    }
  }
  
  return results;
}

// 执行重新入库操作（保留原有类型和价格）
// 数据比较工具函数
function compareAccountData(existingData, newData) {
  const changes = {};
  const fieldsToCheck = [
    { old: 'emailPassword', new: 'password', label: '邮箱密码' },
    { old: 'password', new: 'password', label: '邮箱密码' },
    { old: 'twoFACode', new: 'totp', label: '2FA验证码' },
    { old: 'totp', new: 'totp', label: '2FA验证码' },
    { old: 'auxiliaryEmail', new: 'backupEmail', label: '辅助邮箱' },
    { old: 'backupEmail', new: 'backupEmail', label: '辅助邮箱' },
    { old: 'auxiliaryPassword', new: 'backupPassword', label: '辅助密码' },
    { old: 'backupPassword', new: 'backupPassword', label: '辅助密码' },
    { old: 'accountKey', new: 'accountKey', label: 'API密钥' },
    { old: 'account_key', new: 'account_key', label: 'API密钥' }
  ];

  fieldsToCheck.forEach(field => {
    const existingValue = existingData[field.old] || '';
    const newValue = newData[field.new] || '';
    
    // 除了邮箱外，只要新值与现有值不同就更新（包括从有值变为空值的情况）
    if (newValue !== existingValue) {
      changes[field.old] = {
        oldValue: existingValue,
        newValue: newValue,
        label: field.label
      };
    }
  });

  return changes;
}

// 应用数据变化到账号对象
function applyDataChanges(accountData, changes) {
  const updatedData = { ...accountData };
  
  Object.keys(changes).forEach(fieldName => {
    updatedData[fieldName] = changes[fieldName].newValue;
  });
  
  updatedData.updatedAt = new Date().toISOString();
  return updatedData;
}

// 生成变化报告文本
function generateChangeReport(email, changes) {
  if (Object.keys(changes).length === 0) {
    return '';
  }
  
  const changeList = Object.keys(changes).map(fieldName => {
    const change = changes[fieldName];
    return `  • ${change.label}: 已更新`;
  }).join('\n');
  
  return `\n📝 ${email} 数据已更新:\n${changeList}`;
}

async function executeReInbound(emails, submitterId, accountsData = {}, reinboundPrice = null) {
  const results = {
    success: [],
    failed: [],
    errors: []
  };

  console.log(`[重新入库] 开始处理 ${emails.length} 个账号的重新入库`);

  for (const email of emails) {
    try {
      console.log(`[重新入库] 处理账号: ${email}`);
      
      // 1. 直接从 Notion 获取账号信息并更新状态
      try {
        const notionResponse = await notion.databases.query({
          database_id: DATABASE_ID,
          filter: {
            property: '客户邮箱',
            email: { equals: email }
          }
        });

        if (notionResponse.results.length > 0) {
          const pageId = notionResponse.results[0].id;
          const props = notionResponse.results[0].properties;
          
          // 获取现有账号信息，保持原始提交者信息不变
          const existingAccountInfo = {
            email: email,
            accountType: props['账号类型']?.rich_text?.[0]?.text?.content || '未知',
            price: props['入库价格']?.number || 0,
            submitterId: props['提交者ID']?.rich_text?.[0]?.plain_text || '未知',
            password: props['邮箱密码']?.rich_text?.[0]?.plain_text || '',
            emailPassword: props['邮箱密码']?.rich_text?.[0]?.plain_text || '',
            totp: props['2FA验证码']?.rich_text?.[0]?.plain_text || '',
            twoFACode: props['2FA验证码']?.rich_text?.[0]?.plain_text || '',
            backupEmail: props['辅助邮箱']?.email || '',
            auxiliaryEmail: props['辅助邮箱']?.email || '',
            backupPassword: props['辅助密码']?.rich_text?.[0]?.plain_text || '',
            auxiliaryPassword: props['辅助密码']?.rich_text?.[0]?.plain_text || '',
            accountKey: props['API密钥']?.rich_text?.[0]?.plain_text || '',
            account_key: props['API密钥']?.rich_text?.[0]?.plain_text || ''
          };
          
          // 检查是否有新提交的数据需要更新
          const newAccountData = accountsData[email] || {};
          const changes = compareAccountData(existingAccountInfo, newAccountData);
          
          // 准备 Notion 更新属性
          const notionUpdateProps = {
            '状态': { select: { name: '在库' } },
            '出库日期': { date: null },
            '出库价格': { number: null }
          };
          
          // 重新入库相关字段只记录在本地数据库，不同步到Notion
          
          // 如果有数据变化，更新相应字段
          if (Object.keys(changes).length > 0) {
            if (changes.password || changes.emailPassword) {
              const newPassword = changes.password?.newValue ?? changes.emailPassword?.newValue ?? '';
              notionUpdateProps['邮箱密码'] = { rich_text: [{ text: { content: newPassword } }] };
            }
            
            if (changes.totp || changes.twoFACode) {
              const newTotp = changes.totp?.newValue ?? changes.twoFACode?.newValue ?? '';
              notionUpdateProps['2FA验证码'] = { rich_text: [{ text: { content: newTotp } }] };
            }
            
            if (changes.backupEmail || changes.auxiliaryEmail) {
              const newBackupEmail = changes.backupEmail?.newValue ?? changes.auxiliaryEmail?.newValue ?? '';
              // 对于邮箱字段，空值需要特殊处理
              if (newBackupEmail) {
                notionUpdateProps['辅助邮箱'] = { email: newBackupEmail };
              } else {
                notionUpdateProps['辅助邮箱'] = { email: null };
              }
            }
            
            if (changes.backupPassword || changes.auxiliaryPassword) {
              const newBackupPassword = changes.backupPassword?.newValue ?? changes.auxiliaryPassword?.newValue ?? '';
              notionUpdateProps['辅助密码'] = { rich_text: [{ text: { content: newBackupPassword } }] };
            }
            
            if (changes.accountKey || changes.account_key) {
              const newAccountKey = changes.accountKey?.newValue ?? changes.account_key?.newValue ?? '';
              notionUpdateProps['API密钥'] = { rich_text: [{ text: { content: newAccountKey } }] };
            }
            
            console.log(`[重新入库] 检测到 ${email} 的数据变化，将同时更新字段`);
          }
          
          // 更新 Notion 状态和数据
          await notion.pages.update({
            page_id: pageId,
            properties: notionUpdateProps
          });
          
          // 记录变化信息到账号信息中
          existingAccountInfo.changes = changes;
          existingAccountInfo.changeReport = generateChangeReport(email, changes);
          
          console.log(`[重新入库] Notion数据库更新成功: ${email}`);
          
          // 2. 尝试更新本地数据库（如果存在的话）
          const existingAccount = await localDB.findAccount(email);
          if (existingAccount) {
            // 应用数据变化到本地账号
            const updatedLocalAccount = applyDataChanges(existingAccount, changes);
            
            const localUpdateData = {
              outboundPrice: null,
              outboundDate: null,
              password: updatedLocalAccount.password,
              emailPassword: updatedLocalAccount.emailPassword,
              totp: updatedLocalAccount.totp,
              twoFACode: updatedLocalAccount.twoFACode,
              backupEmail: updatedLocalAccount.backupEmail,
              auxiliaryEmail: updatedLocalAccount.auxiliaryEmail,
              backupPassword: updatedLocalAccount.backupPassword,
              auxiliaryPassword: updatedLocalAccount.auxiliaryPassword,
              accountKey: updatedLocalAccount.accountKey,
              account_key: updatedLocalAccount.account_key,
              updatedAt: updatedLocalAccount.updatedAt
            };
            
            // 如果提供了重新入库价格，添加重新入库字段
            if (reinboundPrice !== null) {
              localUpdateData.reinboundPrice = reinboundPrice;
              localUpdateData.reinboundDate = new Date().toISOString().split('T')[0];
              localUpdateData.reinboundUserId = submitterId.toString();
              localUpdateData.reinboundUserName = getSubmitterAlias(submitterId);
            }
            
            const localUpdateResult = await localDB.updateAccountStatus(email, '在库', localUpdateData);
            
            if (localUpdateResult) {
              console.log(`[重新入库] 本地数据库也已更新: ${email}`);
              if (Object.keys(changes).length > 0) {
                console.log(`[重新入库] 本地数据库字段已同步更新: ${email}`);
              }
            }
          } else {
            console.log(`[重新入库] 账号不在本地数据库中，仅更新了Notion: ${email}`);
          }
          
          results.success.push(existingAccountInfo);
          
        } else {
          console.error(`[重新入库] 在Notion中未找到账号: ${email}`);
          results.failed.push(email);
          results.errors.push(`${email}: 在Notion数据库中未找到该账号`);
        }
      } catch (notionError) {
        console.error(`[重新入库] Notion操作失败: ${email}`, notionError.message);
        results.failed.push(email);
        results.errors.push(`${email}: Notion操作失败 - ${notionError.message}`);
      }
    } catch (error) {
      console.error(`[重新入库] 处理账号失败: ${email}`, error.message);
      results.failed.push(email);
      results.errors.push(`${email}: ${error.message}`);
    }
  }

  console.log(`[重新入库] 完成。成功: ${results.success.length}, 失败: ${results.failed.length}`);
  
  // 清除相关账号的查询缓存
  for (const email of emails) {
    const cacheKey = `dup_${email}`;
    if (queryCache.has(cacheKey)) {
      queryCache.delete(cacheKey);
      console.log(`[缓存] 已清除 ${email} 的缓存`);
    }
  }
  
  // 发送通知给提交者（如果有成功的账号）
  if (results.success.length > 0) {
    try {
      const successEmails = results.success.map(acc => acc.email);
      let notifyMessage = `✅ **重新入库成功通知**\n\n` +
        `以下账号已成功重新入库：\n\n` +
        successEmails.map(email => `• ${email}`).join('\n');
      
      // 添加数据变化报告
      const changesReports = results.success
        .filter(acc => acc.changeReport && acc.changeReport.trim())
        .map(acc => acc.changeReport)
        .join('');
      
      if (changesReports) {
        notifyMessage += `\n\n🔄 **数据更新详情：**${changesReports}`;
      }
      
      notifyMessage += `\n\n📊 **统计：**\n` +
        `• 成功重新入库: ${results.success.length} 个\n` +
        `• 账号已恢复到原有类型和价格\n` +
        `• 状态: 在库`;
      
      await sendMessage(submitterId, notifyMessage);
      console.log(`[重新入库] 已发送通知给提交者: ${submitterId}`);
    } catch (notifyError) {
      console.error(`[重新入库] 发送通知失败:`, notifyError);
    }
  }
  
  return results;
}

// 解封重新入库执行函数
async function executeUnbanReinbound(emails, submitterId) {
  const results = {
    success: [],
    failed: [],
    errors: []
  };

  console.log(`[解封重新入库] 开始处理 ${emails.length} 个账号的解封重新入库`);

  for (const email of emails) {
    try {
      console.log(`[解封重新入库] 处理账号: ${email}`);
      
      // 1. 直接从 Notion 获取账号信息并更新状态
      try {
        const notionResponse = await notion.databases.query({
          database_id: DATABASE_ID,
          filter: {
            property: '客户邮箱',
            email: { equals: email }
          }
        });

        if (notionResponse.results.length > 0) {
          const pageId = notionResponse.results[0].id;
          const props = notionResponse.results[0].properties;
          
          // 获取账号信息，保持原始提交者信息不变
          const accountInfo = {
            email: email,
            accountType: props['账号类型']?.rich_text?.[0]?.text?.content || '未知',
            price: props['入库价格']?.number || 0,
            submitterId: props['提交者ID']?.rich_text?.[0]?.plain_text || '未知'
          };
          
          // 更新 Notion 状态从 "被封" 到 "在库"
          await notion.pages.update({
            page_id: pageId,
            properties: {
              '状态': { select: { name: '在库' } }
            }
          });
          
          console.log(`[解封重新入库] Notion数据库更新成功: ${email}`);
          
          // 2. 尝试更新本地数据库（如果存在的话）
          const existingAccount = await localDB.findAccounts({ email: email });
          if (existingAccount && existingAccount.length > 0) {
            const localUpdateResult = await localDB.updateAccountStatus(email, '在库');
            if (localUpdateResult) {
              await localDB.save();
              console.log(`[解封重新入库] 本地数据库也已更新: ${email}`);
            }
          } else {
            console.log(`[解封重新入库] 账号不在本地数据库中，仅更新了Notion: ${email}`);
          }
          
          results.success.push(accountInfo);
          
        } else {
          console.error(`[解封重新入库] 在Notion中未找到账号: ${email}`);
          results.failed.push(email);
          results.errors.push(`${email}: 在Notion数据库中未找到该账号`);
        }
      } catch (notionError) {
        console.error(`[解封重新入库] Notion操作失败: ${email}`, notionError.message);
        results.failed.push(email);
        results.errors.push(`${email}: Notion操作失败 - ${notionError.message}`);
      }
    } catch (error) {
      console.error(`[解封重新入库] 处理账号失败: ${email}`, error.message);
      results.failed.push(email);
      results.errors.push(`${email}: ${error.message}`);
    }
  }

  console.log(`[解封重新入库] 完成。成功: ${results.success.length}, 失败: ${results.failed.length}`);
  
  // 清除相关账号的查询缓存
  for (const email of emails) {
    const cacheKey = `dup_${email}`;
    if (queryCache.has(cacheKey)) {
      queryCache.delete(cacheKey);
      console.log(`[缓存] 已清除 ${email} 的缓存`);
    }
  }
  
  // 发送通知给提交者（如果有成功的账号）
  if (results.success.length > 0) {
    try {
      const successEmails = results.success.map(acc => acc.email);
      const notifyMessage = `🔓 **解封重新入库成功通知**\n\n` +
        `以下账号已成功解封并重新入库：\n\n` +
        successEmails.map(email => `• ${email}`).join('\n') +
        `\n\n📊 **统计：**\n` +
        `• 成功解封重新入库: ${results.success.length} 个\n` +
        `• 账号状态已从"被封"恢复为"在库"\n` +
        `• 所有账号信息保持不变`;
      
      await sendMessage(submitterId, notifyMessage);
      console.log(`[解封重新入库] 已发送通知给提交者: ${submitterId}`);
    } catch (notifyError) {
      console.error(`[解封重新入库] 发送通知失败:`, notifyError);
    }
  }
  
  return results;
}

// 生成详细预览
function generateDetailedPreview(data, showAll = true) {
  let preview = `📋 **解析结果** (共 ${data.length} 个账号)\n\n`;
  
  // 默认显示全部数据，不再限制数量
  if (data.length <= 1000 || showAll) {
    preview += `📄 **CSV格式数据** (点击复制)\n\n`;
    
    // CSV头部
    const csvHeader = '序号,email,password,totp,backup_email,backup_password,api_key';
    preview += `\`\`\`\n${csvHeader}\n`;
    
    // 显示数据行
    data.forEach((acc, index) => {
      const csvRow = [
        index + 1,
        acc.email || '',
        acc.email_password || '',
        acc.two_fa_code || '',
        acc.auxiliary_email || '',
        acc.auxiliary_email_password || '',
        acc.account_key || ''
      ].map(field => String(field).replace(/,/g, '，')).join(',');
      
      preview += `${csvRow}\n`;
    });
    
    preview += `\`\`\`\n\n`;
    
    if (data.length > 5) {
      preview += `💡 数据已以CSV格式显示，可直接复制使用\n\n`;
    }
  } else {
    // 极大量账号时也显示全部，不再省略
    preview += `📊 **完整数据显示** (全部 ${data.length} 个账号)\n\n`;
    
    const csvHeader = '序号,email,password,totp,backup_email,backup_password,api_key';
    preview += `\`\`\`\n${csvHeader}\n`;
    
    // 显示全部账号，不再限制数量
    data.forEach((acc, index) => {
      const csvRow = [
        index + 1,
        acc.email || '',
        acc.email_password || '',  // 显示完整密码
        acc.two_fa_code || '',     // 显示完整2FA
        acc.auxiliary_email || '',
        acc.auxiliary_email_password || '',
        acc.account_key || ''      // 显示完整API Key
      ].map(field => String(field).replace(/,/g, '，')).join(',');
      
      preview += `${csvRow}\n`;
    });
    
    preview += `\`\`\`\n\n`;
    preview += `💡 已显示全部 ${data.length} 个账号，无数据省略\n\n`;
  }
  
  return preview;
}

// 处理 /start 命令
async function handleStart(msg) {
  const chatId = msg.chat.id;
  const userName = msg.from.first_name || '用户';
  const isAdmin = ADMIN_IDS.includes(chatId.toString());
  
  console.log(`[命令] /start 来自 ${userName} (${chatId})`);
  
  delete sessions[chatId];
  delete editSessions[chatId];
  delete banSessions[chatId];
  
  let welcomeText = `👋 ${userName}，欢迎使用高级账号管理机器人！\n\n`;
  welcomeText += `📥 批量入库使用方法：\n\n`;
  welcomeText += `1️⃣ 直接粘贴包含账号的文本\n`;
  welcomeText += `2️⃣ 我会自动识别邮箱、密码、辅助邮箱等\n`;
  welcomeText += `3️⃣ 您可以编辑修改识别结果\n`;
  welcomeText += `4️⃣ 设置单价后直接入库\n\n`;
  
  welcomeText += `📊 统计功能：\n`;
  welcomeText += `• /mytoday - 查看您今日入库统计\n`;
  welcomeText += `• /quota - 查看配额使用情况\n`;
  
  if (isAdmin) {
    welcomeText += `\n👮 管理员功能：\n`;
    welcomeText += `• /outbound - 出库操作\n`;
    welcomeText += `• /outbound_email - 指定邮箱出库\n`;
    welcomeText += `• /dashboard - 数据面板（库存详情）\n`;
    welcomeText += `• /ban - 标记被封账号\n`;
    welcomeText += `• /find - 查找账号信息\n`;
    welcomeText += `• /limits - 设置每日限额\n`;
  }
  
  welcomeText += `\n👇 现在就粘贴您的数据吧！`;
  
  await sendMessage(chatId, welcomeText);
}

// 处理文本消息
async function handleText(msg) {
  const chatId = msg.chat.id;
  const text = msg.text;
  const userName = msg.from.first_name || '用户';
  
  console.log(`[文本消息] chatId: ${chatId}, text: "${text}"`);
  console.log(`[会话状态] 编辑会话: ${!!editSessions[chatId]}, 数据会话: ${!!sessions[chatId]}, 封禁会话: ${!!banSessions[chatId]}`);
  
  // 处理编辑会话
  if (editSessions[chatId]) {
    console.log('[处理] 进入编辑处理流程');
    await handleEditInput(chatId, text);
    return;
  }
  
  // 处理封禁会话
  if (banSessions[chatId]) {
    console.log('[处理] 进入封禁处理流程');
    await handleBanInput(chatId, text);
    return;
  }
  
  // 类型输入已改为按钮选择，不再处理文本输入
  
  // 处理价格输入
  if (sessions[chatId] && sessions[chatId].waitingForPrice) {
    await handlePriceInput(chatId, text);
    return;
  }
  
  // 处理重新入库价格输入
  if (sessions[chatId] && sessions[chatId].awaitingReInboundPrice) {
    await handleReInboundPriceInput(chatId, text);
    return;
  }
  
  // 处理出库数量输入
  if (outboundSessions[chatId] && outboundSessions[chatId].waitingForQuantity) {
    await handleOutboundQuantityInput(chatId, text);
    return;
  }
  
  // 处理出库价格输入
  if (outboundSessions[chatId] && outboundSessions[chatId].waitingForPrice) {
    await handleOutboundPrice(chatId, text);
    return;
  }
  
  // 处理查找会话
  if (findSessions[chatId] && findSessions[chatId].waitingForEmail) {
    await handleFindEmail(chatId, text);
    return;
  }
  
  // 处理邮箱指定出库会话
  if (emailOutboundSessions[chatId]) {
    if (emailOutboundSessions[chatId].waitingForEmails) {
      await handleEmailOutboundEmails(chatId, text);
      return;
    } else if (emailOutboundSessions[chatId].waitingForPrice) {
      await handleEmailOutboundPrice(chatId, text);
      return;
    }
  }
  
  // 处理限额设置会话
  if (limitSessions[chatId]) {
    if (limitSessions[chatId].waitingForType) {
      await handleLimitType(chatId, text);
      return;
    } else if (limitSessions[chatId].waitingForValue) {
      await handleLimitValue(chatId, text);
      return;
    }
  }
  
  console.log(`[文本] 收到来自 ${userName}: ${text.substring(0, 50)}...`);
  
  
  // 发送处理提示
  const processingMsg = await sendMessage(chatId, '🔍 正在智能解析您的数据...');
  
  try {
    // 解析数据
    const parser = new SmartDataParser();
    const results = parser.parseRawData(text);
    
    console.log(`[解析] 识别到 ${results.length} 个账号`);
    
    if (results.length === 0) {
      await deleteMessage(chatId, processingMsg.message_id);
      await sendMessage(chatId, 
        '❌ **未识别到账号信息**\n\n' +
        '请确保文本包含邮箱地址\n' +
        '例如：user@gmail.com password123',
        { parse_mode: 'Markdown' }
      );
      return;
    }
    
    // 提取所有邮箱进行重复检查
    const emails = results.map(r => r.email).filter(e => e);
    const duplicateResult = await checkDuplicateEmails(emails);
    const inStockDuplicates = duplicateResult.duplicates || [];
    const outboundAccounts = duplicateResult.outboundAccounts || [];
    const bannedAccounts = duplicateResult.bannedAccounts || [];
    
    // 保存原始的已出库账号数据用于UI显示
    const originalOutboundAccounts = [...outboundAccounts];
    
    // 过滤所有非新账号（在库重复、已出库、被封）
    const filteredResults = results.filter(account => 
      !inStockDuplicates.includes(account.email) && 
      !outboundAccounts.includes(account.email) &&
      !bannedAccounts.includes(account.email)
    );
    
    // 保存会话
    sessions[chatId] = {
      data: filteredResults, // 保存过滤后的数据
      userName: userName,
      userId: msg.from.id,
      duplicates: inStockDuplicates,
      outboundAccounts: outboundAccounts,
      bannedAccounts: bannedAccounts,
      originalData: results.map(r => ({...r})), // 保存原始数据副本
      parsedAccounts: results.map(r => ({...r})), // 为重新入库功能保存解析数据
      createdAt: Date.now(),
      lastActivity: Date.now()
    };
    
    // 显示结果
    let preview = generateDetailedPreview(filteredResults);
    
    // 显示去重账号CSV数据
    if (inStockDuplicates.length > 0) {
      preview += `\n⚠️ **去重账号 (${inStockDuplicates.length} 个) - 已在库：**\n\n`;
      preview += `\`\`\`\n`;
      preview += `序号,email,password,totp,backup_email,api_key,status\n`;
      
      // 获取去重账号的完整数据
      const duplicateAccountsData = results.filter(acc => inStockDuplicates.includes(acc.email));
      duplicateAccountsData.forEach((acc, index) => {
        const csvRow = [
          index + 1,
          acc.email || '',
          acc.email_password || '',
          acc.two_fa_code || '',
          acc.auxiliary_email || '',
          acc.account_key || '',
          '已在库'
        ].map(field => String(field).replace(/,/g, '，')).join(',');
        preview += `${csvRow}\n`;
      });
      
      preview += `\`\`\`\n`;
      preview += '💡 以上账号已在库，已自动过滤';
    }
    
    // 显示重新入库账号CSV数据  
    if (outboundAccounts.length > 0) {
      preview += `\n🔄 **重新入库账号 (${outboundAccounts.length} 个) - 已出库：**\n\n`;
      preview += `\`\`\`\n`;
      preview += `序号,email,password,totp,backup_email,api_key,status\n`;
      
      // 获取重新入库账号的完整数据
      const outboundAccountsData = results.filter(acc => outboundAccounts.includes(acc.email));
      outboundAccountsData.forEach((acc, index) => {
        const csvRow = [
          index + 1,
          acc.email || '',
          acc.email_password || '',
          acc.two_fa_code || '',
          acc.auxiliary_email || '',
          acc.account_key || '',
          '已出库'
        ].map(field => String(field).replace(/,/g, '，')).join(',');
        preview += `${csvRow}\n`;
      });
      
      preview += `\`\`\`\n`;
      preview += '💡 以上数据请人工处理';
    }
    
    // 显示被封账号CSV数据
    if (bannedAccounts.length > 0) {
      preview += `\n🚫 **被封账号 (${bannedAccounts.length} 个) - 已被封：**\n\n`;
      preview += `\`\`\`\n`;
      preview += `序号,email,password,totp,backup_email,api_key,status\n`;
      
      // 获取被封账号的完整数据
      const bannedAccountsData = results.filter(acc => bannedAccounts.includes(acc.email));
      bannedAccountsData.forEach((acc, index) => {
        const csvRow = [
          index + 1,
          acc.email || '',
          acc.email_password || '',
          acc.two_fa_code || '',
          acc.auxiliary_email || '',
          acc.account_key || '',
          '已被封'
        ].map(field => String(field).replace(/,/g, '，')).join(',');
        preview += `${csvRow}\n`;
      });
      
      preview += `\`\`\`\n`;
      preview += '💡 以上数据请人工处理';
    }
    
    // 构建按钮布局
    const keyboard = [];
    
    // 只有当有新账号要入库时才显示账号类型按钮（直接入库）
    if (filteredResults.length > 0) {
      // 显示6个固定类型
      keyboard.push([
        { text: '🔵 GCP300', callback_data: 'direct_type_GCP300' },
        { text: '📧 Gmail', callback_data: 'direct_type_Gmail' },
        { text: '☁️ AWS', callback_data: 'direct_type_AWS' }
      ]);
      keyboard.push([
        { text: '🌐 AZURE', callback_data: 'direct_type_AZURE' },
        { text: '🔢 5', callback_data: 'direct_type_5' },
        { text: '🔢 6', callback_data: 'direct_type_6' }
      ]);
      // 添加取消按钮
      keyboard.push([
        { text: '❌ 取消', callback_data: 'cancel' }
      ]);
    } else if (outboundAccounts.length > 0) {
      // 显示重新入库按钮（已出库账号）
      keyboard.push([
        { text: `🔄 重新入库 (${outboundAccounts.length})`, callback_data: 're_inbound' },
        { text: '❌ 取消', callback_data: 'cancel' }
      ]);
      preview += '\n\n💡 检测到已出库账号，可以重新入库';
    } else if (bannedAccounts.length > 0) {
      // 显示解封重新入库按钮（被封账号）
      keyboard.push([
        { text: `🔓 解封重新入库 (${bannedAccounts.length})`, callback_data: 'unban_reinbound' },
        { text: '❌ 取消', callback_data: 'cancel' }
      ]);
      preview += '\n\n💡 检测到被封账号，可以解封重新入库';
    } else {
      // 如果没有任何可处理的账号，只显示取消按钮
      keyboard.push([{ text: '❌ 取消', callback_data: 'cancel' }]);
      preview += '\n\n💡 没有可处理的账号';
    }

    await editMessage(chatId, processingMsg.message_id, preview, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: keyboard
      }
    });
    
  } catch (error) {
    console.error('[错误] 处理失败:', error.message);
    if (processingMsg && processingMsg.message_id) {
      await deleteMessage(chatId, processingMsg.message_id);
    }
    await sendMessage(chatId, '❌ 处理失败，请重试');
  }
}

// 处理编辑输入
async function handleEditInput(chatId, text) {
  const editSession = editSessions[chatId];
  if (!editSession) {
    console.log('[编辑] 没有找到编辑会话');
    return;
  }
  
  const { index, field } = editSession;
  const session = sessions[chatId];
  
  if (!session) {
    delete editSessions[chatId];
    console.log('[编辑] 没有找到数据会话');
    return;
  }
  
  console.log(`[编辑] 收到输入: "${text}", 当前字段: ${field}, 索引: ${index}`);
  
  // 更新数据
  if (text === '/skip' || text === '跳过' || text.toLowerCase() === 'skip') {
    console.log('[编辑] 跳过当前字段');
    // 跳过当前字段
  } else {
    session.data[index][field] = text;
    console.log(`[编辑] 更新字段 ${field} = ${text}`);
  }
  
  // 继续下一个字段或下一条记录
  const fields = ['email', 'email_password', 'two_fa_code', 'auxiliary_email', 'auxiliary_email_password'];
  let nextFieldIndex = fields.indexOf(field) + 1;
  let nextIndex = index;
  
  if (nextFieldIndex >= fields.length) {
    nextFieldIndex = 0;
    nextIndex++;
  }
  
  if (nextIndex >= session.data.length) {
    // 编辑完成
    delete editSessions[chatId];
    
    const preview = generateDetailedPreview(session.data);
    await sendMessage(chatId, 
      preview + '\n✅ 编辑完成！', 
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '📧 选择类型', callback_data: 'select_type' },
              { text: '✏️ 重新编辑', callback_data: 'edit_data' }
            ],
            [
              { text: '❌ 取消', callback_data: 'cancel' }
            ]
          ]
        }
      }
    );
  } else {
    // 继续编辑下一个
    const nextField = fields[nextFieldIndex];
    const currentValue = session.data[nextIndex][nextField] || '无';
    
    editSessions[chatId] = {
      index: nextIndex,
      field: nextField
    };
    
    const fieldNames = {
      'email': '邮箱',
      'email_password': '邮箱密码',
      'two_fa_code': '2FA密码',
      'auxiliary_email': '辅助邮箱',
      'auxiliary_email_password': '辅助密码'
    };
    
    await sendMessage(chatId,
      `📝 编辑第 ${nextIndex + 1} 条记录\n\n` +
      `${fieldNames[nextField]}：${currentValue}\n\n` +
      `请输入新值，或发送 /skip 跳过`
    );
  }
}

// 处理账号类型输入
async function handleTypeInput(chatId, text) {
  const session = sessions[chatId];
  if (!session || !session.waitingForType) return;
  
  const type = text.trim();
  if (!type) {
    await sendMessage(chatId, '❌ 请输入有效的账号类型');
    return;
  }
  
  // 设置类型
  session.data.forEach(acc => {
    acc.account_type = type;
  });
  
  // 检查配额
  const quota = await checkQuota(type);
  const needCount = session.data.length;
  
  if (!quota.allowed || (quota.remaining !== null && quota.remaining < needCount)) {
    // 配额不足
    let errorMsg = `❌ **配额不足**\n\n`;
    errorMsg += `账号类型：${type}\n`;
    
    if (quota.limit !== null) {
      errorMsg += `当前在库：${quota.current}/${quota.limit}\n`;
      errorMsg += `剩余配额：${quota.remaining}\n`;
      errorMsg += `需要数量：${needCount}\n\n`;
      errorMsg += `无法继续入库，请联系管理员调整限额或选择其他类型。`;
    }
    
    await sendMessage(chatId, errorMsg, { parse_mode: 'Markdown' });
    
    // 重置会话状态，让用户重新选择类型
    session.waitingForType = true;
    await sendMessage(chatId, '请重新输入账号类型：');
    return;
  }
  
  session.waitingForType = false;
  session.waitingForPrice = true;
  
  let message = `📊 已设置类型：**${type}**\n`;
  message += `账号数量：${session.data.length} 个\n`;
  
  // 显示配额信息
  if (quota.limit !== null) {
    message += `\n📈 **配额信息：**\n`;
    message += `当前在库：${quota.current}/${quota.limit}\n`;
    message += `本次入库后：${quota.current + needCount}/${quota.limit}\n`;
  }
  
  message += `\n请输入单个账号的价格（美元）：`;
  
  await sendMessage(chatId, message, { parse_mode: 'Markdown' });
}

// 处理价格输入
async function handlePriceInput(chatId, text) {
  const session = sessions[chatId];
  if (!session || isSessionExpired(session) || !session.waitingForPrice) {
    if (session && isSessionExpired(session)) {
      delete sessions[chatId];
      await sendMessage(chatId, '❌ 会话已过期（超过30分钟），请重新开始');
    }
    return;
  }
  
  // 更新会话活动时间
  updateSessionActivity(chatId);
  
  const price = parseFloat(text);
  if (isNaN(price) || price <= 0) {
    await sendMessage(chatId, '❌ 请输入有效的价格（大于0的数字）');
    return;
  }
  
  session.price = price;
  session.waitingForPrice = false;
  
  // 检查是否是新的直接入库流程
  if (session.selectedType) {
    // 新流程：直接执行入库
    await executeDirectInbound(chatId, session);
  } else {
    // 旧流程：显示确认界面
    const totalPrice = price * session.data.length;
    const confirmText = 
      `📊 **最终确认**\n\n` +
      `• 账号类型：${session.data[0].account_type}\n` +
      `• 账号数量：${session.data.length} 个\n` +
      `• 单价：$${price}\n` +
      `• 总价：$${totalPrice}\n\n` +
      `确认直接入库？`;
    
    await sendMessage(chatId, confirmText, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ 确认提交', callback_data: "submit_direct" },
            { text: '❌ 取消', callback_data: 'cancel' }
          ]
        ]
      }
    });
  }
}

// 执行直接入库（新简化流程）
async function executeDirectInbound(chatId, session) {
  const userName = session.userName || '用户';
  
  try {
    const processingMsg = await sendMessage(chatId, '⏳ 正在入库，请稍候...');
    
    // 准备入库数据
    let accounts = session.data;
    
    // 检查重复
    const allEmails = accounts.map(acc => acc.email);
    const duplicateResult = await checkDuplicateEmails(allEmails);
    const notionDuplicates = duplicateResult.duplicates || [];
    const localResult = await checkLocalDuplicates(allEmails);
    const localDuplicates = localResult.duplicates || [];
    const allDuplicates = new Set([...notionDuplicates, ...localDuplicates]);
    
    // 过滤重复账号
    let filteredAccounts = accounts.filter(acc => !allDuplicates.has(acc.email));
    
    if (filteredAccounts.length === 0) {
      await editMessage(chatId, processingMsg.message_id, 
        `❌ 所有账号都已存在于数据库中：\n${Array.from(allDuplicates).join('\n')}`
      );
      delete sessions[chatId];
      return;
    }
    
    // 执行入库
    let success = 0;
    let failed = 0;
    const errors = [];
    
    for (const account of filteredAccounts) {
      try {
        const preparedAccount = {
          email: account.email,
          accountType: account.account_type || session.selectedType,
          status: '在库',
          inboundDate: formatDate(new Date()),
          inboundPrice: session.price,
          outboundDate: null,
          outboundPrice: null,
          auxiliaryEmail: account.auxiliary_email || account.auxEmail || '',
          auxiliaryPassword: account.auxiliary_email_password || '',
          twoFACode: account.two_fa_code || '',
          emailPassword: account.email_password || account.password || '',
          submitterId: session.userId,
          submitterName: userName,
          notes: `单价: $${session.price}\n提交者: ${userName} (ID: ${session.userId})`
        };
        
        // 添加到本地数据库
        await localDB.addAccount(preparedAccount);
        
        // 同步到Notion
        try {
          await syncAccountToNotion(preparedAccount);
        } catch (notionError) {
          console.error('[警告] Notion同步失败，但本地已保存:', notionError.message);
        }
        
        success++;
      } catch (error) {
        failed++;
        errors.push(`${account.email}: ${error.message}`);
        console.error('[错误] 添加账号失败:', error);
      }
    }
    
    // 显示结果
    let resultText = `✅ **入库完成！**\n\n`;
    resultText += `📊 **统计信息：**\n`;
    resultText += `• 类型：${session.selectedType}\n`;
    resultText += `• 成功：${success} 个\n`;
    resultText += `• 失败：${failed} 个\n`;
    resultText += `• 单价：$${session.price}\n`;
    resultText += `• 总金额：$${(success * session.price).toFixed(2)}\n`;
    
    if (allDuplicates.size > 0) {
      resultText += `• 重复过滤：${allDuplicates.size} 个\n`;
    }
    
    if (failed > 0 && errors.length > 0) {
      resultText += `\n❌ **失败详情：**\n`;
      errors.slice(0, 5).forEach(error => {
        resultText += `• ${error}\n`;
      });
      if (errors.length > 5) {
        resultText += `... 还有 ${errors.length - 5} 个错误\n`;
      }
    }
    
    // 检查是否还有已出库账号需要处理
    const hasOutboundAccounts = session.outboundAccounts && session.outboundAccounts.length > 0;
    
    if (hasOutboundAccounts) {
      resultText += `\n\n❓ **还有 ${session.outboundAccounts.length} 个已出库账号：**\n`;
      session.outboundAccounts.forEach(email => {
        resultText += `• ${email}\n`;
      });
      resultText += `\n是否继续处理这些已出库账号？`;
      
      await editMessage(chatId, processingMsg.message_id, resultText, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: `🔄 重新入库 (${session.outboundAccounts.length})`, callback_data: 're_inbound' },
              { text: '❌ 忽略', callback_data: 'cancel' }
            ]
          ]
        }
      });
      
      // 不清理会话，保留给重新入库使用
    } else {
      await editMessage(chatId, processingMsg.message_id, resultText, {
        parse_mode: 'Markdown'
      });
      
      // 清理会话
      delete sessions[chatId];
    }
    
  } catch (error) {
    console.error('[错误] 直接入库失败:', error);
    await sendMessage(chatId, `❌ 入库失败：${error.message}`);
  }
}

// 处理重新入库价格输入
async function handleReInboundPriceInput(chatId, text) {
  const session = sessions[chatId];
  if (!session || !session.awaitingReInboundPrice) {
    await sendMessage(chatId, '❌ 重新入库会话无效，请重新开始');
    return;
  }
  
  // 验证价格输入
  const price = parseFloat(text.trim());
  if (isNaN(price) || price <= 0) {
    await sendMessage(chatId, '❌ 请输入有效的价格（必须是大于0的数字）\n\n例如：15 或 18.5');
    return;
  }
  
  // 清除等待价格输入状态
  session.awaitingReInboundPrice = false;
  session.reinboundPrice = price;
  
  const processingMsg = await sendMessage(chatId, '⏳ 正在执行重新入库操作...');
  
  try {
    // 准备账号数据映射，用于数据比较和更新
    const accountsDataMap = {};
    if (session.parsedAccounts && session.parsedAccounts.length > 0) {
      session.parsedAccounts.forEach(account => {
        accountsDataMap[account.email] = account;
      });
    }
    
    // 执行重新入库操作，传入价格和操作人信息
    const reInboundResult = await executeReInbound(
      session.outboundAccounts, 
      chatId, 
      accountsDataMap, 
      price
    );
    
    let resultMessage = `🔄 **重新入库完成**\n\n`;
    
    if (reInboundResult.success.length > 0) {
      resultMessage += `✅ **成功重新入库 ${reInboundResult.success.length} 个账号：**\n`;
      reInboundResult.success.forEach(account => {
        resultMessage += `• ${account.email} (${account.accountType || '未知类型'})\n`;
      });
      resultMessage += `\n💰 **重新入库价格：** ¥${price} 元/个\n`;
      resultMessage += `💵 **总金额：** ¥${(reInboundResult.success.length * price).toFixed(2)} 元\n\n`;
    }
    
    if (reInboundResult.failed.length > 0) {
      resultMessage += `❌ **重新入库失败 ${reInboundResult.failed.length} 个账号：**\n`;
      reInboundResult.failed.forEach(email => {
        resultMessage += `• ${email}\n`;
      });
      
      if (reInboundResult.errors.length > 0) {
        resultMessage += `\n**错误详情：**\n`;
        reInboundResult.errors.forEach(error => {
          resultMessage += `• ${error}\n`;
        });
      }
      resultMessage += '\n';
    }
    
    resultMessage += `💡 重新入库已完成，账号状态已恢复为"在库"`;
    
    // 检查是否还有被封账号需要处理
    const hasBannedAccounts = session.bannedAccounts && session.bannedAccounts.length > 0;
    
    if (hasBannedAccounts) {
      resultMessage += `\n\n❓ **还有 ${session.bannedAccounts.length} 个被封账号：**\n`;
      session.bannedAccounts.forEach(email => {
        resultMessage += `• ${email}\n`;
      });
      resultMessage += `\n是否继续处理这些被封账号？`;
      
      // 清空已出库账号数据，但保留被封账号数据
      session.outboundAccounts = [];
      
      await editMessage(chatId, processingMsg.message_id, resultMessage, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: `🔓 解封重新入库 (${session.bannedAccounts.length})`, callback_data: 'unban_reinbound' },
              { text: '❌ 忽略', callback_data: 'cancel' }
            ]
          ]
        }
      });
    } else {
      // 没有其他账号需要处理，清空会话数据
      delete sessions[chatId];
      
      await editMessage(chatId, processingMsg.message_id, resultMessage, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ 完成', callback_data: 'cancel' }
            ]
          ]
        }
      });
    }
    
  } catch (error) {
    console.error('[错误] 重新入库操作失败:', error);
    await editMessage(chatId, processingMsg.message_id, 
      `❌ **重新入库失败**\n\n错误: ${error.message}\n\n请稍后重试或联系管理员`, 
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🔄 重试', callback_data: 're_inbound' },
              { text: '❌ 取消', callback_data: 'cancel' }
            ]
          ]
        }
      }
    );
  }
}

// 处理回调查询
async function handleCallback(query) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;
  const userName = query.from.first_name;
  
  console.log(`[回调] ${data} 来自 ${userName}`);
  
  await answerCallback(query.id);
  
  // 取消操作
  if (data === 'cancel') {
    delete sessions[chatId];
    delete editSessions[chatId];
    delete outboundSessions[chatId];
    delete banSessions[chatId];
    await editMessage(chatId, messageId, '❌ 已取消操作');
    return;
  }
  
  // 显示密码
  if (data === 'show_passwords') {
    const session = sessions[chatId];
    if (!session) return;
    
    const preview = generateDetailedPreview(session.data, true);
    await editMessage(chatId, messageId, preview + '\n⚠️ 密码已显示', {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🔒 隐藏密码', callback_data: 'hide_passwords' },
            { text: '✏️ 编辑数据', callback_data: 'edit_data' }
          ],
          [
            { text: '📧 选择类型', callback_data: 'select_type' },
            { text: '❌ 取消', callback_data: 'cancel' }
          ]
        ]
      }
    });
  }
  
  // 隐藏密码
  if (data === 'hide_passwords') {
    const session = sessions[chatId];
    if (!session) return;
    
    const preview = generateDetailedPreview(session.data, false);
    await editMessage(chatId, messageId, preview, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✏️ 编辑数据', callback_data: 'edit_data' },
            { text: '🔍 查看密码', callback_data: 'show_passwords' }
          ],
          [
            { text: '📧 选择类型', callback_data: 'select_type' },
            { text: '🗑️ 移除重复', callback_data: 'remove_duplicates' }
          ],
          [
            { text: '❌ 取消', callback_data: 'cancel' }
          ]
        ]
      }
    });
  }
  
  // 编辑数据
  if (data === 'edit_data') {
    const session = sessions[chatId];
    if (!session) {
      console.log('[编辑] 没有找到数据会话，无法开始编辑');
      await answerCallback(query.id, '数据已过期，请重新导入');
      return;
    }
    
    console.log(`[编辑] 开始编辑数据，chatId: ${chatId}`);
    editSessions[chatId] = {
      index: 0,
      field: 'email'
    };
    
    const firstRecord = session.data[0];
    await sendMessage(chatId,
      `📝 开始编辑数据\n\n` +
      `第 1 条记录\n` +
      `邮箱：${firstRecord.email || '无'}\n\n` +
      `请输入新值，或发送 /skip 跳过`
    );
    console.log('[编辑] 已发送编辑提示，等待用户输入');
  }
  
  // 移除重复
  if (data === 'remove_duplicates') {
    const session = sessions[chatId];
    if (!session) return;
    
    if (session.duplicates.length === 0) {
      await answerCallback(query.id, '没有重复项需要移除');
      return;
    }
    
    // 移除重复项
    session.data = session.data.filter(item => 
      !session.duplicates.includes(item.email)
    );
    
    const preview = generateDetailedPreview(session.data);
    await editMessage(chatId, messageId, 
      preview + `\n✅ 已移除 ${session.duplicates.length} 个重复项`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '📧 选择类型', callback_data: 'select_type' },
              { text: '✏️ 编辑数据', callback_data: 'edit_data' }
            ],
            [
              { text: '❌ 取消', callback_data: 'cancel' }
            ]
          ]
        }
      }
    );
    
    session.duplicates = [];
  }

  // 重新入库处理 - 使用原价格，无需询问
  if (data === 're_inbound') {
    const session = sessions[chatId];
    if (!session || !session.outboundAccounts || session.outboundAccounts.length === 0) {
      await answerCallback(query.id, '没有已出库账号需要处理');
      return;
    }

    await answerCallback(query.id, '开始重新入库');
    
    const processingMsg = await sendMessage(chatId, '⏳ 正在执行重新入库操作...');
    
    try {
      // 准备账号数据映射
      const accountsDataMap = {};
      if (session.parsedAccounts) {
        session.parsedAccounts.forEach(account => {
          accountsDataMap[account.email] = account;
        });
      }
      
      // 使用原价格执行重新入库
      const reInboundResult = await executeReInbound(
        session.outboundAccounts, 
        chatId, 
        accountsDataMap, 
        null // 传入null使用原价格
      );
      
      // 构建结果消息
      let resultMessage = `📦 **重新入库完成**\n\n`;
      
      if (reInboundResult.success.length > 0) {
        resultMessage += `✅ **成功重新入库 ${reInboundResult.success.length} 个账号：**\n`;
        reInboundResult.success.forEach(account => {
          resultMessage += `• ${account.email} (${account.accountType || '未知类型'}) - 原价格\n`;
        });
        resultMessage += `\n💰 **使用原入库价格**\n\n`;
      }
      
      if (reInboundResult.failed.length > 0) {
        resultMessage += `❌ **重新入库失败 ${reInboundResult.failed.length} 个账号：**\n`;
        reInboundResult.failed.forEach(email => {
          resultMessage += `• ${email}\n`;
        });
        resultMessage += `\n`;
      }
      
      // 清理会话
      sessions[chatId] = null;
      
      await editMessage(chatId, processingMsg.message_id, resultMessage, { parse_mode: 'Markdown' });
      
    } catch (error) {
      console.error('[错误] 重新入库失败:', error);
      await editMessage(chatId, processingMsg.message_id, `❌ 重新入库失败：${error.message}`);
    }
    
    return;
  }

  // 解封重新入库处理 - 直接执行，无需确认
  if (data === 'unban_reinbound') {
    const session = sessions[chatId];
    if (!session || !session.bannedAccounts || session.bannedAccounts.length === 0) {
      await answerCallback(query.id, '没有被封账号需要处理');
      return;
    }

    await answerCallback(query.id, '正在处理解封重新入库...');
    
    try {
      // 执行解封重新入库操作
      const unbanResult = await executeUnbanReinbound(session.bannedAccounts, chatId);
      
      let resultMessage = `🔓 **解封重新入库完成**\n\n`;
      
      if (unbanResult.success.length > 0) {
        resultMessage += `✅ **成功解封并重新入库 ${unbanResult.success.length} 个账号：**\n`;
        unbanResult.success.forEach(account => {
          resultMessage += `• ${account.email} (${account.accountType || '未知类型'})\n`;
        });
        resultMessage += '\n';
      }
      
      if (unbanResult.failed.length > 0) {
        resultMessage += `❌ **解封失败 ${unbanResult.failed.length} 个账号：**\n`;
        unbanResult.failed.forEach(email => {
          resultMessage += `• ${email}\n`;
        });
        
        if (unbanResult.errors.length > 0) {
          resultMessage += `\n**错误详情：**\n`;
          unbanResult.errors.forEach(error => {
            resultMessage += `• ${error}\n`;
          });
        }
        resultMessage += '\n';
      }
      
      resultMessage += `💡 解封重新入库已完成，账号状态已从"被封"恢复为"在库"`;
      
      // 检查是否还有已出库账号需要处理
      const hasOutboundAccounts = session.outboundAccounts && session.outboundAccounts.length > 0;
      
      if (hasOutboundAccounts) {
        resultMessage += `\n\n❓ **还有 ${session.outboundAccounts.length} 个已出库账号：**\n`;
        session.outboundAccounts.forEach(email => {
          resultMessage += `• ${email}\n`;
        });
        resultMessage += `\n是否继续处理这些已出库账号？`;
        
        // 清空被封账号数据，但保留已出库账号数据
        session.bannedAccounts = [];
        
        await editMessage(chatId, messageId, resultMessage, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: `🔄 重新入库 (${session.outboundAccounts.length})`, callback_data: 're_inbound' },
                { text: '❌ 忽略', callback_data: 'cancel' }
              ]
            ]
          }
        });
      } else {
        // 没有其他账号需要处理，清空会话数据
        delete sessions[chatId];
        
        await editMessage(chatId, messageId, resultMessage, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ 完成', callback_data: 'cancel' }
              ]
            ]
          }
        });
      }
    } catch (error) {
      console.error('[错误] 解封重新入库处理失败:', error.message);
      await editMessage(chatId, messageId, 
        `❌ **解封重新入库失败**\n\n错误: ${error.message}\n\n请稍后重试或联系管理员`, 
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🔄 重试', callback_data: 'unban_reinbound' },
                { text: '❌ 取消', callback_data: 'cancel' }
              ]
            ]
          }
        }
      );
    }
  }
  
  // 选择类型
  if (data === 'select_type') {
    console.log(`[调试] 处理 select_type，chatId: ${chatId}`);
    const session = sessions[chatId];
    
    if (!session || isSessionExpired(session)) {
      console.log('[调试] 会话不存在或已过期！');
      if (session && isSessionExpired(session)) {
        delete sessions[chatId]; // 清理过期会话
        await answerCallback(query.id, '会话已过期（超过30分钟），请重新开始');
      } else {
        await answerCallback(query.id, '会话已过期，请重新开始');
      }
      return;
    }
    
    // 更新会话活动时间
    updateSessionActivity(chatId);
    
    console.log(`[调试] 会话存在，数据长度: ${session.data.length}`);
    
    if (session.data.length === 0) {
      await editMessage(chatId, messageId, '❌ 没有数据可以处理');
      return;
    }
    
    try {
      await editMessage(chatId, messageId,
        '📝 **请选择账号类型**\n\n' +
        `账号数量：${session.data.length} 个\n\n` +
        '选择对应的类型：',
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🔵 GCP300', callback_data: 'type_GCP300' },
                { text: '📧 Gmail', callback_data: 'type_Gmail' },
                { text: '☁️ AWS', callback_data: 'type_AWS' }
              ],
              [
                { text: '🌐 AZURE', callback_data: 'type_AZURE' },
                { text: '🔢 5', callback_data: 'type_5' },
                { text: '🔢 6', callback_data: 'type_6' }
              ],
              [
                { text: '❌ 取消', callback_data: 'cancel' }
              ]
            ]
          }
        }
      );
      console.log('[调试] 类型选择界面显示成功');
    } catch (error) {
      console.error('[调试] 编辑消息失败:', error);
    }
  }
  
  // 处理类型选择
  // 处理直接类型选择（新流程）
  if (data.startsWith('direct_type_')) {
    await handleDirectTypeSelection(query);
    return;
  }
  
  if (data.startsWith('type_')) {
    await handleTypeSelection(query);
  }
  
  
  // 直接入库（无需审批）
  if (data === 'submit_direct') {
    const session = sessions[chatId];
    if (!session || !session.price) return;
    
    await editMessage(chatId, messageId, '⏳ 正在入库，请稍候...');
    
    // 准备入库数据
    let accounts = session.data;
    
    // 一次性检查所有重复
    const allEmails = accounts.map(acc => acc.email);
    const duplicateResult = await checkDuplicateEmails(allEmails);
    const notionDuplicates = duplicateResult.duplicates || [];
    const localResult = await checkLocalDuplicates(allEmails);
    const localDuplicates = localResult.duplicates || [];
    const allDuplicates = new Set([...notionDuplicates, ...localDuplicates]);
    
    // 过滤掉重复的账号
    let filteredAccounts = accounts.filter(acc => !allDuplicates.has(acc.email));
    
    if (filteredAccounts.length === 0) {
      await editMessage(chatId, messageId, 
        `❌ 所有账号都已存在于数据库中：\n${Array.from(allDuplicates).join('\n')}`
      );
      delete sessions[chatId];
      return;
    }
    
    if (allDuplicates.size > 0) {
      console.log(`[直接入库] 过滤了 ${allDuplicates.size} 个重复账号`);
    }
    
    // 限额检查 - 按账号类型分组检查
    const typeGroups = {};
    filteredAccounts.forEach(acc => {
      const type = acc.account_type || '未分类账号';
      if (!typeGroups[type]) typeGroups[type] = [];
      typeGroups[type].push(acc);
    });

    // 检查每种类型的限额
    for (const [type, typeAccounts] of Object.entries(typeGroups)) {
      const quota = await checkQuota(type);
      if (!quota.allowed || quota.remaining < typeAccounts.length) {
        // 超出限额，禁止入库并提示
        const message = 
          `🚫 **入库被拒绝 - 超出每日限额**\n\n` +
          `📦 **账号类型**: ${type}\n` +
          `⚠️ **当前限额**: ${quota.limit}个\n` +
          `📊 **当前库存**: ${quota.current}个\n` +
          `📈 **剩余额度**: ${quota.remaining}个\n` +
          `❌ **尝试入库**: ${typeAccounts.length}个\n\n` +
          `💡 **建议操作**:\n` +
          `• 减少${type}入库数量至${quota.remaining}个以内\n` +
          `• 或联系管理员使用 /limits 调整限额设置\n\n` +
          `🔍 **查看当前配额**: 发送 /quota 命令`;
        
        await editMessage(chatId, messageId, message, { parse_mode: 'Markdown' });
        delete sessions[chatId];
        return;
      }
    }
    
    // 使用过滤后的账号列表
    accounts = filteredAccounts;
    let success = 0;
    let failed = 0;
    const errors = [];
    
    for (const account of accounts) {
      try {
        const preparedAccount = {
          email: account.email,
          accountType: account.account_type || '未分类账号',
          status: '在库',
          inboundDate: formatDate(new Date()),
          inboundPrice: session.price,
          outboundDate: null,
          outboundPrice: null,
          auxiliaryEmail: account.private_email || account.auxiliary_email || account.auxEmail || '',
          auxiliaryPassword: account.password || '',
          twoFACode: account.two_fa_code || '',
          emailPassword: account.email_password || account.password || '',
          submitterId: query.from.id,
          submitterName: userName,
          notes: account.notes || `单价: $${session.price}\n提交者: ${userName} (ID: ${query.from.id})`
        };
        
        // 添加到本地数据库
        await localDB.addAccount(preparedAccount);
        
        // 同步到Notion
        try {
          await syncAccountToNotion(preparedAccount);
        } catch (notionError) {
          console.error('[警告] Notion同步失败，但本地已保存:', notionError.message);
        }
        
        success++;
      } catch (error) {
        failed++;
        errors.push(`${account.email}: ${error.message}`);
        console.error('[错误] 添加账号失败:', error);
      }
    }
    
    let resultText = `✅ **入库完成！**\n\n`;
    resultText += `• 成功：${success} 条\n`;
    resultText += `• 失败：${failed} 条\n\n`;
    
    if (success > 0) {
      resultText += `数据已保存到本地数据库和Notion\n\n`;
      
      // 添加成功统计信息
      const totalPrice = success * session.price;
      resultText += `📊 **本次统计**\n`;
      resultText += `• 入库数量：${success} 个\n`;
      resultText += `• 入库金额：${totalPrice}`;
    }
    
    if (failed > 0 && errors.length > 0) {
      resultText += `\n\n❌ **失败详情：**\n`;
      errors.forEach(error => {
        resultText += `• ${error}\n`;
      });
    }
    
    await editMessage(chatId, messageId, resultText);
    await answerCallback(query.id, '入库成功');
    
    delete sessions[chatId];
  }


  // 提交审批
  if (data === 'submit_approval') {
    const session = sessions[chatId];
    if (!session || !session.price) return;
    
    // 生成审批ID
    const approvalId = `AP${Date.now()}`;
    
    // 保存到待审批列表
    pendingApprovals[approvalId] = {
      ...session,
      submitterId: query.from.id,
      submitterName: userName,
      submitTime: new Date().toISOString()
    };
    
    await editMessage(chatId, messageId, 
      `✅ **已提交审批**\n\n` +
      `审批编号：${approvalId}\n` +
      `请等待管理员审核`
    );
    
    // 通知管理员
    const totalPrice = session.price * session.data.length;
    await notifyAdmins(
      `🔔 **新的入库申请**\n\n` +
      `• 审批编号：${approvalId}\n` +
      `• 提交者：${userName}\n` +
      `• 账号类型：${session.data[0].account_type}\n` +
      `• 数量：${session.data.length} 个\n` +
      `• 单价：$${session.price}\n` +
      `• 总价：$${totalPrice}\n`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '📋 查看详情', callback_data: `view_${approvalId}` },
              { text: '✅ 批准', callback_data: `approve_${approvalId}` }
            ],
            [
              { text: '❌ 拒绝', callback_data: `reject_${approvalId}` }
            ]
          ]
        }
      }
    );
    
    delete sessions[chatId];
  }
  
  // 查看审批详情
  if (data.startsWith('view_')) {
    const approvalId = data.replace('view_', '');
    const approval = pendingApprovals[approvalId];
    
    if (!approval) {
      await editMessage(chatId, messageId, '❌ 审批记录不存在');
      return;
    }
    
    const details = generateDetailedPreview(approval.data, true);
    await sendMessage(chatId, 
      `📋 **审批详情** ${approvalId}\n\n` +
      details +
      `\n💰 单价：$${approval.price}\n` +
      `💰 总价：$${approval.price * approval.data.length}`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ 批准入库', callback_data: `approve_${approvalId}` },
              { text: '❌ 拒绝', callback_data: `reject_${approvalId}` }
            ]
          ]
        }
      }
    );
  }
  
  // 批准入库
  if (data.startsWith('approve_')) {
    const approvalId = data.replace('approve_', '');
    const approval = pendingApprovals[approvalId];
    
    if (!approval) {
      await editMessage(chatId, messageId, '❌ 审批记录不存在');
      return;
    }
    
    // 只有管理员可以批准
    if (!ADMIN_IDS.includes(chatId.toString())) {
      await answerCallback(query.id, '只有管理员可以批准');
      return;
    }
    
    await editMessage(chatId, messageId, '⏳ 正在入库...');
    
    // 执行入库
    let success = 0;
    let failed = 0;
    
    // 在审批前再次检查重复
    const approvalEmails = approval.data.map(acc => acc.email);
    let duplicateResult = await checkDuplicateEmails(approvalEmails);
    let notionDuplicates = duplicateResult.duplicates || [];
    let localResult = await checkLocalDuplicates(approvalEmails);
    let localDuplicates = localResult.duplicates || [];
    let allDuplicates = new Set([...notionDuplicates, ...localDuplicates]);
    
    if (allDuplicates.size > 0) {
      // 过滤掉重复的账号
      approval.data = approval.data.filter(acc => !allDuplicates.has(acc.email));
      
      const duplicateWarning = `⚠️ 发现 ${allDuplicates.size} 个重复账号已被自动过滤\n`;
      messageText = duplicateWarning + messageText;
    }
    
    for (const acc of approval.data) {
      try {
        const properties = {
          '账号类型': {
            rich_text: [{ text: { content: acc.account_type || '未分类' } }]
          },
          '客户邮箱': {
            email: acc.email
          },
          '状态': {
            select: { name: '在库' }
          },
          '入库日期': {
            date: { start: new Date().toISOString().split('T')[0] }
          },
          '入库价格': {
            number: approval.price
          },
          '来源': {
            rich_text: [{ text: { content: 'Telegram批量导入' } }]
          },
          '提交者ID': {
            rich_text: [{ text: { content: String(approval.submitterId || '') } }]
          }
        };
        
        // 辅助邮箱直接映射到对应字段
        if (acc.auxiliary_email) {
          properties['铺助邮箱'] = {
            rich_text: [{ text: { content: acc.auxiliary_email } }]
          };
        }
        
        // 辅助邮箱密码直接映射
        if (acc.auxiliary_email_password) {
          properties['铺助邮箱密码'] = {
            rich_text: [{ text: { content: acc.auxiliary_email_password } }]
          };
        }
        
        // 密钥映射
        if (acc.account_key) {
          properties['密钥'] = {
            rich_text: [{ text: { content: acc.account_key } }]
          };
        }
        
        // 2FA密码映射
        if (acc.two_fa_code) {
          properties['2fa密码'] = {
            rich_text: [{ text: { content: acc.two_fa_code } }]
          };
        }
        
        // 主邮箱密码映射
        if (acc.email_password) {
          properties['主邮箱密码'] = {
            rich_text: [{ text: { content: acc.email_password } }]
          };
        }
        
        // 备注只存储提交者信息
        let notes = `提交者: ${approval.submitterName} (ID: ${approval.submitterId})`;
        
        properties['备注'] = {
          rich_text: [{ text: { content: notes } }]
        };
        
        await notion.pages.create({
          parent: { database_id: DATABASE_ID },
          properties: properties
        });
        
        // 同步到本地数据库
        await localDB.addAccount({
          ...acc,
          inboundPrice: approval.price,
          submitterId: approval.submitterId,
          submitterName: approval.submitterName,
          notes: notes.trim()
        });
        
        success++;
        console.log(`✅ 入库成功: ${acc.email}`);
      } catch (e) {
        failed++;
        console.error(`❌ 入库失败 ${acc.email}: ${e.message}`);
      }
    }
    
    await editMessage(chatId, messageId,
      `✅ **入库完成！**\n\n` +
      `• 审批编号：${approvalId}\n` +
      `• 成功：${success} 条\n` +
      `• 失败：${failed} 条\n\n` +
      `数据已保存到Notion数据库`
    );
    
    // 通知提交者
    await sendMessage(approval.submitterId,
      `✅ **您的入库申请已通过**\n\n` +
      `审批编号：${approvalId}\n` +
      `成功入库：${success} 条`
    );
    
    delete pendingApprovals[approvalId];
  }
  
  // 拒绝审批
  if (data.startsWith('reject_')) {
    const approvalId = data.replace('reject_', '');
    const approval = pendingApprovals[approvalId];
    
    if (!approval) return;
    
    if (!ADMIN_IDS.includes(chatId.toString())) {
      await answerCallback(query.id, '只有管理员可以拒绝');
      return;
    }
    
    await editMessage(chatId, messageId, `❌ 已拒绝审批 ${approvalId}`);
    
    // 通知提交者
    await sendMessage(approval.submitterId,
      `❌ **您的入库申请被拒绝**\n\n` +
      `审批编号：${approvalId}`
    );
    
    delete pendingApprovals[approvalId];
  }
  
  // 返回预览
  if (data === 'back_to_preview') {
    const session = sessions[chatId];
    if (!session) return;
    
    const preview = generateDetailedPreview(session.data);
    await editMessage(chatId, messageId, preview, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✏️ 编辑数据', callback_data: 'edit_data' },
            { text: '🔍 查看密码', callback_data: 'show_passwords' }
          ],
          [
            { text: '📧 选择类型', callback_data: 'select_type' },
            { text: '🗑️ 移除重复', callback_data: 'remove_duplicates' }
          ],
          [
            { text: '❌ 取消', callback_data: 'cancel' }
          ]
        ]
      }
    });
  }
  
  // 导出CSV
  if (data === 'export_csv') {
    const isAdmin = ADMIN_IDS.includes(chatId.toString());
    
    if (!isAdmin) {
      await answerCallback(query.id, '❌ 此功能仅限管理员使用');
      return;
    }
    
    try {
      // 获取CSV数据
      const csvData = await localDB.exportToCSV();
      
      if (!csvData || csvData.trim().length === 0) {
        await answerCallback(query.id, '❌ 没有数据可导出');
        return;
      }
      
      // 生成文件名
      const timestamp = new Date().toISOString().split('T')[0];
      const filename = `accounts_export_${timestamp}.csv`;
      
      // 发送CSV文件
      await sendDocument(chatId, {
        source: Buffer.from(csvData, 'utf-8'),
        filename: filename
      }, {
        caption: `📊 账号数据导出\n📅 导出时间: ${new Date().toLocaleString('zh-CN')}`
      });
      
      await answerCallback(query.id, '✅ CSV导出成功');
      
    } catch (error) {
      console.error('[CSV导出] 导出失败:', error);
      await answerCallback(query.id, '❌ 导出失败，请稍后重试');
    }
  }
}

// 处理待审批命令
async function handlePending(msg) {
  const chatId = msg.chat.id;
  
  if (!ADMIN_IDS.includes(chatId.toString())) {
    await sendMessage(chatId, '❌ 只有管理员可以查看待审批');
    return;
  }
  
  const pendingList = Object.entries(pendingApprovals);
  
  if (pendingList.length === 0) {
    await sendMessage(chatId, '📭 没有待审批的申请');
    return;
  }
  
  let text = `📋 **待审批列表** (${pendingList.length} 个)\n\n`;
  
  pendingList.forEach(([id, approval]) => {
    const totalPrice = approval.price * approval.data.length;
    text += `• ${id}\n`;
    text += `  提交者：${approval.submitterName}\n`;
    text += `  类型：${approval.data[0].account_type}\n`;
    text += `  数量：${approval.data.length} 个\n`;
    text += `  总价：$${totalPrice}\n\n`;
  });
  
  await sendMessage(chatId, text, { parse_mode: 'Markdown' });
}

// 处理出库命令
async function handleOutbound(msg) {
  const chatId = msg.chat.id;
  
  if (!ADMIN_IDS.includes(chatId.toString())) {
    await sendMessage(chatId, '❌ 只有管理员可以执行出库操作');
    return;
  }
  
  console.log('[命令] /outbound');
  
  // 获取库存统计
  try {
    const stats = await getInventoryStats();
    
    let statsText = '📊 **当前库存**\n\n';
    const buttons = [];
    
    Object.entries(stats).forEach(([type, count]) => {
      if (count > 0) {
        statsText += `• ${type}: ${count} 个\n`;
        buttons.push([{ 
          text: `${type} (${count})`, 
          callback_data: `out_${type}` 
        }]);
      }
    });
    
    if (buttons.length === 0) {
      await sendMessage(chatId, '📭 库存为空');
      return;
    }
    
    statsText += '\n请选择要出库的类型：';
    
    await sendMessage(chatId, statsText, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [...buttons, [{ text: '❌ 取消', callback_data: 'cancel' }]]
      }
    });
    
  } catch (error) {
    console.error('[错误] 获取库存失败:', error);
    await sendMessage(chatId, '❌ 获取库存失败');
  }
}

// 格式化为CSV
function formatToCSV(records) {
  let csv = 'email,password,totp,backup_email,backup_password,api_key,cpny\n';
  
  records.forEach(record => {
    const email = record.email || '';
    const password = record.email_password || record.password || record.emailPassword || ''; // 支持三种字段名
    const totp = record.two_fa_code || record.twoFACode || ''; // 支持两种字段名
    const backupEmail = record.auxiliary_email || record.auxiliaryEmail || ''; // 支持两种字段名
    const backupPassword = record.auxiliary_email_password || record.auxiliaryPassword || ''; // 辅助邮箱密码
    const apiKey = record.account_key || record.accountKey || ''; // API密钥
    const cpny = '1'; // 默认值为1
    
    csv += `${email},${password},${totp},${backupEmail},${backupPassword},${apiKey},${cpny}\n`;
  });
  
  return csv;
}

// 处理直接类型选择（新简化流程）
async function handleDirectTypeSelection(query) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const type = query.data.replace('direct_type_', '');
  const userName = query.from.first_name || '用户';
  
  const session = sessions[chatId];
  if (!session || isSessionExpired(session) || !session.data || session.data.length === 0) {
    if (session && isSessionExpired(session)) {
      delete sessions[chatId];
      await answerCallback(query.id, '会话已过期（超过30分钟），请重新开始');
    } else {
      await answerCallback(query.id, '会话已过期，请重新开始');
    }
    return;
  }
  
  // 更新会话活动时间
  updateSessionActivity(chatId);
  
  // 保存选择的类型到会话
  // 注意：session.data 现在只包含新账号（已过滤掉在库重复、已出库、被封账号）
  session.parsedAccounts = session.originalData.map(acc => ({...acc})); // 保存完整原始数据用于重新入库
  session.data.forEach(acc => {
    acc.account_type = type;
  });
  
  try {
    // 询问单价
    let confirmText = `📝 **账号类型：${type}**\n\n`;
    
    // 显示解析结果摘要（CSV格式，前5个账号）
    if (session.data.length <= 5) {
      confirmText += `📄 **账号详情：**\n\`\`\`\n`;
      confirmText += `序号,email,password,totp,backup_email\n`;
      session.data.forEach((acc, index) => {
        const csvRow = [
          index + 1,
          acc.email || '',
          acc.email_password || '',
          acc.two_fa_code || '',
          acc.auxiliary_email || ''
        ].join(',');
        confirmText += `${csvRow}\n`;
      });
      confirmText += `\`\`\`\n\n`;
    } else {
      confirmText += `📊 **批量入库：${session.data.length} 个账号**\n\n`;
      confirmText += `📄 **预览前5个：**\n\`\`\`\n`;
      confirmText += `序号,email,password,totp,backup_email\n`;
      session.data.slice(0, 5).forEach((acc, index) => {
        const csvRow = [
          index + 1,
          acc.email || '',
          acc.email_password || '',
          acc.two_fa_code || '',
          acc.auxiliary_email || ''
        ].join(',');
        confirmText += `${csvRow}\n`;
      });
      confirmText += `... 还有 ${session.data.length - 5} 个账号\n\`\`\`\n\n`;
    }
    
    confirmText += `💰 **请输入单价（美元）：**`;
    
    // 设置会话状态，等待单价输入
    session.waitingForPrice = true;
    session.selectedType = type;
    
    await editMessage(chatId, messageId, confirmText, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '❌ 取消', callback_data: 'cancel' }
          ]
        ]
      }
    });
    
    await answerCallback(query.id, `已选择 ${type}，请输入单价`);
    
  } catch (error) {
    console.error('[错误] 处理直接类型选择失败:', error);
    await answerCallback(query.id, '处理失败，请重试');
  }
}

// 处理类型选择
async function handleTypeSelection(query) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const selectedType = query.data.replace('type_', '');
  
  // 立即响应回调
  await telegramRequest('answerCallbackQuery', {
    callback_query_id: query.id,
    text: `已选择类型: ${selectedType}`
  });
  
  const session = sessions[chatId];
  if (!session) {
    await sendMessage(chatId, '❌ 会话已过期，请重新开始');
    return;
  }
  
  // 设置类型到每个账号
  session.data.forEach(acc => {
    acc.account_type = selectedType;
  });
  
  // 检查配额
  const quota = await checkQuota(selectedType);
  const needCount = session.data.length;
  
  if (!quota.allowed || (quota.remaining !== null && quota.remaining < needCount)) {
    // 配额不足
    let errorMsg = `❌ **配额不足**\n\n`;
    errorMsg += `账号类型：${selectedType}\n`;
    
    if (quota.limit !== null) {
      errorMsg += `当前在库：${quota.current}/${quota.limit}\n`;
      errorMsg += `剩余配额：${quota.remaining}\n`;
      errorMsg += `需要数量：${needCount}\n\n`;
      errorMsg += `无法继续入库，请联系管理员调整限额或选择其他类型。`;
    }
    
    await editMessage(chatId, messageId, errorMsg, { parse_mode: 'Markdown' });
    return;
  }
  
  // 更新会话状态
  session.waitingForType = false;
  session.waitingForPrice = true;
  session.selectedType = selectedType;
  
  let message = `📊 已设置类型：**${selectedType}**\n`;
  message += `账号数量：${session.data.length} 个\n`;
  
  // 显示配额信息
  if (quota.limit !== null) {
    message += `\n📈 **配额信息：**\n`;
    message += `当前在库：${quota.current}/${quota.limit}\n`;
    message += `本次入库后：${quota.current + needCount}/${quota.limit}\n`;
  }
  
  message += `\n请输入单个账号的价格（美元）：`;
  
  await editMessage(chatId, messageId, message, { parse_mode: 'Markdown' });
  
  console.log(`[类型选择] 用户选择了类型: ${selectedType}`);
}

// 处理查看CSV数据
async function handleShowCSV(query) {
  const chatId = query.message.chat.id;
  const session = outboundSessions[chatId];
  
  // 立即响应回调，避免超时
  await telegramRequest('answerCallbackQuery', {
    callback_query_id: query.id,
    text: '正在显示CSV数据...'
  });
  
  if (!session || !session.csvData) {
    await sendMessage(chatId, '❌ 数据已过期，请重新出库');
    return;
  }
  
  // 发送格式化的CSV数据
  const csvMessage = `📄 **出库数据 (CSV格式)**\n\n\`\`\`csv\n${session.csvData}\`\`\`\n\n✅ 长按上方内容即可复制`;
  
  try {
    await sendMessage(chatId, csvMessage, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('[错误] 发送CSV数据失败:', error.message);
    // 如果Markdown失败，尝试纯文本
    await sendMessage(chatId, `📄 出库数据 (CSV格式)\n\n${session.csvData}\n\n✅ 长按上方内容即可复制`);
  }
}

// 处理复制CSV数据
async function handleCopyCSV(query) {
  const chatId = query.message.chat.id;
  const session = outboundSessions[chatId];
  
  // 立即响应回调，避免超时
  await telegramRequest('answerCallbackQuery', {
    callback_query_id: query.id,
    text: '正在准备CSV数据...'
  });
  
  if (!session || !session.csvData) {
    await sendMessage(chatId, '❌ 数据已过期，请重新出库');
    return;
  }
  
  // 发送纯文本格式的CSV数据，方便复制
  const csvMessage = `📋 **CSV数据（请复制下方内容）:**\n\n\`\`\`\n${session.csvData}\`\`\`\n\n✅ 长按消息即可复制全部内容`;
  
  await sendMessage(chatId, csvMessage, {
    parse_mode: 'Markdown'
  });
}

// 获取库存统计
// 修改为接受统一数据源参数的函数
async function getInventoryStats(allAccounts = null) {
  const stats = {};
  
  try {
    let inStockAccounts;
    
    // 如果提供了统一数据源，优先使用
    if (allAccounts && Array.isArray(allAccounts)) {
      inStockAccounts = allAccounts.filter(acc => acc.status === '在库');
      console.log(`[库存统计] 使用统一数据源，找到 ${inStockAccounts.length} 个在库账号`);
    } else {
      // 否则从本地数据库获取
      const localAccounts = await localDB.findAccounts({ status: '在库' });
      
      inStockAccounts = localAccounts;
      console.log(`[库存统计] 本地数据库找到 ${inStockAccounts.length} 个在库账号`);
    }
    
    // 统计在库账号类型
    inStockAccounts.forEach(account => {
      const type = account.accountType || '未分类';
      stats[type] = (stats[type] || 0) + 1;
    });
    
    return stats;
    
  } catch (error) {
    console.error('[库存统计] 查询失败:', error);
    return {};
  }
}

// 处理出库选择
async function handleOutboundSelection(query) {
  const chatId = query.message.chat.id;
  const type = query.data.replace('out_', '');
  
  outboundSessions[chatId] = {
    type: type,
    step: 'quantity',
    waitingForQuantity: true
  };
  
  await editMessage(chatId, query.message.message_id,
    `📦 已选择类型：**${type}**\n\n` +
    `请输入出库数量（数字）：`,
    { parse_mode: 'Markdown' }
  );
}

// 处理出库数量输入
async function handleOutboundQuantityInput(chatId, text) {
  const session = outboundSessions[chatId];
  if (!session || !session.waitingForQuantity) return;
  
  const quantity = parseInt(text);
  if (isNaN(quantity) || quantity <= 0) {
    await sendMessage(chatId, '❌ 请输入有效的数量（大于0的整数）');
    return;
  }
  
  session.quantity = quantity;
  session.waitingForQuantity = false;
  session.waitingForPrice = true;
  
  await sendMessage(chatId,
    `📦 **出库信息**\n\n` +
    `• 类型：${session.type}\n` +
    `• 数量：${quantity} 个\n\n` +
    `请输入出库单价（美元）：`,
    { parse_mode: 'Markdown' }
  );
}

// 处理出库数量（回调版本，已不再使用）
async function handleOutboundQuantity(query) {
  const chatId = query.message.chat.id;
  const quantity = parseInt(query.data.replace('outqty_', ''));
  const session = outboundSessions[chatId];
  
  if (!session) return;
  
  session.quantity = quantity;
  session.waitingForPrice = true;
  
  await editMessage(chatId, query.message.message_id,
    `📦 **出库信息**\n\n` +
    `• 类型：${session.type}\n` +
    `• 数量：${quantity} 个\n\n` +
    `请输入出库单价（美元）：`
  );
}

// 处理出库价格
async function handleOutboundPrice(chatId, text) {
  const session = outboundSessions[chatId];
  if (!session || !session.waitingForPrice) return;
  
  const price = parseFloat(text);
  if (isNaN(price) || price <= 0) {
    await sendMessage(chatId, '❌ 请输入有效的价格（大于0的数字）');
    return;
  }
  
  session.price = price;
  session.waitingForPrice = false;
  
  const totalPrice = price * session.quantity;
  
  await sendMessage(chatId,
    `📦 **确认出库**\n\n` +
    `• 类型：${session.type}\n` +
    `• 数量：${session.quantity} 个\n` +
    `• 单价：$${price}\n` +
    `• 总价：$${totalPrice}\n\n` +
    `确认执行出库？`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ 确认出库', callback_data: 'confirm_outbound' },
            { text: '❌ 取消', callback_data: 'cancel' }
          ]
        ]
      }
    }
  );
}

// 执行出库
async function executeOutbound(query) {
  const chatId = query.message.chat.id;
  const session = outboundSessions[chatId];
  
  if (!session || !session.price) return;
  
  await editMessage(chatId, query.message.message_id, '⏳ 正在执行出库...');
  
  try {
    // 优先从本地数据库查询
    let availableAccounts = [];
    let useLocalDB = false;
    
    // 先尝试从本地数据库查询
    try {
      const localAccounts = await localDB.queryByType(session.type);
      if (localAccounts.length >= session.quantity) {
        availableAccounts = localAccounts.slice(0, session.quantity);
        useLocalDB = true;
        console.log(`[本地数据库] 找到 ${localAccounts.length} 个 ${session.type} 账号`);
      } else {
        console.log(`[本地数据库] ${session.type} 账号不足，需要 ${session.quantity} 个，实际 ${localAccounts.length} 个`);
      }
    } catch (error) {
      console.error('[本地数据库] 查询失败:', error.message);
    }
    
    // 检查本地数据库库存是否足够
    if (availableAccounts.length < session.quantity) {
      await editMessage(chatId, query.message.message_id, 
        `❌ 库存不足\n\n` +
        `需要：${session.quantity} 个\n` +
        `实际：${availableAccounts.length} 个`
      );
      delete outboundSessions[chatId];
      return;
    }
    
    // 收集出库数据
    const outboundData = [];
    let updateSuccess = 0;
    let updateFailed = 0;
    
    // 只使用本地数据库账号
    const accountsToProcess = availableAccounts.slice(0, session.quantity);
    
    for (const item of accountsToProcess) {
      let record;
      let pageId;
      
      // 只使用本地数据库记录构建数据
      record = {
        email: item.email,
        email_password: item.emailPassword || '',
        auxiliary_email: item.auxiliaryEmail || '',
        auxiliary_email_password: item.auxiliaryPassword || '',
        two_fa_code: item.twoFACode || '',
        notes: item.notes || ''
      };
      
      outboundData.push(record);
      
      // 逐个更新状态为出库，避免冲突
      try {
        // 更新本地数据库
        const updateResult = await localDB.updateAccountStatus(record.email, '出库', {
          outboundPrice: session.price,
          outboundDate: new Date().toISOString().split('T')[0],
            outboundUserId: chatId,
            outboundUserName: getSubmitterAlias(chatId),
            outboundSource: 'manual'
          });
          
          if (updateResult) {
            updateSuccess++;
            console.log(`✅ [本地] 更新成功: ${record.email}`);
            
            // 后台异步更新Notion，不影响响应速度
            (async () => {
              try {
                const notionResponse = await notion.databases.query({
                  database_id: DATABASE_ID,
                  filter: {
                    property: '客户邮箱',
                    email: { equals: record.email }
                  }
                });
                
                if (notionResponse.results.length > 0) {
                  await notion.pages.update({
                    page_id: notionResponse.results[0].id,
                    properties: {
                      '状态': { select: { name: '出库' } },
                      '出库日期': { date: { start: new Date().toISOString().split('T')[0] } },
                      '出库价格': { number: session.price },
                      '出库人ID': {
                        rich_text: [{
                          text: {
                            content: chatId.toString()
                          }
                        }]
                      },
                      '出库人': {
                        rich_text: [{
                          text: {
                            content: getSubmitterAlias(chatId)
                          }
                        }]
                      }
                    }
                  });
                  console.log(`✅ [Notion同步] ${record.email}`);
                }
              } catch (e) {
                console.error(`[Notion同步失败] ${record.email}:`, e.message);
              }
            })();
          } else {
            updateFailed++;
            console.log(`❌ [本地] 更新失败: ${record.email}`);
          }
      } catch (updateError) {
        updateFailed++;
        console.error(`❌ 更新失败 ${record.email}:`, updateError.message);
        // 即使更新失败，也继续处理（数据已经提取）
      }
    }
    
    // 生成CSV格式数据
    const csvData = formatToCSV(outboundData);
    
    // 生成出库摘要（分两部分发送，避免消息过长导致超时）
    const summary = 
      `📦 **出库完成**\n\n` +
      `• 类型：${session.type}\n` +
      `• 请求数量：${session.quantity} 个\n` +
      `• 实际出库：${outboundData.length} 个\n` +
      `• 更新成功：${updateSuccess} 个\n` +
      `• 更新失败：${updateFailed} 个\n` +
      `• 单价：$${session.price}\n` +
      `• 总价：$${session.price * outboundData.length}\n` +
      `• 时间：${new Date().toLocaleString('zh-CN')}\n\n` +
      `点击下方按钮查看CSV数据 👇`;
    
    // 先发送摘要信息（重试机制）
    let summarySuccess = false;
    for (let retry = 0; retry < 3; retry++) {
      try {
        await editMessage(chatId, query.message.message_id, summary, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '📋 查看CSV数据', callback_data: 'show_csv' },
                { text: '📄 复制CSV', callback_data: 'copy_csv' }
              ]
            ]
          }
        });
        summarySuccess = true;
        break;
      } catch (editError) {
        console.error(`[重试${retry + 1}/3] 编辑消息失败:`, editError.message);
        if (retry < 2) await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    // 如果编辑失败，发送新消息
    if (!summarySuccess) {
      try {
        await sendMessage(chatId, summary, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '📋 查看CSV数据', callback_data: 'show_csv' },
                { text: '📄 复制CSV', callback_data: 'copy_csv' }
              ]
            ]
          }
        });
      } catch (sendError) {
        console.error('[错误] 发送摘要消息失败:', sendError.message);
      }
    }
    
    // 立即发送CSV数据（分开发送，确保用户能看到）
    const csvMessage = `📄 **出库数据 (CSV格式)**\n\n\`\`\`csv\n${csvData}\`\`\`\n\n✅ 长按上方内容即可复制`;
    try {
      await sendMessage(chatId, csvMessage, { parse_mode: 'Markdown' });
    } catch (csvError) {
      console.error('[错误] 发送CSV数据失败:', csvError.message);
      // 如果Markdown失败，尝试纯文本
      try {
        await sendMessage(chatId, `📄 出库数据 (CSV格式)\n\n${csvData}\n\n✅ 长按上方内容即可复制`);
      } catch (textError) {
        console.error('[错误] 发送纯文本CSV失败:', textError.message);
      }
    }
    
    // 保存CSV数据到会话，供复制使用
    outboundSessions[chatId].csvData = csvData;
    
  } catch (error) {
    console.error('[错误] 出库失败:', error);
    await editMessage(chatId, query.message.message_id, '❌ 出库失败：' + error.message);
  }
}

// 处理更新
async function handleUpdate(update) {
  try {
    // 处理消息
    if (update.message) {
      const msg = update.message;
      
      // 先检查是否有编辑会话或封禁会话（优先处理这些会话的输入）
      if (msg.text && (editSessions[msg.chat.id] || banSessions[msg.chat.id])) {
        await handleText(msg);
      }
      // 处理命令
      else if (msg.text === '/start') {
        await handleStart(msg);
      } else if (msg.text === '/pending') {
        await handlePending(msg);
      } else if (msg.text === '/outbound') {
        await handleOutbound(msg);
      } else if (msg.text === '/outbound_email') {
        await handleEmailOutbound(msg);
      } else if (msg.text === '/dashboard') {
        await handleDashboard(msg);
      } else if (msg.text === '/ban') {
        await handleBan(msg);
      } else if (msg.text === '/mytoday') {
        await handleMyToday(msg);
      } else if (msg.text === '/find') {
        await handleFind(msg);
      } else if (msg.text === '/limits') {
        await handleLimits(msg);
      } else if (msg.text === '/quota') {
        await handleQuota(msg);
      }
      // 处理普通文本
      else if (msg.text && !msg.text.startsWith('/')) {
        await handleText(msg);
      }
    }
    
    // 处理回调查询
    if (update.callback_query) {
      const query = update.callback_query;
      
      // 立即响应回调，避免延迟
      answerCallback(query.id);
      
      // 类型选择回调
      if (query.data.startsWith('type_')) {
        await handleTypeSelection(query);
      
      // 出库相关回调
      } else if (query.data.startsWith('out_')) {
        await handleOutboundSelection(query);
      } else if (query.data === 'confirm_outbound') {
        await executeOutbound(query);
      } else if (query.data === 'confirm_email_outbound') {
        await executeEmailOutbound(query);
      } else if (query.data === 'show_csv') {
        await handleShowCSV(query);
      } else if (query.data === 'copy_csv') {
        await handleCopyCSV(query);
      } else if (query.data === 'ban_confirm') {
        await answerCallback(query.id, '正在处理封禁...');
        await executeBan(query.from.id);
      } else if (query.data === 'ban_cancel') {
        delete banSessions[query.from.id];
        await answerCallback(query.id, '已取消封禁操作');
        await sendMessage(query.from.id, '❌ 已取消封禁操作');
      } else if (query.data === 'show_find_passwords') {
        await handleShowFindPasswords(query);
      } else if (query.data === 'hide_find_passwords') {
        await handleHideFindPasswords(query);
      } else if (query.data === 'copy_account_info') {
        await handleCopyAccountInfo(query);
      } else if (query.data === 'copy_accounts_csv') {
        await handleCopyAccountsCSV(query);
      } else if (query.data === 'end_find') {
        await handleEndFind(query);
      } else if (query.data.startsWith('limit_')) {
        await handleLimitCallback(query);
      } else if (query.data === 'refresh_dashboard') {
        await handleDashboardRefresh(query);
      } else if (query.data === 'view_instock') {
        await handleViewInstock(query);
      } else if (query.data === 'view_outstock') {
        await handleViewOutstock(query);
      } else if (query.data === 'export_database') {
        await handleExportDatabase(query);
      } else if (query.data === 'export_instock') {
        await handleExportInstock(query);
      } else if (query.data === 'export_outstock') {
        await handleExportOutstock(query);
      } else if (query.data === 'preview_instock') {
        await handlePreviewInstock(query);
      } else if (query.data === 'preview_outstock') {
        await handlePreviewOutstock(query);
      } else {
        await handleCallback(query);
      }
    }
  } catch (error) {
    console.error('[错误] 处理更新失败:', error.message);
  }
}



// 处理数据面板命令（整合库存详情）
async function handleDashboard(msg) {
  const chatId = msg.chat.id;
  
  if (!ADMIN_IDS.includes(chatId.toString())) {
    await sendMessage(chatId, '❌ 只有管理员可以查看数据面板');
    return;
  }
  
  await sendMessage(chatId, '⏳ 正在生成数据面板...');
  
  try {
    // 获取统一数据源
    const allAccounts = await localDB.getAllAccounts();
    console.log(`[数据面板] 统一数据源获取 ${allAccounts.length} 个账号`);
    
    // 基础统计 - 使用统一数据源
    const inStockAccounts = allAccounts.filter(acc => acc.status === '在库');
    const outStockAccounts = allAccounts.filter(acc => acc.status === '出库');
    const bannedAccounts = allAccounts.filter(acc => acc.status === '被封');
    
    // 数据验证 - 确保统计准确性
    const totalByStatus = inStockAccounts.length + outStockAccounts.length + bannedAccounts.length;
    if (totalByStatus !== allAccounts.length) {
      console.warn(`[统计警告] 状态统计不匹配: ${totalByStatus} vs ${allAccounts.length}`);
      console.warn(`[统计详情] 在库:${inStockAccounts.length}, 出库:${outStockAccounts.length}, 被封:${bannedAccounts.length}`);
    }
    
    // 获取其他统计数据 - 传入统一数据源
    const todayStats = await getAllTodayStats();
    const inventoryStats = await getInventoryStats(allAccounts);
    
    // 构建数据面板消息
    let message = `📊 **数据面板 - 库存详情**\n\n`;
    
    // 1. 库存概览
    message += `📈 **库存概览**\n`;
    message += `• 总账号数：${allAccounts.length} 个\n`;
    message += `• 在库：${inStockAccounts.length} 个\n`;
    message += `• 已出库：${outStockAccounts.length} 个\n`;
    message += `• 被封：${bannedAccounts.length} 个\n\n`;
    
    // 2. 在库账号分类统计
    if (Object.keys(inventoryStats).length > 0) {
      message += `📦 **在库分类统计**\n`;
      let totalInStock = 0;
      Object.entries(inventoryStats).forEach(([type, count]) => {
        message += `• ${type}: ${count} 个\n`;
        totalInStock += count;
      });
      message += `**总计**: ${totalInStock} 个\n\n`;
    }
    
    // 3. 今日入库统计
    const submitterCount = Object.keys(todayStats.submitters).length;
    if (submitterCount > 0) {
      message += `📅 **今日入库统计**\n`;
      message += `• 活跃提交者：${submitterCount} 人\n`;
      message += `• 今日入库：${todayStats.totalCount} 个\n`;
      if (todayStats.totalAmount > 0) {
        message += `• 今日金额：¥${todayStats.totalAmount}\n`;
      }
      message += `\n`;
      
      // 4. 今日分类汇总
      if (Object.keys(todayStats.globalTypeStats).length > 0) {
        message += `📋 **今日分类汇总**\n`;
        for (const [type, count] of Object.entries(todayStats.globalTypeStats)) {
          message += `• ${type}: ${count} 个\n`;
        }
        message += `\n`;
      }
      
      // 5. 提交者详细统计
      message += `👤 **提交者详细统计**\n`;
      const submittersByAmount = Object.entries(todayStats.submitters)
        .map(([id, stats]) => ({
          id,
          name: getSubmitterAlias(id),
          total: stats.total,
          amount: stats.totalAmount,
          byType: stats.byType
        }))
        .sort((a, b) => b.amount - a.amount);
      
      submittersByAmount.forEach((submitter, index) => {
        const rank = index + 1;
        message += `${rank}. **${submitter.name}**\n`;
        
        // 显示该提交者的账号类型分类
        if (submitter.byType && Object.keys(submitter.byType).length > 0) {
          Object.entries(submitter.byType).forEach(([type, typeStats]) => {
            message += `   • ${type}: ${typeStats.count}个`;
            if (typeStats.amount > 0) {
              message += ` (¥${typeStats.amount})`;
            }
            message += `\n`;
          });
        }
        
        message += `   📊 小计: ${submitter.total}个`;
        if (submitter.amount > 0) {
          message += ` | ¥${submitter.amount}`;
        }
        message += `\n\n`;
      });
    } else {
      message += `📅 **今日入库统计**\n`;
      message += `📝 今天还没有入库记录\n\n`;
    }

    // 6. 出库人统计
    const outboundStats = await getOutboundUserStats();
    if (outboundStats.totalOutboundUsers > 0) {
      message += `📤 **出库人统计**\n`;
      message += `• 活跃出库人：${outboundStats.totalOutboundUsers} 人\n`;
      message += `• 总出库数：${outboundStats.totalOutboundCount} 个\n`;
      message += `  - 🔧 手动出库：${outboundStats.manualOutboundCount} 个\n`;
      message += `  - 🏪 卡网出售：${outboundStats.cardShopOutboundCount} 个\n\n`;
      
      // 显示出库人排行榜
      const usersByCount = Object.entries(outboundStats.userStats)
        .map(([userId, stats]) => ({
          userId,
          userName: getSubmitterAlias(userId),
          count: stats.count,
          types: stats.types
        }))
        .sort((a, b) => b.count - a.count);
      
      usersByCount.slice(0, 5).forEach((user, index) => {
        const rank = index + 1;
        message += `${rank}. **${user.userName}**: ${user.count}个\n`;
        
        // 显示该出库人的账号类型分类
        if (user.types && Object.keys(user.types).length > 0) {
          const typeList = Object.entries(user.types)
            .map(([type, count]) => `${type}(${count})`)
            .join(', ');
          message += `   └ ${typeList}\n`;
        }
      });
      message += `\n`;
    } else {
      message += `📤 **出库人统计**\n`;
      message += `📝 暂无出库记录\n\n`;
    }

    // 7. 重新入库统计
    const reinboundStats = await getReInboundStats();
    if (reinboundStats.totalReinboundUsers > 0) {
      message += `🔄 **重新入库统计**\n`;
      message += `• 重新入库操作人：${reinboundStats.totalReinboundUsers} 人\n`;
      message += `• 总重新入库数：${reinboundStats.totalReinboundCount} 个\n`;
      message += `• 今日重新入库：${reinboundStats.todayReinboundCount} 个\n\n`;
    } else {
      message += `🔄 **重新入库统计**\n`;
      message += `📝 暂无重新入库记录\n\n`;
    }
    
    // 显示操作按钮
    await sendMessage(chatId, message, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: `📥 查看在库 (${inStockAccounts.length})`, callback_data: 'view_instock' },
            { text: `📤 查看出库 (${outStockAccounts.length})`, callback_data: 'view_outstock' }
          ],
          [
            { text: '📊 导出数据', callback_data: 'export_database' },
            { text: '🔄 刷新面板', callback_data: 'refresh_dashboard' }
          ]
        ]
      }
    });
    
  } catch (error) {
    console.error('[错误] 生成数据面板失败:', error);
    await sendMessage(chatId, '❌ 生成数据面板失败：' + error.message);
  }
}

// 处理数据面板刷新回调
async function handleDashboardRefresh(query) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  
  try {
    await editMessage(chatId, messageId, '⏳ 正在刷新数据面板...');
    
    // 重新生成数据面板 - 使用统一数据源
    const allAccounts = await localDB.getAllAccounts();
    console.log(`[数据面板刷新] 统一数据源获取 ${allAccounts.length} 个账号`);
    
    // 基础统计 - 使用统一数据源
    const inStockAccounts = allAccounts.filter(acc => acc.status === '在库');
    const outStockAccounts = allAccounts.filter(acc => acc.status === '出库');
    const bannedAccounts = allAccounts.filter(acc => acc.status === '被封');
    
    // 数据验证 - 确保统计准确性
    const totalByStatus = inStockAccounts.length + outStockAccounts.length + bannedAccounts.length;
    if (totalByStatus !== allAccounts.length) {
      console.warn(`[刷新统计警告] 状态统计不匹配: ${totalByStatus} vs ${allAccounts.length}`);
    }
    
    // 获取其他统计数据 - 传入统一数据源
    const todayStats = await getAllTodayStats();
    const inventoryStats = await getInventoryStats(allAccounts);
    
    // 构建数据面板消息
    let message = `📊 **数据面板 - 库存详情**\n\n`;
    
    // 1. 库存概览
    message += `📈 **库存概览**\n`;
    message += `• 总账号数：${allAccounts.length} 个\n`;
    message += `• 在库：${inStockAccounts.length} 个\n`;
    message += `• 已出库：${outStockAccounts.length} 个\n`;
    message += `• 被封：${bannedAccounts.length} 个\n\n`;
    
    // 2. 在库账号分类统计
    if (Object.keys(inventoryStats).length > 0) {
      message += `📦 **在库分类统计**\n`;
      let totalInStock = 0;
      Object.entries(inventoryStats).forEach(([type, count]) => {
        message += `• ${type}: ${count} 个\n`;
        totalInStock += count;
      });
      message += `**总计**: ${totalInStock} 个\n\n`;
    }
    
    // 3. 今日入库统计
    const submitterCount = Object.keys(todayStats.submitters).length;
    if (submitterCount > 0) {
      message += `📅 **今日入库统计**\n`;
      message += `• 活跃提交者：${submitterCount} 人\n`;
      message += `• 今日入库：${todayStats.totalCount} 个\n`;
      if (todayStats.totalAmount > 0) {
        message += `• 今日金额：¥${todayStats.totalAmount}\n`;
      }
      message += `\n`;
      
      // 4. 今日分类汇总
      if (Object.keys(todayStats.globalTypeStats).length > 0) {
        message += `📋 **今日分类汇总**\n`;
        for (const [type, count] of Object.entries(todayStats.globalTypeStats)) {
          message += `• ${type}: ${count} 个\n`;
        }
        message += `\n`;
      }
      
      // 5. 提交者详细统计
      message += `👤 **提交者详细统计**\n`;
      const submittersByAmount = Object.entries(todayStats.submitters)
        .map(([id, stats]) => ({
          id,
          name: getSubmitterAlias(id),
          total: stats.total,
          amount: stats.totalAmount,
          byType: stats.byType
        }))
        .sort((a, b) => b.amount - a.amount);
      
      submittersByAmount.forEach((submitter, index) => {
        const rank = index + 1;
        message += `${rank}. **${submitter.name}**\n`;
        
        // 显示该提交者的账号类型分类
        if (submitter.byType && Object.keys(submitter.byType).length > 0) {
          Object.entries(submitter.byType).forEach(([type, typeStats]) => {
            message += `   • ${type}: ${typeStats.count}个`;
            if (typeStats.amount > 0) {
              message += ` (¥${typeStats.amount})`;
            }
            message += `\n`;
          });
        }
        
        message += `   📊 小计: ${submitter.total}个`;
        if (submitter.amount > 0) {
          message += ` | ¥${submitter.amount}`;
        }
        message += `\n\n`;
      });
    } else {
      message += `📅 **今日入库统计**\n`;
      message += `📝 今天还没有入库记录\n\n`;
    }

    // 6. 出库人统计
    const outboundStats = await getOutboundUserStats();
    if (outboundStats.totalOutboundUsers > 0) {
      message += `📤 **出库人统计**\n`;
      message += `• 活跃出库人：${outboundStats.totalOutboundUsers} 人\n`;
      message += `• 总出库数：${outboundStats.totalOutboundCount} 个\n`;
      message += `  - 🔧 手动出库：${outboundStats.manualOutboundCount} 个\n`;
      message += `  - 🏪 卡网出售：${outboundStats.cardShopOutboundCount} 个\n\n`;
      
      // 显示出库人排行榜
      const usersByCount = Object.entries(outboundStats.userStats)
        .map(([userId, stats]) => ({
          userId,
          userName: getSubmitterAlias(userId),
          count: stats.count,
          types: stats.types
        }))
        .sort((a, b) => b.count - a.count);
      
      usersByCount.slice(0, 5).forEach((user, index) => {
        const rank = index + 1;
        message += `${rank}. **${user.userName}**: ${user.count}个\n`;
        
        // 显示该出库人的账号类型分类
        if (user.types && Object.keys(user.types).length > 0) {
          const typeList = Object.entries(user.types)
            .map(([type, count]) => `${type}(${count})`)
            .join(', ');
          message += `   └ ${typeList}\n`;
        }
      });
      message += `\n`;
    } else {
      message += `📤 **出库人统计**\n`;
      message += `📝 暂无出库记录\n\n`;
    }

    // 7. 重新入库统计
    const reinboundStats = await getReInboundStats();
    if (reinboundStats.totalReinboundUsers > 0) {
      message += `🔄 **重新入库统计**\n`;
      message += `• 重新入库操作人：${reinboundStats.totalReinboundUsers} 人\n`;
      message += `• 总重新入库数：${reinboundStats.totalReinboundCount} 个\n`;
      message += `• 今日重新入库：${reinboundStats.todayReinboundCount} 个\n\n`;
    } else {
      message += `🔄 **重新入库统计**\n`;
      message += `📝 暂无重新入库记录\n\n`;
    }
    
    message += `\n🔄 *刷新时间: ${new Date().toLocaleTimeString('zh-CN')}*`;
    
    // 更新消息
    await editMessage(chatId, messageId, message, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: `📥 查看在库 (${inStockAccounts.length})`, callback_data: 'view_instock' },
            { text: `📤 查看出库 (${outStockAccounts.length})`, callback_data: 'view_outstock' }
          ],
          [
            { text: '📊 导出数据', callback_data: 'export_database' },
            { text: '🔄 刷新面板', callback_data: 'refresh_dashboard' }
          ]
        ]
      }
    });
    
  } catch (error) {
    console.error('[错误] 刷新数据面板失败:', error);
    await editMessage(chatId, messageId, '❌ 刷新数据面板失败：' + error.message);
  }
}

// 处理查看在库账号回调
async function handleViewInstock(query) {
  const chatId = query.message.chat.id;
  
  try {
    const allAccounts = await localDB.getAllAccounts();
    const inStockAccounts = allAccounts.filter(acc => acc.status === '在库');
    await showAccountList(chatId, inStockAccounts, '在库');
  } catch (error) {
    console.error('[错误] 查看在库账号失败:', error);
    await sendMessage(chatId, '❌ 查看在库账号失败：' + error.message);
  }
}

// 处理查看出库账号回调
async function handleViewOutstock(query) {
  const chatId = query.message.chat.id;
  
  try {
    const allAccounts = await localDB.getAllAccounts();
    const outStockAccounts = allAccounts.filter(acc => acc.status === '出库');
    await showAccountList(chatId, outStockAccounts, '已出库');
  } catch (error) {
    console.error('[错误] 查看出库账号失败:', error);
    await sendMessage(chatId, '❌ 查看出库账号失败：' + error.message);
  }
}

// 处理导出数据回调
async function handleExportDatabase(query) {
  const chatId = query.message.chat.id;
  
  try {
    const allAccounts = await localDB.getAllAccounts();
    
    if (allAccounts.length === 0) {
      await sendMessage(chatId, '📭 没有数据可导出');
      return;
    }
    
    // 使用优化的导出函数
    await exportAccountsAsCSV(chatId, allAccounts, '完整数据库');
    
  } catch (error) {
    console.error('[错误] 导出数据失败:', error);
    await sendMessage(chatId, '❌ 导出数据失败：' + error.message);
  }
}

// 处理导出在库账号回调
async function handleExportInstock(query) {
  const chatId = query.message.chat.id;
  
  try {
    const allAccounts = await localDB.getAllAccounts();
    const inStockAccounts = allAccounts.filter(acc => acc.status === '在库');
    
    if (inStockAccounts.length === 0) {
      await sendMessage(chatId, '📭 没有在库账号可导出');
      return;
    }
    
    await exportAccountsAsCSV(chatId, inStockAccounts, '在库账号');
  } catch (error) {
    console.error('[错误] 导出在库账号失败:', error);
    await sendMessage(chatId, '❌ 导出在库账号失败：' + error.message);
  }
}

// 处理导出出库账号回调
async function handleExportOutstock(query) {
  const chatId = query.message.chat.id;
  
  try {
    const allAccounts = await localDB.getAllAccounts();
    const outStockAccounts = allAccounts.filter(acc => acc.status === '出库');
    
    if (outStockAccounts.length === 0) {
      await sendMessage(chatId, '📭 没有出库账号可导出');
      return;
    }
    
    await exportAccountsAsCSV(chatId, outStockAccounts, '出库账号');
  } catch (error) {
    console.error('[错误] 导出出库账号失败:', error);
    await sendMessage(chatId, '❌ 导出出库账号失败：' + error.message);
  }
}

// 处理预览在库账号回调
async function handlePreviewInstock(query) {
  const chatId = query.message.chat.id;
  
  try {
    const allAccounts = await localDB.getAllAccounts();
    const inStockAccounts = allAccounts.filter(acc => acc.status === '在库');
    
    if (inStockAccounts.length === 0) {
      await sendMessage(chatId, '📭 没有在库账号');
      return;
    }
    
    // 显示前10个账号的CSV格式
    await showAccountListCSV(chatId, inStockAccounts.slice(0, 10), '在库');
  } catch (error) {
    console.error('[错误] 预览在库账号失败:', error);
    await sendMessage(chatId, '❌ 预览在库账号失败：' + error.message);
  }
}

// 处理预览出库账号回调
async function handlePreviewOutstock(query) {
  const chatId = query.message.chat.id;
  
  try {
    const allAccounts = await localDB.getAllAccounts();
    const outStockAccounts = allAccounts.filter(acc => acc.status === '出库');
    
    if (outStockAccounts.length === 0) {
      await sendMessage(chatId, '📭 没有出库账号');
      return;
    }
    
    // 显示前10个账号的CSV格式
    await showAccountListCSV(chatId, outStockAccounts.slice(0, 10), '出库');
  } catch (error) {
    console.error('[错误] 预览出库账号失败:', error);
    await sendMessage(chatId, '❌ 预览出库账号失败：' + error.message);
  }
}

// 导出账号为CSV文件的通用函数
async function exportAccountsAsCSV(chatId, accounts, title) {
  try {
    // 生成统计信息
    const stats = {
      total: accounts.length,
      byStatus: {},
      byType: {},
      totalInboundValue: 0,
      totalOutboundValue: 0
    };
    
    // 计算统计数据
    accounts.forEach(acc => {
      // 按状态统计
      const status = acc.status || '未知';
      stats.byStatus[status] = (stats.byStatus[status] || 0) + 1;
      
      // 按类型统计
      const type = acc.accountType || '未分类';
      stats.byType[type] = (stats.byType[type] || 0) + 1;
      
      // 计算总价值
      if (acc.inboundPrice) {
        stats.totalInboundValue += Number(acc.inboundPrice) || 0;
      }
      if (acc.outboundPrice) {
        stats.totalOutboundValue += Number(acc.outboundPrice) || 0;
      }
    });
    
    // 生成统计信息注释
    const timestamp = new Date().toLocaleString('zh-CN');
    let csvContent = `# ${title}导出报告 - ${timestamp}\n`;
    csvContent += `# 总计: ${stats.total} 个账号\n`;
    csvContent += `# 入库总价值: $${stats.totalInboundValue.toFixed(2)}\n`;
    csvContent += `# 出库总价值: $${stats.totalOutboundValue.toFixed(2)}\n`;
    csvContent += `#\n`;
    csvContent += `# 按状态统计:\n`;
    Object.entries(stats.byStatus).forEach(([status, count]) => {
      csvContent += `#   ${status}: ${count} 个\n`;
    });
    csvContent += `#\n`;
    csvContent += `# 按类型统计:\n`;
    Object.entries(stats.byType).forEach(([type, count]) => {
      csvContent += `#   ${type}: ${count} 个\n`;
    });
    csvContent += `#\n`;
    
    // CSV头部（包含所有字段）
    const csvHeader = '序号,email,password,totp,backup_email,backup_password,api_key,account_type,status,inbound_price,outbound_price,inbound_date,outbound_date,submitter_name,notes\n';
    
    // 生成CSV数据
    const csvData = accounts.map((acc, index) => {
      return [
        index + 1,
        acc.email || '',
        acc.password || acc.emailPassword || '',
        acc.totp || acc.twoFACode || '',
        acc.backupEmail || acc.auxiliaryEmail || '',
        acc.backupPassword || acc.auxiliaryPassword || '',
        acc.accountKey || acc.key || '',
        acc.accountType || '',
        acc.status || '',
        acc.inboundPrice || 0,
        acc.outboundPrice || 0,
        acc.inboundDate || '',
        acc.outboundDate || '',
        acc.submitterName || '',
        (acc.notes || '').replace(/\n/g, ' ').replace(/,/g, '，') // 替换换行和逗号
      ].map(field => `"${String(field).replace(/"/g, '""')}"`).join(',');
    }).join('\n');
    
    const fullCsv = csvContent + csvHeader + csvData;
    const fileName = `${title}_export_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.csv`;
    
    // 发送CSV文件
    await sendDocument(chatId, {
      source: Buffer.from(fullCsv, 'utf8'),
      filename: fileName
    }, {
      caption: `📊 ${title}导出文件\n` +
        `📈 总计: ${accounts.length} 条记录\n` +
        `💰 入库价值: $${stats.totalInboundValue.toFixed(2)}\n` +
        `💸 出库价值: $${stats.totalOutboundValue.toFixed(2)}\n` +
        `📋 包含完整统计信息`
    });
    
  } catch (error) {
    console.error('[错误] 导出CSV文件失败:', error);
    throw error;
  }
}

// 显示账号列表（CSV格式）
async function showAccountList(chatId, accounts, title) {
  if (accounts.length === 0) {
    await sendMessage(chatId, `📭 没有${title}的账号`);
    return;
  }
  
  // 如果账号数量较少，直接显示CSV格式
  if (accounts.length <= 10) {
    await showAccountListCSV(chatId, accounts, title);
  } else {
    // 账号数量较多，分批显示并提供完整导出
    await showAccountListPaginated(chatId, accounts, title);
  }
}

// CSV格式显示账号列表
async function showAccountListCSV(chatId, accounts, title) {
  let message = `📋 **${title}账号列表** (共 ${accounts.length} 个)\n\n`;
  message += `📄 **CSV格式数据** (点击复制)\n\n`;
  
  // CSV头部
  const csvHeader = '序号,email,password,totp,backup_email,api_key,account_type,status,inbound_price,outbound_price,inbound_date,outbound_date';
  message += `\`\`\`\n${csvHeader}\n`;
  
  // CSV数据行
  accounts.forEach((acc, index) => {
    const csvRow = [
      index + 1,
      acc.email || '',
      acc.password || acc.emailPassword || '',
      acc.totp || acc.twoFACode || '',
      acc.backupEmail || acc.auxiliaryEmail || '',
      acc.accountKey || acc.key || '',
      acc.accountType || '',
      acc.status || '',
      acc.inboundPrice || 0,
      acc.outboundPrice || 0,
      acc.inboundDate || '',
      acc.outboundDate || ''
    ].map(field => String(field).replace(/,/g, '，')).join(','); // 替换逗号避免CSV冲突
    
    message += `${csvRow}\n`;
  });
  
  message += `\`\`\`\n\n`;
  message += `💡 **使用说明**\n`;
  message += `• 长按上方CSV数据即可复制\n`;
  message += `• 可直接粘贴到Excel等表格软件\n`;
  message += `• 逗号分隔，支持标准CSV格式`;
  
  // 添加操作按钮
  const buttons = [
    [
      { text: '📊 导出完整CSV文件', callback_data: `export_${title === '在库' ? 'instock' : 'outstock'}` },
      { text: '🔄 刷新数据', callback_data: title === '在库' ? 'view_instock' : 'view_outstock' }
    ],
    [
      { text: '⬅️ 返回数据面板', callback_data: 'refresh_dashboard' }
    ]
  ];
  
  await sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons }
  });
}

// 分页显示账号列表（大量数据时使用）
async function showAccountListPaginated(chatId, accounts, title) {
  let message = `📋 **${title}账号列表** (共 ${accounts.length} 个)\n\n`;
  
  // 按类型分组统计
  const groupedByType = {};
  accounts.forEach(acc => {
    const type = acc.accountType || '未分类';
    if (!groupedByType[type]) {
      groupedByType[type] = [];
    }
    groupedByType[type].push(acc);
  });
  
  message += `📊 **分类统计**\n`;
  for (const [type, typeAccounts] of Object.entries(groupedByType)) {
    message += `• ${type}: ${typeAccounts.length} 个\n`;
  }
  
  message += `\n⚠️ **账号数量较多，建议导出CSV文件查看完整数据**\n\n`;
  
  // 显示前5个账号作为预览
  message += `📄 **预览（前5个账号）**\n\n`;
  message += `\`\`\`\n`;
  message += `email,password,totp,account_type,status\n`;
  
  accounts.slice(0, 5).forEach(acc => {
    const previewRow = [
      acc.email || '',
      acc.password || acc.emailPassword || '',
      acc.totp || acc.twoFACode || '',
      acc.accountType || '',
      acc.status || ''
    ].join(',');
    message += `${previewRow}\n`;
  });
  
  message += `...\n\`\`\``;
  
  // 操作按钮
  const buttons = [
    [
      { text: '📊 导出完整CSV文件', callback_data: `export_${title === '在库' ? 'instock' : 'outstock'}` }
    ],
    [
      { text: '📋 显示前10个（CSV格式）', callback_data: `preview_${title === '在库' ? 'instock' : 'outstock'}` },
      { text: '🔄 刷新数据', callback_data: title === '在库' ? 'view_instock' : 'view_outstock' }
    ],
    [
      { text: '⬅️ 返回数据面板', callback_data: 'refresh_dashboard' }
    ]
  ];
  
  await sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons }
  });
}


// 获取更新
async function getUpdates() {
  let errorCount = 0;
  const maxErrorCount = 10;
  let conflictWarningShown = false; // 添加标志避免重复警告
  
  while (true) {
    try {
      const updates = await telegramRequest('getUpdates', {
        offset: lastUpdateId + 1,
        timeout: 0,  // 0秒轮询，最快响应！
        limit: 100   // 批量获取更新
      });
      
      // 重置错误计数
      errorCount = 0;
      
      // 更新健康检查
      updateHealthCheck();
      
      if (updates.length > 0) {
        console.log(`\n[更新] 收到 ${updates.length} 条新消息`);
        
        for (const update of updates) {
          try {
            await handleUpdate(update);
            lastUpdateId = update.update_id;
          } catch (updateError) {
            console.error('[错误] 处理更新失败:', updateError.message);
            lastUpdateId = update.update_id;  // 仍然更新ID，避免卡住
          }
        }
      }
    } catch (error) {
      errorCount++;
      
      // 特殊处理冲突错误
      if (error.message.includes('Conflict: terminated by other getUpdates request')) {
        if (!conflictWarningShown) {
          console.log(`[警告] 检测到getUpdates冲突，可能有其他实例在运行`);
          conflictWarningShown = true;
        }
        
        // 冲突错误采用指数退避策略，减少日志噪音
        const waitTime = Math.min(1000 * Math.pow(2, errorCount - 1), 30000); // 最长等待30秒
        
        if (errorCount >= maxErrorCount) {
          console.log('[冲突处理] 持续冲突中，采用长时间等待策略 (60秒)');
          await new Promise(resolve => setTimeout(resolve, 60000));
          errorCount = Math.floor(maxErrorCount / 2); // 部分重置，避免完全重置导致频繁报错
        } else {
          // 简化日志输出，减少噪音
          if (errorCount % 5 === 0) {
            console.log(`[冲突处理] 等待 ${waitTime}ms 后重试 (${errorCount}/${maxErrorCount})`);
          }
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      } else {
        // 非冲突错误的正常处理
        console.error(`[错误] 获取更新失败 (${errorCount}/${maxErrorCount}):`, error.message);
        
        if (errorCount >= maxErrorCount) {
          console.error('[严重] 连续错误次数过多，等待10秒后重试...');
          await new Promise(resolve => setTimeout(resolve, 10000));
          errorCount = 0;
        } else {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
  }
}

// 初始化
async function init() {
  try {
    // 检查并创建实例锁
    if (!createLock()) {
      console.log('[启动失败] 无法获取实例锁，可能有其他实例正在运行');
      process.exit(1);
    }

    // 启动心跳机制，每分钟更新锁时间戳
    setInterval(updateLock, 60 * 1000);

    // 获取机器人信息
    const me = await telegramRequest('getMe');
    console.log(`✅ 机器人 @${me.username} 已启动！`);
    
    // 清理旧更新
    const oldUpdates = await telegramRequest('getUpdates', { offset: -1 });
    if (oldUpdates.length > 0) {
      lastUpdateId = oldUpdates[oldUpdates.length - 1].update_id;
      console.log(`✅ 已清理 ${oldUpdates.length} 条旧更新`);
    }
    
    console.log('\n📱 发送 /start 开始使用');
    console.log('📝 直接粘贴文本进行批量导入');
    console.log('👮 管理员命令: /dashboard /outbound\n');
    
    // 初始化本地数据库
    try {
      localDB.initialize();
    } catch (error) {
      console.error('[本地数据库] 初始化失败，但机器人将继续运行:', error.message);
    }
    
    // 开始轮询
    getUpdates();
    
  } catch (error) {
    console.error('初始化失败:', error.message);
    process.exit(1);
  }
}

// 健康检查标记
let lastHealthCheck = Date.now();
let isHealthy = true;

// 健康检查函数
function updateHealthCheck() {
  lastHealthCheck = Date.now();
  isHealthy = true;
}

// 定期健康检查
setInterval(() => {
  const now = Date.now();
  const timeSinceLastCheck = now - lastHealthCheck;
  
  // 如果超过2分钟没有更新，认为不健康
  if (timeSinceLastCheck > 120000) {
    isHealthy = false;
    console.error('[健康检查] 机器人可能已停止响应，超过2分钟未更新');
    // 可以在这里添加重启逻辑或发送告警
  }
}, 60000);  // 每分钟检查一次

// 处理 /ban 命令
async function handleBan(msg) {
  const chatId = msg.chat.id;
  const isAdmin = ADMIN_IDS.includes(chatId.toString());
  
  if (!isAdmin) {
    await sendMessage(chatId, '❌ 此功能仅限管理员使用');
    return;
  }
  
  // 清理之前的会话
  delete sessions[chatId];
  delete editSessions[chatId];
  delete banSessions[chatId];
  
  banSessions[chatId] = {
    step: 'input_emails',
    emails: []
  };
  
  const message = `🚫 **标记被封账号**\n\n` +
    `请输入被封的账号邮箱：\n\n` +
    `示例：\n` +
    `account1@gmail.com\n` +
    `account2@outlook.com\n\n` +
    `💡 输入后会立即标记并通知提交者\n` +
    `📌 发送 /cancel 结束操作`;
  
  await sendMessage(chatId, message, { parse_mode: 'Markdown' });
}

// 处理封禁输入
async function handleBanInput(chatId, text) {
  const session = banSessions[chatId];
  if (!session) return;
  
  if (text === '/cancel') {
    delete banSessions[chatId];
    await sendMessage(chatId, '✅ 已结束封禁标记操作');
    return;
  }
  
  // 提取邮箱
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const foundEmails = text.match(emailRegex);
  
  if (foundEmails && foundEmails.length > 0) {
    // 去重
    const uniqueEmails = [...new Set(foundEmails.map(email => email.toLowerCase()))];
    
    // 直接执行封禁操作
    await sendMessage(chatId, `🔄 正在标记 ${uniqueEmails.length} 个账号为被封状态...`);
    
    const results = {
      success: [],
      notFound: [],
      failed: [],
      notifications: {} // 按提交者ID分组
    };
    
    for (const email of uniqueEmails) {
      try {
        // 从本地数据库查询账号
        const account = await localDB.findAccount(email);
        
        if (!account) {
          results.notFound.push(email);
          continue;
        }
        
        // 处理找到的账号
        try {
          // 获取提交者ID
          const submitterId = account.submitterId;
          
          // 更新本地数据库状态为被封
          await localDB.updateAccountStatus(email, '被封');
          
          results.success.push(email);
          
          // 记录需要通知的提交者
          if (submitterId) {
            if (!results.notifications[submitterId]) {
              results.notifications[submitterId] = [];
            }
            results.notifications[submitterId].push(email);
          }
        } catch (error) {
          console.error(`[封禁] 更新失败 ${email}:`, error);
          results.failed.push(email);
        }
      } catch (error) {
        console.error(`[封禁] 查询失败 ${email}:`, error);
        results.failed.push(email);
      }
    }
    
    // 发送结果报告
    let reportMessage = '📊 **标记完成**\n\n';
    
    if (results.success.length > 0) {
      reportMessage += `✅ 成功标记为被封: ${results.success.length} 个\n`;
      reportMessage += results.success.map(e => `  • ${e}`).join('\n') + '\n';
    }
    
    if (results.notFound.length > 0) {
      reportMessage += `\n❓ 未找到: ${results.notFound.length} 个\n`;
      reportMessage += results.notFound.map(e => `  • ${e}`).join('\n') + '\n';
    }
    
    if (results.failed.length > 0) {
      reportMessage += `\n❌ 处理失败: ${results.failed.length} 个\n`;
    }
    
    await sendMessage(chatId, reportMessage, { parse_mode: 'Markdown' });
    
    // 发送通知给原提交者
    let notificationCount = 0;
    for (const [submitterId, emails] of Object.entries(results.notifications)) {
      try {
        const notifyMessage = `⚠️ **账号封禁通知**\n\n` +
          `您提交的以下账号已被封禁，请及时处理：\n\n` +
          emails.map(email => `• ${email}`).join('\n');
        
        await sendMessage(submitterId, notifyMessage, { parse_mode: 'Markdown' });
        notificationCount++;
      } catch (error) {
        console.error(`[封禁] 发送通知失败 to ${submitterId}:`, error);
      }
    }
    
    if (notificationCount > 0) {
      await sendMessage(chatId, `\n📤 已向 ${notificationCount} 个提交者发送通知`);
    }
    
    // 继续等待更多输入
    await sendMessage(chatId, '\n💡 继续输入更多邮箱进行标记，或发送 /cancel 结束');
  } else {
    await sendMessage(chatId, '⚠️ 未识别到有效的邮箱地址，请重新输入');
  }
}

// 执行封禁操作
async function executeBan(chatId) {
  const session = banSessions[chatId];
  if (!session || !session.emails || session.emails.length === 0) return;
  
  await sendMessage(chatId, '🔄 正在处理封禁操作...');
  
  const results = {
    success: [],
    notFound: [],
    failed: [],
    notifications: {} // 按提交者ID分组
  };
  
  for (const email of session.emails) {
    try {
      // 从本地数据库查询账号
      const account = await localDB.findAccount(email);
      
      if (!account) {
        results.notFound.push(email);
        continue;
      }
      
      try {
        // 获取提交者ID
        const submitterId = account.submitterId;
        
        // 更新本地数据库状态为被封
        await localDB.updateAccountStatus(email, '被封');
        
        results.success.push(email);
        
        // 记录需要通知的提交者
        if (submitterId) {
          if (!results.notifications[submitterId]) {
            results.notifications[submitterId] = [];
          }
          results.notifications[submitterId].push(email);
        }
      } catch (error) {
        console.error(`[封禁] 更新失败 ${email}:`, error);
        results.failed.push(email);
      }
    } catch (error) {
      console.error(`[封禁] 查询失败 ${email}:`, error);
      results.failed.push(email);
    }
  }
  
  // 发送结果报告
  let reportMessage = '📊 **封禁操作完成**\n\n';
  
  if (results.success.length > 0) {
    reportMessage += `✅ 成功封禁: ${results.success.length} 个\n`;
  }
  
  if (results.notFound.length > 0) {
    reportMessage += `❓ 未找到: ${results.notFound.length} 个\n`;
    reportMessage += results.notFound.map(e => `  • ${e}`).join('\n') + '\n';
  }
  
  if (results.failed.length > 0) {
    reportMessage += `❌ 处理失败: ${results.failed.length} 个\n`;
  }
  
  await sendMessage(chatId, reportMessage, { parse_mode: 'Markdown' });
  
  // 发送通知给原提交者
  let notificationCount = 0;
  for (const [submitterId, emails] of Object.entries(results.notifications)) {
    try {
      const notifyMessage = `⚠️ **账号封禁通知**\n\n` +
        `您提交的以下账号已被封禁，请及时处理：\n\n` +
        emails.map(email => `• ${email}`).join('\n');
      
      await sendMessage(submitterId, notifyMessage, { parse_mode: 'Markdown' });
      notificationCount++;
    } catch (error) {
      console.error(`[封禁] 发送通知失败 to ${submitterId}:`, error);
    }
  }
  
  if (notificationCount > 0) {
    await sendMessage(chatId, `📤 已向 ${notificationCount} 个提交者发送通知`);
  }
  
  // 清理会话
  delete banSessions[chatId];
}


// 获取今日入库统计（提交者用）
async function getMyTodayStats(submitterId) {
  const today = new Date().toISOString().split('T')[0];
  const stats = {
    total: 0,
    byType: {},
    accounts: []
  };
  
  try {
    // 从本地数据库查询今日该提交者的账号
    const todayAccounts = await localDB.findAccounts({
      submitterId: submitterId
    });
    
    // 过滤今日入库的账号
    const todayInbound = todayAccounts.filter(acc => acc.inboundDate === today);
    
    for (const account of todayInbound) {
      const type = account.accountType || '未分类';
      const email = account.email || '';
      
      stats.total++;
      stats.byType[type] = (stats.byType[type] || 0) + 1;
      stats.accounts.push({ email, type });
    }
  } catch (error) {
    console.error('[错误] 获取今日统计失败:', error);
    throw error;
  }
  
  return stats;
}

// 获取所有提交者今日统计（管理员用）
async function getAllTodayStats() {
  const today = new Date().toISOString().split('T')[0];
  const statsBySubmitter = {};
  const globalTypeStats = {}; // 全局类型统计
  let totalAmount = 0;
  let totalCount = 0;
  
  try {
    // 从本地数据库获取今日入库数据
    const allAccounts = await localDB.getAllAccounts();
    const todayAccounts = allAccounts.filter(acc => 
      acc.inboundDate === today
    );
    
    for (const account of todayAccounts) {
      const submitterId = account.submitterId?.toString() || '未知';
      const submitterName = account.submitterName || '未知';
      const type = account.accountType || '未分类';
      const price = account.inboundPrice || 0;
      
      // 初始化提交者统计
      if (!statsBySubmitter[submitterId]) {
        statsBySubmitter[submitterId] = {
          name: submitterName,
          total: 0,
          totalAmount: 0,
          byType: {}
        };
      }
      
      // 初始化全局类型统计
      if (!globalTypeStats[type]) {
        globalTypeStats[type] = 0;
      }
      
      const submitterStats = statsBySubmitter[submitterId];
      submitterStats.total++;
      submitterStats.totalAmount += price;
      
      if (!submitterStats.byType[type]) {
        submitterStats.byType[type] = {
          count: 0,
          amount: 0,
          price: price
        };
      }
      
      submitterStats.byType[type].count++;
      submitterStats.byType[type].amount += price;
      
      globalTypeStats[type]++;
      totalCount++;
      totalAmount += price;
    }
  } catch (error) {
    console.error('[错误] 获取所有提交者统计失败:', error);
    throw error;
  }
  
  return {
    date: today,
    submitters: statsBySubmitter,
    globalTypeStats,
    totalCount,
    totalAmount
  };
}

// 获取出库人统计 - 增强空值处理和准确性
async function getOutboundUserStats() {
  const outboundUserStats = {};
  let totalOutboundCount = 0;
  let manualOutboundCount = 0;
  let cardShopOutboundCount = 0;
  let unknownUserCount = 0; // 统计未知用户数量
  
  try {
    // 从本地数据库获取所有出库数据
    const allAccounts = await localDB.getAllAccounts();
    const outboundAccounts = allAccounts.filter(acc => 
      acc.status === '出库'
    );
    
    console.log(`[出库人统计] 发现 ${outboundAccounts.length} 个出库账号`);
    
    for (const account of outboundAccounts) {
      // 统计出库来源
      const outboundSource = account.outboundSource || 'manual';
      if (outboundSource === 'manual') {
        manualOutboundCount++;
      } else if (outboundSource === 'cardshop') {
        cardShopOutboundCount++;
      }
      
      // 增强空值处理
      let userId = 'unknown';
      let userName = '未知出库人';
      
      // 处理出库人ID
      if (account.outboundUserId) {
        userId = account.outboundUserId.toString().trim();
        if (userId && userId !== 'null' && userId !== 'undefined') {
          // 有效的用户ID，尝试获取用户名
          if (account.outboundUserName && String(account.outboundUserName).trim()) {
            userName = String(account.outboundUserName).trim();
          } else {
            // 尝试从别名映射获取
            const aliasName = getSubmitterAlias(userId);
            if (aliasName && aliasName !== userId) {
              userName = aliasName;
            } else {
              userName = `用户${userId}`;
            }
          }
        } else {
          userId = 'unknown';
        }
      }
      
      // 统计未知用户
      if (userId === 'unknown') {
        unknownUserCount++;
      }
      
      const accountType = account.accountType?.trim() || '未分类';
      
      // 初始化用户统计
      if (!outboundUserStats[userId]) {
        outboundUserStats[userId] = {
          userName,
          count: 0,
          types: {}
        };
      }
      
      const userStats = outboundUserStats[userId];
      userStats.count++;
      totalOutboundCount++;
      
      // 按账号类型统计
      if (!userStats.types[accountType]) {
        userStats.types[accountType] = 0;
      }
      userStats.types[accountType]++;
    }
    
    // 日志记录统计信息
    if (unknownUserCount > 0) {
      console.log(`[出库人统计] 发现 ${unknownUserCount} 个未知出库人的账号`);
    }
  } catch (error) {
    console.error('[错误] 获取出库人统计失败:', error);
  }
  
  return {
    userStats: outboundUserStats,
    totalOutboundUsers: Object.keys(outboundUserStats).length,
    totalOutboundCount,
    manualOutboundCount,
    cardShopOutboundCount
  };
}

// 获取重新入库统计 - 增强空值处理和准确性
async function getReInboundStats() {
  const reinboundUserStats = {};
  let totalReinboundCount = 0;
  let todayReinboundCount = 0;
  let unknownUserCount = 0; // 统计未知用户数量
  const today = new Date().toISOString().split('T')[0];
  
  try {
    // 从本地数据库获取所有重新入库数据
    const allAccounts = await localDB.getAllAccounts();
    const reinboundAccounts = allAccounts.filter(acc => 
      acc.reinboundDate && acc.reinboundPrice !== null && acc.reinboundPrice !== undefined
    );
    
    console.log(`[重新入库统计] 发现 ${reinboundAccounts.length} 个重新入库账号`);
    
    for (const account of reinboundAccounts) {
      // 增强空值处理
      let userId = 'unknown';
      let userName = '未知操作人';
      
      // 处理重新入库人ID
      if (account.reinboundUserId) {
        userId = account.reinboundUserId.toString().trim();
        if (userId && userId !== 'null' && userId !== 'undefined') {
          // 有效的用户ID，尝试获取用户名
          if (account.reinboundUserName && String(account.reinboundUserName).trim()) {
            userName = String(account.reinboundUserName).trim();
          } else {
            // 尝试从别名映射获取
            const aliasName = getSubmitterAlias(userId);
            if (aliasName && aliasName !== userId) {
              userName = aliasName;
            } else {
              userName = `用户${userId}`;
            }
          }
        } else {
          userId = 'unknown';
        }
      }
      
      // 统计未知用户
      if (userId === 'unknown') {
        unknownUserCount++;
      }
      
      const accountType = account.accountType?.trim() || '未分类';
      const reinboundDate = account.reinboundDate;
      const reinboundPrice = account.reinboundPrice || 0;
      
      totalReinboundCount++;
      
      // 统计今日重新入库
      if (reinboundDate === today) {
        todayReinboundCount++;
      }
      
      // 按操作人统计
      if (!reinboundUserStats[userId]) {
        reinboundUserStats[userId] = {
          name: userName,
          count: 0,
          totalAmount: 0,
          types: {},
          todayCount: 0,
          todayAmount: 0
        };
      }
      
      const userStats = reinboundUserStats[userId];
      userStats.count++;
      userStats.totalAmount += reinboundPrice;
      
      if (reinboundDate === today) {
        userStats.todayCount++;
        userStats.todayAmount += reinboundPrice;
      }
      
      // 按类型统计
      if (!userStats.types[accountType]) {
        userStats.types[accountType] = 0;
      }
      userStats.types[accountType]++;
    }
    
    // 日志记录统计信息
    if (unknownUserCount > 0) {
      console.log(`[重新入库统计] 发现 ${unknownUserCount} 个未知操作人的账号`);
    }
  } catch (error) {
    console.error('[错误] 获取重新入库统计失败:', error);
  }
  
  return {
    userStats: reinboundUserStats,
    totalReinboundUsers: Object.keys(reinboundUserStats).length,
    totalReinboundCount,
    todayReinboundCount,
    today,
    unknownUserCount
  };
}

// 处理 /mytoday 命令
async function handleMyToday(msg) {
  const chatId = msg.chat.id;
  const submitterId = chatId.toString();
  
  await sendMessage(chatId, '⏳ 正在统计您今日的入库数据...');
  
  try {
    const stats = await getMyTodayStats(submitterId);
    
    let message = `📊 **今日入库统计**\n\n`;
    message += `✅ 入库总数：${stats.total} 个\n`;
    message += `📅 日期：${new Date().toISOString().split('T')[0]}\n\n`;
    
    if (stats.total > 0) {
      message += `**按类型分类：**\n`;
      for (const [type, count] of Object.entries(stats.byType)) {
        message += `• ${type}: ${count} 个\n`;
      }
      message += `\n💡 继续加油！`;
    } else {
      message += `📝 今天还没有入库记录哦～`;
    }
    
    await sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    await sendMessage(chatId, '❌ 获取统计数据失败，请稍后重试');
  }
}

// 处理 /find 命令
async function handleFind(msg) {
  const chatId = msg.chat.id;
  
  // 验证管理员权限
  if (!ADMIN_IDS.includes(chatId.toString())) {
    await sendMessage(chatId, '❌ 只有管理员可以使用查找功能');
    return;
  }
  
  // 清理其他会话
  delete sessions[chatId];
  delete editSessions[chatId];
  delete banSessions[chatId];
  delete outboundSessions[chatId];
  
  // 初始化查找会话
  findSessions[chatId] = {
    waitingForEmail: true
  };
  
  await sendMessage(chatId, 
    '🔍 **智能账号查找**\n\n' +
    '✨ **支持多种格式：**\n' +
    '• 单个邮箱：`user@gmail.com`\n' +
    '• 多个邮箱：一行一个或用空格分隔\n' +
    '• 混合数据：从聊天记录中智能提取\n\n' +
    '📤 **显示特性：**\n' +
    '• 横排紧凑显示，方便查看\n' +
    '• 显示实际账号类型 (GCP300、2、3等)\n' +
    '• 密码明文显示，支持CSV导出\n\n' +
    '请输入要查找的内容：\n' +
    '（发送 /cancel 取消查找）',
    { parse_mode: 'Markdown' }
  );
}

// 处理限额设置命令
async function handleLimits(msg) {
  const chatId = msg.chat.id;
  
  // 验证管理员权限
  if (!ADMIN_IDS.includes(chatId.toString())) {
    await sendMessage(chatId, '❌ 只有管理员可以设置限额');
    return;
  }
  
  // 清理其他会话
  delete sessions[chatId];
  delete editSessions[chatId];
  delete banSessions[chatId];
  delete outboundSessions[chatId];
  delete findSessions[chatId];
  
  // 获取当前限额配置
  const limitsData = loadLimits();
  
  let message = '⚙️ **每日限额管理**\n\n';
  message += '📊 **当前限额设置：**\n';
  
  if (Object.keys(limitsData.limits).length === 0) {
    message += '_暂未设置任何限额_\n';
  } else {
    for (const [type, limit] of Object.entries(limitsData.limits)) {
      const current = await getCurrentStock(type);
      message += `• ${type}: ${current}/${limit}\n`;
    }
  }
  
  if (limitsData.lastUpdate) {
    message += `\n_最后更新: ${limitsData.lastUpdate} by ${limitsData.updatedBy}_\n`;
  }
  
  message += '\n请选择操作：';
  
  const keyboard = [
    [{ text: '➕ 添加/修改限额', callback_data: 'limit_add' }],
    [{ text: '🗑 删除限额', callback_data: 'limit_delete' }],
    [{ text: '❌ 取消', callback_data: 'limit_cancel' }]
  ];
  
  await sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

// 处理配额查询命令
async function handleQuota(msg) {
  const chatId = msg.chat.id;
  
  await sendMessage(chatId, '📊 正在查询配额使用情况...');
  
  const limitsData = loadLimits();
  
  let message = '📊 **配额使用情况**\n\n';
  
  if (Object.keys(limitsData.limits).length === 0) {
    message += '_管理员暂未设置任何限额，可自由入库_';
  } else {
    message += '```\n';
    message += '类型          已用/限额   剩余\n';
    message += '--------------------------------\n';
    
    for (const [type, limit] of Object.entries(limitsData.limits)) {
      const current = await getCurrentStock(type);
      const remaining = limit - current;
      const status = remaining > 0 ? `✅ ${remaining}` : '❌ 已满';
      
      message += `${type.padEnd(12)} ${current}/${limit}      ${status}\n`;
    }
    
    message += '```\n';
    message += '\n💡 提示：只有"在库"状态的账号计入配额';
  }
  
  await sendMessage(chatId, message, { parse_mode: 'Markdown' });
}

// 处理限额类型输入
async function handleLimitType(chatId, type) {
  const session = limitSessions[chatId];
  if (!session || !session.waitingForType) return;
  
  // 验证输入
  if (!type || type.length < 2) {
    await sendMessage(chatId, '❌ 账号类型名称至少需要2个字符');
    return;
  }
  
  session.accountType = type;
  session.waitingForType = false;
  session.waitingForValue = true;
  
  await sendMessage(chatId, 
    `📝 账号类型：**${type}**\n\n` +
    '请输入每日限额数量（输入0表示不限制）：'
  , { parse_mode: 'Markdown' });
}

// 处理限额数值输入
async function handleLimitValue(chatId, value) {
  const session = limitSessions[chatId];
  if (!session || !session.waitingForValue) return;
  
  const limit = parseInt(value);
  if (isNaN(limit) || limit < 0) {
    await sendMessage(chatId, '❌ 请输入有效的数字（0或正整数）');
    return;
  }
  
  // 加载当前配置
  const limitsData = loadLimits();
  
  // 更新限额
  if (limit === 0) {
    delete limitsData.limits[session.accountType];
    await sendMessage(chatId, `✅ 已取消 **${session.accountType}** 的限额`);
  } else {
    limitsData.limits[session.accountType] = limit;
    await sendMessage(chatId, `✅ 已设置 **${session.accountType}** 的每日限额为 **${limit}** 个`);
  }
  
  // 更新元数据
  limitsData.lastUpdate = new Date().toISOString().split('T')[0];
  limitsData.updatedBy = 'Admin';
  
  // 保存配置
  if (saveLimits(limitsData)) {
    await sendMessage(chatId, '💾 限额配置已保存', { parse_mode: 'Markdown' });
  } else {
    await sendMessage(chatId, '❌ 保存配置失败，请重试');
  }
  
  // 清理会话
  delete limitSessions[chatId];
}

// 查找账号
async function findAccount(email) {
  try {
    // 首先从本地数据库查询
    const localAccount = await localDB.findAccount(email);
    if (localAccount) {
      return localAccount;
    }
    
    return null;
  } catch (error) {
    console.error('[错误] 查找账号失败:', error);
    throw error;
  }
}

// 格式化账号信息（直接显示所有信息）
function formatAccountInfo(account) {
  let message = `📧 **账号详情**\n\n`;
  
  // 基本信息
  message += `📌 **邮箱：** ${account.email}\n`;
  message += `🏷 **类型：** ${account.accountType}\n`;
  
  // 状态信息
  const statusEmoji = account.status === '在库' ? '✅' : 
                      account.status === '出库' ? '📤' : 
                      account.status === '被封' ? '🚫' : '❓';
  message += `${statusEmoji} **状态：** ${account.status}\n\n`;
  
  // 密码信息（直接显示）
  message += `🔐 **密码信息**\n`;
  message += `• 主密码：${account.password || '无'}\n`;
  if (account.twoFA) {
    message += `• 2FA密码：${account.twoFA}\n`;
  }
  if (account.auxiliaryEmail) {
    message += `• 辅助邮箱：${account.auxiliaryEmail}\n`;
    if (account.auxiliaryPassword) {
      message += `• 辅助密码：${account.auxiliaryPassword}\n`;
    }
  }
  if (account.key || account.accountKey) {
    message += `• 密钥：${account.key || account.accountKey}\n`;
  }
  
  message += `\n📅 **时间信息**\n`;
  if (account.inboundDate) {
    message += `• 入库日期：${account.inboundDate}\n`;
    message += `• 入库价格：¥${account.inboundPrice}\n`;
  }
  if (account.outboundDate) {
    message += `• 出库日期：${account.outboundDate}\n`;
    message += `• 出库价格：¥${account.outboundPrice}\n`;
  }
  
  message += `\n📝 **其他信息**\n`;
  // 显示提交者代号和ID
  const submitterAlias = getSubmitterAlias(account.submitterId);
  const submitterDisplay = submitterAlias !== account.submitterId ? 
    `${submitterAlias} (ID: ${account.submitterId})` : 
    account.submitterId || '未知';
  message += `• 提交者：${submitterDisplay}\n`;
  if (account.notes) {
    // 清理重复的提交者信息
    let cleanNotes = account.notes.replace(/提交者:\s*\w+\s*\(ID:\s*\d+\)\s*/g, '');
    cleanNotes = cleanNotes.replace(/提交者:\s*\w+\s*/g, '');
    cleanNotes = cleanNotes.trim();
    
    if (cleanNotes) {
      message += `• 备注：${cleanNotes}\n`;
    }
  }
  
  return message;
}

// 格式化多个账号的紧凑横排显示
function formatMultipleAccountsCompact(accounts, notFound = []) {
  let message = `🔍 **查找结果** (${accounts.length}个账号)\n\n`;
  
  for (const account of accounts) {
    const submitterAlias = getSubmitterAlias(account.submitterId) || '未知';
    
    // 价格显示逻辑
    let priceDisplay = `💰 ¥${account.inboundPrice}`;
    if (account.outboundPrice && account.outboundDate) {
      priceDisplay = `💰 ¥${account.inboundPrice}→¥${account.outboundPrice}`;
    }
    
    // 横排紧凑格式 - 显示用户选择的实际账号类型，转义特殊字符
    const safePassword = account.password.replace(/([*_`\[\]()~>#+\-=|{}.!\\])/g, '\\$1');
    const apiKeyDisplay = account.accountKey || account.key ? ` | 🔑 ${account.accountKey || account.key}` : '';
    message += `📧 ${account.email} | ${account.accountType} | ${account.status} | 🔐 ${safePassword} | ${priceDisplay} | 📅 ${account.inboundDate} | 👤 ${submitterAlias}${apiKeyDisplay}\n`;
  }
  
  if (notFound.length > 0) {
    message += `\n❌ **未找到的账号：**\n`;
    notFound.forEach(email => {
      message += `• ${email}\n`;
    });
  }
  
  return message;
}

// 智能提取邮箱地址（专用于查找功能）
function extractEmailsForFind(text) {
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const emails = text.match(emailRegex) || [];
  return [...new Set(emails)]; // 去重
}

// 处理查找邮箱输入
async function handleFindEmail(chatId, input) {
  const session = findSessions[chatId];
  if (!session || !session.waitingForEmail) return;
  
  // 智能提取邮箱
  const emails = extractEmailsForFind(input);
  
  if (emails.length === 0) {
    await sendMessage(chatId, '❌ 未检测到有效的邮箱地址\n请重新输入或发送 /cancel 取消');
    return;
  }
  
  await sendMessage(chatId, `🔍 正在查找 ${emails.length} 个账号信息...`);
  
  try {
    const results = [];
    const notFound = [];
    
    for (const email of emails) {
      const accountInfo = await findAccount(email);
      if (accountInfo) {
        results.push(accountInfo);
      } else {
        notFound.push(email);
      }
    }
    
    if (results.length === 0) {
      await sendMessage(chatId, `❌ 未找到任何账号：\n${emails.join('\n')}`);
      delete findSessions[chatId];
      return;
    }
    
    // 保存查找结果
    session.accountInfos = results;
    session.notFound = notFound;
    session.waitingForEmail = false;
    
    // 格式化横排显示结果
    const message = formatMultipleAccountsCompact(results, notFound);
    
    await sendMessage(chatId, message, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📋 复制CSV格式', callback_data: `copy_accounts_csv` },
            { text: '❌ 结束查找', callback_data: 'end_find' }
          ]
        ]
      }
    });
  } catch (error) {
    await sendMessage(chatId, '❌ 查找失败，请稍后重试');
    delete findSessions[chatId];
  }
}

// 处理显示查找密码
async function handleShowFindPasswords(query) {
  const chatId = query.message.chat.id;
  const session = findSessions[chatId];
  
  if (!session || !session.accountInfo) {
    await answerCallback(query.id, '会话已过期');
    return;
  }
  
  // 更新消息，显示密码
  const message = formatAccountInfo(session.accountInfo, true);
  
  await editMessage(chatId, query.message.message_id, message, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '👁 显示密码', callback_data: `show_find_passwords` },
          { text: '🙈 隐藏密码', callback_data: `hide_find_passwords` }
        ],
        [
          { text: '📋 复制完整信息', callback_data: `copy_account_info` },
          { text: '❌ 结束查找', callback_data: 'end_find' }
        ]
      ]
    }
  });
  
  await answerCallback(query.id, '已显示密码');
}

// 处理隐藏查找密码
async function handleHideFindPasswords(query) {
  const chatId = query.message.chat.id;
  const session = findSessions[chatId];
  
  if (!session || !session.accountInfo) {
    await answerCallback(query.id, '会话已过期');
    return;
  }
  
  // 更新消息，隐藏密码
  const message = formatAccountInfo(session.accountInfo, false);
  
  await editMessage(chatId, query.message.message_id, message, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '👁 显示密码', callback_data: `show_find_passwords` },
          { text: '🙈 隐藏密码', callback_data: `hide_find_passwords` }
        ],
        [
          { text: '📋 复制完整信息', callback_data: `copy_account_info` },
          { text: '❌ 结束查找', callback_data: 'end_find' }
        ]
      ]
    }
  });
  
  await answerCallback(query.id, '已隐藏密码');
}

// 处理复制账号信息（CSV格式）
async function handleCopyAccountInfo(query) {
  const chatId = query.message.chat.id;
  const session = findSessions[chatId];
  
  if (!session || !session.accountInfo) {
    await answerCallback(query.id, '会话已过期');
    return;
  }
  
  const acc = session.accountInfo;
  
  // 生成CSV格式数据（只包含核心字段）
  const csvHeader = 'email,password,backup_email,backup_password,totp';
  const csvData = [
    acc.email || '',
    acc.password || '',
    acc.auxiliaryEmail || '',
    acc.auxiliaryPassword || '',
    acc.twoFA || ''
  ].join(',');
  
  const csvText = `${csvHeader}\n${csvData}`;
  
  // 发送CSV格式的可复制文本消息
  await sendMessage(chatId, `📄 **账号信息 (CSV格式)**\n\n\`\`\`csv\n${csvText}\n\`\`\`\n\n✅ 长按上方内容即可复制`, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ 已复制', callback_data: 'copied' }
      ]]
    }
  });
  
  await answerCallback(query.id, 'CSV信息已发送，请复制');
}

// 处理复制多个账号的CSV格式
async function handleCopyAccountsCSV(query) {
  const chatId = query.message.chat.id;
  const session = findSessions[chatId];
  
  if (!session || !session.accountInfos) {
    await answerCallback(query.id, '❌ 没有可复制的账号信息');
    return;
  }
  
  // 生成CSV格式
  let csvContent = 'email,password,totp,backup_email,api_key,cpny\n';
  
  for (const account of session.accountInfos) {
    const email = account.email || '';
    const password = account.password || '';
    const totp = account.twoFA || '';
    const backupEmail = account.auxiliaryEmail || '';
    const apiKey = account.accountKey || account.key || '';
    const cpny = '1'; // 默认值
    
    csvContent += `${email},${password},${totp},${backupEmail},${apiKey},${cpny}\n`;
  }
  
  // 发送CSV格式
  await sendMessage(chatId, 
    `📋 **CSV格式数据** (${session.accountInfos.length}个账号)\n\n` +
    '```\n' + csvContent + '```\n\n' +
    '💡 已按照标准CSV格式整理，可直接复制使用',
    { parse_mode: 'Markdown' }
  );
  
  await answerCallback(query.id, 'CSV数据已发送，请复制');
}

// 处理结束查找
async function handleEndFind(query) {
  const chatId = query.message.chat.id;
  
  delete findSessions[chatId];
  
  await editMessage(chatId, query.message.message_id, '✅ 查找会话已结束');
  await answerCallback(query.id, '已结束查找');
}

// 处理限额相关回调
async function handleLimitCallback(query) {
  const chatId = query.message.chat.id;
  const action = query.data;
  
  // 验证管理员权限
  if (!ADMIN_IDS.includes(chatId.toString())) {
    await answerCallback(query.id, '❌ 权限不足');
    return;
  }
  
  if (action === 'limit_add') {
    // 开始添加/修改限额流程
    limitSessions[chatId] = {
      waitingForType: false,
      waitingForValue: false
    };
    
    await editMessage(chatId, query.message.message_id, 
      '➕ **添加/修改限额**\n\n' +
      '请选择账号类型：', {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🔵 GCP300', callback_data: 'limit_type_GCP300' },
            { text: '📧 Gmail', callback_data: 'limit_type_Gmail' },
            { text: '☁️ AWS', callback_data: 'limit_type_AWS' }
          ],
          [
            { text: '🌐 AZURE', callback_data: 'limit_type_AZURE' },
            { text: '🔢 5', callback_data: 'limit_type_5' },
            { text: '🔢 6', callback_data: 'limit_type_6' }
          ],
          [
            { text: '❌ 取消', callback_data: 'limit_cancel' }
          ]
        ]
      }
    });
    await answerCallback(query.id, '请选择账号类型');
    
  } else if (action === 'limit_delete') {
    // 显示可删除的限额列表
    const limitsData = loadLimits();
    
    if (Object.keys(limitsData.limits).length === 0) {
      await editMessage(chatId, query.message.message_id, '❌ 暂无限额可删除');
      await answerCallback(query.id, '暂无限额');
      return;
    }
    
    let message = '🗑 **删除限额**\n\n请选择要删除的限额：\n';
    const keyboard = [];
    
    for (const [type, limit] of Object.entries(limitsData.limits)) {
      message += `• ${type}: ${limit}\n`;
      keyboard.push([{ 
        text: `❌ ${type}`, 
        callback_data: `limit_del_${type}` 
      }]);
    }
    
    keyboard.push([{ text: '取消', callback_data: 'limit_cancel' }]);
    
    await editMessage(chatId, query.message.message_id, message, {
      reply_markup: { inline_keyboard: keyboard }
    });
    await answerCallback(query.id, '选择要删除的限额');
    
  } else if (action.startsWith('limit_type_')) {
    // 处理限制类型选择
    const type = action.replace('limit_type_', '');
    const session = limitSessions[chatId];
    
    if (!session) {
      await answerCallback(query.id, '会话已过期');
      return;
    }
    
    session.accountType = type;
    session.waitingForType = false;
    session.waitingForValue = true;
    
    await editMessage(chatId, query.message.message_id, 
      `📝 账号类型：**${type}**\n\n` +
      '请输入每日限额数量（输入0表示不限制）：'
    );
    await answerCallback(query.id, `已选择 ${type}，请输入限额`);
    
  } else if (action.startsWith('limit_del_')) {
    // 执行删除限额
    const type = action.replace('limit_del_', '');
    const limitsData = loadLimits();
    
    if (limitsData.limits[type]) {
      delete limitsData.limits[type];
      limitsData.lastUpdate = new Date().toISOString().split('T')[0];
      limitsData.updatedBy = 'Admin';
      
      if (saveLimits(limitsData)) {
        await editMessage(chatId, query.message.message_id, 
          `✅ 已删除 **${type}** 的限额设置`
        );
        await answerCallback(query.id, '删除成功');
      } else {
        await answerCallback(query.id, '删除失败');
      }
    }
    
  } else if (action === 'limit_cancel') {
    delete limitSessions[chatId];
    await editMessage(chatId, query.message.message_id, '❌ 已取消限额设置');
    await answerCallback(query.id, '已取消');
  }
}

// 优雅关闭处理
process.on('SIGINT', () => {
  console.log('\n[关闭] 收到中断信号，正在优雅关闭...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[关闭] 收到终止信号，正在优雅关闭...');
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  console.error('[严重错误] 未捕获的异常:', error);
  // 记录错误但不退出，保持机器人运行
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[严重错误] 未处理的Promise拒绝:', reason);
  // 记录错误但不退出，保持机器人运行
});

// 定期清理过期缓存
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  
  for (const [key, value] of queryCache.entries()) {
    if (now - value.time > CACHE_TTL) {
      queryCache.delete(key);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    console.log(`[缓存] 清理了 ${cleaned} 个过期缓存项`);
  }
}, 60000); // 每分钟清理一次

// ===============================
// 邮箱指定出库功能
// ===============================

// 处理 /outbound_email 命令
async function handleEmailOutbound(msg) {
  const chatId = msg.chat.id;
  
  // 验证管理员权限
  if (!ADMIN_IDS.includes(chatId.toString())) {
    await sendMessage(chatId, '❌ 只有管理员可以使用邮箱出库功能');
    return;
  }
  
  console.log('[命令] /outbound_email');
  
  // 清理其他会话
  delete sessions[chatId];
  delete editSessions[chatId];
  delete banSessions[chatId];
  delete outboundSessions[chatId];
  delete findSessions[chatId];
  delete limitSessions[chatId];
  
  // 初始化邮箱出库会话
  emailOutboundSessions[chatId] = {
    waitingForEmails: true,
    lastActivity: Date.now()
  };
  
  await sendMessage(chatId, 
    `📤 **邮箱指定出库**\n\n` +
    `请输入要出库的邮箱地址，支持以下格式：\n\n` +
    `• 单个邮箱：user@gmail.com\n` +
    `• 多个邮箱（逗号分隔）：user1@gmail.com, user2@gmail.com\n` +
    `• 多行邮箱：每行一个邮箱地址\n` +
    `• CSV格式：user@gmail.com,password,...（将提取邮箱）\n\n` +
    `💡 系统会自动查找这些邮箱对应的在库账号\n\n` +
    `发送 /cancel 取消操作`, 
    { parse_mode: 'Markdown' }
  );
}

// 处理邮箱输入
async function handleEmailOutboundEmails(chatId, input) {
  const session = emailOutboundSessions[chatId];
  if (!session || !session.waitingForEmails) return;
  
  // 更新会话活动时间
  session.lastActivity = Date.now();
  
  // 智能提取邮箱（复用现有的查找功能逻辑）
  const emails = extractEmailsForFind(input);
  
  if (emails.length === 0) {
    await sendMessage(chatId, '❌ 未检测到有效的邮箱地址\n请重新输入或发送 /cancel 取消');
    return;
  }
  
  await sendMessage(chatId, `🔍 正在查找 ${emails.length} 个账号信息...`);
  
  try {
    const foundAccounts = [];
    const notFound = [];
    const notInStock = [];
    
    // 查找每个邮箱对应的账号
    for (const email of emails) {
      const accountInfo = await findAccountForOutbound(email);
      
      if (!accountInfo) {
        notFound.push(email);
      } else if (accountInfo.status !== '在库') {
        notInStock.push({ email, status: accountInfo.status });
      } else {
        foundAccounts.push(accountInfo);
      }
    }
    
    // 保存找到的账号到会话
    session.foundAccounts = foundAccounts;
    session.notFound = notFound;
    session.notInStock = notInStock;
    
    // 构建结果消息
    let resultMessage = `📋 **查找结果**\n\n`;
    
    if (foundAccounts.length > 0) {
      resultMessage += `✅ **找到 ${foundAccounts.length} 个可出库账号：**\n`;
      foundAccounts.forEach((acc, index) => {
        resultMessage += `${index + 1}. ${acc.email} (${acc.accountType || '未知类型'})\n`;
      });
      resultMessage += '\n';
    }
    
    if (notFound.length > 0) {
      resultMessage += `❌ **未找到 ${notFound.length} 个账号：**\n`;
      notFound.forEach(email => {
        resultMessage += `• ${email}\n`;
      });
      resultMessage += '\n';
    }
    
    if (notInStock.length > 0) {
      resultMessage += `⚠️ **${notInStock.length} 个账号不在库存中：**\n`;
      notInStock.forEach(item => {
        resultMessage += `• ${item.email} (状态: ${item.status})\n`;
      });
      resultMessage += '\n';
    }
    
    if (foundAccounts.length === 0) {
      resultMessage += `💡 没有可出库的账号`;
      delete emailOutboundSessions[chatId];
      await sendMessage(chatId, resultMessage, { parse_mode: 'Markdown' });
      return;
    }
    
    // 询问出库价格
    session.waitingForEmails = false;
    session.waitingForPrice = true;
    
    resultMessage += `💰 请输入统一出库价格（美元）：`;
    
    await sendMessage(chatId, resultMessage, { parse_mode: 'Markdown' });
    
  } catch (error) {
    console.error('[错误] 邮箱出库查找失败:', error.message);
    await sendMessage(chatId, '❌ 查找账号时出错，请稍后重试');
    delete emailOutboundSessions[chatId];
  }
}

// 处理价格输入
async function handleEmailOutboundPrice(chatId, text) {
  const session = emailOutboundSessions[chatId];
  if (!session || !session.waitingForPrice) return;
  
  // 更新会话活动时间
  session.lastActivity = Date.now();
  
  const price = parseFloat(text);
  if (isNaN(price) || price <= 0) {
    await sendMessage(chatId, '❌ 请输入有效的价格（大于0的数字）');
    return;
  }
  
  session.price = price;
  session.waitingForPrice = false;
  
  const totalPrice = price * session.foundAccounts.length;
  
  // 构建确认消息
  let confirmMessage = `📦 **确认批量出库**\n\n`;
  confirmMessage += `📊 **出库详情：**\n`;
  confirmMessage += `• 出库数量：${session.foundAccounts.length} 个账号\n`;
  confirmMessage += `• 单价：$${price}\n`;
  confirmMessage += `• 总价：$${totalPrice}\n\n`;
  
  confirmMessage += `📋 **账号列表：**\n`;
  session.foundAccounts.forEach((acc, index) => {
    confirmMessage += `${index + 1}. ${acc.email} (${acc.accountType || '未知类型'})\n`;
  });
  
  confirmMessage += `\n确认执行批量出库？`;
  
  await sendMessage(chatId, confirmMessage, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ 确认出库', callback_data: 'confirm_email_outbound' },
          { text: '❌ 取消', callback_data: 'cancel' }
        ]
      ]
    }
  });
}

// 查找账号（专用于出库功能）
async function findAccountForOutbound(email) {
  try {
    // 优先查找本地数据库
    const localAccount = await localDB.findAccount(email);
    if (localAccount) {
      return {
        email: localAccount.email,
        status: localAccount.status,
        accountType: localAccount.accountType,
        id: localAccount.id,
        source: 'local'
      };
    }
    
    return null;
  } catch (error) {
    console.error(`[错误] 查找账号失败: ${email}`, error.message);
    return null;
  }
}

// 执行批量出库
async function executeEmailOutbound(query) {
  const chatId = query.message.chat.id;
  const session = emailOutboundSessions[chatId];
  
  if (!session || !session.foundAccounts || !session.price) {
    await answerCallback(query.id, '会话已过期，请重新开始');
    return;
  }
  
  await editMessage(chatId, query.message.message_id, '⏳ 正在执行批量出库...');
  
  try {
    const results = {
      success: [],
      failed: []
    };
    
    const currentDate = new Date().toISOString().split('T')[0];
    
    // 逐个处理账号出库
    for (const account of session.foundAccounts) {
      try {
        // 更新Notion数据库
        if (account.source === 'notion' || !account.source) {
          await notion.pages.update({
            page_id: account.id,
            properties: {
              '状态': {
                rich_text: [{ text: { content: '出库' } }]
              },
              '出库日期': {
                date: { start: currentDate }
              },
              '出库价格': {
                number: session.price
              }
            }
          });
          console.log(`✅ [Notion同步] ${account.email}`);
        }
        
        // 更新本地数据库
        const localUpdateResult = await localDB.updateAccountStatus(account.email, '出库');
        if (localUpdateResult) {
          // 更新出库价格和日期
          const localAccount = await localDB.findAccount(account.email);
          if (localAccount) {
            localAccount.outboundDate = currentDate;
            localAccount.outboundPrice = session.price;
            localAccount.updatedAt = new Date().toISOString();
            await localDB.save();
          }
          console.log(`✅ [本地] 更新成功: ${account.email}`);
        }
        
        results.success.push(account);
        
      } catch (error) {
        console.error(`[错误] 出库失败: ${account.email}`, error.message);
        results.failed.push({ email: account.email, error: error.message });
      }
    }
    
    // 生成CSV数据
    let csvData = '';
    if (results.success.length > 0) {
      csvData = '\n📄 **出库账号CSV数据：**\n```\n';
      csvData += 'email,password,totp,backup_email,api_key\n';
      
      for (const account of results.success) {
        // 获取完整账号信息
        const fullAccount = await localDB.findAccount(account.email);
        console.log(`[调试] 查找账号 ${account.email}:`, fullAccount ? '找到' : '未找到');
        if (fullAccount) {
          console.log(`[调试] 账号字段: email=${fullAccount.email}, password=${fullAccount.emailPassword}, backup=${fullAccount.auxiliaryEmail}`);
          const csvRow = [
            fullAccount.email || '',
            fullAccount.emailPassword || '',
            fullAccount.twoFACode || '',
            fullAccount.auxiliaryEmail || '',
            fullAccount.accountKey || ''
          ].map(field => String(field).replace(/,/g, '，')).join(',');
          csvData += csvRow + '\n';
        }
      }
      csvData += '```';
    }
    
    // 构建结果消息
    let resultMessage = `📦 **批量出库完成**\n\n`;
    
    if (results.success.length > 0) {
      resultMessage += `✅ **成功出库 ${results.success.length} 个账号：**\n`;
      results.success.forEach(acc => {
        resultMessage += `• ${acc.email} (${acc.accountType})\n`;
      });
      resultMessage += `\n💰 总价值：$${(session.price * results.success.length).toFixed(2)}\n`;
    }
    
    if (results.failed.length > 0) {
      resultMessage += `\n❌ **出库失败 ${results.failed.length} 个账号：**\n`;
      results.failed.forEach(item => {
        resultMessage += `• ${item.email}\n`;
      });
    }
    
    resultMessage += csvData;
    
    await editMessage(chatId, query.message.message_id, resultMessage, { 
      parse_mode: 'Markdown' 
    });
    
    // 清理会话
    delete emailOutboundSessions[chatId];
    
  } catch (error) {
    console.error('[错误] 批量出库执行失败:', error.message);
    await editMessage(chatId, query.message.message_id, 
      `❌ **批量出库失败**\n\n错误: ${error.message}`, 
      { parse_mode: 'Markdown' }
    );
    delete emailOutboundSessions[chatId];
  }
}

// =============================================================================
// 卡网出库接口 (预留功能)
// =============================================================================

/**
 * 卡网出库接口 - 标记账号为卡网出库
 * @param {string} email - 账号邮箱
 * @param {number} price - 出库价格  
 * @param {string} buyerId - 购买者ID (可选)
 * @returns {Promise<boolean>} 是否成功
 */
async function markCardShopOutbound(email, price, buyerId = null) {
  try {
    console.log(`[卡网出库] 处理账号: ${email}, 价格: $${price}`);
    
    // 更新本地数据库
    const updateResult = await localDB.updateAccountStatus(email, '出库', {
      outboundPrice: price,
      outboundDate: new Date().toISOString().split('T')[0],
      outboundUserId: 'cardshop',
      outboundUserName: '卡网系统',
      outboundSource: 'cardshop',
      buyerId: buyerId // 记录购买者信息
    });
    
    if (updateResult) {
      console.log(`✅ [卡网出库] 本地数据库更新成功: ${email}`);
      return true;
    } else {
      console.log(`❌ [卡网出库] 本地数据库更新失败: ${email}`);
      return false;
    }
    
  } catch (error) {
    console.error(`[卡网出库错误] ${email}:`, error.message);
    return false;
  }
}

/**
 * 批量卡网出库接口
 * @param {Array} accounts - 账号列表 [{email, price, buyerId}]
 * @returns {Promise<Object>} 批量处理结果
 */
async function batchCardShopOutbound(accounts) {
  const results = {
    success: [],
    failed: [],
    total: accounts.length
  };
  
  console.log(`[卡网批量出库] 开始处理 ${accounts.length} 个账号`);
  
  for (const account of accounts) {
    const success = await markCardShopOutbound(account.email, account.price, account.buyerId);
    if (success) {
      results.success.push(account.email);
    } else {
      results.failed.push(account.email);
    }
  }
  
  console.log(`[卡网批量出库] 完成 - 成功: ${results.success.length}, 失败: ${results.failed.length}`);
  return results;
}

// 启动
init();